import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type { ExtensionContext, ExtensionUIContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type OverlayHandle,
	type Terminal,
	type TUI,
	TuiAltScreen,
	TuiMainScreen,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
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
				const tui = { mode: "regular", terminal: { rows: 24 }, requestRender: () => {} };
				const viewer = await factory(
					tui as TUI,
					theme,
					{ matches: () => false } as unknown as KeybindingsManager,
					() => {
						closed = true;
					},
				);
				options?.onHandle?.({} as OverlayHandle);
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

function fullscreenInspector(
	t: TestContext,
	{ boundsAvailable = true, routingAvailable = true, regularMode = false } = {},
) {
	let input = (_data: string) => {};
	const noop = () => {};
	const terminal: Terminal & { rows: number; columns: number } = {
		rows: 24,
		columns: 100,
		kittyProtocolActive: false,
		start: (onInput) => {
			input = onInput;
		},
		stop: noop,
		drainInput: async () => {},
		write: noop,
		moveBy: noop,
		hideCursor: noop,
		showCursor: noop,
		clearLine: noop,
		clearFromCursor: noop,
		clearScreen: noop,
		setTitle: noop,
		setProgress: noop,
		setProgramStatus: noop,
	};
	const tui = regularMode ? new TuiMainScreen(terminal, false) : new TuiAltScreen(terminal, false);
	let routingHooks = 0;
	// Match Pi's proxy behavior for one renderer: function identity and descriptors are not preserved.
	// Renderer replacement is omitted because Pi blocks switching while overlays are open.
	const reference = new Proxy({} as TUI, {
		get: (_target, property) => {
			if (!routingAvailable && property === "dispatchMouseToOverlay") return undefined;
			const value = Reflect.get(tui, property, tui);
			return typeof value === "function" ? (...args: unknown[]) => Reflect.apply(value, tui, args) : value;
		},
		set: (_target, property, value) => {
			if (property === "dispatchMouseToOverlay") routingHooks++;
			return Reflect.set(tui, property, value, tui);
		},
	});
	let backgroundClicks = 0;
	const background: Component = {
		render: (width) => Array.from({ length: terminal.rows }, () => "background".padEnd(width)),
		invalidate: noop,
		handleMouse: (event) => {
			if (event.type === "click") backgroundClicks++;
			return { handled: true };
		},
	};
	if (tui instanceof TuiAltScreen) tui.setLayoutRoot(background);
	else tui.addChild(background);
	tui.start();
	const workers = [worker(t, "scout", "Map the repository"), worker(t, "reviewer")];
	type Mounted = { handle: OverlayHandle; closed: boolean; dispose(): void };
	const mounted: Mounted[] = [];
	let ready = Promise.withResolvers<Mounted>();
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			custom: async (
				factory: Parameters<ExtensionUIContext["custom"]>[0],
				options: Parameters<ExtensionUIContext["custom"]>[1],
			) => {
				const completion = Promise.withResolvers<void>();
				const viewer = await factory(
					reference,
					theme,
					{ matches: () => false } as unknown as KeybindingsManager,
					() => {
						entry.dispose();
						completion.resolve();
					},
				);
				const overlayOptions =
					typeof options?.overlayOptions === "function" ? options.overlayOptions() : options?.overlayOptions;
				const handle = tui.showOverlay(viewer, overlayOptions);
				const entry: Mounted = {
					handle,
					closed: false,
					dispose: () => {
						if (entry.closed) return;
						entry.closed = true;
						handle.hide();
						viewer.dispose?.();
					},
				};
				mounted.push(entry);
				options?.onHandle?.(
					boundsAvailable ? handle : ({ ...handle, getBounds: undefined } as unknown as OverlayHandle),
				);
				tui.renderNow();
				ready.resolve(entry);
				return completion.promise;
			},
		},
	} as unknown as ExtensionContext;
	t.after(() => {
		for (const entry of mounted) entry.dispose();
		tui.stop();
	});
	const mouse = (button: number, x: number, y: number, release = false) =>
		input(`\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`);
	return {
		tui,
		terminal,
		workers,
		input,
		mouse,
		backgroundClicks: () => backgroundClicks,
		routingHooks: () => routingHooks,
		open: async (name = "scout") => {
			ready = Promise.withResolvers<Mounted>();
			const finished = openInspector(ctx, workers, name);
			const entry = await ready.promise;
			return { ...entry, isClosed: () => entry.closed, finished };
		},
		click: (x: number, y: number) => {
			mouse(0, x, y);
			mouse(0, x, y, true);
		},
	};
}

