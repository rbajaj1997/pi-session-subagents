import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { normalizeName } from "./text";

export type WorkerModel = NonNullable<ExtensionContext["model"]>;

export function resolveModel(
	modelQuery: string | undefined,
	available: readonly WorkerModel[],
	fallback: WorkerModel | undefined,
): WorkerModel {
	if (!modelQuery?.trim()) {
		const model = fallback ?? available[0];
		if (!model) throw new Error("No model available for subagent.");
		return model;
	}

	const norm = normalizeName(modelQuery);
	if (!norm) throw new Error(`No available model matches "${modelQuery}".`);
	let best: { model: WorkerModel; score: number } | null = null;

	for (const model of available) {
		const pieces = [
			`${model.provider || ""}/${model.id || ""}`,
			String(model.id || ""),
			String(model.name || ""),
			String(model.provider || ""),
		];
		let score = 0;
		for (const piece of pieces.map(normalizeName)) {
			if (!piece) continue;
			if (piece === norm) score = Math.max(score, 1000);
			else if (piece.startsWith(norm)) score = Math.max(score, 850);
			else if (piece.includes(norm)) score = Math.max(score, 700);
		}
		const joined = normalizeName(pieces.join(" "));
		if (joined === norm) score = Math.max(score, 950);
		else if (joined.includes(norm)) score = Math.max(score, 650);
		if (!best || score > best.score) best = { model, score };
	}

	if (!best || best.score === 0) throw new Error(`No available model matches "${modelQuery}".`);
	return best.model;
}
