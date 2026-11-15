import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";
import { ControlledSession } from "./helpers/session.mjs";

const jiti = createJiti(import.meta.url);
const { Worker } = await jiti.import("../src/worker.ts");
const { buildReport } = await jiti.import("../src/report.ts");

function setup(t, session = new ControlledSession()) {
	const reports = [];
	const worker = new Worker(
		"scout",
		session,
		{
			modelLabel: "example/small",
			cwd: "/workspace",
			requestedTools: ["read", "grep"],
			warnings: ["Project resources skipped"],
		},
		(ended) => reports.push(buildReport(ended)),
	);
	t.after(() => worker.close());
	return { worker, session, reports };
}

test("an idle worker makes no model request and has no result or completion report", async (t) => {
	const { worker, session, reports } = setup(t);
	await worker.settled();
	assert.equal(worker.status, "idle");
	assert.equal(worker.runId, 0);
	assert.equal(worker.task, "");
	assert.deepEqual(worker.stats(), {
		turns: 0,
		toolUses: 0,
		tokens: 0,
		durationMs: 0,
		outcome: "",
	});
	assert.deepEqual(session.requests, []);
	assert.deepEqual(reports, []);
});

test("a task stays running until its response finishes, then reports its result once", async (t) => {
	const { worker, session, reports } = setup(t);
	worker.start("Map the repository");
	assert.equal(worker.status, "running");
	assert.equal(worker.task, "Map the repository");
	assert.equal(session.requests[0].text, "Map the repository");
	assert.deepEqual(reports, []);

	session.assistant("The entry point is src/index.ts.");
	session.requests[0].finish();
	await worker.settled();
	assert.equal(worker.status, "done");
	assert.equal(worker.error, "");
	assert.equal(worker.stats().outcome, "The entry point is src/index.ts.");
	assert.equal(reports.length, 1);
	assert.equal(reports[0].outcome, "The entry point is src/index.ts.");
	assert.equal(reports[0].runId, worker.runId);
	assert.equal(reports[0].sessionPath, "/sessions/scout.jsonl");
});

test("follow-up results and usage exclude earlier assignments", async (t) => {
	const { worker, session } = setup(t);
	worker.start("First assignment");
	session.assistant("Earlier result");
	session.requests[0].finish();
	await worker.settled();
	const firstRunId = worker.runId;

	worker.start("Follow-up assignment");
	assert.notEqual(worker.runId, firstRunId);
	assert.equal(worker.stats().outcome, "");
	session.assistant("Inspecting", {
		content: [
			{
				type: "toolCall",
				id: "read-1",
				name: "read",
				arguments: { path: "README.md" },
			},
		],
	});
	session.assistant("Follow-up result");
	session.requests[1].finish();
	await worker.settled();
	const { durationMs, ...stats } = worker.stats();
	assert.deepEqual(stats, {
		turns: 2,
		toolUses: 1,
		tokens: 40,
		outcome: "Follow-up result",
	});
	assert.ok(durationMs >= 0);
});

test("run ids cannot collide across workers, including reused names", async (t) => {
	const first = setup(t);
	const replacement = setup(t);
	first.worker.start("First");
	replacement.worker.start("Replacement");
	assert.ok(first.worker.runId > 0);
	assert.ok(replacement.worker.runId > 0);
	assert.notEqual(first.worker.runId, replacement.worker.runId);
});

test("capabilities distinguish enabled, callable, and unavailable requested tools", (t) => {
	const { worker } = setup(t);
	assert.deepEqual(worker.capabilities(), {
		enabledTools: ["read"],
		callableTools: ["read", "tool_search"],
		missingTools: ["grep"],
		warnings: ["Project resources skipped"],
	});
});

for (const [stopReason, errorMessage] of [
	["error", "Provider unavailable"],
	["aborted", "Request cancelled"],
]) {
	test(`a model ${stopReason} produces a failed completion report`, async (t) => {
		const { worker, session, reports } = setup(t);
		worker.start("Inspect files");
		session.assistant("Partial answer", { stopReason, errorMessage });
		session.requests[0].finish();
		await worker.settled();
		assert.equal(worker.status, "error");
		assert.equal(worker.error, errorMessage);
		assert.equal(reports.length, 1);
		assert.equal(reports[0].status, "error");
		assert.equal(reports[0].error, errorMessage);
		assert.equal(reports[0].outcome, "Partial answer");
	});
}

test("a rejected prompt is reported as an error instead of a successful empty result", async (t) => {
	const session = new ControlledSession();
	session.deferAcceptance = true;
	const { worker, reports } = setup(t, session);
	worker.start("Inspect files");
	session.requests[0].fail(new Error("Authentication failed"));
	await worker.settled();
	assert.equal(worker.status, "error");
	assert.equal(worker.error, "Authentication failed");
	assert.equal(reports.length, 1);
	assert.equal(reports[0].status, "error");
});

test("errors after prompt acceptance still fail the run", async (t) => {
	const { worker, session, reports } = setup(t);
	worker.start("Inspect files");
	session.requests[0].fail(new Error("Connection lost"));
	await worker.settled();
	assert.equal(worker.status, "error");
	assert.equal(reports[0].error, "Connection lost");
});

