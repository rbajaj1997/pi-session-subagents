import type { AgentToolResult, AgentToolUpdateCallback, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	DEFAULT_MAX_BYTES,
	defineTool,
	sessionEntryToContextMessages,
	type Theme,
	type ToolDefinition,
	type ToolRenderResultOptions,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type TSchema, Type } from "typebox";
import { TOOL_COPY, type ToolName } from "./copy";
import type { Roster } from "./roster";
import { clip, formatDuration, getResultPage, messageText, shortModelLabel, summarizeToolArgs } from "./text";
import type { Worker } from "./worker";

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function tool<P extends TSchema, D>(
	name: ToolName,
	definition: Omit<ToolDefinition<P, D>, "name" | "label" | "description" | "promptSnippet">,
) {
	return defineTool<P, D>({ ...definition, ...TOOL_COPY[name], name, defaultActive: false });
}

export function subagentTools(roster: Roster) {
	return [
		tool("spawn_subagent", {
			parameters: Type.Object({
				name: Type.Optional(
					Type.String({
						description:
							"Optional brief subagent name such as 'qa', 'frontend', or 'backend'. Defaults to 'worker'.",
					}),
				),
				task: Type.Optional(
					Type.String({
						description:
							"Optional task to start immediately. Omit or leave blank to create an idle worker without a model call.",
					}),
				),
				model: Type.Optional(
					Type.String({ description: "Fuzzy model name such as 'opus', 'gpt-4.1', or provider/id" }),
				),
				cwd: Type.Optional(
					Type.String({
						description:
							"Working directory for the subagent, absolute or relative to your cwd. Defaults to your cwd.",
					}),
				),
				tools: Type.Optional(
					Type.Array(Type.String(), {
						description:
							"Tool names for the worker, for example read, grep, find, ls for read-only exploration. Each must be active in this session. Defaults to all of your active tools.",
					}),
				),
				// A plain string enum, which every provider accepts. pi-ai's StringEnum is untyped for TypeBox.
				thinking: Type.Optional(
					Type.Unsafe<ThinkingLevel>({
						type: "string",
						enum: THINKING_LEVELS,
						description: "Reasoning level for the worker. Defaults to yours.",
					}),
				),
				timeoutMs: Type.Optional(
					Type.Integer({
						minimum: 1,
						description:
							"Deadline in milliseconds for the initial task. On expiry the run is aborted and reported as an error; the worker stays available. Defaults to no limit.",
					}),
				),
			}),
			async execute(_id, params, signal, _onUpdate: unknown, ctx) {
				const worker = await roster.spawn(params, ctx, signal);
				const capabilities = worker.capabilities();
				const thinking = worker.session.thinkingLevel;
				const model = worker.info.modelLabel;
				const summary = worker.task
					? `Spawned ${worker.name} (${model}, thinking ${thinking}) and started: ${worker.task}`
					: `Spawned ${worker.name} (${model}, thinking ${thinking}), idle and ready. No model call made.`;
				return {
					content: [
						{
							type: "text",
							text: [
								summary,
								"Model/auth runtime: independent. Parent-only runtime overrides are not inherited.",
								`Enabled tools: ${capabilities.enabledTools.join(", ") || "(none)"}`,
								...(capabilities.missingTools.length
									? [`Missing requested tools: ${capabilities.missingTools.join(", ")}`]
									: []),
								...capabilities.warnings.map((warning) => `Warning: ${warning}`),
							].join("\n"),
						},
					],
					details: {
						name: worker.name,
						model,
						thinking,
						cwd: worker.info.cwd,
						task: worker.task,
						missingTools: capabilities.missingTools,
						warnings: capabilities.warnings,
					},
				};
			},
			renderCall: (args, theme) =>
				callLine(theme, "spawn_subagent", args.name || args.model || "worker", args.task?.trim() || "(idle)"),
			renderResult: (result, options, theme, context) =>
				resultLine(result, options, theme, context, () => {
					const { name, model, thinking, task, missingTools, warnings } = result.details;
					return [
						theme.fg("success", "✓ ") +
							theme.bold(name) +
							theme.fg("muted", ` · ${shortModelLabel(model)} · ${thinking} · ${task ? "started" : "idle"}`),
						...(missingTools.length ? [theme.fg("warning", `Missing tools: ${missingTools.join(", ")}`)] : []),
						...warnings.map((warning) => theme.fg("warning", warning)),
					].join("\n");
				}),
		}),

		tool("list_subagents", {
			parameters: Type.Object({}),
			async execute() {
				const workers = roster.list();
				const text = workers.length
					? workers
							.map(
								(worker) =>
									`${worker.name} [${worker.status} · ${shortModelLabel(worker.info.modelLabel)}] — ${clip(worker.task || "(idle)", 90)}`,
							)
							.join("\n")
					: "No subagents.";
				return { content: [{ type: "text", text }], details: undefined };
			},
			renderCall: (_args, theme) => new Text(theme.fg("toolTitle", theme.bold("list_subagents")), 0, 0),
		}),

		tool("inspect_subagent", {
			parameters: Type.Object({
				name: Type.String({ description: "Subagent name" }),
				tailLines: Type.Optional(
					Type.Integer({ minimum: 1, description: "Number of recent conversation lines to include, up to 50KB" }),
				),
				includeResult: Type.Optional(
					Type.Boolean({ description: "Include a page of the latest run's result. Defaults to false." }),
				),
				runId: Type.Optional(
					Type.Integer({
						minimum: 1,
						description:
							"Expected run id when reading a result. Pass the report's runId to avoid reading output from a later assignment or another worker.",
					}),
				),
				resultOffset: Type.Optional(
					Type.Integer({
						minimum: 0,
						description:
							"Character offset into the result, starting at 0. Use the next offset returned by the previous page.",
					}),
				),
			}),
			async execute(_id, params) {
				const worker = roster.find(params.name);
				return {
					content: [{ type: "text", text: inspectText(worker, params) }],
					details: { name: worker.name, status: worker.status, runId: worker.runId },
				};
			},
			renderCall: (args, theme) =>
				callLine(
					theme,
					"inspect_subagent",
					args.name,
					args.includeResult ? "result" : args.tailLines ? `last ${args.tailLines} lines` : undefined,
				),
		}),

		tool("message_subagent", {
			parameters: Type.Object({
				name: Type.String({ description: "Subagent name" }),
				message: Type.String({ description: "Instruction to send" }),
				timeoutMs: Type.Optional(
					Type.Integer({
						minimum: 1,
						description:
							"Deadline in milliseconds for the task this message starts. Ignored when the message steers a running worker.",
					}),
				),
			}),
			async execute(_id, params) {
				const { worker, mode } = await roster.message(params.name, params.message, params.timeoutMs);
				const verb =
					mode === "steer"
						? "Steered"
						: mode === "start"
							? "Started"
							: "An input handler in the worker consumed the message for";
				return {
					content: [{ type: "text", text: `${verb} ${worker.name}: ${params.message}` }],
					details: { name: worker.name, mode },
				};
			},
			renderCall: (args, theme) => callLine(theme, "message_subagent", args.name, args.message),
			renderResult: (result, options, theme, context) =>
				resultLine(result, options, theme, context, () => {
					const { name, mode } = result.details;
					return (
						theme.fg(
							"success",
							mode === "steer" ? "↪ steered " : mode === "start" ? "▶ started " : "✓ handled by ",
						) + theme.bold(name)
					);
				}),
		}),

		tool("await_subagents", {
			parameters: Type.Object({
				names: Type.Optional(
					Type.Array(Type.String(), { description: "Subagents to wait for. Defaults to all running subagents." }),
				),
				timeoutMs: Type.Optional(
					Type.Integer({
						minimum: 1,
						description: "Stop waiting after this many milliseconds. The workers keep running.",
					}),
				),
			}),
			async execute(_id, params, signal, onUpdate: AgentToolUpdateCallback<{ waiting: string[] }> | undefined) {
				const waiting = (await roster.waitFor(params.names, params.timeoutMs, signal, onUpdate)).map(
					(worker) => worker.name,
				);
				const text = waiting.length
					? `Stopped waiting after ${formatDuration(params.timeoutMs ?? 0)}. Still running: ${waiting.join(", ")}.`
					: "All awaited subagents have finished.";
				return { content: [{ type: "text", text }], details: { waiting } };
			},
			renderCall: (args, theme) =>
				callLine(
					theme,
					"await_subagents",
					args.names?.join(", ") || "all running",
					args.timeoutMs ? `timeout ${formatDuration(args.timeoutMs)}` : undefined,
				),
			renderResult: (result, options, theme, context) =>
				resultLine(result, options, theme, context, () =>
					result.details.waiting.length
						? theme.fg("warning", `… still running: ${result.details.waiting.join(", ")}`)
						: theme.fg("success", "✓ all finished"),
				),
		}),

		tool("stop_subagent", {
			parameters: Type.Object({ name: Type.String({ description: "Subagent name" }) }),
			async execute(_id, params) {
				const worker = await roster.stop(params.name);
				return {
					content: [{ type: "text", text: `Stopped and removed ${worker.name}.` }],
					details: { name: worker.name },
				};
			},
			renderCall: (args, theme) => callLine(theme, "stop_subagent", args.name),
			renderResult: (result, options, theme, context) =>
				resultLine(
					result,
					options,
					theme,
					context,
					() => theme.fg("muted", "■ removed ") + theme.bold(result.details.name),
				),
		}),
	];
}

