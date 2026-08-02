/**
 * Deployment resolution for the Aura cloud client.
 *
 * Everything an Aura deployment points at is derived from a single opt-in variable,
 * `AURA_DOMAIN`, or replaced surface by surface with an exact override variable. There is no
 * source default, no compiled-in domain and no DNS probe: an environment that says nothing
 * about Aura produces a deployment that says nothing about Aura, and every caller then takes
 * whatever explicit, legacy or offline path it already had.
 *
 * Three rules shape the whole module:
 *
 *  1. **Only the selected tier is validated.** Aura's URL rules (HTTPS, no credentials, no
 *     query/fragment, origin-vs-base path shape) govern Aura's own tiers — the exact override
 *     variables and the domain derivations. A per-call argument, a persisted setting or a
 *     legacy environment variable keeps the semantics it already had; those tiers predate
 *     Aura and are operator-controlled, so `wss://relay.example.com` and
 *     `http://broker.internal:9000` must keep working exactly as before.
 *  2. **An invalid winner is an error, never a fall-through.** Silently dropping a malformed
 *     `AURA_DOMAIN` would hand the caller the legacy path while the operator believes Aura is
 *     switched on. Every rejection raises {@link AuraCloudError} with `invalid_configuration`.
 *  3. **A switch removes exactly the Aura tiers.** {@link auraDeploymentFor} projects a
 *     deployment down to the one field a consumer is entitled to read, and drops it entirely
 *     when that consumer's `cloud.*.enabled` switch is off. Nothing a switch does can reach a
 *     per-call, persisted or legacy endpoint.
 *
 * The module deliberately exposes no generic "build a URL for an arbitrary host" helper. The
 * derivation table below is the complete set of hosts this client will ever construct.
 */

import { AuraCloudError } from "./errors";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Where a resolved endpoint came from.
 *
 * Ordered loosely by authority: a `call` argument is the most specific thing a caller can
 * say, `legacy_env` the least. Carried on every result so callers can log *why* they are
 * talking to a host, and so QA can order its canonical variable above the legacy alias
 * without a second resolution path.
 */
export type EndpointSource = "call" | "setting" | "aura_env" | "domain" | "legacy_env";

/** A single endpoint plus the tier that produced it. */
export interface ResolvedEndpoint {
	readonly url: string;
	readonly source: EndpointSource;
}

/** The four distribution endpoints, resolved together or not at all. */
export interface AuraDistributionEndpoints {
	readonly apiBaseUrl: ResolvedEndpoint;
	readonly downloadBaseUrl: ResolvedEndpoint;
	readonly jwksUrl: ResolvedEndpoint;
	readonly catalogManifestUrl: ResolvedEndpoint;
}

/**
 * The Aura tiers only: exact override variables and domain derivations.
 *
 * Deliberately *not* a complete picture of where a surface will talk. Per-call, persisted and
 * legacy tiers are supplied by the caller at {@link resolveServiceEndpoint} time, because only
 * the caller knows them.
 */
export interface AuraDeployment {
	readonly domain?: string;
	readonly authOrigin?: ResolvedEndpoint;
	readonly syncOrigin?: ResolvedEndpoint;
	readonly brokerBaseUrl?: ResolvedEndpoint;
	readonly gatewayBaseUrl?: ResolvedEndpoint;
	readonly telemetryBaseUrl?: ResolvedEndpoint;
	readonly qaEndpoint?: ResolvedEndpoint;
	readonly collabOrigin?: ResolvedEndpoint;
	readonly distribution?: AuraDistributionEndpoints;
}

/** Surfaces that resolve a single endpoint through {@link resolveServiceEndpoint}. */
export type AuraServiceSurface = "auth" | "sync" | "broker" | "gateway" | "telemetry" | "qa" | "collab";

// ═══════════════════════════════════════════════════════════════════════════
// Errors
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Raise `invalid_configuration`, naming the variable and the reason but never the value.
 *
 * An endpoint variable can carry credentials in userinfo or a query parameter, so the offending
 * string never reaches the error — not even the private cause, which
 * `auraCloudErrorCause` can surface into a debugging session.
 */
