/**
 * Predicates and normalizers shared by the cloud client's three runtime modules.
 *
 * Nothing here is exported from `index.ts`: this is an internal seam, not public surface. It
 * exists because `token-store.ts`, `token-manager.ts` and `auth.ts` each grew their own copy
 * of the same three helpers, and a duplicated *validator* is worse than a duplicated formatter
 * — the copies drift, and the module that drifts is the one that stops rejecting something.
 *
 * The one dependency is `errors.ts`, so this module stays as cheap and side-effect-free as the
 * error taxonomy itself and can be imported from anywhere in the layer.
 */

import { AuraCloudError } from "./errors";

/**
 * Crockford base32 ULID, uppercase, exactly 26 characters.
 *
 * Every identity field the server sends — device, user, org, account, realm — is a ULID, and
 * this is the only definition of that shape in the layer. It is deliberately strict: `I`, `L`,
 * `O` and `U` are excluded by Crockford's alphabet, so a lookalike substitution is a rejection
 * rather than a different-but-valid id.
 */
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Whether `value` is a ULID string. */
export function isUlid(value: unknown): value is string {
	return typeof value === "string" && ULID_RE.test(value);
}

/**
 * A JSON object, and not an array.
 *
 * Excluding arrays matters: `typeof [] === "object"` and `[] !== null`, so the naive check
 * lets an array through to code that then reads named properties off it and finds `undefined`
 * everywhere — a malformed response that silently reads as an empty valid one.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reduce a configured origin to `scheme://host[:port]`, or reject it.
 *
 * `URL.origin` is `"null"` for opaque origins (`file:`, `data:`, anything non-special), which
 * would otherwise stringify into request URLs as the literal text `null`. Every failure is
 * `invalid_configuration`: reaching here with an unusable origin is an operator error, not a
 * server one.
 */
export function normalizeOrigin(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new AuraCloudError("invalid_configuration");
	}
	if (url.origin === "null") throw new AuraCloudError("invalid_configuration");
	return url.origin;
}
