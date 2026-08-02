/**
 * Error taxonomy for the Aura cloud client.
 *
 * Every failure the client surfaces collapses into one of {@link AURA_CLOUD_ERROR_CODES},
 * plus an optional HTTP status and a coarse classification of the host that was contacted.
 * Nothing else is reachable from the error object: no tokens, no URLs (which may carry
 * credentials in userinfo or query parameters), no response bodies, no synchronized values.
 * That keeps the error safe to log, serialize, and attach to telemetry verbatim.
 *
 * "Verbatim" specifically includes inspect-style logging. A wrapped `cause` is deliberately
 * *not* stored as the standard `Error.cause` property: `Object.keys` hides it, but
 * `Bun.inspect`/`util.inspect` walk and print the whole cause chain, and the top-level CLI
 * error path (`src/cli.ts`) dumps `Bun.inspect(err)` to stderr. A `TypeError` from `fetch`
 * routinely embeds the full request URL in its message, so retaining it as `cause` would
 * print `?access_token=…` to the terminal. Causes are held in a module-private WeakMap and
 * reachable only through the explicit {@link auraCloudErrorCause} accessor, which makes
 * surfacing one a deliberate act rather than a side effect of `console.error`.
 */

/** The complete, closed set of cloud client failure codes. */
export const AURA_CLOUD_ERROR_CODES = [
	"not_configured",
	"invalid_configuration",
	"login_required",
	"relogin_required",
	"access_denied",
	"expired",
	"unauthorized",
	"forbidden",
	"conflict",
	"rate_limited",
	"payload_too_large",
	"unsupported",
	"unavailable",
	"invalid_response",
	"aborted",
] as const;

/** A single cloud client failure code. */
export type AuraCloudErrorCode = (typeof AURA_CLOUD_ERROR_CODES)[number];

/**
 * Coarse classification of the endpoint a request was aimed at.
 *
 * Deliberately describes the *shape* of the host (is this a dev loopback, a private
 * network, or the public internet?) rather than its identity, so it stays useful in logs
 * without ever naming a deployment.
 */
export type AuraCloudHostClass = "loopback" | "private" | "public" | "unknown";

/** Construction detail for {@link AuraCloudError}. Only these fields are ever retained. */
export interface AuraCloudErrorOptions {
	/** HTTP status, when the failure came from a response. */
	readonly status?: number;
	/** The endpoint that was contacted. Classified via {@link classifyHost} and then discarded. */
	readonly host?: string;
	/**
	 * Underlying error. Held off the error object entirely (see the file header) and
	 * retrievable only via {@link auraCloudErrorCause}.
	 */
	readonly cause?: unknown;
}

/**
 * Causes, held outside the error object so no inspect/serialize path can reach them.
 *
 * A `WeakMap` rather than a private field or symbol property: private fields still show up
 * in `util.inspect`, and symbol-keyed properties are printed by inspect at default options.
 */
const CAUSES = new WeakMap<AuraCloudError, unknown>();

const HOST_CLASS_UNKNOWN: AuraCloudHostClass = "unknown";

/** Exact hostnames that always mean "this machine", in the forms `URL.hostname` produces. */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]", "::", "[::]"]);

/**
 * The one answer to "is this host this machine?".
 *
 * There used to be three sets with three different memberships — this module's, the
 * `http`-may-drop-TLS set in `deployment.ts`, and the verification-URI set in `auth.ts` — so
 * `http://0.0.0.0:8080` was reported as `loopback` in an error while being refused the loopback
 * TLS exemption, and `127.0.0.2` was reported as `private`. The *policies* those call sites
 * apply legitimately differ; the membership question must not.
 *
 * Membership, and why:
 *
 * - `localhost` and anything under it (RFC 6761: `localhost.` and its subdomains always resolve
 *   to the loopback interface). `localhost.corp.example` is not under it, and is not included.
 * - The whole of `127.0.0.0/8`, not just `127.0.0.1` — RFC 1122 reserves the entire block, and a
 *   dev server on `127.0.0.2` is exactly as unreachable from the network as one on `127.0.0.1`.
 * - `::1`, bracketed or not, as `URL.hostname` may report either depending on the caller.
 * - The unspecified addresses `0.0.0.0` and `::`. They are not loopback addresses in the
 *   addressing sense, but they answer *this* question the same way: a connection opened to the
 *   unspecified address is defined to reach the local host, so the traffic cannot leave the
 *   machine. That is what both call-site policies actually depend on — honest classification
 *   for one, "TLS may be dropped only where there is no network to eavesdrop on" for the other.
 *   Classifying `0.0.0.0` as `public` (which is where it lands otherwise, having dots and no
 *   private prefix) would be the actively misleading answer.
 *
 * Takes a bare hostname, not a URL: callers already hold `url.hostname`, and accepting a URL
 * would invite passing a raw operator string that has not been screened yet.
 */
export function isLoopbackHostname(hostname: string): boolean {
	if (hostname === "") return false;
	const host = hostname.toLowerCase();
	if (LOOPBACK_HOSTNAMES.has(host)) return true;
	if (host.endsWith(".localhost")) return true;
	return isLoopbackIpv4(host);
}

/** `127.0.0.0/8` in dotted-quad form. */
function isLoopbackIpv4(hostname: string): boolean {
	const octets = hostname.split(".");
	if (octets.length !== 4) return false;
	for (const part of octets) {
		if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return false;
	}
	return octets[0] === "127";
}