function invalidConfiguration(variable: string, reason: string): AuraCloudError {
	return new AuraCloudError("invalid_configuration", { cause: new Error(`${variable}: ${reason}`) });
}

// ═══════════════════════════════════════════════════════════════════════════
// Environment reading
// ═══════════════════════════════════════════════════════════════════════════

/** Environment view: a plain record, never `process.env` implicitly. */
export type EnvView = Readonly<Record<string, string | undefined>>;

/**
 * Read a variable, treating absent and blank as the same thing: unset.
 *
 * Surrounding whitespace is trimmed because a value sourced from a shell `$(...)`, a `.env`
 * file or a CI secret routinely arrives with a trailing newline. Interior whitespace is *not*
 * accepted — the validators below reject it.
 */
function readEnv(env: EnvView, name: string): string | undefined {
	const raw = env[name];
	if (raw === undefined) return undefined;
	const trimmed = raw.trim();
	return trimmed === "" ? undefined : trimmed;
}

// ═══════════════════════════════════════════════════════════════════════════
// AURA_DOMAIN validation
// ═══════════════════════════════════════════════════════════════════════════

const MAX_HOSTNAME_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;

/**
 * Longest label this module ever prefixes to `AURA_DOMAIN` (`telemetry.`, `downloads.`).
 *
 * The 253-octet DNS bound applies to the *derived* host, not to the configured domain, so the
 * usable domain budget is shorter than 253 by exactly this much.
 */
const LONGEST_DERIVED_PREFIX = "telemetry.".length;

/** Everything a DNS name may contain once it is already lowercase ASCII. */
const DOMAIN_CHARSET = /^[a-z0-9.-]+$/;

/**
 * Validate `AURA_DOMAIN` as an already-normalized lowercase ASCII DNS name.
 *
 * Rejection is the only outcome for anything that would need normalizing — an uppercase
 * label, a scheme, a port, a trailing dot. Normalizing here would mean quietly accepting a
 * value the operator can no longer find in their own configuration, and (for a scheme or a
 * userinfo segment) quietly reinterpreting which host they meant.
 */
function validateDomain(value: string): string {
	const fail = (reason: string): never => {
		throw invalidConfiguration("AURA_DOMAIN", reason);
	};
	if (value.length + LONGEST_DERIVED_PREFIX > MAX_HOSTNAME_LENGTH) {
		fail(`derived hostnames would exceed the ${MAX_HOSTNAME_LENGTH}-octet DNS limit`);
	}
	// One character-class check subsumes scheme (`:` `/`), path (`/`), backslash, port (`:`),
	// wildcard (`*`), userinfo (`@`), query (`?`), fragment (`#`), whitespace, control
	// characters, percent-encoding (`%`), underscores and any non-ASCII/uppercase character.
	if (!DOMAIN_CHARSET.test(value)) fail("must be a lowercase ASCII DNS name");
	// RFC 6761: `localhost` is the one reserved single-label name with defined resolution.
	if (value === "localhost") return value;
	const labels = value.split(".");
	if (labels.length < 2) fail("must contain at least one dot (or be exactly `localhost`)");
	for (const label of labels) {
		// An empty label covers a leading dot, a trailing dot and a doubled dot at once.
		if (label.length === 0) fail("must not contain an empty label");
		if (label.length > MAX_LABEL_LENGTH) fail(`labels must be at most ${MAX_LABEL_LENGTH} characters`);
		if (!/^[a-z0-9]/.test(label) || !/[a-z0-9]$/.test(label)) fail("labels must start and end alphanumeric");
	}
	return value;
}

// ═══════════════════════════════════════════════════════════════════════════
// Override URL validation
// ═══════════════════════════════════════════════════════════════════════════

/** Generous but finite: no legitimate endpoint base approaches this. */
const MAX_URL_LENGTH = 2048;

/** The exact hosts that may drop TLS. Anything that merely *looks* local is not on the list. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Percent-encoded sequences that would let a path segment lie about its own structure:
 * encoded forward slash, backslash, dot, percent, and any encoded C0/DEL control character.
 */
const ENCODED_SEPARATOR = /%(?:2f|5c|2e|25|7f|[01][0-9a-f])/i;

