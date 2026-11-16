import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	CustomMessageComponent,
	type ExtensionContext,
	getMarkdownTheme,
	type KeybindingsManager,
	sessionEntryToContextMessages,
	type Theme,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	matchesKey,
	type OverlayHandle,
	Text,
	TruncatedText,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { clip, formatDuration, formatTokens, shortModelLabel } from "../text";
import type { Worker } from "../worker";
import { dismissOnOutsideClick } from "./outside-click";

type ToolView = { component: ToolExecutionComponent; result?: unknown; durationMs?: number };

const VIEWPORT_TOP = 4;
const VIEWPORT_LEFT = 2;
const VIEWPORT_BOTTOM = 3;

export async function openInspector(ctx: ExtensionContext, workers: Worker[], name?: string): Promise<void> {
	if (ctx.mode !== "tui") {
		if (ctx.hasUI)
			ctx.ui.notify("The subagent inspector needs the interactive TUI. Use inspect_subagent instead.", "warning");
		return;
	}
	let worker = name?.trim() ? workers.find((candidate) => candidate.name === name.trim()) : undefined;
	if (name?.trim() && !worker) {
		ctx.ui.notify(`Unknown subagent: ${name}`, "error");
		return;
	}
	if (!worker) {
		if (workers.length === 0) {
			ctx.ui.notify("No subagents", "info");
			return;
		}
		const options = workers.map(
			(candidate) => `${candidate.name} [${candidate.status}] — ${clip(candidate.task || "(idle)", 70)}`,
		);
		const choice = await ctx.ui.select("Inspect Subagent", options);
		worker = choice ? workers[options.indexOf(choice)] : undefined;
		if (!worker) return;
	}
	const selected = worker;
	let viewer: ConversationViewer;
	await ctx.ui.custom<void>(
		(tui, theme, keybindings, done) => {
			viewer = new ConversationViewer(tui, selected, theme, keybindings, () => done());
			return viewer;
		},
		{
			overlay: true,
			overlayOptions: { anchor: "center", width: "90%", margin: 1 },
			onHandle: (handle) => viewer.attachOverlay(handle),
		},
	);
}

class ConversationViewer implements Component {
	private readonly history = new Container();
	private readonly rows = new Map<string, Component>();
	private readonly tools = new Map<string, ToolView>();
	private readonly unsubscribe: () => void;
	private leafId: string | null | undefined;
	private streaming: AssistantMessageComponent | undefined;
	private scrollOffset = 0;
	private autoScroll = true;
	private contentHeight = 0;
	private historyHeight = 0;
	private viewportHeight = 1;
	private contentWidth = 0;
	private expanded = false;
	private hideThinking: boolean;
	private disposed = false;
	private removeOutsideClick: (() => void) | undefined;

	constructor(
		private readonly tui: TUI,
		private readonly worker: Worker,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly done: () => void,
	) {
		this.hideThinking = worker.session.settingsManager.getHideThinkingBlock();
		const partial = worker.session.state.streamingMessage;
		if (partial?.role === "assistant") this.updateStreaming(partial);
		this.unsubscribe = worker.session.subscribe((event) => {
			if (this.disposed) return;
			switch (event.type) {
				case "message_update":
					if (event.message.role === "assistant") this.updateStreaming(event.message);
					break;
				case "message_end":
					if (event.message.role === "assistant") this.streaming = undefined;
					break;
				case "tool_execution_start":
					this.tool(event.toolName, event.toolCallId, event.args).component.markExecutionStarted();
					break;
				case "tool_execution_update":
					this.tool(event.toolName, event.toolCallId, event.args).component.updateResult(
						{ ...event.partialResult, isError: false },
						true,
					);
					break;
				case "tool_execution_end": {
					const tool = this.tools.get(event.toolCallId);
					if (tool) {
						tool.durationMs = event.durationMs;
						tool.component.updateResult({
							...event.result,
							isError: event.isError,
							durationMs: event.durationMs,
						});
					}
					break;
				}
			}
			this.tui.requestRender();
		});
	}

