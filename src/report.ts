import {
	type ExtensionAPI,
	type ExtensionContext,
	getMarkdownTheme,
	type MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text, TruncatedText } from "@earendil-works/pi-tui";
import { READ_MORE_HINT } from "./copy";
import { clip, formatDuration, getResultPage } from "./text";
import type { Worker } from "./worker";

export const REPORT_MESSAGE_TYPE = "subagent-report";

export interface SubagentReport {
	agent: string;
	runId: number;
	model: string;
	task: string;
	status: "done" | "error";
	outcome: string;
	error?: string;
	toolUses: number;
	turns: number;
	tokens: number;
	duration: string;
	sessionPath?: string;
}

export function buildReport(worker: Worker): SubagentReport {
	const stats = worker.stats();
	return {
		agent: worker.name,
		runId: worker.runId,
		model: worker.info.modelLabel,
		task: worker.task,
		status: worker.error ? "error" : "done",
		outcome: stats.outcome,
		error: worker.error || undefined,
		toolUses: stats.toolUses,
		turns: stats.turns,
		tokens: stats.tokens,
		duration: formatDuration(stats.durationMs),
		sessionPath: worker.session.sessionManager.getSessionFile(),
	};
}

export class ReportOutbox {
	private readonly clearableByEscape = new Map<number, SubagentReport>();

	constructor(private readonly pi: ExtensionAPI) {}

	deliver(report: SubagentReport, ctx: ExtensionContext | undefined): void {
		if (ctx && !ctx.isIdle()) this.clearableByEscape.set(report.runId, report);
		this.pi.sendMessage<SubagentReport>(reportMessage(report), { deliverAs: "steer", triggerTurn: true });
		if (ctx?.hasUI)
			ctx.ui.notify(
				`${report.agent} ${report.status === "error" ? "failed" : "completed"}`,
				report.status === "error" ? "error" : "info",
			);
	}

	delivered(report: SubagentReport): void {
		this.clearableByEscape.delete(report.runId);
	}

	resendClearedByEscape(): void {
		for (const report of this.clearableByEscape.values())
			this.pi.sendMessage<SubagentReport>(reportMessage(report), { deliverAs: "nextTurn" });
		this.clearableByEscape.clear();
	}

	clear(): void {
		this.clearableByEscape.clear();
	}
}

function reportMessage(report: SubagentReport) {
	const page = getResultPage(report.outcome);
	const truncated = page.nextOffset !== undefined;
	return {
		customType: REPORT_MESSAGE_TYPE,
		content: JSON.stringify({
			agent: report.agent,
			runId: report.runId,
			status: report.status,
			task: clip(report.task, 1_000),
			result: page.content,
			error: report.error ? clip(report.error, 2_000) : undefined,
			truncated,
			nextResultOffset: page.nextOffset,
			sessionPath: report.sessionPath,
			...(truncated ? { readMore: READ_MORE_HINT } : {}),
		}),
		display: true,
		details: report,
	};
}

export function registerReportDelivery(pi: ExtensionAPI, outbox: ReportOutbox): void {
	pi.registerMessageRenderer(REPORT_MESSAGE_TYPE, renderReport);
	pi.on("message_end", async (event) => {
		const message = event.message;
		if (message.role === "custom" && message.customType === REPORT_MESSAGE_TYPE && message.details) {
			outbox.delivered(message.details as SubagentReport);
		}
	});
	// Escape in the TUI drops queued custom messages, including unread reports.
	pi.on("agent_settled", async (event, ctx) => {
		if (event.aborted && ctx.mode === "tui") outbox.resendClearedByEscape();
	});
}

const renderReport: MessageRenderer<SubagentReport> = (message, options, theme) => {
	const report = message.details;
	const failed = report?.status === "error";
	const outcome = report?.outcome || report?.error || "";
	const card = new Container();
	card.addChild(
		new Text(
			theme.fg(
				failed ? "error" : "success",
				`${failed ? "✗" : "✓"} ${report?.agent || "subagent"} ${failed ? "failed" : "completed"}`,
			) + theme.fg("dim", ` ${options.keyHint("app.tools.expand", options.expanded ? "to collapse" : "to expand")}`),
			options.outputPad,
			0,
		),
	);
	card.addChild(
		new TruncatedText(theme.fg("muted", `Task: ${(report?.task || "").replace(/\s+/g, " ")}`), options.outputPad, 0),
	);
	card.addChild(
		options.expanded
			? new Markdown(outcome, options.outputPad, 0, getMarkdownTheme())
			: new TruncatedText(outcome.replace(/\s+/g, " "), options.outputPad, 0),
	);
	if (failed && report?.error && outcome !== report.error)
		card.addChild(new Text(theme.fg("error", report.error), options.outputPad, 0));
	if (report?.sessionPath)
		card.addChild(
			new TruncatedText(theme.fg("dim", `Session: pi --session ${report.sessionPath}`), options.outputPad, 0),
		);
	return card;
};
