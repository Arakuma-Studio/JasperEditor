// How long Playwright waits for `e2e/serve.mjs` to answer `/health` before it gives up on the run.
// The stock 60 s was too short on a loaded shared host (the engine and web build start-up took up to 600 s at load
// 100+), so the default is 180 s and `E2E_SERVER_TIMEOUT_MS` raises or lowers it for one run.

/** Default web-server start-up timeout in milliseconds. */
export const E2E_SERVER_TIMEOUT_DEFAULT_MS = 180_000;
/** Accepted range for `E2E_SERVER_TIMEOUT_MS` (1 s … 1 h). */
export const E2E_SERVER_TIMEOUT_MIN_MS = 1_000;
export const E2E_SERVER_TIMEOUT_MAX_MS = 3_600_000;

/**
 * Reads `E2E_SERVER_TIMEOUT_MS`. Unset or empty gives the default; anything that is not a whole number of
 * milliseconds inside the accepted range is refused with a message naming the variable (a typo must not quietly
 * fall back to a timeout the run did not ask for).
 */
export function e2eServerTimeoutMs(env: Record<string, string | undefined> = process.env): number {
	const raw = env.E2E_SERVER_TIMEOUT_MS?.trim();
	if (raw === undefined || raw === '') return E2E_SERVER_TIMEOUT_DEFAULT_MS;
	if (!/^\d+$/.test(raw)) {
		throw new Error(
			`E2E_SERVER_TIMEOUT_MS must be a whole number of milliseconds, got "${raw.slice(0, 40)}"`,
		);
	}
	const ms = Number(raw);
	if (ms < E2E_SERVER_TIMEOUT_MIN_MS || ms > E2E_SERVER_TIMEOUT_MAX_MS) {
		throw new Error(
			`E2E_SERVER_TIMEOUT_MS must be between ${E2E_SERVER_TIMEOUT_MIN_MS} and ${E2E_SERVER_TIMEOUT_MAX_MS} ms, got ${raw}`,
		);
	}
	return ms;
}
