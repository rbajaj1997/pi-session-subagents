import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type { ExtensionContext, ExtensionUIContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { openInspector } from "../src/ui/conversation-viewer";
import { SubagentWidget } from "../src/ui/widget";
import { Worker } from "../src/worker";
import { ControlledSession } from "./helpers/session";

const theme = { fg: (_color: unknown, text: string) => text, bold: (text: string) => text } as Theme;
type WidgetComponent = Component & { handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined };
type WidgetFactory = (tui: TUI, theme: Theme) => WidgetComponent;

function worker(t: TestContext, name: string, task?: string) {
	const created = new Worker(
		name,
		new ControlledSession().asAgentSession(),
		{ modelLabel: "example/small", cwd: "/workspace", requestedTools: [], warnings: [] },
		() => {},
	);
	if (task) created.start(task);
	t.after(() => created.close());
	return created;
}

function mountWidget(t: TestContext, workers: Worker[], { mode = "tui", tuiMode = "fullscreen" } = {}) {
	const selected: string[] = [];
	const registrations: (WidgetFactory | undefined)[] = [];
	let component: WidgetComponent | undefined;
	const current = () => {
		assert.ok(component);
		return component;
	};
	const ctx = {
		mode,
		ui: {
			setWidget: (_key: string, factory?: WidgetFactory) => {
				registrations.push(factory);
				component = factory?.({ mode: tuiMode, requestRender: () => {} } as TUI, theme);
			},
		},
	};
	const widget = new SubagentWidget(
		() => workers,
		(name) => selected.push(name),
	);
	widget.attach(ctx as unknown as ExtensionContext);
	t.after(() => widget.dispose());
	const click = (y: number) => {
		const position = {
			x: 0,
			y,
			screenX: 0,
			screenY: y,
			width: 80,
			height: 24,
			shift: false,
			alt: false,
			ctrl: false,
		};
		current().handleMouse({ button: "left", type: "press", ...position });
		current().handleMouse({ button: "left", type: "click", ...position });
	};
	return { widget, selected, registrations, click, lines: () => current().render(80) };
}

test("clicking a worker's row in the widget selects that worker, and the header selects nothing", (t) => {
	const view = mountWidget(t, [worker(t, "scout", "Map the repository"), worker(t, "reviewer")]);
	const lines = view.lines();
	assert.match(lines[1], /scout/);
	assert.match(lines[3], /reviewer/);
	view.click(0);
	assert.deepEqual(view.selected, []);
	view.click(2);
	assert.deepEqual(view.selected, ["scout"]);
	view.click(3);
	assert.deepEqual(view.selected, ["scout", "reviewer"]);
});

test("the click hint appears only in fullscreen mode, where clicks reach the widget", (t) => {
	const workers = [worker(t, "scout")];
	assert.match(mountWidget(t, workers).lines()[0], /click to inspect/);
	assert.doesNotMatch(mountWidget(t, workers, { tuiMode: "regular" }).lines()[0], /click to inspect/);
});

test("a long list ends with a count of hidden workers that selects nothing", (t) => {
	const workers = Array.from({ length: 12 }, (_, index) => worker(t, `worker-${index + 1}`));
	const view = mountWidget(t, workers);
	const lines = view.lines();
	assert.equal(lines.length, 12);
	assert.match(lines[lines.length - 1], /\+2 more/);
	view.click(lines.length - 1);
	assert.deepEqual(view.selected, []);
});

test("the widget is removed when the last worker goes, and never shown outside the TUI", (t) => {
	const workers = [worker(t, "scout")];
	const view = mountWidget(t, workers);
	workers.length = 0;
	view.widget.refresh();
	assert.equal(view.registrations.at(-1), undefined);
	assert.deepEqual(mountWidget(t, [worker(t, "other")], { mode: "rpc" }).registrations, []);
});

function inspectorContext({ mode = "tui", choice }: { mode?: ExtensionContext["mode"]; choice?: string } = {}) {
	const notices: { text: string; level?: string }[] = [];
	const overlays: {
		options: Parameters<ExtensionUIContext["custom"]>[1];
		frame: string[];
		close(): void;
		closed(): boolean;
	}[] = [];
	const ctx = {
		mode,
		hasUI: true,
		ui: {
			notify: (text: string, level?: string) => {
				notices.push({ text, level });
			},
			select: async (_title: string, options: string[]) =>
				options.find((option) => option.startsWith(choice ?? "\0")),
			custom: async (
				factory: Parameters<ExtensionUIContext["custom"]>[0],
				options: Parameters<ExtensionUIContext["custom"]>[1],
			) => {
				let closed = false;
				const tui = { terminal: { rows: 24 }, requestRender: () => {} };
				const viewer = await factory(
					tui as TUI,
					theme,
					{ matches: () => false } as unknown as KeybindingsManager,
					() => {
						closed = true;
					},
				);
				overlays.push({
					options,
					frame: viewer.render(80),
					close: () => {
						assert.ok(viewer.handleInput);
						viewer.handleInput("\x1b");
					},
					closed: () => closed,
				});
			},
		},
	};
	return { ctx: ctx as unknown as ExtensionContext, notices, overlays };
}

test("the inspector opens a framed overlay for the named worker and closes on Escape", async (t) => {
	const { ctx, overlays } = inspectorContext();
	await openInspector(ctx, [worker(t, "scout", "Map the repository"), worker(t, "reviewer")], "scout");
	assert.equal(overlays.length, 1);
	assert.equal(overlays[0].options?.overlay, true);
	assert.match(overlays[0].frame[0], /^╭─+╮$/);
	assert.match(overlays[0].frame[1], /scout/);
	assert.match(overlays[0].frame[2], /Map the repository/);
	overlays[0].close();
	assert.equal(overlays[0].closed(), true);
});

test("without a name the inspector asks which worker to open", async (t) => {
	const workers = [worker(t, "scout"), worker(t, "reviewer")];
	const chosen = inspectorContext({ choice: "reviewer" });
	await openInspector(chosen.ctx, workers);
	assert.match(chosen.overlays[0].frame[1], /reviewer/);
	const cancelled = inspectorContext();
	await openInspector(cancelled.ctx, workers);
	assert.deepEqual(cancelled.overlays, []);
});

test("the inspector explains instead of opening when it cannot show a worker", async (t) => {
	const outsideTui = inspectorContext({ mode: "rpc" });
	await openInspector(outsideTui.ctx, [worker(t, "scout")], "scout");
	const unknown = inspectorContext();
	await openInspector(unknown.ctx, [worker(t, "scout")], "missing");
	const empty = inspectorContext();
	await openInspector(empty.ctx, []);
	for (const { overlays, notices } of [outsideTui, unknown, empty]) {
		assert.deepEqual(overlays, []);
		assert.equal(notices.length, 1);
	}
	assert.equal(outsideTui.notices[0].level, "warning");
	assert.equal(unknown.notices[0].level, "error");
});
