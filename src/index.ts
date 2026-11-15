import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isSubagentTool, TOOL_NAMES } from "./copy";
import { registerReportDelivery } from "./report";
import { Roster } from "./roster";
import { subagentTools } from "./tools";
import { openInspector } from "./ui/conversation-viewer";

export default function (pi: ExtensionAPI) {
	const roster = new Roster(pi);

	function setEnabled(enabled: boolean): void {
		const others = pi.getActiveTools().filter((name) => !isSubagentTool(name));
		pi.setActiveTools(enabled ? [...others, ...TOOL_NAMES] : others);
	}

	for (const tool of subagentTools(roster)) pi.registerTool(tool);
	registerReportDelivery(pi, roster.reports);

	pi.registerCommand("subagents:inspect", {
		description: "Inspect subagents in a live read-only overlay",
		getArgumentCompletions: (prefix) => roster.completions(prefix),
		handler: (args, ctx) => openInspector(ctx, roster.list(), args),
	});

	pi.registerCommand("subagents", {
		description:
			"Use 'on' to enable the subagent tools, 'off' to stop all workers and disable them, or pass a request to enable them and send it",
		handler: async (args, ctx) => {
			const request = args?.trim() || "";
			if (!request) {
				if (ctx.hasUI) ctx.ui.notify("Usage: /subagents on, /subagents off, or /subagents <request>", "info");
				return;
			}
			const command = request.toLowerCase();
			if (command === "off") {
				try {
					await roster.stopAll();
				} finally {
					await ctx.waitForIdle();
					setEnabled(false);
				}
				if (ctx.hasUI) ctx.ui.notify("Subagent mode off. All subagents stopped and tools disabled.", "info");
				return;
			}
			await ctx.waitForIdle();
			if (!pi.getActiveTools().some(isSubagentTool)) {
				setEnabled(true);
				if (ctx.hasUI)
					ctx.ui.notify("Subagent mode on. Use /subagents off to stop all workers and disable the tools.", "info");
			}
			if (command !== "on") pi.sendUserMessage(request);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		roster.attach(ctx);
		setEnabled(false);
	});

	pi.on("session_shutdown", async () => {
		await roster.dispose();
	});
}
