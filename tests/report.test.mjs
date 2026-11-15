import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";

const { ReportOutbox, registerReportDelivery } = await createJiti(import.meta.url).import("../src/report.ts");

function report(overrides = {}) {
	return {
		agent: "scout",
		runId: 7,
		model: "example/small",
		task: "Map the repository",
		status: "done",
		outcome: "The entry point is src/index.ts.",
		toolUses: 2,
		turns: 3,
		tokens: 100,
		duration: "1.5s",
		sessionPath: "/sessions/scout.jsonl",
		...overrides,
	};
}

function setup() {
	const messages = [];
	const notifications = [];
	const outbox = new ReportOutbox({
		sendMessage: (message, options) => messages.push({ message, options }),
	});
	const context = (idle) => ({
		isIdle: () => idle,
		hasUI: true,
		ui: { notify: (text, level) => notifications.push({ text, level }) },
	});
	return { outbox, messages, notifications, context };
}

test("completion sends a model-readable report, full card data, and a wake-up request", () => {
	const { outbox, messages, notifications, context } = setup();
	outbox.deliver(report(), context(true));
	assert.equal(messages.length, 1);
	assert.deepEqual(messages[0].options, {
		deliverAs: "steer",
		triggerTurn: true,
	});
	assert.equal(messages[0].message.customType, "subagent-report");
	assert.equal(messages[0].message.display, true);
	assert.deepEqual(JSON.parse(messages[0].message.content), {
		agent: "scout",
		runId: 7,
		status: "done",
		task: "Map the repository",
		result: "The entry point is src/index.ts.",
		truncated: false,
		sessionPath: "/sessions/scout.jsonl",
	});
	assert.equal(messages[0].message.details.model, "example/small");
	assert.equal(messages[0].message.details.tokens, 100);
	assert.deepEqual(notifications, [{ text: "scout completed", level: "info" }]);
});

test("failure reports retain partial output and expose the error to the parent", () => {
	const { outbox, messages, notifications, context } = setup();
	outbox.deliver(
		report({
			status: "error",
			error: "Provider unavailable",
			outcome: "Partial findings",
		}),
		context(false),
	);
	const payload = JSON.parse(messages[0].message.content);
	assert.equal(payload.status, "error");
	assert.equal(payload.error, "Provider unavailable");
	assert.equal(payload.result, "Partial findings");
	assert.deepEqual(notifications, [{ text: "scout failed", level: "error" }]);
});

test("long reports preserve newlines and Unicode, advertise continuation, and retain full output for the card", () => {
	const { outbox, messages } = setup();
	const outcome = `${"a".repeat(11_998)}\n🚀\nRest of the result`;
	outbox.deliver(report({ outcome }));
	const payload = JSON.parse(messages[0].message.content);
	assert.equal(payload.result, `${"a".repeat(11_998)}\n`);
	assert.equal(payload.nextResultOffset, 11_999);
	assert.equal(payload.truncated, true);
	assert.match(payload.readMore, /inspect_subagent/);
	assert.match(payload.readMore, /runId/);
	assert.equal(messages[0].message.details.outcome, outcome);
});

test("model-visible task and error text are bounded without losing the full card data", () => {
	const { outbox, messages } = setup();
	outbox.deliver(
		report({
			task: "t".repeat(1_001),
			error: "e".repeat(2_001),
			status: "error",
		}),
	);
	const payload = JSON.parse(messages[0].message.content);
	assert.ok(payload.task.length <= 1_000);
	assert.ok(payload.task.startsWith("t".repeat(900)));
	assert.ok(payload.error.length <= 2_000);
	assert.ok(payload.error.startsWith("e".repeat(1_900)));
	assert.equal(messages[0].message.details.task, "t".repeat(1_001));
	assert.equal(messages[0].message.details.error, "e".repeat(2_001));
});

test("Escape requeues unread reports once for the next turn without waking the parent", () => {
	const { outbox, messages, context } = setup();
	outbox.deliver(report(), context(false));
	outbox.resendClearedByEscape();
	assert.equal(messages.length, 2);
	assert.deepEqual(messages[1].message, messages[0].message);
	assert.deepEqual(messages[1].options, { deliverAs: "nextTurn" });
	outbox.resendClearedByEscape();
	assert.equal(messages.length, 2);
});

test("Escape replays only undelivered reports even when the worker name is reused", () => {
	const { outbox, messages, context } = setup();
	outbox.deliver(report({ runId: 7, outcome: "First assignment" }), context(false));
	outbox.deliver(report({ runId: 8, outcome: "Second assignment" }), context(false));
	outbox.delivered(report({ runId: 7 }));
	outbox.resendClearedByEscape();
	assert.equal(messages.length, 3);
	assert.equal(JSON.parse(messages[2].message.content).runId, 8);
	assert.equal(JSON.parse(messages[2].message.content).result, "Second assignment");
});

test("reports sent while idle or without a context are not replayed by Escape", () => {
	const { outbox, messages, context } = setup();
	outbox.deliver(report({ runId: 7 }), context(true));
	outbox.deliver(report({ runId: 8 }));
	outbox.resendClearedByEscape();
	assert.equal(messages.length, 2);
});

test("clearing the outbox discards pending replays without affecting future deliveries", () => {
	const { outbox, messages, context } = setup();
	outbox.deliver(report(), context(false));
	outbox.clear();
	outbox.resendClearedByEscape();
	assert.equal(messages.length, 1);
	outbox.deliver(report({ runId: 8 }), context(false));
	outbox.resendClearedByEscape();
	assert.equal(messages.length, 3);
	assert.equal(JSON.parse(messages[2].message.content).runId, 8);
});

function deliverySetup() {
	const handlers = new Map();
	const messages = [];
	const pi = {
		sendMessage: (message, options) => messages.push({ message, options }),
		registerMessageRenderer: () => {},
		on: (event, handler) => handlers.set(event, handler),
	};
	const outbox = new ReportOutbox(pi);
	registerReportDelivery(pi, outbox);
	const busy = { isIdle: () => false, hasUI: false };
	const reportArrives = (sent) => handlers.get("message_end")({ message: { role: "custom", ...sent.message } });
	const settle = (aborted, mode) => handlers.get("agent_settled")({ aborted }, { mode });
	return { outbox, messages, busy, reportArrives, settle };
}

test("a report that reached the parent's transcript is not resent after Escape", async () => {
	const { outbox, messages, busy, reportArrives, settle } = deliverySetup();
	outbox.deliver(report(), busy);
	await reportArrives(messages[0]);
	await settle(true, "tui");
	assert.equal(messages.length, 1);
});

test("a report Escape cleared in the TUI is resent, but not after a normal finish or outside the TUI", async () => {
	const { outbox, messages, busy, settle } = deliverySetup();
	outbox.deliver(report(), busy);
	await settle(false, "tui");
	await settle(true, "rpc");
	assert.equal(messages.length, 1);
	await settle(true, "tui");
	assert.equal(messages.length, 2);
	assert.deepEqual(messages[1].options, { deliverAs: "nextTurn" });
});
