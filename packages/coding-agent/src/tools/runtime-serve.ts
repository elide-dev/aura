import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type } from "arktype";
import runtimeServeDescription from "../prompts/tools/runtime-serve.md" with { type: "text" };
import type { ToolSession } from ".";
import { requireRuntimeService } from "./jvm-common";
import {
	failedLaunchBody,
	hubToolAvailable,
	jobHandleLine,
	type LaunchExecutor,
	noEndpointReport,
	type RuntimeJobDetails,
	resolveWaitSeconds,
	runtimeJobResult,
	startRuntimeJob,
} from "./runtime-launch";

const serveSchema = type({
	directory: type("string").describe("static files directory"),
	"port?": type("number").describe("port (default 8080)"),
	"host?": type("string").describe("bind interface (default 127.0.0.1)"),
	"cwd?": type("string").describe("base directory (session cwd)"),
	"waitSeconds?": type("number").describe("URL discovery timeout (default 15s)"),
});

export type RuntimeServeToolParams = typeof serveSchema.infer;

/** Serve a directory over HTTP as a hub job. */
export class RuntimeServeTool implements AgentTool<typeof serveSchema, RuntimeJobDetails> {
	readonly name = "serve";
	readonly approval = "exec" as const;
	readonly label = "Serve";
	readonly description = runtimeServeDescription;
	readonly parameters = serveSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;
	readonly summary = "Serve a directory over HTTP as a hub job";

	constructor(
		private readonly session: ToolSession,
		private readonly launch?: LaunchExecutor,
	) {}

	static createIf(session: ToolSession): RuntimeServeTool | null {
		if (!session.settings.get("runtime.enabled")) return null;
		return new RuntimeServeTool(session);
	}

	async execute(
		_toolCallId: string,
		params: RuntimeServeToolParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<RuntimeJobDetails>> {
		const descriptor = await requireRuntimeService(this.session).spawn(
			{
				directory: params.directory,
				port: params.port,
				host: params.host,
				cwd: params.cwd ?? this.session.cwd,
			},
			signal,
			this.session.getSessionId?.() ?? undefined,
		);
		const waitSeconds = resolveWaitSeconds(params.waitSeconds);
		const job = await startRuntimeJob(this.session, descriptor, {
			namePrefix: "runtime-serve",
			waitSeconds,
			signal,
			launch: this.launch,
		});
		const hubAvailable = hubToolAvailable(this.session);
		if (job.failed) return runtimeJobResult(failedLaunchBody(job, hubAvailable), job, descriptor);
		const endpoint = job.details.endpoint;
		// argv[1] is `serve`, argv[2] the absolute directory the endpoint resolved.
		const served = descriptor.argv[2] ?? params.directory;
		const body =
			endpoint === undefined
				? noEndpointReport("The static file server", job.details, waitSeconds, hubAvailable)
				: [`Serving ${served} at ${endpoint}`, jobHandleLine(job.details, hubAvailable)].join("\n");
		return runtimeJobResult(body, job, descriptor);
	}
}
