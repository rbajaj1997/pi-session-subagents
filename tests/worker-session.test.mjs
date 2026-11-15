import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createJiti } from "jiti";
import { ControlledSession } from "./helpers/session.mjs";

const { closeWorkerSession, resolveWorkerCwd, withoutSubagentExtensions } = await createJiti(import.meta.url).import(
	"../src/worker-session.ts",
);

function directory(t) {
	const path = mkdtempSync(join(tmpdir(), "pi-subagents-test-"));
	t.after(() => rmSync(path, { recursive: true, force: true }));
	return path;
}

test("workers inherit the parent directory or resolve a relative working directory", (t) => {
	const parent = directory(t);
	mkdirSync(join(parent, "child"));
	assert.equal(resolveWorkerCwd(parent, undefined), realpathSync(parent));
	assert.equal(resolveWorkerCwd(parent, "child"), realpathSync(join(parent, "child")));
});

test("absolute working directories and symlinks resolve to the canonical directory", (t) => {
	const parent = directory(t);
	const target = join(parent, "target");
	mkdirSync(target);
	symlinkSync(target, join(parent, "alias"), "dir");
	assert.equal(resolveWorkerCwd(parent, target), realpathSync(target));
	assert.equal(resolveWorkerCwd(parent, "alias"), realpathSync(target));
});

test("files and missing paths cannot be used as a worker directory", (t) => {
	const parent = directory(t);
	writeFileSync(join(parent, "file.txt"), "not a directory");
	assert.throws(() => resolveWorkerCwd(parent, "file.txt"), Error);
	assert.throws(() => resolveWorkerCwd(parent, "missing"), Error);
});

test("session shutdown still disposes resources and settles credentials when an extension fails", async () => {
	const session = new ControlledSession();
	const failure = new Error("Extension shutdown failed");
	session.extensionRunner.emit = async () => {
		throw failure;
	};
	const writes = Promise.withResolvers();
	session.credentialWrites = writes.promise;
	const disposed = Promise.withResolvers();
	session.dispose = () => {
		session.disposed = true;
		disposed.resolve();
	};
	let closed = false;
	const closing = closeWorkerSession(session);
	const rejected = assert.rejects(closing, (error) => {
		closed = true;
		return error === failure;
	});
	try {
		await disposed.promise;
		assert.equal(session.disposed, true);
		assert.equal(closed, false);
	} finally {
		writes.resolve();
		await rejected;
	}
});

test("workers load every discovered extension except ones that provide subagent tools", () => {
	const extension = (path, tools) => ({ path, tools: new Map(tools.map((name) => [name, {}])) });
	const discovered = {
		extensions: [
			extension("formatter", ["format"]),
			extension("this-package", ["spawn_subagent", "list_subagents"]),
			extension("another-copy", ["stop_subagent"]),
			extension("no-tools", []),
		],
		errors: [{ path: "broken", error: "Syntax error" }],
	};
	const loaded = withoutSubagentExtensions(discovered);
	assert.deepEqual(
		loaded.extensions.map((ext) => ext.path),
		["formatter", "no-tools"],
	);
	assert.deepEqual(loaded.errors, discovered.errors);
});
