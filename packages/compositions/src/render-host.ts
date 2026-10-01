// Render host (S11:ANM-014): how a browser driven by `@remotion/renderer` must be set up so that every captured frame
// is the finished paint of that frame. Node-side (no DOM, no imports): used by the engine and the parity e2e.
//
// With a full Chrome (Remotion's `chromeMode: 'chrome-for-testing'`, i.e. `--headless=new`), Remotion opens the
// pages of a render with `concurrency > 1` as tabs of one window: only the tab last brought to the front is visible,
// the others are hidden and are not painted. Remotion releases a page's first frame at once (its `setFrame` to the
// page's initial frame is a no-op) and captures it right after `Target.activateTarget` showed the tab, so the
// screenshot raced Chrome's first raster of that page: a black frame, or the text layers without the templates and
// shapes above them (1–3 of the first 4 frames of a renderFrames/renderMedia at concurrency 4 on a loaded box).
// Pages in their own windows are never hidden. Remotion's own chrome-headless-shell (`--headless=old`) has no tabs
// and needs nothing.

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
