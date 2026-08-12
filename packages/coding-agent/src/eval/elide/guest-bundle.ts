/**
 * Builds the bootstrap source a Tier 2 context evaluates once, right after
 * `contextOpen`, to become a JS eval kernel.
 *
 * Three pieces, in this order, because each depends on the one before it:
 *
 * 1. **The config global.** `./guest-entry.ts` reads `__OMP_ELIDE_KERNEL__` at
 *    module scope, so it must exist before the bundle runs. Every constant the
 *    host and guest share is defined *here* and travels in that object — the
 *    host must never `import` from `guest-entry.ts`, which would drag the whole
 *    eval runtime into the host graph.
 * 2. **The `Bun` shim.** The guest is Elide's JavaScript, which ships `require`,
 *    `fetch`, `Buffer`, and the node builtins the eval runtime needs, but no
 *    `Bun` global. Seven `Bun.*` uses survive into the bundle and one of them
 *    (`new Bun.Transpiler`) runs at module scope, so the shim cannot be lazy.
 * 3. **The bundle**, built from `./guest-entry.ts` with `Bun.build`.
 *
 * The build swaps `node:async_hooks` for a **sticky** `AsyncLocalStorage`. This
 * is not an optimisation: Elide's `AsyncLocalStorage` does not carry its store
 * across an `await`, and `JsRuntime` resolves the active run's hooks from that
 * store on every `console.log`, tool call, and status emit. Under the real thing
 * a cell's output vanishes the moment it awaits anything. See the guest-realm
 * note on {@link STICKY_ASYNC_LOCAL_STORAGE_SOURCE} for what "sticky" costs.
 */
import type { BunPlugin } from "bun";

/**
 * Marks a protocol frame among the guest's ordinary stdout lines.
 *
 * Leads with NUL because that is the one byte a cell's own output will not begin
 * a line with by accident, and because `JSON.stringify` escapes it — so a frame's
 * payload can never contain the sentinel that introduces it.
 */
export const ELIDE_GUEST_FRAME_PREFIX = "\u0000OMP:";

/**
 * How often the guest re-reads its inbound spool while a cell is in flight.
 *
 * Only paid during a run, and it doubles as the handle that keeps the guest
 * event loop — and therefore the host's `contextCall` — alive across a tool
 * call. Small enough that a tool round trip is not visibly slower than the Bun
 * worker's message port; large enough that a parked cell is not a spin loop.
 */
export const ELIDE_GUEST_INBOX_POLL_MILLIS = 4;

/**
 * A single-run `AsyncLocalStorage`: the store is held on the instance and
 * restored when the callback's promise SETTLES rather than when it first
 * suspends.
 *
 * That is correct exactly while one run at a time occupies the context, which is
 * what Tier 2 guarantees — `contextCall` is FIFO on the one execution thread, so
 * a second cell cannot begin until the first has settled. If context-level
 * concurrency ever lands, this shim becomes wrong (two runs would share one
 * store) and the fix is a real async-context implementation in the runtime, not
 * a bigger shim here.
 */
const STICKY_ASYNC_LOCAL_STORAGE_SOURCE = `
export class AsyncLocalStorage {
	#store = undefined;
	getStore() {
		return this.#store;
	}
	enterWith(store) {
		this.#store = store;
	}
	disable() {
		this.#store = undefined;
	}
	exit(callback, ...args) {
		const previous = this.#store;
		this.#store = undefined;
		try {
			return callback(...args);
		} finally {
			this.#store = previous;
		}
	}
	run(store, callback, ...args) {
		const previous = this.#store;
		this.#store = store;
		let result;
		try {
			result = callback(...args);
		} catch (error) {
			this.#store = previous;
			throw error;
		}
		if (result && typeof result.then === "function") {
			return result.then(
				value => {
					this.#store = previous;
					return value;
				},
				error => {
					this.#store = previous;
					throw error;
				},
			);
		}
		this.#store = previous;
		return result;
	}
}
export default { AsyncLocalStorage };
`;

/**
 * The `Bun` surface the bundled eval runtime touches, over node builtins the
 * guest does have. Installed only when the guest has no `Bun` of its own, so a
 * runtime that grows one wins.
 *
 * `Transpiler.transformSync` is an identity function, not an error: its only
 * caller (`stripTypeScript`) already falls back to the original source when the
 * transpiler fails, so an identity shim and a throwing one behave the same — a
 * TypeScript cell reaches the guest unstripped either way. That is a real gap,
 * recorded rather than papered over.
 */
