import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { test } from "node:test";
import { createJiti } from "jiti";
import { ControlledSession } from "./helpers/session.mjs";

const { Roster } = await createJiti(import.meta.url).import("../src/roster.ts");

const SUBAGENT_TOOLS = [
	"spawn_subagent",
	"list_subagents",
	"inspect_subagent",
	"message_subagent",
	"await_subagents",
	"stop_subagent",
];

function setup(t, { parentTools = ["read", "bash", ...SUBAGENT_TOOLS], idle = true } = {}) {
	const created = [];
	const sent = [];
	const pi = {
		getActiveTools: () => parentTools,
		getThinkingLevel: () => "medium",
		sendMessage: (message, options) => sent.push({ message, options }),
	};
	const createSession = async (_ctx, options) => {
		const session = new ControlledSession();
		created.push({ options, session });
		return { session, modelLabel: "example/small", warnings: [] };
	};
	const roster = new Roster(pi, createSession);
	const ctx = { cwd: process.cwd(), mode: "print", hasUI: false, isIdle: () => idle };
	roster.attach(ctx);
	t.after(() => roster.dispose());
	const spawn = (options = {}, signal) => roster.spawn(options, ctx, signal);
	return { roster, created, sent, spawn };
}

test("a worker gets the parent's active tools except the subagent tools", async (t) => {
	const { created, spawn } = setup(t);
	await spawn();
	assert.deepEqual(created[0].options.tools, ["read", "bash"]);
	assert.equal(created[0].options.thinking, "medium");
	assert.equal(created[0].options.cwd, realpathSync(process.cwd()));
});

test("a worker can be limited to a subset of the parent's tools", async (t) => {
	const { created, spawn } = setup(t);
	await spawn({ tools: ["read", "read"], thinking: "low" });
	assert.deepEqual(created[0].options.tools, ["read"]);
	assert.equal(created[0].options.thinking, "low");
});

test("a worker cannot get tools the parent does not have active, including subagent tools", async (t) => {
	const { roster, created, spawn } = setup(t);
	await assert.rejects(spawn({ tools: ["write"] }), /write/);
	await assert.rejects(spawn({ tools: ["spawn_subagent"] }), /spawn_subagent/);
	assert.equal(created.length, 0);
	assert.deepEqual(roster.list(), []);
});

test("names are slugged and made unique, and lookups ignore case and punctuation", async (t) => {
	const { roster, spawn } = setup(t);
	const first = await spawn();
	const second = await spawn();
	const named = await spawn({ name: "QA Team" });
	assert.equal(first.name, "worker");
	assert.equal(second.name, "worker-2");
	assert.equal(named.name, "qa-team");
	assert.equal(roster.find("QA_TEAM"), named);
	assert.throws(() => roster.find("missing"), /Unknown subagent/);
});

test("a spawn with a task starts it, and one without stays idle", async (t) => {
	const { created, spawn } = setup(t);
	const busy = await spawn({ task: "  Map the repository  " });
	const idle = await spawn();
	assert.equal(busy.status, "running");
	assert.deepEqual(
		created[0].session.requests.map((request) => request.text),
		["Map the repository"],
	);
	assert.equal(idle.status, "idle");
	assert.deepEqual(created[1].session.requests, []);
});

test("a spawn cancelled while the session is created leaves no worker behind", async (t) => {
	const { roster, created, spawn } = setup(t);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(spawn({ task: "Never runs" }, controller.signal));
	assert.deepEqual(roster.list(), []);
	assert.equal(created[0].session.disposed, true);
	assert.deepEqual(created[0].session.requests, []);
});

test("a message starts an idle worker and steers a running one", async (t) => {
	const { roster, created, spawn } = setup(t);
	await spawn({ name: "scout" });
	const session = created[0].session;
	assert.equal((await roster.message("scout", "First task")).mode, "start");
	assert.equal((await roster.message("scout", "Also check tests")).mode, "steer");
	assert.deepEqual(
		session.requests.map((request) => request.text),
		["First task", "Also check tests"],
	);
});

test("a finished run delivers one report to the parent", async (t) => {
	const { created, sent, spawn } = setup(t);
	const worker = await spawn({ task: "Map the repository" });
	created[0].session.assistant("The entry point is src/index.ts.");
	created[0].session.requests[0].finish();
	await worker.settled();
	assert.equal(sent.length, 1);
	assert.equal(JSON.parse(sent[0].message.content).result, "The entry point is src/index.ts.");
});

test("waiting returns when the workers finish and reports progress while they run", async (t) => {
	const { roster, created, spawn } = setup(t);
	await spawn({ name: "scout", task: "Map the repository" });
	const updates = [];
	const waiting = roster.waitFor(["scout"], undefined, undefined, (update) => updates.push(update.details.waiting));
	created[0].session.requests[0].finish();
	assert.deepEqual(await waiting, []);
	assert.deepEqual(updates, [["scout"]]);
});

test("waiting with a timeout returns the workers still running and leaves them running", async (t) => {
	const { roster, spawn } = setup(t);
	const worker = await spawn({ name: "scout", task: "Slow work" });
	const stillRunning = await roster.waitFor(["scout"], 20, undefined, undefined);
	assert.deepEqual(stillRunning, [worker]);
	assert.equal(worker.status, "running");
});

test("waiting is cancelled by the caller's abort signal", async (t) => {
	const { roster, spawn } = setup(t);
	await spawn({ name: "scout", task: "Slow work" });
	const controller = new AbortController();
	const waiting = roster.waitFor(undefined, undefined, controller.signal, undefined);
	controller.abort();
	await assert.rejects(waiting);
});

test("stopping removes the worker, closes its session, and sends no report", async (t) => {
	const { roster, created, sent, spawn } = setup(t);
	await spawn({ name: "scout", task: "Long task" });
	const stopped = await roster.stop("scout");
	assert.equal(stopped.status, "stopped");
	assert.deepEqual(roster.list(), []);
	assert.equal(created[0].session.disposed, true);
	assert.deepEqual(sent, []);
	await assert.rejects(roster.stop("scout"), /Unknown subagent/);
});

test("shutdown stops every worker without reports and refuses new workers", async (t) => {
	const { roster, created, sent, spawn } = setup(t);
	await spawn({ task: "One" });
	await spawn({ task: "Two" });
	await roster.dispose();
	assert.deepEqual(roster.list(), []);
	assert.ok(created.every(({ session }) => session.disposed));
	assert.deepEqual(sent, []);
	await assert.rejects(spawn());
});
