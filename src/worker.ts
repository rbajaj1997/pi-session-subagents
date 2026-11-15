import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession, PromptOptions } from "@earendil-works/pi-coding-agent";
import { LATE_STEER_TURN_MESSAGE, timeoutMessage } from "./copy";
import { formatDuration, lastLine, messageText, summarizeToolArgs } from "./text";
import { closeWorkerSession } from "./worker-session";

export type WorkerStatus = "idle" | "running" | "done" | "error" | "stopped";

export interface WorkerInfo {
	modelLabel: string;
	cwd: string;
	requestedTools: string[];
	warnings: string[];
}

export interface RunStats {
	turns: number;
	toolUses: number;
	tokens: number;
	durationMs: number;
	outcome: string;
}

type PromptDisposition = Parameters<NonNullable<PromptOptions["preflightResult"]>>[0];

interface Run {
	id: number;
	task: string;
	startedAt: number;
	lastEntryBeforeRun: string | null;
	controller: AbortController;
	submissions: Set<Promise<void>>;
	submitError?: unknown;
	done?: Promise<void>;
	endedAt?: number;
	error?: string;
}

let lastRunIdAcrossWorkers = 0;

export class Worker {
	readonly createdAt = Date.now();
	private run: Run | undefined;
	private closing: Promise<void> | undefined;

	constructor(
		readonly name: string,
		readonly session: AgentSession,
		readonly info: WorkerInfo,
		private readonly onRunEnd: (worker: Worker) => void,
	) {}

	get status(): WorkerStatus {
		if (this.closing) return "stopped";
		if (!this.run) return "idle";
		if (this.run.endedAt === undefined) return "running";
		return this.run.error ? "error" : "done";
	}

	get task(): string {
		return this.run?.task ?? "";
	}

	get runId(): number {
		return this.run?.id ?? 0;
	}

	get error(): string {
		return this.run?.error ?? "";
	}

	settled(): Promise<void> {
		return this.run?.done ?? Promise.resolve();
	}

