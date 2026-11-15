import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { type TestContext, test } from "node:test";
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Roster } from "../src/roster";
import { subagentTools } from "../src/tools";
import { ControlledSession } from "./helpers/session";

async function setup(t: TestContext) {
	const session = new ControlledSession();
	const pi = {
		getActiveTools: () => ["read", "grep"],
		getThinkingLevel: () => "low",
		sendMessage: () => {},
	} satisfies Partial<ExtensionAPI>;
	const roster = new Roster(pi as unknown as ExtensionAPI, async () => ({
		session: session.asAgentSession(),
		modelLabel: "example/small",
		warnings: ["Untrusted project resources skipped"],
	}));
	t.after(() => roster.dispose());
	const ctx = { cwd: process.cwd(), mode: "print", hasUI: false, isIdle: () => true } as ExtensionContext;
	roster.attach(ctx);
	const worker = await roster.spawn({ name: "scout" }, ctx);
	const tools = subagentTools(roster);
	const inspectTool = tools.find((tool) => tool.name === "inspect_subagent");
	assert.ok(inspectTool);
	const inspect = async (
		options: { tailLines?: number; includeResult?: boolean; runId?: number; resultOffset?: number } = {},
	) => {
		const result = await inspectTool.execute(
			"inspection",
			{ name: "scout", ...options },
			undefined,
			undefined,
			ctx as ExtensionToolContext,
		);
		const content = result.content[0];
		assert.equal(content.type, "text");
		return { text: content.text, details: result.details };
	};
	const finish = async (outcome: string) => {
		worker.start("Map the repository");
		session.assistant(outcome);
		const request = session.requests.at(-1);
		assert.ok(request);
		request.finish();
		await worker.settled();
	};
	return { worker, session, inspect, finish };
}

test("inspection exposes actual capabilities and session location without including output by default", async (t) => {
	const { worker, inspect, finish } = await setup(t);
	await finish("Private result text");
	const { text, details } = await inspect();
	assert.deepEqual(details, {
		name: "scout",
		status: "done",
		runId: worker.runId,
	});
	for (const line of [
		"Name: scout",
		"Status: done",
		"Model: example/small",
		"Thinking: low",
		`Working directory: ${realpathSync(process.cwd())}`,
		"Tools: read",
		"Callable tools: read, tool_search",
		"Missing requested tools: grep",
		"Warning: Untrusted project resources skipped",
		"Session file: /sessions/scout.jsonl",
	])
		assert.ok(text.split("\n").includes(line), `Missing inspection line: ${line}`);
	assert.doesNotMatch(text, /Result characters/);
});

test("result pages preserve Unicode and line breaks and can reconstruct the whole response", async (t) => {
	const { worker, inspect, finish } = await setup(t);
	const prefix = `${"a".repeat(11_998)}\n`;
	const suffix = "🚀\nRemaining findings";
	await finish(prefix + suffix);
	const first = await inspect({ includeResult: true, runId: worker.runId });
	assert.ok(first.text.includes(`Result characters 0 to 11999 of 12020:\n${prefix}`));
	assert.ok(first.text.endsWith(`Continue with includeResult: true, runId: ${worker.runId}, resultOffset: 11999.`));
	const second = await inspect({
		includeResult: true,
		runId: worker.runId,
		resultOffset: 11_999,
	});
	assert.ok(second.text.endsWith(`Result characters 11999 to 12020 of 12020:\n${suffix}`));
	assert.doesNotMatch(second.text, /Continue with/);
});

test("a result exactly one page long does not advertise an empty continuation", async (t) => {
	const { inspect, finish } = await setup(t);
	await finish("x".repeat(12_000));
	const { text } = await inspect({ includeResult: true });
	assert.ok(text.endsWith(`Result characters 0 to 12000 of 12000:\n${"x".repeat(12_000)}`));
	assert.doesNotMatch(text, /Continue with/);
});

test("offsets beyond the result return an empty final page", async (t) => {
	const { inspect, finish } = await setup(t);
	await finish("Short answer");
	const { text } = await inspect({
		includeResult: true,
		resultOffset: 1_000,
	});
	assert.ok(text.endsWith("Result characters 12 to 12 of 12:\n(no result)"));
	assert.doesNotMatch(text, /Continue with/);
});

test("inspection rejects a stale run id instead of returning a follow-up assignment's result", async (t) => {
	const { worker, inspect, finish } = await setup(t);
	await finish("First answer");
	const oldRunId = worker.runId;
	await finish("Second answer");
	await assert.rejects(inspect({ includeResult: true, runId: oldRunId }), Error);
	const { text } = await inspect({
		includeResult: true,
		runId: worker.runId,
	});
	assert.ok(text.endsWith("Second answer"));
});

test("an idle worker can be inspected before any assignment produces a result", async (t) => {
	const { inspect } = await setup(t);
	const { text } = await inspect({ includeResult: true });
	assert.match(text, /Status: idle/);
	assert.match(text, /Run: \(none yet\)/);
	assert.ok(text.endsWith("Result characters 0 to 0 of 0:\n(no result)"));
});

test("transcript tails include user text and tool work but exclude thinking", async (t) => {
	const { session, inspect, finish } = await setup(t);
	session.branch.push({
		type: "message",
		id: "user-1",
		message: {
			role: "user",
			timestamp: Date.now(),
			content: [{ type: "text", text: "Read the README" }],
		},
	});
	session.assistant("", {
		content: [
			{ type: "thinking", thinking: "Hidden reasoning" },
			{
				type: "toolCall",
				id: "read-1",
				name: "read",
				arguments: { path: "README.md" },
			},
		],
	});
	await finish("First line\nFinal line");
	const full = await inspect({ tailLines: 20 });
	assert.match(full.text, /\[user\] Read the README/);
	assert.match(full.text, /\[tool\] read README.md/);
	assert.match(full.text, /\[assistant\] First line\nFinal line/);
	assert.doesNotMatch(full.text, /Hidden reasoning/);
	const tail = await inspect({ tailLines: 2 });
	assert.match(tail.text, /\[assistant\] First line\nFinal line$/);
	assert.doesNotMatch(tail.text, /\[user\]|\[tool\]/);
});
