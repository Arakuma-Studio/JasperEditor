// Font loading for text layers (S03:TXT-005, KND-050). Every face listed in `RenderDoc.fonts` is loaded
// before the frame renders: `delayRender` holds renders (and stills) until the FontFace resolves.
//
// We register faces with the FontFace API ourselves instead of calling `@remotion/fonts` `loadFont`
// because that helper calls `cancelRender` when a face fails to load, which would abort a whole export
// for one missing font; S03:TXT-005 wants a fallback to the default sans font instead. The format is
// derived from the URL extension the same way `@remotion/fonts` does, when possible.
//
// Readiness is tracked per face (family / weight / style). Font-dependent layers (text, anime
// templates) are not mounted until their faces have settled, so they never split, measure or build timelines
// with a fallback font and the Player shows nothing rather than a fallback-font flash; renders and stills are
// held by a `delayRender` handle created in a layout effect (never in a state initializer, which StrictMode and
// concurrent rendering may run more than once and leak) and continued only after the commit that mounts them.
import type { RenderVisualClip } from '@jasper/project';
import { createContext, useContext, useLayoutEffect, useMemo, useReducer } from 'react';
import { useDelayRender } from 'remotion';
import type { RenderDoc } from './types.ts';

type FontFaceSpec = RenderDoc['fonts'][number];

/** Fallback stack appended to every family (S03:TXT-005). */
export const FALLBACK_FONT_STACK = '"Source Sans 3", "Source Sans Pro", Arial, Helvetica, sans-serif';

const faceKey = (f: FontFaceSpec) => `${f.family}|${f.weight}|${f.style}|${f.url}`;
const loaded = new Map<string, Promise<boolean>>();
/** Faces whose load has finished on this page (loaded, or failed → fallback stack). */
const settledFaces = new Set<string>();

/** CSS `format()` hint from the URL extension, or undefined when unknown. */
function fontFormatFromUrl(url: string): string | undefined {
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

/** True when a face's load has finished on this page (loaded, or failed → fallback stack). */
export function isFontFaceSettled(f: FontFaceSpec): boolean {
	return settledFaces.has(faceKey(f));
}

/** Loads one face once per page; resolves false (never rejects) when it cannot be loaded. */
export function loadFontFace(f: FontFaceSpec): Promise<boolean> {
	const key = faceKey(f);
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
	})().then((ok) => {
		settledFaces.add(key);
		return ok;
	});
	loaded.set(key, p);
	return p;
}

/** A face a layer depends on; omitted weight/style = every face of the family. */
export type FontFaceQuery = { family: string; weight?: number; style?: 'normal' | 'italic' };

/**
 * Font readiness for font-dependent layers (S11:FIX-003, ARCHITECTURE §20.4): text and anime-template layers do
 * not split, measure or build timelines before their faces are loaded. Provided by SequenceComposition from
 * `useFontsReadyState`. Without a provider every face counts as loaded (standalone layers, tests).
 */
export type FontsReadyState = {
	/** Every face of the document has settled (loaded or failed → fallback stack). */
	allLoaded: boolean;
	/**
	 * Per-face readiness: true when every document face of `family` (narrowed to `weight` / `style` when given)
	 * has settled; true for faces the document does not load. Falls back to `allLoaded` when absent.
	 */
	isLoaded?(family: string, weight?: number, style?: 'normal' | 'italic'): boolean;
};
export const FontsReadyContext = createContext<FontsReadyState>({ allLoaded: true });

/** True when every given face (a family name, or a family / weight / style query) has settled. */
export function useFontsReady(faces: readonly (string | FontFaceQuery)[]): boolean {
	const state = useContext(FontsReadyContext);
	return faces.every((f) => {
		if (!state.isLoaded) return state.allLoaded;
		return typeof f === 'string' ? state.isLoaded(f) : state.isLoaded(f.family, f.weight, f.style);
	});
}

/** The document face a style uses: exact weight/style, else any face of the font (as TextLayer resolves it). */
export function fontFaceFor(
	fonts: readonly FontFaceSpec[] | undefined,
	fontId: string,
	weight?: number,
	italic?: boolean,
): FontFaceSpec | undefined {
	const all = fonts ?? [];
	return (
		all.find(
			(f) =>
				f.fontId === fontId &&
				(weight === undefined || f.weight === weight) &&
				(italic === undefined || (f.style === 'italic') === italic),
		) ?? all.find((f) => f.fontId === fontId)
	);
}

