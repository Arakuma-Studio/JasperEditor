// Chrome-for-testing paints only visible tabs. Remotion may capture an initial frame immediately after
// activating a tab, before its first raster. Separate windows keep concurrent render pages visible.
// The headless shell has no tabs and does not need this patch.
/** The CDP connection of a browser returned by `@remotion/renderer`'s `openBrowser` (4.0.499: `browser.connection`). */
type CdpConnection = { send(method: string, ...rest: unknown[]): Promise<unknown> };

const PATCHED = Symbol.for('jasper.renderPagesInOwnWindows');

/**
 * Makes a browser opened with `@remotion/renderer`'s `openBrowser` create every page in its own window
 * (`Target.createTarget` with `newWindow: true`), for `chromeMode: 'chrome-for-testing'`. Idempotent. Returns false
 * (and changes nothing) when the browser does not expose the CDP connection this relies on.
 */
export function renderPagesInOwnWindows(browser: unknown): boolean {
	const conn = (browser as { connection?: CdpConnection } | null | undefined)?.connection;
	if (!conn || typeof conn.send !== 'function') return false;
	const marked = conn as CdpConnection & { [PATCHED]?: true };
	if (marked[PATCHED]) return true;
	const send = conn.send.bind(conn);
	conn.send = (method: string, ...rest: unknown[]) =>
		method === 'Target.createTarget'
			? send(
					method,
					{ ...(rest[0] as Record<string, unknown> | undefined), newWindow: true },
					...rest.slice(1),
				)
			: send(method, ...rest);
	marked[PATCHED] = true;
	return true;
}