	stats(): RunStats {
		const run = this.run;
		if (!run) return { turns: 0, toolUses: 0, tokens: 0, durationMs: 0, outcome: "" };
		const messages = this.runMessages(run);
		let toolUses = 0;
		let tokens = 0;
		for (const message of messages) {
			toolUses += message.content.filter((part) => part.type === "toolCall").length;
			const usage = message.usage;
			tokens += (usage?.input ?? 0) + (usage?.output ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
		}
		const outcome = messageText(messages.findLast((message) => messageText(message)));
		return {
			turns: messages.length,
			toolUses,
			tokens,
			durationMs: (run.endedAt ?? Date.now()) - run.startedAt,
			outcome,
		};
	}

	activity(): string {
		if (this.status !== "running") return this.error || lastLine(this.stats().outcome);
		const state = this.session.state;
		const calls =
			lastAssistant(state.messages)?.content.flatMap((part) =>
				part.type === "toolCall" && state.pendingToolCalls.has(part.id)
					? [`${part.name} ${summarizeToolArgs(part.arguments)}`.trim()]
					: [],
			) ?? [];
		if (calls.length) return calls.join(", ");
		const streaming =
			state.streamingMessage?.role === "assistant" ? lastLine(messageText(state.streamingMessage)) : "";
		return streaming || "thinking…";
	}

	capabilities(): { enabledTools: string[]; callableTools: string[]; missingTools: string[]; warnings: string[] } {
		const enabledTools = this.session.getActiveToolNames();
		return {
			enabledTools,
			callableTools: this.session.getCallableToolNames(),
			missingTools: this.info.requestedTools.filter((name) => !enabledTools.includes(name)),
			warnings: this.info.warnings,
		};
	}

	start(task: string, timeoutMs?: number): void {
		if (this.closing) throw new Error(`${this.name} has been stopped.`);
		const run: Run = {
			id: ++lastRunIdAcrossWorkers,
			task,
			startedAt: Date.now(),
			lastEntryBeforeRun: this.session.sessionManager.getLeafId(),
			controller: new AbortController(),
			submissions: new Set(),
		};
		this.run = run;
		run.done = this.execute(run, timeoutMs);
	}

	async steer(text: string): Promise<"steer" | "handled"> {
		const run = this.run;
		if (!run || run.endedAt !== undefined) throw new Error(`${this.name} is not running.`);
		return (await this.promptUntilAccepted(run, text)) === "handled" ? "handled" : "steer";
	}

	close(): Promise<void> {
		this.closing ??= (async () => {
			const run = this.run;
			if (run && run.endedAt === undefined) this.cancel(run, new Error("Stopped."));
			await run?.done;
			await closeWorkerSession(this.session);
		})();
		return this.closing;
	}

	private async execute(run: Run, timeoutMs?: number): Promise<void> {
		const timer = timeoutMs
			? setTimeout(() => this.cancel(run, new Error(timeoutMessage(formatDuration(timeoutMs)))), timeoutMs)
			: undefined;
		let failure: unknown;
		try {
			await this.promptUntilAccepted(run, run.task);
			await this.finishAcceptedPromptsAndLateSteers(run);
		} catch (error) {
			failure = error;
		}
		clearTimeout(timer);
		if (run.controller.signal.aborted) {
			this.session.clearQueue();
			failure = run.controller.signal.reason;
		}
		failure ??= run.submitError;
		run.endedAt = Date.now();
		run.error = failure !== undefined ? errorText(failure) : lastTurnError(this.runMessages(run));
		if (!this.closing) this.onRunEnd(this);
	}

	private async finishAcceptedPromptsAndLateSteers(run: Run): Promise<void> {
		while (true) {
			if (run.submissions.size > 0) {
				await Promise.all(run.submissions);
				continue;
			}
			if (run.controller.signal.aborted || run.submitError !== undefined || this.session.pendingMessageCount === 0)
				return;
			// A steer accepted after the last turn's queue check waits for a turn that never comes, so start one.
			await this.session.sendCustomMessage(
				{ customType: "subagent-late-steer", content: LATE_STEER_TURN_MESSAGE, display: false },
				{ triggerTurn: true },
			);
		}
	}

	private promptUntilAccepted(run: Run, text: string): Promise<PromptDisposition> {
		return new Promise((resolve, reject) => {
			let accepted = false;
			const work: Promise<void> = this.session
				.prompt(text, {
					streamingBehavior: "steer",
					preflightResult: (disposition) => {
						accepted = true;
						if (disposition === "started" && run.controller.signal.aborted) void this.session.abort();
						resolve(disposition);
					},
				})
				.then(
					() => resolve("queued"),
					(error) => {
						if (!accepted) reject(error);
						else run.submitError ??= error;
					},
				)
				.finally(() => run.submissions.delete(work));
			run.submissions.add(work);
		});
	}

	private cancel(run: Run, reason: Error): void {
		if (run.controller.signal.aborted) return;
		run.controller.abort(reason);
		void this.session.abort();
	}

	private runMessages(run: Run): AssistantMessage[] {
		const branch = this.session.sessionManager.getBranch();
		const start = branch.findIndex((entry) => entry.id === run.lastEntryBeforeRun) + 1;
		return branch
			.slice(start)
			.flatMap((entry) => (entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : []));
	}
}

function lastAssistant(messages: readonly { role: string }[]): AssistantMessage | undefined {
	return messages.findLast((message): message is AssistantMessage => message.role === "assistant");
}

function lastTurnError(messages: AssistantMessage[]): string {
	const last = messages.at(-1);
	if (last?.stopReason === "error") return last.errorMessage || "Model request failed.";
	if (last?.stopReason === "aborted") return last.errorMessage || "Run was aborted.";
	return "";
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