/** Shape of the URL a surface accepts. */
interface UrlRules {
	/** A base may carry a fixed path; an origin may not. */
	readonly allowPath: boolean;
	/** Collab speaks WebSocket, so `wss:` (and `ws:` on loopback) is legitimate there. */
	readonly allowWebSocket: boolean;
}

const ORIGIN_RULES: UrlRules = { allowPath: false, allowWebSocket: false };
const BASE_RULES: UrlRules = { allowPath: true, allowWebSocket: false };
const COLLAB_RULES: UrlRules = { allowPath: false, allowWebSocket: true };

/**
 * Validate an exact Aura override variable and normalize trailing slashes — nothing else.
 *
 * The raw string is screened before `new URL` ever sees it, because the WHATWG parser is a
 * normalizer by design: it rewrites `\` to `/`, strips tab and newline characters, and happily
 * absorbs a userinfo segment. Screening first means the rejected shapes are rejected on what
 * the operator actually wrote.
 */
function validateAuraUrl(raw: string, variable: string, rules: UrlRules): string {
	const fail = (reason: string): never => {
		throw invalidConfiguration(variable, reason);
	};
	if (raw.length > MAX_URL_LENGTH) fail(`must be at most ${MAX_URL_LENGTH} characters`);
	for (const char of raw) {
		const code = char.codePointAt(0) ?? 0;
		// Printable ASCII only: excludes every control character, every flavour of whitespace,
		// and every non-ASCII codepoint (an IDN host must be punycode before it gets here).
		if (code < 0x21 || code > 0x7e) fail("must contain only printable ASCII characters");
	}
	if (raw.includes("\\")) fail("must not contain a backslash");
	if (raw.includes("@")) fail("must not contain credentials");
	if (raw.includes("?")) fail("must not contain a query string");
	if (raw.includes("#")) fail("must not contain a fragment");
	if (raw.includes("*")) fail("must not contain a wildcard");
	if (ENCODED_SEPARATOR.test(raw)) fail("must not contain percent-encoded separators");

	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return fail("must be an absolute URL");
	}

	const loopback = LOOPBACK_HOSTS.has(url.hostname);
	const allowedProtocols = new Set(["https:"]);
	if (rules.allowWebSocket) allowedProtocols.add("wss:");
	if (loopback) {
		allowedProtocols.add("http:");
		if (rules.allowWebSocket) allowedProtocols.add("ws:");
	}
	if (!allowedProtocols.has(url.protocol)) {
		fail(
			rules.allowWebSocket
				? "must use https or wss (http/ws on loopback only)"
				: "must use https (http on loopback only)",
		);
	}
	// Belt and braces: `@` is screened above, but a parser change must never silently
	// reintroduce userinfo.
	if (url.username !== "" || url.password !== "") fail("must not contain credentials");
	if (url.search !== "" || url.hash !== "") fail("must not contain a query string or fragment");
	if (url.hostname === "") fail("must have a host");
	if (url.hostname.endsWith(".")) fail("must not have a trailing dot in the host");
	if (!url.hostname.startsWith("[")) {
		if (url.hostname.length > MAX_HOSTNAME_LENGTH) fail(`host must be at most ${MAX_HOSTNAME_LENGTH} octets`);
		for (const label of url.hostname.split(".")) {
			if (label.length === 0) fail("host must not contain an empty label");
			if (label.length > MAX_LABEL_LENGTH) fail(`host labels must be at most ${MAX_LABEL_LENGTH} characters`);
		}
	}

	if (!rules.allowPath) {
		if (url.pathname !== "/" && url.pathname !== "") fail("must be an origin with no path");
		return `${url.protocol}//${url.host}`;
	}

	// Path checks run on what the operator *wrote*, not on `url.pathname`: the WHATWG parser
	// resolves `..` and `.` away before anyone can look at them, so inspecting the parsed path
	// would silently accept `/v1/../../admin` as `/admin`.
	const authorityEnd = raw.indexOf("/", raw.indexOf("://") + 3);
	const rawPath = authorityEnd === -1 ? "" : raw.slice(authorityEnd);
	// Trailing slashes are the one thing that *is* normalized, so strip them before deciding
	// whether an empty segment is present.
	const path = rawPath.replace(/\/+$/, "");
	if (path !== "") {
		for (const segment of path.slice(1).split("/")) {
			if (segment === "." || segment === "..") fail("must not contain relative path segments");
			if (segment === "") fail("must not contain an empty path segment");
		}
	}
	return `${url.protocol}//${url.host}${path}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Derivation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The complete derivation table.
 *
 * Kept as one literal so the set of hosts this client can construct is readable in a single
 * glance — and so nothing else in the codebase is tempted to assemble an Aura URL by hand.
 */
function derive(domain: string) {
	return {
		auth: `https://auth.${domain}`,
		sync: `https://sync.${domain}`,
		broker: `https://api.${domain}/broker`,
		gateway: `https://api.${domain}/gateway`,
		telemetry: `https://telemetry.${domain}`,
		qa: `https://qa.${domain}/v1/grievances`,
		collab: `https://collab.${domain}`,
		distApi: `https://api.${domain}/v1/distribution`,
		distDownload: `https://downloads.${domain}`,
		distJwks: `https://api.${domain}/.well-known/distribution-jwks.json`,
		catalogManifest: `https://api.${domain}/v1/distribution/catalog/manifest`,
	} as const;
}

