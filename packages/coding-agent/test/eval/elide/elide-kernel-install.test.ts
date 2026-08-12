/**
 * The install site.
 *
 * `docs/aura/ELIDE_ALIGNMENT.md` parked this as an open design call with three
 * candidates and one obligation: *whichever is chosen, land a test with it,
 * because nothing in the repo constrains it today — which is exactly how the
 * wrong shape would ship green.* This file is that test.
 *
 * The shape chosen is the third candidate: a **process-lifetime install site**,
 * reached lazily from the Elide backend's `isAvailable()`, memoized, idempotent,
 * and never cleared. The three failure modes the doc named for the per-scope
 * candidate are each pinned below as a property of this one:
 *
 * 1. *Last install wins* → an occupied slot is never overwritten.
 * 2. *Any one retirement clears the shared slot* → nothing here clears it, and
 *    the module exports no way to.
 * 3. *A settings rekey clears the slot the replacement just filled* → the second
 *    ensure is a no-op, whatever it is asked for.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../../src/config/settings";
import elideBackend from "../../../src/eval/elide";
import {
	type ElideJsKernelFactory,
	getElideJsKernelFactory,
	setElideJsKernelFactory,
} from "../../../src/eval/elide/kernel";
import * as kernelEmbedded from "../../../src/eval/elide/kernel-embedded";
import type { ToolSession } from "../../../src/tools";

let tempDir: TempDir;
let restoreFactory: ElideJsKernelFactory | undefined;
let savedEngineEnv: string | undefined;
/** Any regular file resolves: the library is opened lazily, on the first context. */
let resolvableLibrary: string;

const inertFactory: ElideJsKernelFactory = {
	open: async () => {
		throw new Error("inert test factory");
	},
};

function makeSession(settings: Settings): ToolSession {
	return { cwd: process.cwd(), hasUI: false, settings } as unknown as ToolSession;
}

beforeEach(async () => {
	tempDir = TempDir.createSync("@omp-elide-install-");
	resolvableLibrary = path.join(tempDir.path(), "libelide_embed.so");
	await writeFile(resolvableLibrary, "not really a library");
	savedEngineEnv = Bun.env.AURA_EVAL_JS_ENGINE;
	delete Bun.env.AURA_EVAL_JS_ENGINE;
	restoreFactory = setElideJsKernelFactory(undefined);
	kernelEmbedded.resetElideJsKernelInstallForTests();
});

afterEach(() => {
	setElideJsKernelFactory(restoreFactory);
	restoreFactory = undefined;
	kernelEmbedded.resetElideJsKernelInstallForTests();
	if (savedEngineEnv === undefined) delete Bun.env.AURA_EVAL_JS_ENGINE;
	else Bun.env.AURA_EVAL_JS_ENGINE = savedEngineEnv;
	tempDir[Symbol.dispose]();
});

describe("Elide kernel install site", () => {
	it("installs one factory when a library resolves", async () => {
		expect(await kernelEmbedded.ensureElideJsKernelFactory({ embeddedPath: resolvableLibrary })).toBe(true);
		const installed = getElideJsKernelFactory();
		expect(installed).toBeDefined();

		// Idempotent: asking again — even for a different library — changes nothing.
		expect(await kernelEmbedded.ensureElideJsKernelFactory({ embeddedPath: "/nonexistent/other.so" })).toBe(true);
		expect(getElideJsKernelFactory()).toBe(installed);
	});

	it("reports no kernel when the configured library is missing, and leaves the slot empty", async () => {
		// A nonblank configured path is BINDING: resolution stops there rather than
		// silently selecting a managed or environment library instead. That is what
		// makes this case hermetic even when the artifact env is set.
		expect(await kernelEmbedded.ensureElideJsKernelFactory({ embeddedPath: "/nonexistent/missing.so" })).toBe(false);
		expect(getElideJsKernelFactory()).toBeUndefined();
	});

	it("never overwrites a factory that is already installed", async () => {
		setElideJsKernelFactory(inertFactory);
		expect(await kernelEmbedded.ensureElideJsKernelFactory({ embeddedPath: resolvableLibrary })).toBe(true);
		// "Last install wins" is the failure mode this site exists to avoid: a test's
		// fake, or a first session's kernel, keeps the slot.
		expect(getElideJsKernelFactory()).toBe(inertFactory);
	});

	it("exports no way to clear the slot outside tests", () => {
		const clearers = Object.keys(kernelEmbedded).filter(
			name => /clear|retire|uninstall/i.test(name) && !name.endsWith("ForTests"),
		);
		expect(clearers).toEqual([]);
	});
});

describe("Elide backend availability", () => {
	it("installs lazily and reports available when the session asks for the elide engine", async () => {
		const session = makeSession(
			Settings.isolated({ "eval.jsEngine": "elide", "runtime.embeddedPath": resolvableLibrary }),
		);
		expect(await elideBackend.isAvailable(session)).toBe(true);
		expect(getElideJsKernelFactory()).toBeDefined();
	});

	it("never installs anything for a Bun session", async () => {
		const session = makeSession(Settings.isolated({ "runtime.embeddedPath": resolvableLibrary }));
		expect(await elideBackend.isAvailable(session)).toBe(false);
		// The default engine must not pay for — or even reach — the embedded kernel.
		expect(getElideJsKernelFactory()).toBeUndefined();
	});

	it("reports unavailable, without a factory, when the engine is asked for but no library resolves", async () => {
		const session = makeSession(
			Settings.isolated({ "eval.jsEngine": "elide", "runtime.embeddedPath": "/nonexistent/missing.so" }),
		);
		expect(await elideBackend.isAvailable(session)).toBe(false);
		expect(getElideJsKernelFactory()).toBeUndefined();
	});
});
