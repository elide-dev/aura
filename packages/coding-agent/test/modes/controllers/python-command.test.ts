/**
 * The local `$`/`$$` action is an upstream CPython-kernel surface: it shares the
 * kernel session with eval's Python backend so a `$` cell and an `eval` cell see
 * the same names. The controller therefore hands the code to
 * `AgentSession.executePython` — the fork's runtime-tool detour is retired.
 */
import { beforeAll, describe, expect, it, vi } from "bun:test";
import { EvalExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/eval-execution";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

function createContainer() {
	return {
		children: [] as unknown[],
		addChild(child: unknown) {
			this.children.push(child);
		},
	};
}

function pythonResult(output: string) {
	return {
		output,
		exitCode: 0,
		cancelled: false,
		truncated: false,
		totalLines: 1,
		totalBytes: output.length,
		outputLines: 1,
		outputBytes: output.length,
		displayOutputs: [],
		stdinRequested: false,
	};
}

/**
 * A session that offers ONLY the shared-kernel entry point: any other execution
 * route the controller might reach for is absent, so a detour throws instead of
 * silently passing.
 */
function createContext(isStreaming = false) {
	const executePython = vi.fn(
		async (
			_code: string,
			_onChunk?: (chunk: string) => void,
			_options?: { excludeFromContext?: boolean },
		): Promise<ReturnType<typeof pythonResult>> => pythonResult("42\n"),
	);
	const pendingMessagesContainer = createContainer();
	const present = vi.fn();
	const ctx = {
		session: { isStreaming, executePython },
		sessionManager: { getCwd: () => "/tmp" },
		chatContainer: createContainer(),
		pendingMessagesContainer,
		pendingPythonComponents: [] as unknown[],
		ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
		present,
		showError: vi.fn(),
		showWarning: vi.fn(),
	} as unknown as InteractiveModeContext;
	return { ctx, executePython, pendingMessagesContainer, present };
}

describe("python shortcut command", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		setThemeInstance(theme);
	});

	it("runs interactive $ cells in the session's shared Python kernel", async () => {
		const { ctx, executePython, present } = createContext();
		const controller = new CommandController(ctx);

		await controller.handlePythonCommand("print(6 * 7)");

		expect(executePython).toHaveBeenCalledWith("print(6 * 7)", expect.any(Function), {
			excludeFromContext: false,
		});
		expect(ctx.showError).not.toHaveBeenCalled();
		const component = present.mock.calls[0]?.[0];
		expect(component).toBeInstanceOf(EvalExecutionComponent);
	});

	it("carries the $$ exclusion flag through to the kernel call", async () => {
		const { ctx, executePython } = createContext();
		const controller = new CommandController(ctx);

		await controller.handlePythonCommand("print('quiet')", true);

		expect(executePython).toHaveBeenCalledWith("print('quiet')", expect.any(Function), {
			excludeFromContext: true,
		});
		expect(ctx.showError).not.toHaveBeenCalled();
	});

	it("streams kernel output into the deferred component while a turn is streaming", async () => {
		const { ctx, executePython, pendingMessagesContainer, present } = createContext(true);
		executePython.mockImplementationOnce(async (_code: string, onChunk?: (chunk: string) => void) => {
			onChunk?.("streamed\n");
			return pythonResult("streamed\n");
		});
		const controller = new CommandController(ctx);

		await controller.handlePythonCommand("print('streamed')");

		expect(present).not.toHaveBeenCalled();
		expect(pendingMessagesContainer.children).toHaveLength(1);
		expect(ctx.pendingPythonComponents).toHaveLength(1);
		const component = pendingMessagesContainer.children[0] as EvalExecutionComponent;
		expect(component).toBeInstanceOf(EvalExecutionComponent);
		expect(ctx.showError).not.toHaveBeenCalled();
	});

	it("reports a kernel failure through the error channel", async () => {
		const { ctx, executePython } = createContext();
		executePython.mockRejectedValueOnce(new Error("kernel is gone"));
		const controller = new CommandController(ctx);

		await controller.handlePythonCommand("print(1)");

		expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining("kernel is gone"));
	});
});