function stringsIn(v: unknown, out: Set<string>): Set<string> {
	if (typeof v === 'string') out.add(v);
	else if (Array.isArray(v)) for (const x of v) stringsIn(x, out);
	else if (v && typeof v === 'object') for (const x of Object.values(v)) stringsIn(x, out);
	return out;
}

/**
 * Faces a layer draws with (S11:FIX-003): a text clip's style and its styled runs; an anime template's params
 * naming a document font (by font id or family). Other layers draw no text from document fonts.
 */
function layerFontFaces(
	clip: Pick<RenderVisualClip, 'source'>,
	fonts: readonly FontFaceSpec[] | undefined,
): FontFaceQuery[] {
	const src = clip.source;
	const faces = new Map<string, FontFaceQuery>();
	const add = (f: FontFaceSpec | undefined) => {
		if (f) faces.set(faceKey(f), { family: f.family, weight: f.weight, style: f.style });
	};
	if ('text' in src) {
		const s = src.text.style;
		add(fontFaceFor(fonts, s.fontId, s.weight, s.italic));
		for (const run of src.text.runs ?? [])
			add(
				fontFaceFor(
					fonts,
					run.style.fontId ?? s.fontId,
					run.style.weight ?? s.weight,
					run.style.italic ?? s.italic,
				),
			);
	} else if ('captions' in src) {
		// Caption markup can select bold and italic faces beyond the base style.
		const s = src.captions.style;
		for (const [w, it] of [
			[s.weight, s.italic],
			[Math.max(s.weight, 700), s.italic],
			[s.weight, true],
		] as const) {
			const f = fontFaceFor(fonts, s.fontId, w, it);
			if (f && f.weight === w && (f.style === 'italic') === it) add(f);
		}
		add(fontFaceFor(fonts, s.fontId, s.weight, s.italic));
	} else if ('mg' in src && src.mg.renderer === 'anime') {
		const named = stringsIn(src.mg.params, new Set());
		for (const f of fonts ?? []) if (named.has(f.fontId) || named.has(f.family)) add(f);
	}
	return [...faces.values()];
}

/** Whether the faces `clip` draws with have settled (FontsReadyContext); layers render nothing until then. */
export function useLayerFontsReady(
	clip: Pick<RenderVisualClip, 'source'>,
	fonts: readonly FontFaceSpec[] | undefined,
): boolean {
	const faces = useMemo(() => layerFontFaces(clip, fonts), [clip, fonts]);
	return useFontsReady(faces);
}

/**
 * Loads the document's faces and reports their readiness per face (FontsReadyContext value). Holds rendering
 * with one `delayRender` handle while faces are pending; the handle is created in a layout effect (StrictMode
 * re-runs release and re-create it) and continued by the commit that first renders every face as settled — the
 * one that mounts the gated layers with their real fonts (layout effects and their synchronous re-renders run in
 * the same task, before the renderer can see the frame as ready). `fonts` should keep its identity while
 * unchanged (see stabilizeRenderDoc).
 */
export function useFontsReadyState(fonts: readonly FontFaceSpec[]): FontsReadyState {
	const { delayRender, continueRender } = useDelayRender();
	const [version, bump] = useReducer((n: number) => n + 1, 0);
	const allLoaded = fonts.every((f) => settledFaces.has(faceKey(f)));
	// Re-run when the rendered readiness flips: the commit that renders `allLoaded` (and mounts the gated
	// layers) releases the handle in this effect's cleanup.
	useLayoutEffect(() => {
		if (fonts.every((f) => settledFaces.has(faceKey(f)))) {
			// settled between render and commit: render again with the faces loaded
			if (!allLoaded) bump();
			return;
		}
		let cancelled = false;
		const handle = delayRender(`Loading ${fonts.length} font face(s)`);
		for (const f of fonts) void loadFontFace(f).then(() => !cancelled && bump());
		return () => {
			cancelled = true;
			continueRender(handle);
		};
	}, [fonts, allLoaded, delayRender, continueRender]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `version` changes when a face settles
	return useMemo<FontsReadyState>(
		() => ({
			allLoaded: fonts.every((f) => settledFaces.has(faceKey(f))),
			isLoaded: (family, weight, style) =>
				fonts
					.filter(
						(f) =>
							f.family === family &&
							(weight === undefined || f.weight === weight) &&
							(style === undefined || f.style === style),
					)
					.every((f) => settledFaces.has(faceKey(f))),
		}),
		[fonts, version],
	);
}