test("an outside click dismisses the inspector, not the worker, and does not activate the main session", async (t) => {
	const view = fullscreenInspector(t);
	const inspector = await view.open();
	view.mouse(0, 0, 10);
	assert.equal(inspector.isClosed(), false);
	view.mouse(0, 0, 10, true);
	await inspector.finished;
	assert.equal(inspector.isClosed(), true);
	assert.equal(view.workers[0].status, "running");
	assert.equal(view.backgroundClicks(), 0);
	view.tui.renderNow();
	view.click(0, 10);
	assert.equal(view.backgroundClicks(), 1);
});

test("the entire framed inspector stays open on inside clicks", async (t) => {
	const view = fullscreenInspector(t);
	const inspector = await view.open();
	const bounds = inspector.handle.getBounds();
	assert.ok(bounds);
	for (const [x, y] of [
		[bounds.col, bounds.row],
		[bounds.col + 2, bounds.row + 1],
		[bounds.col + 2, bounds.row + 2],
		[bounds.col + 2, bounds.row + 5],
		[bounds.col + 2, bounds.row + bounds.height - 2],
		[bounds.col + bounds.width - 1, bounds.row + bounds.height - 1],
	]) {
		view.click(x, y);
		assert.equal(inspector.isClosed(), false);
	}
	view.mouse(0, bounds.col + 3, bounds.row + 5);
	view.mouse(32, bounds.col + 6, bounds.row + 5);
	view.mouse(0, bounds.col + 6, bounds.row + 5, true);
	assert.equal(inspector.isClosed(), false);
	assert.equal(view.backgroundClicks(), 0);
});

test("wheel input and inside-to-outside drags do not dismiss the inspector", async (t) => {
	const view = fullscreenInspector(t);
	const inspector = await view.open();
	view.mouse(65, 0, 10);
	const bounds = inspector.handle.getBounds();
	assert.ok(bounds);
	view.mouse(0, bounds.col + 3, bounds.row + 5);
	view.mouse(32, 0, 10);
	view.mouse(0, 0, 10, true);
	assert.equal(inspector.isClosed(), false);
	assert.equal(view.backgroundClicks(), 0);
});

test("right and middle clicks outside do not dismiss the inspector", async (t) => {
	const view = fullscreenInspector(t);
	const inspector = await view.open();
	for (const button of [1, 2]) {
		view.mouse(button, 0, 10);
		view.mouse(button, 0, 10, true);
		assert.equal(inspector.isClosed(), false);
	}
});

test("modifier-left-clicks outside dismiss without activating the main session", async (t) => {
	const view = fullscreenInspector(t);
	for (const modifier of [4, 8, 16]) {
		const inspector = await view.open();
		view.mouse(modifier, 0, 10);
		view.mouse(modifier, 0, 10, true);
		await inspector.finished;
		assert.equal(inspector.isClosed(), true);
		assert.equal(view.backgroundClicks(), 0);
	}
});

test("outside-click boundaries follow the rendered panel after resizing", async (t) => {
	const view = fullscreenInspector(t);
	const inspector = await view.open();
	view.click(6, 10);
	assert.equal(inspector.isClosed(), false);
	view.terminal.columns = 200;
	view.tui.renderNow();
	view.click(6, 10);
	await inspector.finished;
	assert.equal(inspector.isClosed(), true);
});