function domainEndpoint(url: string): ResolvedEndpoint {
	return { url, source: "domain" };
}

/**
 * Resolve the Aura tiers of a deployment from an environment view.
 *
 * Pure and side-effect free: no network, no DNS, no `process.env` read of its own. Throws
 * `invalid_configuration` when a variable that is present is malformed — a present variable is
 * always the winner of its own tier, so this is the "invalid winner" rule, not eager
 * validation of a tier nobody selected.
 */
export function resolveAuraDeployment(input: { env: EnvView }): AuraDeployment {
	const { env } = input;
	// Read untrimmed on purpose: `AURA_DOMAIN` rejects whitespace rather than normalizing it,
	// so trimming here would accept a value the validator is supposed to refuse. A blank value
	// is still just "unset" — that is an absent variable, not a malformed domain.
	const rawDomain = env.AURA_DOMAIN;
	const domain = rawDomain === undefined || rawDomain.trim() === "" ? undefined : validateDomain(rawDomain);
	const derived = domain === undefined ? undefined : derive(domain);

	const override = (variable: string, rules: UrlRules): ResolvedEndpoint | undefined => {
		const raw = readEnv(env, variable);
		if (raw === undefined) return undefined;
		return { url: validateAuraUrl(raw, variable, rules), source: "aura_env" };
	};

	const tier = (variable: string, rules: UrlRules, fallback: string | undefined): ResolvedEndpoint | undefined =>
		override(variable, rules) ?? (fallback === undefined ? undefined : domainEndpoint(fallback));

	const deployment: {
		domain?: string;
		authOrigin?: ResolvedEndpoint;
		syncOrigin?: ResolvedEndpoint;
		brokerBaseUrl?: ResolvedEndpoint;
		gatewayBaseUrl?: ResolvedEndpoint;
		telemetryBaseUrl?: ResolvedEndpoint;
		qaEndpoint?: ResolvedEndpoint;
		collabOrigin?: ResolvedEndpoint;
		distribution?: AuraDistributionEndpoints;
	} = {};

	if (domain !== undefined) deployment.domain = domain;
	assign(deployment, "authOrigin", tier("AURA_AUTH_URL", ORIGIN_RULES, derived?.auth));
	assign(deployment, "syncOrigin", tier("AURA_SYNC_URL", ORIGIN_RULES, derived?.sync));
	assign(deployment, "brokerBaseUrl", tier("AURA_BROKER_URL", BASE_RULES, derived?.broker));
	assign(deployment, "gatewayBaseUrl", tier("AURA_GATEWAY_URL", BASE_RULES, derived?.gateway));
	assign(deployment, "telemetryBaseUrl", tier("AURA_TELEMETRY_URL", BASE_RULES, derived?.telemetry));
	assign(deployment, "qaEndpoint", tier("AURA_QA_URL", BASE_RULES, derived?.qa));
	assign(deployment, "collabOrigin", tier("AURA_COLLAB_ORIGIN", COLLAB_RULES, derived?.collab));

	const apiBaseUrl = tier("AURA_DIST_API_URL", BASE_RULES, derived?.distApi);
	const downloadBaseUrl = tier("AURA_DIST_DOWNLOAD_URL", BASE_RULES, derived?.distDownload);
	const jwksUrl = tier("AURA_DIST_JWKS_URL", BASE_RULES, derived?.distJwks);
	const catalogManifestUrl = tier("AURA_CATALOG_MANIFEST_URL", BASE_RULES, derived?.catalogManifest);
	const distributionParts = [apiBaseUrl, downloadBaseUrl, jwksUrl, catalogManifestUrl];
	if (apiBaseUrl && downloadBaseUrl && jwksUrl && catalogManifestUrl) {
		deployment.distribution = { apiBaseUrl, downloadBaseUrl, jwksUrl, catalogManifestUrl };
	} else if (distributionParts.some(part => part !== undefined)) {
		// Distribution is signed and cross-checked as a unit: a manifest URL without its JWKS,
		// or an object store without its API, is not a usable half-configuration — it is a
		// configuration the operator will assume is working.
		throw invalidConfiguration(
			"AURA_DIST_API_URL/AURA_DIST_DOWNLOAD_URL/AURA_DIST_JWKS_URL/AURA_CATALOG_MANIFEST_URL",
			"all four distribution endpoints must be set together, or AURA_DOMAIN must supply them",
		);
	}
	return deployment;
}

