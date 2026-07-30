import { afterEach, describe, expect, it, vi } from "bun:test";
import { runUpdateCommand } from "../../src/cli/update-cli";

type FetchInput = string | URL | Request;
type FetchInit = RequestInit | BunFetchRequestInit;

describe("runUpdateCommand fetch cancellation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("checks release metadata with a timeout signal", async () => {
		let requestSignal: AbortSignal | undefined;
		vi.spyOn(console, "log").mockImplementation(() => {});
		const fetchStub = Object.assign(
			async (_input: FetchInput, init?: FetchInit) => {
				requestSignal = init?.signal ?? undefined;
				// Answer in both release shapes so the stub stays valid whichever
				// DIST_UPDATE_CHANNEL is configured: the github channel reads
				// `tag_name` (and rejects anything that is not vX.Y.Z), npm reads
				// `version`. A payload for only one channel makes getLatestRelease
				// throw, and runUpdateCommand's failure path exits the process —
				// which kills the test runner outright, with no reported failure.
				return Response.json({ tag_name: "v999.0.0", version: "999.0.0" });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		await runUpdateCommand({ force: false, check: true });

		expect(requestSignal).toBeInstanceOf(AbortSignal);
	});
});
