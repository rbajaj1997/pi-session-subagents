import { RESULT_PAGE_CHARS } from "./text";

interface ToolCopy {
	label: string;
	description: string;
	promptSnippet: string;
	promptGuidelines?: string[];
}

export const TOOL_COPY = {
	spawn_subagent: {
		label: "Spawn Subagent",
		description:
			"Create a session-scoped subagent with its own independent context window. Provide a task to start work immediately, or omit it to create an idle worker without a model call.",
		promptSnippet: "Spawn an independent worker, optionally starting a task. Omit task to keep it idle.",
		promptGuidelines: [
			"Use spawn_subagent when a task can run independently in a separate context window.",
			"Subagents do not share context with the parent or with each other.",
			"Workers independently discover configured tools and providers. Check enabled and missing tools in the spawn result before assigning work that depends on a capability.",
			"When asked to keep workers ready or on standby, omit task. Do not assign a readiness acknowledgment task. Start an idle worker later with message_subagent.",
			"When the user wants a specific subagent name or role label, set the optional name field to that brief label.",
			"Completion reports from workers arrive on their own and start a new turn when you are idle. While workers run, end your turn instead of waiting, so the user can keep talking to you.",
			"Use await_subagents only when you cannot continue without the workers' results, such as combining several results in one answer, or when the user asks you to wait. Messages the user sends are held until await_subagents returns.",
			"Do not use spawn_subagent as a probe or test. If the goal is to inspect, wait on, message, or stop an existing subagent, use those tools directly.",
		],
	},
	list_subagents: {
		label: "List Subagents",
		description: "List all active subagents in the current session.",
		promptSnippet: "List known subagents and their statuses.",
	},
	inspect_subagent: {
		label: "Inspect Subagent",
		description: `Inspect a subagent's status and actual capabilities. Optionally read the last result in ${RESULT_PAGE_CHARS.toLocaleString("en-US")}-character pages or include a recent transcript tail.`,
		promptSnippet:
			"Inspect worker status and capabilities, or read its full result with includeResult and resultOffset.",
	},
	message_subagent: {
		label: "Message Subagent",
		description:
			"Send an instruction to a subagent. Starts an idle worker or continues a completed worker. If it is already running, the message steers its current work.",
		promptSnippet: "Start an idle worker, continue a completed worker, or steer a busy worker.",
	},
	await_subagents: {
		label: "Await Subagents",
		description:
			"Wait until the named subagents, or all running ones, finish. With timeoutMs, return when it expires and list the workers still running.",
		promptSnippet: "Block until running subagents finish. Only when you need their results now.",
	},
	stop_subagent: {
		label: "Stop Subagent",
		description: "Stop a subagent and remove it from the roster.",
		promptSnippet: "Stop a subagent and clear it from the active subagent list.",
	},
} satisfies Record<string, ToolCopy>;

export type ToolName = keyof typeof TOOL_COPY;
export const TOOL_NAMES = Object.keys(TOOL_COPY) as ToolName[];
export const isSubagentTool = (name: string): name is ToolName => (TOOL_NAMES as string[]).includes(name);

export const WORKER_SYSTEM_PROMPT = [
	"You are a session-scoped worker subagent created by a parent pi session.",
	"",
	"Important rules:",
	"- You have your own isolated context window and conversation history.",
	"- Do not assume access to the parent agent's hidden reasoning or other subagents' context.",
	"- Focus only on the current delegated task.",
	"- If you receive a later instruction, treat it as a continuation or steering update from the parent.",
	"- When you finish, end with a concise final answer describing the result.",
].join("\n");

export const LATE_STEER_TURN_MESSAGE = "The parent sent another instruction as you finished.";

export const READ_MORE_HINT =
	"Use inspect_subagent with includeResult: true, this runId, and resultOffset: nextResultOffset.";

export function timeoutMessage(duration: string): string {
	return `Timed out after ${duration}. Its conversation is intact; send a follow-up with message_subagent to continue.`;
}
