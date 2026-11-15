import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";
import { ControlledSession } from "./helpers/session.mjs";

const jiti = createJiti(import.meta.url);
const { Worker } = await jiti.import("../src/worker.ts");
const { SubagentWidget } = await jiti.import("../src/ui/widget.ts");
const { openInspector } = await jiti.import("../src/ui/conversation-viewer.ts");

const theme = { fg: (_color, text) => text, bold: (text) => text };

function worker(t, name, task) {
	const created = new Worker(
		name,
		new ControlledSession(),
		{ modelLabel: "example/small", cwd: "/workspace", requestedTools: [], warnings: [] },
		() => {},
	);
	if (task) created.start(task);
	t.after(() => created.close());
	return created;
}

function mountWidget(t, workers, { mode = "tui", tuiMode = "fullscreen" } = {}) {
	const selected = [];
	const registrations = [];
	let component;
	const ctx = {
		mode,
		ui: {
			setWidget: (_key, factory) => {
				registrations.push(factory);
				component = factory?.({ mode: tuiMode, requestRender: () => {} }, theme);
			},
		},
	};
	const widget = new SubagentWidget(
		() => workers,
		(name) => selected.push(name),
	);
	widget.attach(ctx);
	t.after(() => widget.dispose());
	const click = (y) => {
		component.handleMouse({ button: "left", type: "press", y });
		component.handleMouse({ button: "left", type: "click", y });
	};
	return { widget, selected, registrations, click, lines: () => component.render(80) };
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
	assert.match(lines.at(-1), /\+2 more/);
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

function inspectorContext({ mode = "tui", choice } = {}) {
	const notices = [];
	const overlays = [];
	const ctx = {
		mode,
		hasUI: true,
		ui: {
			notify: (text, level) => notices.push({ text, level }),
			select: async (_title, options) => options.find((option) => option.startsWith(choice ?? "\0")),
			custom: async (factory, options) => {
				let closed = false;
				const tui = { terminal: { rows: 24 }, requestRender: () => {} };
				const viewer = factory(tui, theme, { matches: () => false }, () => {
					closed = true;
				});
				overlays.push({
					options,
					frame: viewer.render(80),
					close: () => viewer.handleInput("\x1b"),
					closed: () => closed,
				});
			},
		},
	};
	return { ctx, notices, overlays };
}

test("the inspector opens a framed overlay for the named worker and closes on Escape", async (t) => {
	const { ctx, overlays } = inspectorContext();
	await openInspector(ctx, [worker(t, "scout", "Map the repository"), worker(t, "reviewer")], "scout");
	assert.equal(overlays.length, 1);
	assert.equal(overlays[0].options.overlay, true);
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
