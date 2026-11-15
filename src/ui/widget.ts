import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type TUI, type TuiMouseEvent, type TuiMouseEventResult, truncateToWidth } from "@earendil-works/pi-tui";
import { clip, shortModelLabel } from "../text";
import type { Worker } from "../worker";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_WIDGET_LINES = 12;
const WIDGET_KEY = "subagents";

export class SubagentWidget {
	private ctx: ExtensionContext | undefined;
	private tui: TUI | undefined;
	private registered = false;
	private frame = 0;
	private interval: ReturnType<typeof setInterval> | undefined;
	private rowWorkers: (string | undefined)[] = [];

	constructor(
		private readonly getWorkers: () => Worker[],
		private readonly onSelect: (name: string) => void,
	) {}

	attach(ctx: ExtensionContext): void {
		this.dispose();
		this.ctx = ctx;
		this.refresh();
	}

	refresh(): void {
		const ctx = this.ctx;
		if (ctx?.mode !== "tui") return;
		const workers = this.getWorkers();
		if (workers.some((worker) => worker.status === "running")) {
			this.interval ??= setInterval(() => {
				this.frame++;
				this.tui?.requestRender();
			}, 90);
		} else {
			this.stopTimer();
		}

		if (workers.length === 0) {
			if (this.registered) ctx.ui.setWidget(WIDGET_KEY, undefined);
			this.registered = false;
		} else if (!this.registered) {
			ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
				this.tui = tui;
				return {
					render: (width: number) => this.render(width, theme),
					handleMouse: (event: TuiMouseEvent) => this.handleMouse(event),
					invalidate: () => {},
				};
			});
			this.registered = true;
		} else {
			this.tui?.requestRender();
		}
	}

	dispose(): void {
		this.stopTimer();
		if (this.registered && this.ctx?.mode === "tui") this.ctx.ui.setWidget(WIDGET_KEY, undefined);
		this.registered = false;
		this.tui = undefined;
	}

	private stopTimer(): void {
		clearInterval(this.interval);
		this.interval = undefined;
	}

	private handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;
		const name = this.rowWorkers[event.y];
		if (!name) return undefined;
		if (event.type === "click") this.onSelect(name);
		// Claiming the press is what makes Pi send the matching click.
		return { handled: true };
	}

	private render(width: number, theme: Theme): string[] {
		const workers = this.getWorkers();
		const truncate = (text: string) => truncateToWidth(text, width);
		const running = workers.some((worker) => worker.status === "running");
		const hint = this.tui?.mode === "fullscreen" ? theme.fg("dim", " · click to inspect") : "";
		const rows: { line: string; name: string }[] = [];
		for (const worker of workers) {
			const label = `${theme.bold(worker.name)} ${theme.fg("muted", `· ${shortModelLabel(worker.info.modelLabel)}`)}`;
			if (worker.status === "running") {
				rows.push({
					line: `${theme.fg("dim", "├─")} ${theme.fg("accent", SPINNER[this.frame % SPINNER.length])} ${label}`,
					name: worker.name,
				});
				rows.push({
					line: `${theme.fg("dim", "│  ")} ${theme.fg("dim", "⎿")} ${theme.fg("muted", worker.activity())}`,
					name: worker.name,
				});
			} else {
				const icon =
					worker.status === "done"
						? theme.fg("success", "✓")
						: worker.status === "error"
							? theme.fg("error", "✗")
							: theme.fg("dim", "○");
				const error = worker.status === "error" ? theme.fg("error", ` · ${clip(worker.error, 50)}`) : "";
				rows.push({ line: `${theme.fg("dim", "├─")} ${icon} ${label}${error}`, name: worker.name });
			}
		}
		const shown = rows.length > MAX_WIDGET_LINES - 1 ? rows.slice(0, MAX_WIDGET_LINES - 2) : rows;
		this.rowWorkers = [undefined, ...shown.map((row) => row.name)];
		return [
			truncate(`${theme.fg(running ? "accent" : "dim", "●")} ${theme.fg("accent", theme.bold("Subagents"))}${hint}`),
			...shown.map((row) => truncate(row.line)),
			...(shown.length < rows.length
				? [truncate(theme.fg("dim", `└─ ... +${rows.length - shown.length} more`))]
				: []),
		];
	}
}
