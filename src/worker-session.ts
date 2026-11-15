import { realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type AgentSession,
	createAgentSessionFromServices,
	createAgentSessionServices,
	createCodemodeExtension,
	createMcpExtension,
	createToolSearchExtension,
	type ExtensionContext,
	getAgentDir,
	hasTrustRequiringProjectResources,
	type LoadExtensionsResult,
	type ModelRuntime,
	ProjectTrustStore,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { isSubagentTool, WORKER_SYSTEM_PROMPT } from "./copy";
import { resolveModel, type WorkerModel } from "./model-resolver";

export interface WorkerSessionOptions {
	cwd: string;
	model?: string;
	thinking: ThinkingLevel;
	tools: string[];
	onExtensionError: (message: string) => void;
}

export interface WorkerSession {
	session: AgentSession;
	modelLabel: string;
	warnings: string[];
}

export function resolveWorkerCwd(parentCwd: string, cwd: string | undefined): string {
	const resolved = realpathSync(resolve(parentCwd, cwd || "."));
	if (!statSync(resolved).isDirectory()) throw new Error(`Not a directory: ${resolved}`);
	return resolved;
}

export async function createWorkerSession(
	ctx: ExtensionContext,
	options: WorkerSessionOptions,
): Promise<WorkerSession> {
	const { cwd, tools } = options;
	const agentDir = getAgentDir();
	const projectTrusted =
		cwd === realpathSync(ctx.cwd) ? ctx.isProjectTrusted() : new ProjectTrustStore(agentDir).get(cwd) === true;
	const services = await createAgentSessionServices({
		cwd,
		agentDir,
		settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted }),
		resourceLoaderOptions: {
			noPromptTemplates: true,
			noThemes: true,
			extensionFactories: cliBuiltinExtensionsNeededBy(tools),
			extensionsOverride: withoutSubagentExtensions,
			appendSystemPrompt: [WORKER_SYSTEM_PROMPT],
		},
	});

	let created: Awaited<ReturnType<typeof createAgentSessionFromServices>>;
	let model: WorkerModel;
	try {
		model = await pickModel(services.modelRuntime, options.model, ctx);
		created = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.create(cwd, join(agentDir, "subagent-sessions"), {
				parentSession: ctx.sessionManager.getSessionFile(),
			}),
			model,
			thinkingLevel: options.thinking,
			tools,
		});
	} catch (error) {
		await services.modelRuntime.settleCredentialWrites();
		throw error;
	}

	const { session, extensionsResult } = created;
	const warnings = [
		...(!projectTrusted && hasTrustRequiringProjectResources(cwd)
			? [`Project resources in ${cwd} were not loaded because the folder is not trusted.`]
			: []),
		...services.diagnostics.map((diagnostic) => diagnostic.message),
		...extensionsResult.errors.map((error) => `Extension ${error.path}: ${error.error}`),
		...(extensionsResult.warnings ?? []).map((warning) => `Extension ${warning.path}: ${warning.warning}`),
	];
	try {
		await session.bindExtensions({
			onError: (error) => {
				const warning = `Extension ${error.extensionPath} (${error.event}): ${error.error}`;
				warnings.push(warning);
				options.onExtensionError(warning);
			},
		});
		session.setActiveToolsByName(tools);
		return { session, modelLabel: `${model.provider}/${model.id}`, warnings };
	} catch (error) {
		await closeWorkerSession(session);
		throw error;
	}
}

export async function closeWorkerSession(session: AgentSession): Promise<void> {
	try {
		await session.abort();
		// dispose() does not emit session_shutdown, which worker extensions such as MCP need to clean up.
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	} finally {
		session.dispose();
		await session.modelRuntime.settleCredentialWrites();
	}
}

async function pickModel(
	modelRuntime: ModelRuntime,
	query: string | undefined,
	ctx: ExtensionContext,
): Promise<WorkerModel> {
	const parent = ctx.model && modelRuntime.getModel(ctx.model.provider, ctx.model.id);
	if (!query?.trim() && ctx.model && !parent) {
		throw new Error(
			`Model ${ctx.model.provider}/${ctx.model.id} is not registered in the worker's independent runtime. Parent-only provider/model overrides are not inherited.`,
		);
	}
	return resolveModel(query, await modelRuntime.getAvailable(), parent);
}

function cliBuiltinExtensionsNeededBy(tools: string[]) {
	const usesMcp = tools.some((name) => name === "codemode" || name === "tool_search" || name.startsWith("mcp__"));
	return [
		...(tools.includes("codemode") ? [createCodemodeExtension()] : []),
		...(tools.includes("tool_search") ? [createToolSearchExtension()] : []),
		...(usesMcp ? [createMcpExtension()] : []),
	];
}

export function withoutSubagentExtensions(base: LoadExtensionsResult): LoadExtensionsResult {
	return {
		...base,
		extensions: base.extensions.filter((extension) => ![...extension.tools.keys()].some(isSubagentTool)),
	};
}
