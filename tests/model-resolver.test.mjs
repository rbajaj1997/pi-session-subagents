import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";

const { resolveModel } = await createJiti(import.meta.url).import("../src/model-resolver.ts");

const small = {
	provider: "anthropic",
	id: "claude-haiku-4-5",
	name: "Claude Haiku 4.5",
};
const large = {
	provider: "anthropic",
	id: "claude-opus-4-5",
	name: "Claude Opus 4.5",
};
const otherProvider = {
	provider: "bedrock",
	id: "claude-haiku-4-5",
	name: "Claude Haiku 4.5",
};

test("an omitted or blank model query inherits the parent model", () => {
	for (const query of [undefined, "", "  \n "]) {
		assert.equal(resolveModel(query, [small, large], large), large);
	}
});

test("without a parent model the first available model is selected", () => {
	assert.equal(resolveModel(undefined, [small, large], undefined), small);
});

test("provider/id selects the requested provider even when model ids overlap", () => {
	assert.equal(resolveModel("BEDROCK/claude-haiku-4-5", [small, otherProvider], large), otherProvider);
});

test("fuzzy queries accept display names and ignore punctuation and case", () => {
	for (const query of ["Haiku", "CLAUDE HAIKU 4.5", "claude_haiku_4_5"]) {
		assert.equal(resolveModel(query, [large, small], large), small);
	}
});

test("exact matches win over broader matches regardless of registry order", () => {
	const exact = { provider: "example", id: "haiku", name: "Small model" };
	assert.equal(resolveModel("haiku", [small, exact], large), exact);
	assert.equal(resolveModel("haiku", [exact, small], large), exact);
});

test("a prefix match wins over a substring match", () => {
	const substring = {
		provider: "example",
		id: "super-haiku",
		name: "Small model",
	};
	const prefix = {
		provider: "example",
		id: "haiku-latest",
		name: "New small model",
	};
	assert.equal(resolveModel("haiku", [substring, prefix], large), prefix);
});

test("an unavailable or punctuation-only query fails instead of silently using the parent", () => {
	for (const query of ["missing-model", "---/!!!", "🛰️"]) {
		assert.throws(() => resolveModel(query, [small, large], large), Error);
	}
});

test("selection fails when neither a parent nor an available model exists", () => {
	assert.throws(() => resolveModel(undefined, [], undefined), Error);
	assert.throws(() => resolveModel("haiku", [], undefined), Error);
});