const BUN_SHIM_SOURCE = `
(() => {
	if (typeof globalThis.Bun !== "undefined") return;
	const fsp = require("node:fs/promises");
	const nodeModule = require("node:module");
	const nodeUtil = require("node:util");

	class Transpiler {
		constructor(options) {
			this.options = options ?? {};
		}
		transformSync(code) {
			return code;
		}
		scanImports() {
			return [];
		}
	}

	const bunFile = filePath => ({
		name: filePath,
		async text() {
			return await fsp.readFile(filePath, "utf8");
		},
		async bytes() {
			return new Uint8Array(await fsp.readFile(filePath));
		},
		async arrayBuffer() {
			const buffer = await fsp.readFile(filePath);
			return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
		},
		async stat() {
			return await fsp.stat(filePath);
		},
		async exists() {
			try {
				await fsp.access(filePath);
				return true;
			} catch {
				return false;
			}
		},
		slice(start, end) {
			return {
				async text() {
					const buffer = await fsp.readFile(filePath);
					return buffer.subarray(start ?? 0, end ?? buffer.length).toString("utf8");
				},
			};
		},
	});

	const fnv1a64 = value => {
		let hash = 0xcbf29ce484222325n;
		const bytes = new TextEncoder().encode(String(value));
		for (const byte of bytes) {
			hash ^= BigInt(byte);
			hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
		}
		return hash;
	};

	globalThis.Bun = {
		sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
		get env() {
			return process.env;
		},
		file: bunFile,
		write: async (target, data) => {
			const filePath = typeof target === "string" ? target : target.name;
			if (typeof data === "string") {
				await fsp.writeFile(filePath, data);
				return data.length;
			}
			const view = ArrayBuffer.isView(data) ? data : new Uint8Array(data);
			await fsp.writeFile(filePath, Buffer.from(view.buffer, view.byteOffset, view.byteLength));
			return view.byteLength;
		},
		hash: fnv1a64,
		resolveSync: (specifier, parent) => nodeModule.createRequire(parent + "/[resolve]").resolve(specifier),
		inspect: value => nodeUtil.inspect(value),
		Transpiler,
	};
})();
`;

const stickyAsyncLocalStorage: BunPlugin = {
	name: "omp-elide-guest-async-context",
	setup(build) {
		build.onResolve({ filter: /^node:async_hooks$/ }, () => ({
			path: "omp-sticky-async-local-storage",
			namespace: "omp-elide-guest",
		}));
		build.onLoad({ filter: /.*/, namespace: "omp-elide-guest" }, () => ({
			contents: STICKY_ASYNC_LOCAL_STORAGE_SOURCE,
			loader: "js",
		}));
	},
};

let bundlePromise: Promise<string> | undefined;

/**
 * Bundle `./guest-entry.ts` for the guest, once per process.
 *
 * Built at runtime from source rather than embedded at build time, which is the
 * one thing about this module that does not survive a compiled distribution:
 * `Bun.build` needs `src/` on disk. Acceptable while the engine is opt-in and
 * gated on a locally resolved library; a shipped default needs a build-time
 * artifact instead.
 */
export function buildElideGuestBundle(): Promise<string> {
	bundlePromise ??= (async () => {
		const entrypoint = Bun.fileURLToPath(new URL("./guest-entry.ts", import.meta.url));
		const built = await Bun.build({
			entrypoints: [entrypoint],
			target: "node",
			// The guest evaluates this as one script in a shared top-level scope, so
			// `import`/`export` cannot survive into the output.
			format: "cjs",
			// Deliberately unminified: a cell's error stack names frames inside this
			// bundle, and those frames reach the model.
			minify: false,
			plugins: [stickyAsyncLocalStorage],
		});
		if (!built.success) {
			throw new Error(`Failed to bundle the runtime JS guest entry: ${built.logs.map(String).join("; ")}`);
		}
		const output = built.outputs[0];
		if (!output) throw new Error("Bundling the runtime JS guest entry produced no output.");
		return await output.text();
	})();
	return bundlePromise;
}

/** Test-only: drop the memoized bundle so a later build is observed. */
export function resetElideGuestBundleForTests(): void {
	bundlePromise = undefined;
}

export interface ElideGuestBootstrapOptions {
	/** Append-only spool the host writes mid-run inbound messages to. */
	inboxPath: string;
}

/** The full source one context evaluates to become a JS eval kernel. */
export async function renderElideGuestBootstrap(options: ElideGuestBootstrapOptions): Promise<string> {
	const config = JSON.stringify({
		framePrefix: ELIDE_GUEST_FRAME_PREFIX,
		inboxPath: options.inboxPath,
		pollMillis: ELIDE_GUEST_INBOX_POLL_MILLIS,
	});
	return `globalThis.__OMP_ELIDE_KERNEL__ = ${config};\n${BUN_SHIM_SOURCE}\n${await buildElideGuestBundle()}`;
}