/** Assign only when defined, so an absent tier leaves no `undefined`-valued key behind. */
function assign<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
	if (value !== undefined) target[key] = value;
}

// ═══════════════════════════════════════════════════════════════════════════
// Per-surface resolution
// ═══════════════════════════════════════════════════════════════════════════

const SURFACE_FIELD: Readonly<Record<AuraServiceSurface, keyof AuraDeployment>> = {
	auth: "authOrigin",
	sync: "syncOrigin",
	broker: "brokerBaseUrl",
	gateway: "gatewayBaseUrl",
	telemetry: "telemetryBaseUrl",
	qa: "qaEndpoint",
	collab: "collabOrigin",
};

/** Non-empty explicit value, tagged with the tier it came from. Never re-validated. */
function explicit(url: string | undefined, source: EndpointSource): ResolvedEndpoint | undefined {
	if (url === undefined) return undefined;
	const trimmed = url.trim();
	return trimmed === "" ? undefined : { url: trimmed, source };
}

/**
 * Pick the winning endpoint for one surface.
 *
 * The chain is per-call → persisted → Aura (override, then domain) → legacy for every surface
 * except QA, where the legacy alias `PI_AUTO_QA_PUSH_URL` deliberately sits *above* the
 * `dev.autoqaPush.endpoint` setting and above the domain derivation, and only the exact
 * `AURA_QA_URL` outranks it. The `source` recorded on the deployment is what lets one function
 * express both orders: an `aura_env` QA endpoint is the operator naming Aura explicitly, a
 * `domain` one is only an inference.
 *
 * Explicit tiers are returned as given (whitespace-trimmed). They are not held to Aura's URL
 * rules, because they are exactly the values operators already configured — `wss://` relays,
 * plain-HTTP internal brokers — and a switch or a rebrand must not retroactively invalidate
 * them.
 */
export function resolveServiceEndpoint(
	surface: AuraServiceSurface,
	input: { deployment: AuraDeployment; perCallUrl?: string; persistedUrl?: string; legacyUrl?: string },
): ResolvedEndpoint | undefined {
	const { deployment, perCallUrl, persistedUrl, legacyUrl } = input;
	const aura = deployment[SURFACE_FIELD[surface]] as ResolvedEndpoint | undefined;
	const call = explicit(perCallUrl, "call");
	const setting = explicit(persistedUrl, "setting");
	const legacy = explicit(legacyUrl, "legacy_env");

	if (surface === "qa") {
		const auraVariable = aura?.source === "aura_env" ? aura : undefined;
		const auraDomain = aura?.source === "domain" ? aura : undefined;
		return call ?? auraVariable ?? legacy ?? setting ?? auraDomain;
	}
	return call ?? setting ?? aura ?? legacy;
}

