export class ControlledSession {
	branch = [];
	requests = [];
	pendingMessageCount = 0;
	thinkingLevel = "low";
	state = {
		messages: [],
		pendingToolCalls: new Set(),
		streamingMessage: undefined,
	};
	enabledTools = ["read"];
	callableTools = ["read", "tool_search"];
	queuedMessages = [];
	shutdownEvents = [];
	disposed = false;
	credentialWrites = Promise.resolve();
	deferAcceptance = false;
	onLateTurn = () => {};

	sessionManager = {
		getLeafId: () => this.branch.at(-1)?.id ?? null,
		getBranch: () => this.branch,
		getSessionFile: () => "/sessions/scout.jsonl",
	};

	extensionRunner = {
		emit: async (event) => {
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

	prompt(text, options) {
		const completion = Promise.withResolvers();
		const request = {
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
				options.preflightResult(disposition);
			},
		};
		this.requests.push(request);
		if (!this.deferAcceptance) request.accept(this.running ? "queued" : "started");
		return completion.promise;
	}

	assistant(text, overrides = {}) {
		const message = {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "example",
			model: "small",
			usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 3 },
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

	async sendCustomMessage(_message, options) {
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
