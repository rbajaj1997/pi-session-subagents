import type { Component, OverlayHandle, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";

type Dismissal = { handle: OverlayHandle; close: () => void };
// Pi's TUI proxy forwards symbol values unchanged, but wraps functions on every read.
const ROUTING = Symbol.for("pi-session-subagents.outside-click");
type OverlayDispatch = {
	hit: boolean;
	result?: TuiMouseEventResult & {
		target: { component: Component; originX: number; originY: number; width: number; height: number };
	};
};
type Registration = {
	dismissals: Set<Dismissal>;
	intercept?: (event: TuiMouseEvent) => OverlayDispatch | undefined;
};
type MouseRouter = {
	[ROUTING]?: Registration;
	dispatchMouseToOverlay?: (event: TuiMouseEvent) => OverlayDispatch;
};

/** Pi 1.5.2 consumes fullscreen mouse input before extension input listeners run. */
export function dismissOnOutsideClick(tui: TUI, handle: OverlayHandle, close: () => void): () => void {
	const router = tui as unknown as MouseRouter;
	if (
		tui.mode !== "fullscreen" ||
		typeof router.dispatchMouseToOverlay !== "function" ||
		typeof handle.getBounds !== "function" ||
		typeof handle.isFocused !== "function"
	) {
		return () => {};
	}

	let registration = router[ROUTING];
	if (!registration) {
		const original = router.dispatchMouseToOverlay;
		const state: Registration = { dismissals: new Set() };
		router[ROUTING] = state;
		// Install once per renderer; refresh the interception logic when reopening after /reload.
		router.dispatchMouseToOverlay = (event) => state.intercept?.(event) ?? original.call(tui, event);
		registration = state;
	}
	const active = registration.dismissals;
	registration.intercept = (event) => {
		if (event.type === "press" && event.button === "left") {
			for (const dismissal of active) {
				const bounds = dismissal.handle.getBounds();
				if (!dismissal.handle.isFocused() || !bounds) continue;
				const inside =
					event.screenX >= bounds.col &&
					event.screenX < bounds.col + bounds.width &&
					event.screenY >= bounds.row &&
					event.screenY < bounds.row + bounds.height;
				if (inside) break;
				// Claim the entire gesture. Pi emits click only after a release without a drag.
				const target: Component = {
					render: () => [],
					invalidate: () => {},
					handleMouse: (next) => {
						if (next.type === "click" && active.has(dismissal) && dismissal.handle.isFocused()) {
							dismissal.close();
						}
						return { handled: true };
					},
				};
				return {
					hit: true,
					result: {
						handled: true,
						target: {
							component: target,
							originX: event.screenX - event.x,
							originY: event.screenY - event.y,
							width: event.width,
							height: event.height,
						},
					},
				};
			}
		}
		return undefined;
	};
	const dismissal = { handle, close };
	active.add(dismissal);
	return () => {
		active.delete(dismissal);
		if (active.size === 0) registration.intercept = undefined;
	};
}
