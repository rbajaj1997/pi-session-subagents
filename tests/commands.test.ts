import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import register from "../src/index";
import { TestEvents } from "./helpers/events";

function setup() {
	const commands = new Map<string, Pick<RegisteredCommand, "handler">>();
	const events = new TestEvents();
	const requests: string[] = [];
	const notifications: { text: string; level?: string }[] = [];
	let activeTools = ["read", "bash"];
	const pi = {
		getActiveTools: () => activeTools,
		setActiveTools: (names) => {
			activeTools = names;
		},
		registerTool: () => {},
		registerMessageRenderer: () => {},
		registerCommand: (name, command) => {
			commands.set(name, command);
		},
		on: events.on,
		sendUserMessage: (text) => {
			assert.ok(typeof text === "string");
			requests.push(text);
		},
	} satisfies Partial<ExtensionAPI>;
	register(pi as unknown as ExtensionAPI);
	const ctx = {
		hasUI: false,
		waitForIdle: async () => {},
		ui: {
			notify: (text: string, level?: string) => {
				notifications.push({ text, level });
			},
		},
	};
	return {
		events,
		ctx,
		requests,
		notifications,
		active: () => activeTools,
		command: (args: string) => {
			const command = commands.get("subagents");
			assert.ok(command);
			return command.handler(args, ctx as ExtensionCommandContext);
		},
	};
}

test("turning subagents on enables all six tools without sending a model request", async () => {
	const app = setup();
	await app.command("on");
	assert.deepEqual(
		app.active().toSorted(),
		[
			"read",
			"bash",
			"spawn_subagent",
			"list_subagents",
			"inspect_subagent",
			"message_subagent",
			"await_subagents",
			"stop_subagent",
		].toSorted(),
	);
	assert.deepEqual(app.requests, []);
	await app.command("ON");
	assert.equal(app.active().length, 8);
});

test("a request enables subagent tools and forwards the trimmed user instruction", async () => {
	const app = setup();
	await app.command("  Create a scout using Haiku  ");
	assert.ok(app.active().includes("spawn_subagent"));
	assert.deepEqual(app.requests, ["Create a scout using Haiku"]);
});

test("blank commands do not enable tools or send an empty model request", async () => {
	const app = setup();
	app.ctx.hasUI = true;
	await app.command("   ");
	assert.deepEqual(app.active(), ["read", "bash"]);
	assert.deepEqual(app.requests, []);
	assert.equal(app.notifications.length, 1);
	assert.match(app.notifications[0].text, /Usage:/);
});

test("enabling waits for the parent's current turn before forwarding a new request", async () => {
	const app = setup();
	const idle = Promise.withResolvers<void>();
	app.ctx.waitForIdle = () => idle.promise;
	const pending = app.command("Create a scout");
	assert.deepEqual(app.active(), ["read", "bash"]);
	assert.deepEqual(app.requests, []);
	idle.resolve();
	await pending;
	assert.ok(app.active().includes("spawn_subagent"));
	assert.deepEqual(app.requests, ["Create a scout"]);
});

test("turning subagents off preserves unrelated tools and waits for the parent to be idle", async () => {
	const app = setup();
	await app.command("on");
	const idle = Promise.withResolvers<void>();
	const waiting = Promise.withResolvers<void>();
	app.ctx.waitForIdle = () => {
		waiting.resolve();
		return idle.promise;
	};
	const pending = app.command("OFF");
	await waiting.promise;
	assert.ok(app.active().includes("spawn_subagent"));
	idle.resolve();
	await pending;
	assert.deepEqual(app.active(), ["read", "bash"]);
	assert.deepEqual(app.requests, []);
});

test("a new parent session turns worker tools off even if they were previously enabled", async () => {
	const app = setup();
	await app.command("on");
	assert.ok(app.active().includes("spawn_subagent"));
	await app.events.emit({ type: "session_start", reason: "startup" }, app.ctx as ExtensionCommandContext);
	assert.deepEqual(app.active(), ["read", "bash"]);
});