test("another focused overlay receives its clicks without dismissing the inspector", async (t) => {
	const view = fullscreenInspector(t);
	const inspector = await view.open();
	let clicks = 0;
	const other = view.tui.showOverlay(
		{
			render: () => ["Another overlay"],
			invalidate: () => {},
			handleMouse: (event) => {
				if (event.type === "click") clicks++;
				return { handled: true };
			},
		},
		{ row: 0, col: 0, width: 20 },
	);
	view.tui.renderNow();
	view.click(0, 0);
	assert.equal(clicks, 1);
	assert.equal(inspector.isClosed(), false);
	other.hide();
	view.tui.renderNow();
	view.click(0, 10);
	await inspector.finished;
});

test("an outside click on a non-capturing overlay dismisses only the inspector", async (t) => {
	const view = fullscreenInspector(t);
	const inspector = await view.open();
	let clicks = 0;
	const other = view.tui.showOverlay(
		{
			render: () => ["Passive overlay"],
			invalidate: () => {},
			handleMouse: (event) => {
				if (event.type === "click") clicks++;
				return { handled: true };
			},
		},
		{ row: 0, col: 0, width: 20, nonCapturing: true },
	);
	view.tui.renderNow();
	view.click(0, 0);
	await inspector.finished;
	assert.equal(clicks, 0);
	assert.equal(view.backgroundClicks(), 0);
	other.hide();
});

test("Escape cleanup and reopening preserve outside-click dismissal", async (t) => {
	const view = fullscreenInspector(t);
	for (const key of ["\x1b", "q"]) {
		const inspector = await view.open();
		view.input(key);
		await inspector.finished;
		view.tui.renderNow();
		view.click(0, 10);
	}
	assert.equal(view.backgroundClicks(), 2);
	const reopened = await view.open();
	view.click(0, 10);
	await reopened.finished;
	assert.equal(view.backgroundClicks(), 2);
	assert.equal(view.routingHooks(), 1);
});

test("inspectors can be disposed out of order without leaving mouse interception behind", async (t) => {
	const view = fullscreenInspector(t);
	const first = await view.open();
	const second = await view.open("reviewer");
	first.dispose();
	view.tui.renderNow();
	view.click(0, 10);
	await second.finished;
	assert.equal(view.backgroundClicks(), 0);
	view.tui.renderNow();
	view.click(0, 10);
	assert.equal(view.backgroundClicks(), 1);
});

test("outside drags, including a return to the press point, do not dismiss or activate the main session", async (t) => {
	const view = fullscreenInspector(t);
	const inspector = await view.open();
	for (const returnToStart of [false, true]) {
		view.mouse(0, 0, 10);
		view.mouse(32, 1, 10);
		if (returnToStart) view.mouse(32, 0, 10);
		view.mouse(0, returnToStart ? 0 : 1, 10, true);
		assert.equal(inspector.isClosed(), false);
		assert.equal(view.backgroundClicks(), 0);
	}
});

for (const missing of ["bounds", "routing"] as const) {
	test(`missing overlay ${missing} leaves mouse routing unchanged and keyboard dismissal available`, async (t) => {
		const view = fullscreenInspector(t, {
			boundsAvailable: missing !== "bounds",
			routingAvailable: missing !== "routing",
		});
		const inspector = await view.open();
		view.click(0, 10);
		assert.equal(inspector.isClosed(), false);
		assert.equal(view.backgroundClicks(), 1);
		assert.equal(view.routingHooks(), 0);
		view.input("\x1b");
		await inspector.finished;
		assert.equal(inspector.isClosed(), true);
	});
}

test("regular mode keeps keyboard dismissal without installing mouse interception", async (t) => {
	const view = fullscreenInspector(t, { regularMode: true });
	const inspector = await view.open();
	assert.equal(view.routingHooks(), 0);
	view.input("q");
	await inspector.finished;
	assert.equal(inspector.isClosed(), true);
});
