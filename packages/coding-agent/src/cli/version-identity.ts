/**
 * The `--version` identity block.
 *
 * A bug report that says "aura 0.9.3" does not answer "what shape is the
 * runtime seam?", which is the first thing a runtime-tool bug needs. So the
 * protocol version `aura runtime status` prints is printed here too.
 *
 * The first line is deliberately byte-identical to what the CLI runner has
 * always emitted (`<bin>/<version>`), so anything parsing `aura --version`
 * keeps working; the protocol goes on its own second line.
 *
 * Kept in its own module (rather than in `cli.ts`) because the `--version`
 * path is meant to stay a minimal import graph: this pulls in `runtime/protocol`,
 * which is types plus one constant, and nothing else.
 */
import { APP_NAME, VERSION } from "@oh-my-pi/pi-utils/dirs";
import { RUNTIME_PROTOCOL_VERSION } from "../runtime/protocol";

/** The protocol half of the identity, shared with the launch-parser `--version` path in `main.ts`. */
export const RUNTIME_PROTOCOL_LINE = `runtime protocol v${RUNTIME_PROTOCOL_VERSION}`;

export function formatVersionIdentity(bin: string = APP_NAME, version: string = VERSION): string {
	return `${bin}/${version}\n${RUNTIME_PROTOCOL_LINE}`;
}
