/**
 * Error taxonomy for the Aura cloud client.
 *
 * Every failure the client surfaces collapses into one of {@link AURA_CLOUD_ERROR_CODES},
 * plus an optional HTTP status and a coarse classification of the host that was contacted.
 * Nothing else is retained: no tokens, no URLs (which may carry credentials in userinfo or
 * query parameters), no response bodies, no synchronized values. That keeps the error safe
 * to log, serialize, and attach to telemetry verbatim.
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
	/** Underlying error, kept non-enumerable by `Error`'s own `cause` handling. */
	readonly cause?: unknown;
}

const HOST_CLASS_UNKNOWN: AuraCloudHostClass = "unknown";

/** Hostnames that always mean "this machine". */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

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
	if (a === 10 || a === 127) return true;
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
	// RFC 6761: `localhost` and anything under it always resolves to the loopback interface.
	if (LOOPBACK_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost")) return "loopback";
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
		super(formatMessage(code, status, hostClass), "cause" in options ? { cause: options.cause } : undefined);
		this.code = code;
		this.status = status;
		this.hostClass = hostClass;
	}

	/** Only ever emits code, status and host class. */
	toJSON(): AuraCloudErrorJson {
		return { code: this.code, status: this.status, hostClass: this.hostClass };
	}
}

/** Narrow an unknown thrown value to an {@link AuraCloudError}. */
export function isAuraCloudError(value: unknown): value is AuraCloudError {
	return value instanceof AuraCloudError;
}
