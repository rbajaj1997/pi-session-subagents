import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentToolUpdateCallback, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { isSubagentTool } from "./copy";
import { buildReport, ReportOutbox } from "./report";
import { normalizeName, slugify } from "./text";
import { openInspector } from "./ui/conversation-viewer";
import { SubagentWidget } from "./ui/widget";
import { Worker } from "./worker";
import { closeWorkerSession, createWorkerSession, resolveWorkerCwd } from "./worker-session";

export interface SpawnOptions {
	name?: string;
	task?: string;
	model?: string;
	cwd?: string;
	tools?: string[];
	thinking?: ThinkingLevel;
	timeoutMs?: number;
}

export class Roster {
	readonly reports: ReportOutbox;
	private readonly workers = new Map<string, Worker>();
	private readonly widget: SubagentWidget;
	private ctx: ExtensionContext | undefined;
	private disposed = false;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly createSession = createWorkerSession,
	) {
		this.reports = new ReportOutbox(pi);
		this.widget = new SubagentWidget(
			() => this.list(),
			(name) => {
				const ctx = this.ctx;
				if (!ctx) return;
				openInspector(ctx, this.list(), name).catch((error) =>
					ctx.ui.notify(
						`Could not open ${name}: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					),
				);
			},
		);
	}

	attach(ctx: ExtensionContext): void {
		this.ctx = ctx;
		this.widget.attach(ctx);
	}

	list(): Worker[] {
		return [...this.workers.values()].sort((a, b) => a.createdAt - b.createdAt);
	}

	find(name: string): Worker {
		const normalized = normalizeName(name);
		const worker =
			this.workers.get(name) ?? this.list().find((candidate) => normalizeName(candidate.name) === normalized);
		if (!worker) throw new Error(`Unknown subagent: ${name}`);
		return worker;
	}

	completions(prefix: string): AutocompleteItem[] | null {
		const items = this.list()
			.filter((worker) => worker.name.startsWith(prefix))
			.map((worker) => ({ value: worker.name, label: `${worker.name} [${worker.status}]` }));
		return items.length > 0 ? items : null;
	}

	async spawn(options: SpawnOptions, ctx: ExtensionContext, signal?: AbortSignal): Promise<Worker> {
		if (this.disposed) throw new Error("Cannot create a worker after session shutdown.");
		const cwd = resolveWorkerCwd(ctx.cwd, options.cwd);
		const tools = pickTools(this.pi.getActiveTools(), options.tools);
		const { session, modelLabel, warnings } = await this.createSession(ctx, {
			cwd,
			model: options.model,
			thinking: options.thinking ?? this.pi.getThinkingLevel(),
			tools,
			onExtensionError: (warning) => {
				if (!this.disposed && this.ctx?.hasUI) this.ctx.ui.notify(warning, "warning");
			},
		});
		if (this.disposed || signal?.aborted) {
			await closeWorkerSession(session);
			throw new Error(
				this.disposed ? "Worker creation was interrupted by session shutdown." : "Worker creation was cancelled.",
			);
		}
		const worker = new Worker(
			this.uniqueName(options.name),
			session,
			{ modelLabel, cwd, requestedTools: tools, warnings },
			(ended) => this.runEnded(ended),
		);
		this.workers.set(worker.name, worker);
		const task = options.task?.trim();
		if (task) worker.start(task, options.timeoutMs);
		this.changed();
		return worker;
	}

	async message(
		name: string,
		text: string,
		timeoutMs?: number,
	): Promise<{ worker: Worker; mode: "steer" | "start" | "handled" }> {
		const worker = this.find(name);
		if (worker.status === "running") return { worker, mode: await worker.steer(text) };
		worker.start(text, timeoutMs);
		this.changed();
		return { worker, mode: "start" };
	}

	async stop(name: string): Promise<Worker> {
		const worker = this.find(name);
		await this.remove(worker);
		return worker;
	}

	async stopAll(): Promise<void> {
		await Promise.all(this.list().map((worker) => this.remove(worker)));
	}

	async waitFor(
		names: string[] | undefined,
		timeoutMs: number | undefined,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<{ waiting: string[] }> | undefined,
	): Promise<Worker[]> {
		const targets = names?.length
			? names.map((name) => this.find(name))
			: this.list().filter((worker) => worker.status === "running");
		const deadline = new AbortController();
		const timer = timeoutMs ? setTimeout(() => deadline.abort(), timeoutMs) : undefined;
		const stop = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
		const stopped = new Promise<void>((resolve) => stop.addEventListener("abort", () => resolve(), { once: true }));
		try {
			while (true) {
				const running = targets.filter((worker) => worker.status === "running");
				if (signal?.aborted) throw new Error("Aborted");
				if (running.length === 0 || deadline.signal.aborted) return running;
				const waiting = running.map((worker) => worker.name);
				onUpdate?.({
					content: [{ type: "text", text: `Waiting on ${waiting.length} subagent(s): ${waiting.join(", ")}` }],
					details: { waiting },
				});
				await Promise.race([stopped, ...running.map((worker) => worker.settled())]);
			}
		} finally {
			clearTimeout(timer);
		}
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		this.reports.clear();
		this.widget.dispose();
		await Promise.allSettled(this.list().map((worker) => this.remove(worker)));
	}

	private remove(worker: Worker): Promise<void> {
		if (this.workers.get(worker.name) === worker) this.workers.delete(worker.name);
		const closing = worker.close();
		this.changed();
		return closing;
	}

	private runEnded(worker: Worker): void {
		this.changed();
		this.reports.deliver(buildReport(worker), this.ctx);
	}

	private changed(): void {
		if (!this.disposed) this.widget.refresh();
	}

	private uniqueName(preferred: string | undefined): string {
		const base = slugify(preferred?.trim() || "worker");
		if (!this.workers.has(base)) return base;
		let count = 2;
		while (this.workers.has(`${base}-${count}`)) count++;
		return `${base}-${count}`;
	}
}

function pickTools(parentTools: string[], requested: string[] | undefined): string[] {
	const available = parentTools.filter((name) => !isSubagentTool(name));
	if (!requested) return available;
	const unavailable = requested.filter((name) => !available.includes(name));
	if (unavailable.length)
		throw new Error(
			`Tools not active in the parent session: ${unavailable.join(", ")}. Available: ${available.join(", ") || "(none)"}.`,
		);
	return [...new Set(requested)];
}
