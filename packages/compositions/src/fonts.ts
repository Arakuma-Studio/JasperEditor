// Font loading for text layers (S03:TXT-005, KND-050). Every face listed in `RenderDoc.fonts` is loaded
// before the frame renders: `delayRender` holds renders (and stills) until the FontFace resolves.
//
// We register faces with the FontFace API ourselves instead of calling `@remotion/fonts` `loadFont`
// because that helper calls `cancelRender` when a face fails to load, which would abort a whole export
// for one missing font; S03:TXT-005 wants a fallback to the default sans font instead. The format is
// derived from the URL extension the same way `@remotion/fonts` does, when possible.
import { createContext, useContext, useEffect, useState } from 'react';
import { continueRender, delayRender } from 'remotion';
import type { RenderDoc } from './types.ts';

type FontFaceSpec = RenderDoc['fonts'][number];

/** Fallback stack appended to every family (S03:TXT-005). */
export const FALLBACK_FONT_STACK = '"Source Sans 3", "Source Sans Pro", Arial, Helvetica, sans-serif';

const loaded = new Map<string, Promise<boolean>>();

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
function loadFontFace(f: FontFaceSpec): Promise<boolean> {
	const key = `${f.family}|${f.weight}|${f.style}|${f.url}`;
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
 * Font readiness for font-dependent layers (S11:FIX-003, ARCHITECTURE §20.4): text and anime-template layers do
 * not split, measure or build timelines before their faces are loaded. Provided by SequenceComposition from
 * `useDocumentFonts`. Contracts: one flag for the whole document; wp-m2-anime-core refines it per face
 * (`isLoaded`). Without a provider every family counts as loaded (standalone layers, tests).
 */
export type FontsReadyState = {
	/** Every face of the document has settled (loaded or failed → fallback stack). */
	allLoaded: boolean;
	/** Per-family readiness (optional refinement); falls back to `allLoaded`. */
	isLoaded?(family: string): boolean;
};
export const FontsReadyContext = createContext<FontsReadyState>({ allLoaded: true });

/** True when the faces of every given family have settled. */
export function useFontsReady(families: readonly string[]): boolean {
	const state = useContext(FontsReadyContext);
	return families.every((f) => (state.isLoaded ? state.isLoaded(f) : state.allLoaded));
}

/**
 * Holds rendering until the document's fonts are loaded (or failed; failed faces fall back to
 * FALLBACK_FONT_STACK). `fonts` should keep its identity while unchanged (see stabilizeRenderDoc).
 * Returns whether the current `fonts` have settled (M2, FontsReadyContext).
 */
export function useDocumentFonts(fonts: readonly FontFaceSpec[]): boolean {
	const [handle] = useState(() => (fonts.length ? delayRender('Loading fonts') : null));
	const [settled, setSettled] = useState<readonly FontFaceSpec[] | null>(null);
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
				setSettled(fonts);
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
	return fonts.length === 0 || settled === fonts;
}
