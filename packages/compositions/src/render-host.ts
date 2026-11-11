// Node-side helpers of the engine's Remotion renders.
//
// Chrome-for-testing paints only visible tabs. Remotion may capture an initial frame immediately after
// activating a tab, before its first raster. Separate windows keep concurrent render pages visible.
// The headless shell has no tabs and does not need this patch.
import type { VideoConfig } from 'remotion';
import { sequenceMetadata } from './metadata.ts';
import { type RenderDoc, SEQUENCE_COMPOSITION_ID, SEQUENCE_DEFAULT_PROPS } from './types.ts';

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

/**
 * The `JasperSequence` composition of a render's input props, as `selectComposition` resolves it in the bundle
 * (`remotion_calculateComposition`: the props are the default props overridden by the input props, the size, fps and
 * duration `calculateSequenceMetadata` of the document, no defaults for codec or formats) — without opening a page.
 * Null when the props carry no document with settings and a duration (the caller then asks the bundle).
 */
export function sequenceComposition(inputProps: Record<string, unknown>): VideoConfig | null {
	const doc = inputProps.doc as Partial<RenderDoc> | undefined;
	const s = doc?.settings;
	if (
		!s ||
		typeof doc.durationFrames !== 'number' ||
		typeof s.width !== 'number' ||
		typeof s.height !== 'number' ||
		typeof s.fps?.num !== 'number' ||
		typeof s.fps.den !== 'number'
	)
		return null;
	return {
		id: SEQUENCE_COMPOSITION_ID,
		...sequenceMetadata({ settings: s, durationFrames: doc.durationFrames }),
		props: { ...SEQUENCE_DEFAULT_PROPS, ...inputProps },
		defaultProps: SEQUENCE_DEFAULT_PROPS,
		defaultCodec: null,
		defaultOutName: null,
		defaultVideoImageFormat: null,
		defaultPixelFormat: null,
		defaultProResProfile: null,
		defaultSampleRate: null,
	};
}
