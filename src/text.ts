import type { AssistantMessage } from "@earendil-works/pi-ai";

export const RESULT_PAGE_CHARS = 12_000;

export function normalizeName(input: string): string {
	return input.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function slugify(input: string): string {
	return (
		input
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "worker"
	);
}

export function clip(text: string, max = 140): string {
	return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

export function lastLine(text: string): string {
	return (
		text
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.at(-1) ?? ""
	);
}

export function shortModelLabel(label: string): string {
	return label.split("/")[1] ?? label;
}

export function formatDuration(ms: number): string {
	return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

export function formatTokens(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M tok`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k tok`;
	return `${count} tok`;
}

export function messageText(message: Pick<AssistantMessage, "content"> | undefined): string {
	return (message?.content ?? [])
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join("\n")
		.trim();
}

export function getResultPage(
	text: string,
	offset = 0,
): { content: string; offset: number; nextOffset?: number; totalChars: number } {
	const start = Math.min(Math.max(0, offset), text.length);
	let end = Math.min(start + RESULT_PAGE_CHARS, text.length);
	const lastUnit = text.charCodeAt(end - 1);
	const splitsSurrogatePair = end < text.length && lastUnit >= 0xd800 && lastUnit <= 0xdbff;
	if (splitsSurrogatePair) end--;
	return {
		content: text.slice(start, end),
		offset: start,
		nextOffset: end < text.length ? end : undefined,
		totalChars: text.length,
	};
}

export function summarizeToolArgs(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const { path, command, pattern } = args as Record<string, unknown>;
	if (typeof path === "string") return path;
	if (typeof command === "string") return clip(command.replace(/\s+/g, " "), 70);
	if (typeof pattern === "string") return pattern;
	return clip(JSON.stringify(args), 70);
}