// ═══════════════════════════════════════════════════════════════════════════
// Cloud switches
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A consumer of Aura endpoints, one per `cloud.*.enabled` switch.
 *
 * Finer-grained than {@link AuraServiceSurface} on purpose: collab and share both read the
 * collab origin, and the three distribution consumers all read the distribution block, but
 * each is switchable on its own. That is why gating is expressed as a per-consumer *view* of
 * the deployment rather than as a mutation of the shared object.
 */
export type CloudConsumer =
	| "account"
	| "broker"
	| "gateway"
	| "settingsSync"
	| "telemetry"
	| "qa"
	| "collab"
	| "share"
	| "distribution"
	| "runtimeMirror"
	| "catalogMirror";

/** The settings path that owns each consumer's switch. */
export const CLOUD_CONSUMER_SETTINGS = {
	account: "cloud.account.enabled",
	broker: "cloud.broker.enabled",
	gateway: "cloud.gateway.enabled",
	settingsSync: "cloud.settingsSync.enabled",
	telemetry: "cloud.telemetry.enabled",
	qa: "cloud.qa.enabled",
	collab: "cloud.collab.enabled",
	share: "cloud.share.enabled",
	distribution: "cloud.distribution.enabled",
	runtimeMirror: "cloud.runtimeMirror.enabled",
	catalogMirror: "cloud.catalogMirror.enabled",
} as const satisfies Readonly<Record<CloudConsumer, `cloud.${string}.enabled`>>;

/** A `cloud.*.enabled` settings path. */
export type CloudSwitchPath = (typeof CLOUD_CONSUMER_SETTINGS)[CloudConsumer];

/**
 * Defaults, mirroring the schema.
 *
 * Gateway, settings sync and telemetry are off: each ships data outward that the user has not
 * asked to ship. Telemetry in particular stays opt-in after login and after a domain is
 * configured — being signed in is not consent to be measured.
 */
export const CLOUD_SWITCH_DEFAULTS = {
	account: true,
	broker: true,
	gateway: false,
	settingsSync: false,
	telemetry: false,
	qa: true,
	collab: true,
	share: true,
	distribution: true,
	runtimeMirror: true,
	catalogMirror: true,
} as const satisfies Readonly<Record<CloudConsumer, boolean>>;

/** Per-consumer switch state; an omitted consumer falls back to {@link CLOUD_SWITCH_DEFAULTS}. */
export type CloudSwitches = Partial<Record<CloudConsumer, boolean>>;

/**
 * Minimal read surface over settings.
 *
 * Structural rather than an import of `Settings`, so this module stays free of the config
 * layer and cheap to pull onto any call graph.
 */
export interface CloudSwitchReader {
	get(path: CloudSwitchPath): boolean | undefined;
}

/** Snapshot every switch from settings, defaulting anything unset. */
export function readCloudSwitches(settings: CloudSwitchReader): CloudSwitches {
	const switches: CloudSwitches = {};
	for (const consumer of Object.keys(CLOUD_CONSUMER_SETTINGS) as CloudConsumer[]) {
		const value = settings.get(CLOUD_CONSUMER_SETTINGS[consumer]);
		switches[consumer] = typeof value === "boolean" ? value : CLOUD_SWITCH_DEFAULTS[consumer];
	}
	return switches;
}

/** Which single deployment field each consumer is entitled to read. */
const CONSUMER_FIELD: Readonly<Record<CloudConsumer, keyof AuraDeployment>> = {
	account: "authOrigin",
	broker: "brokerBaseUrl",
	gateway: "gatewayBaseUrl",
	settingsSync: "syncOrigin",
	telemetry: "telemetryBaseUrl",
	qa: "qaEndpoint",
	collab: "collabOrigin",
	share: "collabOrigin",
	distribution: "distribution",
	runtimeMirror: "distribution",
	catalogMirror: "distribution",
};

/**
 * Project a deployment down to what one consumer may use.
 *
 * Returns a deployment carrying the consumer's own field and nothing else — and not even that
 * when the consumer's switch is off. Two properties follow, and both are load-bearing:
 *
 *  - Switching `cloud.collab.enabled` off cannot disturb share, and switching
 *    `cloud.catalogMirror.enabled` off cannot disturb runtime downloads, even though those
 *    consumers read the same underlying field.
 *  - A disabled consumer holds a deployment with no Aura endpoint in it at all, so the only
 *    thing {@link resolveServiceEndpoint} can hand it is a per-call, persisted or legacy
 *    value. A switch cannot reach those tiers because it never sees them.
 *
 * `domain` is retained as metadata (a consumer may want to name the deployment in a message);
 * it is inert, since no exported function turns a domain into a URL for an arbitrary surface.
 */
