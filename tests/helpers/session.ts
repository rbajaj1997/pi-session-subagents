import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	AgentSession,
	PromptOptions,
	SessionMessageEntry,
	SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";

type PromptDisposition = Parameters<NonNullable<PromptOptions["preflightResult"]>>[0];

interface ControlledRequest {
	text: string;
	options: PromptOptions;
	disposition?: PromptDisposition;
	finish(): void;
	fail(error: unknown): void;
	accept(disposition: PromptDisposition): void;
}

export class ControlledSession {
	branch: Pick<SessionMessageEntry, "type" | "id" | "message">[] = [];
	requests: ControlledRequest[] = [];
	pendingMessageCount = 0;
	thinkingLevel: ThinkingLevel = "low";
	running = false;
	state: {
		messages: AgentMessage[];
		pendingToolCalls: Set<string>;
		streamingMessage: Pick<AssistantMessage, "role" | "content"> | undefined;
	} = {
		messages: [],
		pendingToolCalls: new Set(),
		streamingMessage: undefined,
	};
	enabledTools = ["read"];
	callableTools = ["read", "tool_search"];
	queuedMessages: string[] = [];
	shutdownEvents: SessionShutdownEvent[] = [];
	disposed = false;
	credentialWrites = Promise.resolve();
	deferAcceptance = false;
	onLateTurn: (queued: string[]) => void | Promise<void> = () => {};

	// AgentSession has private members, so a structural fake needs this one cast.
	asAgentSession(): AgentSession {
		return this as unknown as AgentSession;
	}

	sessionManager = {
		getLeafId: () => this.branch.at(-1)?.id ?? null,
		getBranch: () => this.branch,
		getSessionFile: () => "/sessions/scout.jsonl",
	};

	extensionRunner = {
		emit: async (event: SessionShutdownEvent) => {
			this.shutdownEvents.push(event);
		},
	};
	modelRuntime = { settleCredentialWrites: () => this.credentialWrites };
	settingsManager = { getHideThinkingBlock: () => false };

	subscribe() {
		return () => {};
	}

	getActiveToolNames() {
		return this.enabledTools;
	}
	getCallableToolNames() {
		return this.callableTools;
	}

	prompt(text: string, options: PromptOptions) {
		const completion = Promise.withResolvers<void>();
		const request: ControlledRequest = {
			text,
			options,
			finish: () => {
				if (request.disposition === "started") this.running = false;
				completion.resolve();
			},
			fail: (error) => completion.reject(error),
			accept: (disposition) => {
				request.disposition = disposition;
				if (disposition === "started") this.running = true;
				if (disposition === "queued") {
					this.pendingMessageCount++;
					this.queuedMessages.push(text);
				}
				options.preflightResult?.(disposition);
			},
		};
		this.requests.push(request);
		if (!this.deferAcceptance) request.accept(this.running ? "queued" : "started");
		return completion.promise;
	}

	assistant(text: string, overrides: Partial<AssistantMessage> = {}) {
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "example",
			model: "small",
			usage: {
				input: 10,
				output: 5,
				cacheRead: 2,
				cacheWrite: 3,
				totalTokens: 20,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
			...overrides,
		};
		this.branch.push({
			type: "message",
			id: `entry-${this.branch.length + 1}`,
			message,
		});
		this.state.messages.push(message);
	}

	async sendCustomMessage(_message: unknown, options: { triggerTurn?: boolean }) {
		if (options.triggerTurn) {
			const queued = this.queuedMessages.splice(0);
			this.pendingMessageCount = 0;
			await this.onLateTurn(queued);
		}
	}

	clearQueue() {
		this.queuedMessages = [];
		this.pendingMessageCount = 0;
	}

	async abort() {
		this.running = false;
		for (const request of this.requests) request.finish();
	}

	dispose() {
		this.disposed = true;
	}
}
