import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext, ExtensionEvent, ExtensionHandler } from "@earendil-works/pi-coding-agent";

export class TestEvents {
	private handlers = new Map<string, unknown>();

	on: ExtensionAPI["on"] = (event, handler) => {
		this.handlers.set(event, handler);
		return () => {
			this.handlers.delete(event);
		};
	};

	emit<E extends ExtensionEvent>(event: E, ctx: ExtensionContext) {
		const handler = this.handlers.get(event.type) as ExtensionHandler<E, unknown> | undefined;
		assert.ok(handler, `No handler registered for ${event.type}`);
		return handler(event, ctx);
	}
}