	attachOverlay(handle: OverlayHandle): void {
		if (this.disposed || this.removeOutsideClick) return;
		this.removeOutsideClick = dismissOnOutsideClick(this.tui, handle, this.done);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "q") || this.keybindings.matches(data, "tui.select.cancel")) {
			this.done();
			return;
		}
		if (matchesKey(data, "t") || this.keybindings.matches(data, "app.tools.expand")) {
			this.expanded = !this.expanded;
			for (const tool of this.tools.values()) tool.component.setExpanded(this.expanded);
			for (const row of this.rows.values()) {
				if (
					row instanceof CustomMessageComponent ||
					row instanceof CompactionSummaryMessageComponent ||
					row instanceof BranchSummaryMessageComponent
				) {
					row.setExpanded(this.expanded);
				}
			}
		} else if (this.keybindings.matches(data, "app.thinking.toggle")) {
			this.hideThinking = !this.hideThinking;
			for (const row of this.rows.values()) {
				if (row instanceof AssistantMessageComponent) row.setHideThinkingBlock(this.hideThinking);
			}
			this.streaming?.setHideThinkingBlock(this.hideThinking);
		} else if (matchesKey(data, "up") || matchesKey(data, "k") || this.keybindings.matches(data, "tui.select.up")) {
			this.scrollBy(-1);
		} else if (
			matchesKey(data, "down") ||
			matchesKey(data, "j") ||
			this.keybindings.matches(data, "tui.select.down")
		) {
			this.scrollBy(1);
		} else if (matchesKey(data, "pageUp") || this.keybindings.matches(data, "tui.altScreen.pageUp")) {
			this.scrollBy(-this.viewportHeight);
		} else if (matchesKey(data, "pageDown") || this.keybindings.matches(data, "tui.altScreen.pageDown")) {
			this.scrollBy(this.viewportHeight);
		} else if (matchesKey(data, "home") || this.keybindings.matches(data, "tui.altScreen.top")) {
			this.scrollOffset = 0;
			this.autoScroll = false;
		} else if (matchesKey(data, "end") || this.keybindings.matches(data, "tui.altScreen.bottom")) {
			this.autoScroll = true;
		} else {
			return;
		}
		this.tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel") {
			this.scrollBy(event.wheelDelta || 0);
			this.tui.requestRender();
			return { handled: true };
		}
		if (event.y < VIEWPORT_TOP || event.y >= VIEWPORT_TOP + this.viewportHeight) return undefined;
		const x = event.x - VIEWPORT_LEFT;
		const y = event.y - VIEWPORT_TOP + this.scrollOffset;
		const result =
			y < this.historyHeight
				? this.history.handleMouse({ ...event, x, y, width: this.contentWidth, height: this.historyHeight })
				: this.streaming?.handleMouse({
						...event,
						x,
						y: y - this.historyHeight,
						width: this.contentWidth,
						height: this.contentHeight - this.historyHeight,
					});
		if (!result) return undefined;
		this.tui.requestRender();
		return { handled: true };
	}

	render(width: number): string[] {
		if (width < 20) return new TruncatedText("Widen terminal. Esc closes.", 0, 0).render(width);
		this.syncHistory();
		const inner = width - 2 * VIEWPORT_LEFT;
		this.contentWidth = inner;
		const height = Math.max(1, this.tui.terminal.rows - 2);
		this.viewportHeight = Math.max(0, height - VIEWPORT_TOP - VIEWPORT_BOTTOM);
		const content = this.history.render(inner);
		this.historyHeight = content.length;
		if (this.streaming) content.push(...this.streaming.render(inner));
		if (content.length === 0) content.push(...new Text("(waiting for transcript...)", 0, 0).render(inner));
		this.contentHeight = content.length;
		const maxScroll = Math.max(0, this.contentHeight - this.viewportHeight);
		this.scrollOffset = this.autoScroll ? maxScroll : Math.min(this.scrollOffset, maxScroll);
		const run = this.worker.stats();
		const stats = [
			shortModelLabel(this.worker.info.modelLabel),
			this.worker.status,
			`⟳${run.turns}`,
			`${run.toolUses} tools`,
			formatTokens(run.tokens),
			formatDuration(run.durationMs),
		].join(" · ");
		const border = (text: string) => this.theme.fg("borderAccent", text);
		const rule = (left: string, right: string) => border(`${left}${"─".repeat(width - 2)}${right}`);
		const row = (line: string) => `${border("│")} ${truncateToWidth(line, inner, "…", true)} ${border("│")}`;
		return [
			rule("╭", "╮"),
			row(this.theme.bold(this.worker.name) + this.theme.fg("muted", ` · ${stats}`)),
			row(this.theme.fg("muted", `Task: ${(this.worker.task || "(idle)").replace(/\s+/g, " ")}`)),
			rule("├", "┤"),
			...Array.from({ length: this.viewportHeight }, (_, i) => row(content[this.scrollOffset + i] || "")),
			rule("├", "┤"),
			row(
				this.theme.fg(
					"dim",
					`Esc close · ↑↓/PgUp/PgDn scroll · t tools · ${this.autoScroll ? "live" : "End follows"}`,
				),
			),
			rule("╰", "╯"),
		].slice(0, height);
	}

	invalidate(): void {
		this.history.invalidate();
		this.streaming?.invalidate();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.removeOutsideClick?.();
		this.unsubscribe();
		this.history.clear();
		this.rows.clear();
		this.tools.clear();
		this.streaming = undefined;
	}

	private scrollBy(delta: number): void {
		const maxScroll = Math.max(0, this.contentHeight - this.viewportHeight);
		this.scrollOffset = Math.max(0, Math.min(maxScroll, this.scrollOffset + delta));
		this.autoScroll = delta > 0 && this.scrollOffset === maxScroll;
	}

	private updateStreaming(message: AssistantMessage): void {
		this.streaming ||= new AssistantMessageComponent(
			undefined,
			this.hideThinking,
			getMarkdownTheme(),
			undefined,
			0,
			this.worker.session.extensionRunner.getMarkdownTransformers(),
		);
		this.streaming.updateContent(message, true);
	}

	private tool(name: string, id: string, args: unknown): ToolView {
		let tool = this.tools.get(id);
		if (!tool) {
			const session = this.worker.session;
			const renderers = session.extensionRunner.resolveToolRenderers(name, () => session.getToolDefinition(name));
			const component = new ToolExecutionComponent(
				name,
				id,
				args,
				{ showImages: false, outputPad: 0 },
				renderers,
				this.tui,
				this.worker.info.cwd,
			);
			component.setArgsComplete();
			component.setExpanded(this.expanded);
			if (session.state.pendingToolCalls.has(id)) component.markExecutionStarted();
			tool = { component };
			this.tools.set(id, tool);
		}
		return tool;
	}

	private syncHistory(): void {
		const session = this.worker.session;
		const leafId = session.sessionManager.getLeafId();
		if (leafId === this.leafId) return;
		this.leafId = leafId;
		this.history.clear();
		for (const entry of session.sessionManager.getBranch()) {
			for (const [index, message] of sessionEntryToContextMessages(entry).entries()) {
				if (message.role === "toolResult") {
					this.showResult(message);
					continue;
				}
				const key = `${entry.id}:${index}`;
				let component = this.rows.get(key);
				if (!component) {
					component = this.messageComponent(message, entry.id, entry.timestamp);
					if (component) this.rows.set(key, component);
				}
				if (component) this.history.addChild(component);
				if (message.role !== "assistant") continue;
				for (const part of message.content) {
					if (part.type !== "toolCall") continue;
					const tool = this.tool(part.name, part.id, part.arguments);
					this.history.addChild(tool.component);
					if (!tool.result && (message.stopReason === "error" || message.stopReason === "aborted")) {
						tool.result = message;
						tool.component.updateResult({
							content: [{ type: "text", text: message.errorMessage || message.stopReason }],
							isError: true,
						});
					}
				}
			}
		}
	}

	private showResult(message: ToolResultMessage): void {
		const tool = this.tool(message.toolName, message.toolCallId, {});
		if (tool.result === message) return;
		tool.result = message;
		tool.component.markExecutionStarted();
		tool.component.updateResult({ ...message, durationMs: tool.durationMs });
	}

	private messageComponent(message: AgentMessage, id: string, timestamp: string): Component | undefined {
		const transformers = this.worker.session.extensionRunner.getMarkdownTransformers();
		switch (message.role) {
			case "assistant":
				return new AssistantMessageComponent(
					message,
					this.hideThinking,
					getMarkdownTheme(),
					undefined,
					0,
					transformers,
					id,
					timestamp,
				);
			case "user":
				return new UserMessageComponent(
					typeof message.content === "string"
						? message.content
						: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
					getMarkdownTheme(),
					0,
					transformers,
					id,
					timestamp,
				);
			case "custom": {
				if (!message.display) return undefined;
				const component = new CustomMessageComponent(
					message,
					this.worker.session.extensionRunner.getMessageRenderer(message.customType),
					getMarkdownTheme(),
					0,
					transformers,
					id,
					timestamp,
				);
				component.setExpanded(this.expanded);
				return component;
			}
			case "compactionSummary": {
				const component = new CompactionSummaryMessageComponent(
					message,
					getMarkdownTheme(),
					0,
					transformers,
					id,
					timestamp,
				);
				component.setExpanded(this.expanded);
				return component;
			}
			case "branchSummary": {
				const component = new BranchSummaryMessageComponent(
					message,
					getMarkdownTheme(),
					0,
					transformers,
					id,
					timestamp,
				);
				component.setExpanded(this.expanded);
				return component;
			}
			default:
				return undefined;
		}
	}
}
