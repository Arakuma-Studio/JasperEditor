// Font loading for text layers (S03:TXT-005, KND-050). Every face listed in `RenderDoc.fonts` is loaded
// before the frame renders: `delayRender` holds renders (and stills) until the FontFace resolves.
//
// We register faces with the FontFace API ourselves instead of calling `@remotion/fonts` `loadFont`
// because that helper calls `cancelRender` when a face fails to load, which would abort a whole export
// for one missing font; S03:TXT-005 wants a fallback to the default sans font instead. The format is
// derived from the URL extension the same way `@remotion/fonts` does, when possible.
import { useEffect, useState } from 'react';
import { continueRender, delayRender } from 'remotion';
import type { RenderDoc } from './types.ts';

export type FontFaceSpec = RenderDoc['fonts'][number];

/** Fallback stack appended to every family (S03:TXT-005). */
export const FALLBACK_FONT_STACK = '"Source Sans 3", "Source Sans Pro", Arial, Helvetica, sans-serif';

const loaded = new Map<string, Promise<boolean>>();

export function fontKey(f: Pick<FontFaceSpec, 'family' | 'weight' | 'style' | 'url'>): string {
	return `${f.family}|${f.weight}|${f.style}|${f.url}`;
}

/** CSS `format()` hint from the URL extension, or undefined when unknown. */
export function fontFormatFromUrl(url: string): string | undefined {
	const ext = url.split(/[?#]/)[0]!.split('.').pop()?.toLowerCase();
	switch (ext) {
		case 'woff2':
			return 'woff2';
		case 'woff':
			return 'woff';
		case 'otf':
			return 'opentype';
		case 'ttf':
			return 'truetype';
		default:
			return undefined;
	}
}

/** Loads one face once per page; resolves false (never rejects) when it cannot be loaded. */
export function loadFontFace(f: FontFaceSpec): Promise<boolean> {
	const key = fontKey(f);
	const existing = loaded.get(key);
	if (existing) return existing;
	const p = (async () => {
		if (typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) return false;
		try {
			const format = fontFormatFromUrl(f.url);
			const src = format ? `url('${f.url}') format('${format}')` : `url('${f.url}')`;
			const face = new FontFace(f.family, src, { weight: String(f.weight), style: f.style });
			await face.load();
			document.fonts.add(face);
			return true;
		} catch {
			return false;
		}
	})();
	loaded.set(key, p);
	return p;
}

/**
 * Holds rendering until the document's fonts are loaded (or failed; failed faces fall back to
 * FALLBACK_FONT_STACK). `fonts` should keep its identity while unchanged (see stabilizeRenderDoc).
 */
export function useDocumentFonts(fonts: readonly FontFaceSpec[]): void {
	const [handle] = useState(() => (fonts.length ? delayRender('Loading fonts') : null));
	useEffect(() => {
		let cancelled = false;
		const done = () => {
			if (handle !== null) continueRender(handle);
		};
		if (fonts.length === 0) {
			done();
			return;
		}
		const inner = delayRender(`Loading ${fonts.length} font face(s)`);
		void Promise.all(fonts.map(loadFontFace)).then(() => {
			if (!cancelled) {
				continueRender(inner);
				done();
			}
		});
		return () => {
			cancelled = true;
			continueRender(inner);
			// Release the mount-time handle too: on unmount before the fonts resolve it would otherwise
			// never be continued. A re-run with new fonts is held by its own `inner` handle.
			done();
		};
	}, [fonts, handle]);
}