function inspectText(
	worker: Worker,
	options: { tailLines?: number; includeResult?: boolean; resultOffset?: number; runId?: number },
): string {
	const capabilities = worker.capabilities();
	const stats = worker.stats();
	const lines = [
		`Name: ${worker.name}`,
		`Status: ${worker.status}`,
		`Run: ${worker.runId || "(none yet)"}`,
		`Model: ${worker.info.modelLabel}`,
		`Thinking: ${worker.session.thinkingLevel}`,
		`Working directory: ${worker.info.cwd}`,
		"Model/auth runtime: independent, using configured credentials and provider discovery",
		`Tools: ${capabilities.enabledTools.join(", ") || "(none)"}`,
		`Callable tools: ${capabilities.callableTools.join(", ") || "(none)"}`,
		`Missing requested tools: ${capabilities.missingTools.join(", ") || "(none)"}`,
		...capabilities.warnings.map((warning) => `Warning: ${warning}`),
		`Task: ${worker.task || "(idle)"}`,
		`Latest: ${worker.activity() || "(no output yet)"}`,
		`Turns: ${stats.turns}`,
		`Tool uses: ${stats.toolUses}`,
		`Session file: ${worker.session.sessionManager.getSessionFile() || "(none)"}`,
		...(worker.error ? [`Error: ${worker.error}`] : []),
	];
	if (options.includeResult) {
		if (options.runId !== undefined && options.runId !== worker.runId) {
			throw new Error(
				`Run ${options.runId} is not ${worker.name}'s latest run (${worker.runId || "none"}). Earlier output remains in its report card and session file.`,
			);
		}
		const page = getResultPage(stats.outcome, options.resultOffset);
		lines.push(
			"",
			`Result characters ${page.offset} to ${page.offset + page.content.length} of ${page.totalChars}:`,
			page.content || "(no result)",
		);
		if (page.nextOffset !== undefined)
			lines.push(`Continue with includeResult: true, runId: ${worker.runId}, resultOffset: ${page.nextOffset}.`);
	}
	if (options.tailLines) {
		const transcript = worker.session.sessionManager
			.getBranch()
			.flatMap(sessionEntryToContextMessages)
			.flatMap((message) => {
				if (message.role === "user") {
					const text =
						typeof message.content === "string"
							? message.content
							: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
					return text.trim() ? [`[user] ${text}`] : [];
				}
				if (message.role !== "assistant") return [];
				const text = messageText(message);
				return [
					...(text ? [`[assistant] ${text}`] : []),
					...message.content.flatMap((part) =>
						part.type === "toolCall" ? [`[tool] ${part.name} ${summarizeToolArgs(part.arguments)}`.trim()] : [],
					),
				];
			})
			.join("\n");
		const tail = truncateTail(transcript, { maxLines: options.tailLines, maxBytes: DEFAULT_MAX_BYTES });
		if (tail.content)
			lines.push("", `Recent transcript (last ${tail.outputLines} of ${tail.totalLines} lines):`, tail.content);
	}
	return lines.join("\n");
}

function callLine(theme: Theme, tool: string, subject: string, detail?: string): Text {
	const suffix = detail ? theme.fg("dim", " — ") + theme.fg("muted", clip(detail.replace(/\s+/g, " "), 60)) : "";
	return new Text(`${theme.fg("toolTitle", theme.bold(tool))} ${theme.fg("accent", subject)}${suffix}`, 0, 0);
}

function resultLine(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: { isError: boolean },
	summary: () => string,
): Text {
	const text = result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
	if (context.isError) return new Text(theme.fg("error", text), 0, 0);
	if (options.isPartial) return new Text(theme.fg("muted", text), 0, 0);
	return new Text(summary(), 0, 0);
}