export function auraDeploymentFor(
	consumer: CloudConsumer,
	deployment: AuraDeployment,
	switches: CloudSwitches = {},
): AuraDeployment {
	const enabled = switches[consumer] ?? CLOUD_SWITCH_DEFAULTS[consumer];
	const view: { -readonly [K in keyof AuraDeployment]?: AuraDeployment[K] } = {};
	if (deployment.domain !== undefined) view.domain = deployment.domain;
	if (!enabled) return view;
	const field = CONSUMER_FIELD[consumer];
	const value = deployment[field];
	if (value !== undefined) (view as Record<string, unknown>)[field] = value;
	return view;
}

// ═══════════════════════════════════════════════════════════════════════════
// QA
// ═══════════════════════════════════════════════════════════════════════════

/** A QA push token plus the tier it came from. */
export interface ResolvedQaToken {
	readonly value: string;
	readonly source: "aura_env" | "legacy_env" | "setting";
}

/** The QA push destination and credential, or nothing at all. */
export interface ResolvedQaConfiguration {
	readonly endpoint?: ResolvedEndpoint;
	readonly token?: ResolvedQaToken;
}

/**
 * Resolve the QA push endpoint and token together.
 *
 * QA is the one surface with a canonical Aura variable *and* a legacy alias that operators
 * already point at their own collector. When both are set they must agree byte for byte; a
 * disagreement is an error rather than a silent choice, because either choice would ship
 * grievance reports to a host the operator did not pick. The check runs here, before any
 * request is built, and deliberately not inside {@link resolveAuraDeployment}: a QA-only
 * conflict must not take auth, sync or distribution down with it.
 *
 * No tier here carries or receives Aura account authentication — the token is an operator
 * credential for their own collector, nothing more.
 *
 * Pass a deployment already narrowed by {@link auraDeploymentFor}: with `cloud.qa.enabled`
 * off, the Aura tiers are simply absent and the legacy/setting tiers stay in operator hands.
 * With no tier configured at all, `endpoint` is `undefined` and consented reports stay queued
 * with zero network traffic.
 */
export function resolveQaConfiguration(input: {
	deployment: AuraDeployment;
	env: EnvView;
	settingUrl?: string;
	settingToken?: string;
}): ResolvedQaConfiguration {
	const { deployment, env, settingUrl, settingToken } = input;

	const auraUrl = readEnv(env, "AURA_QA_URL");
	const legacyUrl = readEnv(env, "PI_AUTO_QA_PUSH_URL");
	if (auraUrl !== undefined && legacyUrl !== undefined && auraUrl !== legacyUrl) {
		throw invalidConfiguration("AURA_QA_URL/PI_AUTO_QA_PUSH_URL", "are both set and disagree");
	}
	const auraToken = readEnv(env, "AURA_QA_TOKEN");
	const legacyToken = readEnv(env, "PI_AUTO_QA_PUSH_TOKEN");
	if (auraToken !== undefined && legacyToken !== undefined && auraToken !== legacyToken) {
		throw invalidConfiguration("AURA_QA_TOKEN/PI_AUTO_QA_PUSH_TOKEN", "are both set and disagree");
	}

	const endpoint = resolveServiceEndpoint("qa", { deployment, persistedUrl: settingUrl, legacyUrl });

	let token: ResolvedQaToken | undefined;
	if (auraToken !== undefined) token = { value: auraToken, source: "aura_env" };
	else if (legacyToken !== undefined) token = { value: legacyToken, source: "legacy_env" };
	else if (settingToken !== undefined && settingToken.trim() !== "") {
		token = { value: settingToken.trim(), source: "setting" };
	}

	const config: { endpoint?: ResolvedEndpoint; token?: ResolvedQaToken } = {};
	if (endpoint !== undefined) config.endpoint = endpoint;
	if (token !== undefined) config.token = token;
	return config;
}