/** Suffixes conventionally resolved on the local network rather than the public internet. */
const PRIVATE_SUFFIXES = [".local", ".internal", ".home.arpa"];

/** IPv6 prefixes (bracketed, as WHATWG `URL.hostname` reports them) that never leave the LAN. */
const PRIVATE_IPV6_PREFIXES = ["[fc", "[fd", "[fe8", "[fe9", "[fea", "[feb"];

function isPrivateIpv4(hostname: string): boolean {
	const octets = hostname.split(".");
	if (octets.length !== 4) return false;
	const parsed = octets.map(part => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
	if (parsed.some(value => Number.isNaN(value) || value > 255)) return false;
	const [a, b] = parsed as [number, number, number, number];
	// `127.0.0.0/8` is deliberately absent: it is loopback, and {@link isLoopbackHostname} has
	// already claimed it by the time this runs. Listing it here too would be a second answer to
	// a question that now has one.
	if (a === 10) return true;
	if (a === 192 && b === 168) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 169 && b === 254) return true;
	return false;
}

/**
 * Reduce a URL to a {@link AuraCloudHostClass}.
 *
 * Anything unparseable is `"unknown"` rather than an error: classification is a logging
 * nicety and must never become a second failure mode.
 */
export function classifyHost(host: string | undefined): AuraCloudHostClass {
	if (!host) return HOST_CLASS_UNKNOWN;
	let hostname: string;
	try {
		hostname = new URL(host).hostname.toLowerCase();
	} catch {
		return HOST_CLASS_UNKNOWN;
	}
	if (!hostname) return HOST_CLASS_UNKNOWN;
	if (isLoopbackHostname(hostname)) return "loopback";
	if (isPrivateIpv4(hostname)) return "private";
	if (hostname.startsWith("[")) {
		return PRIVATE_IPV6_PREFIXES.some(prefix => hostname.startsWith(prefix)) ? "private" : "public";
	}
	if (PRIVATE_SUFFIXES.some(suffix => hostname.endsWith(suffix))) return "private";
	// A bare label (no dot) can only be resolved by local DNS/hosts.
	if (!hostname.includes(".")) return "private";
	return "public";
}

/** Human-readable summaries. Fixed strings — never interpolated with caller detail. */
const CODE_SUMMARY: Record<AuraCloudErrorCode, string> = {
	not_configured: "cloud is not configured",
	invalid_configuration: "cloud configuration is invalid",
	login_required: "cloud login is required",
	relogin_required: "cloud login has to be repeated",
	access_denied: "cloud access was denied",
	expired: "cloud credential has expired",
	unauthorized: "cloud request was unauthorized",
	forbidden: "cloud request was forbidden",
	conflict: "cloud request conflicted with existing state",
	rate_limited: "cloud request was rate limited",
	payload_too_large: "cloud request payload was too large",
	unsupported: "cloud operation is unsupported",
	unavailable: "cloud is unavailable",
	invalid_response: "cloud returned an invalid response",
	aborted: "cloud request was aborted",
};

function formatMessage(code: AuraCloudErrorCode, status: number | undefined, hostClass: AuraCloudHostClass): string {
	const detail = status === undefined ? `host ${hostClass}` : `status ${status}, host ${hostClass}`;
	return `${CODE_SUMMARY[code]} (${code}; ${detail})`;
}

/** Structured, redaction-safe projection of an {@link AuraCloudError}. */
export interface AuraCloudErrorJson {
	readonly code: AuraCloudErrorCode;
	readonly status: number | undefined;
	readonly hostClass: AuraCloudHostClass;
}

/**
 * The single error type raised by the Aura cloud client.
 *
 * The message is derived entirely from {@link code}, {@link status} and {@link hostClass};
 * callers cannot inject free-form text, which is what makes every code path that formats
 * this error — `message`, `toString()`, `JSON.stringify` — safe by construction.
 */
export class AuraCloudError extends Error {
	override readonly name = "AuraCloudError";
	readonly code: AuraCloudErrorCode;
	readonly status: number | undefined;
	readonly hostClass: AuraCloudHostClass;

	constructor(code: AuraCloudErrorCode, options: AuraCloudErrorOptions = {}) {
		const status = typeof options.status === "number" ? options.status : undefined;
		const hostClass = classifyHost(options.host);
		super(formatMessage(code, status, hostClass));
		this.code = code;
		this.status = status;
		this.hostClass = hostClass;
		if ("cause" in options) CAUSES.set(this, options.cause);
	}

	/** Only ever emits code, status and host class. */
	toJSON(): AuraCloudErrorJson {
		return { code: this.code, status: this.status, hostClass: this.hostClass };
	}
}

/**
 * Retrieve the underlying error an {@link AuraCloudError} was constructed from, if any.
 *
 * The returned value has had no redaction applied and may embed request URLs, tokens, or
 * response bodies. It is for interactive debugging and narrow structural checks only —
 * never write it to logs, telemetry, support bundles, or user-facing output.
 */
export function auraCloudErrorCause(error: AuraCloudError): unknown {
	return CAUSES.get(error);
}

/** Narrow an unknown thrown value to an {@link AuraCloudError}. */
export function isAuraCloudError(value: unknown): value is AuraCloudError {
	return value instanceof AuraCloudError;
}