test("steering that arrives at the end of a turn is processed before reporting", async (t) => {
	const { worker, session, reports } = setup(t);
	worker.start("Inspect files");
	session.deferAcceptance = true;
	const steering = worker.steer("Also inspect tests");
	session.assistant("Initial result");
	session.requests[0].finish();
	await Promise.resolve();
	assert.equal(worker.status, "running");
	assert.deepEqual(reports, []);

	session.onLateTurn = (queued) => {
		assert.deepEqual(queued, ["Also inspect tests"]);
		session.assistant("Result including tests");
	};
	session.requests[1].accept("queued");
	session.requests[1].finish();
	assert.equal(await steering, "steer");
	await worker.settled();
	assert.equal(worker.status, "done");
	assert.equal(reports.length, 1);
	assert.equal(reports[0].outcome, "Result including tests");
});

test("an input handler can consume steering without starting another task", async (t) => {
	const { worker, session, reports } = setup(t);
	worker.start("Inspect files");
	const runId = worker.runId;
	session.deferAcceptance = true;
	const steering = worker.steer("Handled by extension");
	session.requests[1].accept("handled");
	session.requests[1].finish();
	assert.equal(await steering, "handled");
	assert.equal(worker.runId, runId);
	assert.deepEqual(reports, []);
	session.assistant("Finished original assignment");
	session.requests[0].finish();
	await worker.settled();
	assert.equal(reports.length, 1);
	assert.equal(reports[0].outcome, "Finished original assignment");
});

test("a deadline fails the task, drops unread steering, and permits a follow-up", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
	const { worker, session, reports } = setup(t);
	worker.start("Slow task", 500);
	const steering = worker.steer("Unread instruction");
	assert.equal(await steering, "steer");
	assert.deepEqual(session.queuedMessages, ["Unread instruction"]);
	t.mock.timers.tick(499);
	assert.equal(worker.status, "running");
	t.mock.timers.tick(1);
	await worker.settled();
	assert.equal(worker.status, "error");
	assert.match(worker.error, /Timed out/);
	assert.deepEqual(session.queuedMessages, []);
	assert.equal(reports.length, 1);
	assert.equal(reports[0].status, "error");
	assert.equal(reports[0].duration, "0.5s");

	worker.start("Continue after timeout");
	session.assistant("Recovered result");
	session.requests.at(-1).finish();
	await worker.settled();
	assert.equal(worker.status, "done");
	assert.equal(worker.error, "");
	assert.equal(reports.length, 2);
	assert.equal(reports[1].outcome, "Recovered result");
});

test("stopping suppresses completion reports and waits for credential writes before resolving", async (t) => {
	const { worker, session, reports } = setup(t);
	const writes = Promise.withResolvers();
	session.credentialWrites = writes.promise;
	worker.start("Long-running assignment");
	const closing = worker.close();
	let closed = false;
	closing.then(() => {
		closed = true;
	});
	try {
		await worker.settled();
		assert.equal(worker.status, "stopped");
		assert.deepEqual(reports, []);
		assert.equal(closed, false);
		assert.throws(() => worker.start("Not allowed"), Error);
	} finally {
		writes.resolve();
		await closing;
	}
	assert.equal(session.disposed, true);
	assert.deepEqual(session.shutdownEvents, [{ type: "session_shutdown", reason: "quit" }]);
	await worker.close();
	assert.equal(session.shutdownEvents.length, 1);
});

test("activity exposes pending tool work and then the final response", async (t) => {
	const { worker, session } = setup(t);
	worker.start("Read the README");
	session.assistant("", {
		content: [
			{
				type: "toolCall",
				id: "read-1",
				name: "read",
				arguments: { path: "README.md" },
			},
		],
	});
	session.state.pendingToolCalls.add("read-1");
	assert.equal(worker.activity(), "read README.md");
	session.state.pendingToolCalls.clear();
	session.state.streamingMessage = {
		role: "assistant",
		content: [{ type: "text", text: "Progress\nReading documentation" }],
	};
	assert.equal(worker.activity(), "Reading documentation");
	session.assistant("Summary\nThe README documents setup.");
	session.requests[0].finish();
	await worker.settled();
	assert.equal(worker.activity(), "The README documents setup.");
});

test("the outcome is the last text the worker wrote, even when its final message only calls tools", async (t) => {
	const { worker, session, reports } = setup(t);
	worker.start("Summarize, then clean up");
	session.assistant("Summary of findings");
	session.assistant("", {
		content: [{ type: "toolCall", id: "bash-1", name: "bash", arguments: { command: "rm -rf tmp" } }],
	});
	session.requests[0].finish();
	await worker.settled();
	assert.equal(reports[0].outcome, "Summary of findings");
});

test("steering requires a running task", async (t) => {
	const { worker, session } = setup(t);
	await assert.rejects(worker.steer("Too early"));
	worker.start("Inspect files");
	session.requests[0].finish();
	await worker.settled();
	await assert.rejects(worker.steer("Too late"));
	assert.equal(session.requests.length, 1);
});

test("after a failed run the activity line shows the error", async (t) => {
	const { worker, session } = setup(t);
	worker.start("Inspect files");
	session.requests[0].fail(new Error("Connection lost"));
	await worker.settled();
	assert.equal(worker.activity(), "Connection lost");
});
