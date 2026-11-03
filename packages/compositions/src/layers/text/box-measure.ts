// Text box measurer (S01:KND-006, spec 13 SH-004, docs/wp-notes/text-render.md): the size of a text as the text
// layer lays it out — the same block CSS (`block.ts`) or, for extended typography, the same typeset layout
// (`measure.ts`) — in the browser, with the font faces the renderers load (same family names, same files, same
// Chromium shaping). The editor session measures in its own page (`createDomTextMeasurer`); the engine measures
// in its headless browser through the bundle's `__jasperTextMeasure` hook (`installTextMeasureHook`), so a clip
// gets the same box whoever creates it.
//
// Box semantics: point text (`autoSize: 'width'`) = the widest line × the block height (no wrapping); paragraph text
// (`'height'`) = the block height at `box.width`. Sizes are whole pixels (rounded up), so a re-measure of the same
// text gives the same box and the box covers the line boxes it lays out.
import {
	type FontRef,
	isVerticalText,
	type TextBox,
	type TextContent,
	type TextMeasurer,
	type TextStyle,
} from '@jasper/project';
import { fontFaceFor, isFontFaceSettled, loadFontFace } from '../../fonts.ts';
import type { RenderDoc } from '../../types.ts';
import {
	blockStyles,
	contentSpans,
	runLayoutCss,
	textBlockStyle,
	textFontFamily,
	UPRIGHT_TEXT_CSS,
} from './block.ts';
import { applyCss, measureTypeset, textMeasureHost } from './measure.ts';
import { needsTypeset } from './typography.ts';

export type MeasureFace = RenderDoc['fonts'][number];
export type MeasuredBox = { width: number; height: number };

/** Whole pixels, rounded up (a hair of float noise does not add a pixel). */
const up = (v: number) => Math.max(0, Math.ceil(v - 0.01));

/** The faces of `faces` a content draws with (base style and runs), as the renderers pick them. */
export function contentFaces(content: TextContent, faces: readonly MeasureFace[]): MeasureFace[] {
	const used = new Set<MeasureFace>();
	for (const s of blockStyles(content)) {
		const f = fontFaceFor(faces, s.fontId, s.weight, s.italic);
		if (f) used.add(f);
	}
	return [...used];
}

/**
 * Lays `content` out like the text layer draws it with `faces` and returns its box size. Null while a face is still
 * loading (its load starts; measure again once `whenFacesSettled` resolves). Browser only.
 */
export function measureTextBox(
	content: TextContent,
	box: Pick<TextBox, 'width' | 'autoSize'> & Partial<Pick<TextBox, 'height'>>,
	faces: readonly MeasureFace[],
): MeasuredBox | null {
	if (typeof document === 'undefined' || !document.body) return null;
	const used = contentFaces(content, faces);
	let pending = false;
	for (const f of used)
		if (!isFontFaceSettled(f)) {
			pending = true;
			void loadFontFace(f);
		}
	if (pending) return null;
	const pointText = box.autoSize === 'width';
	const width = Math.max(1, Number.isFinite(box.width) ? box.width : 1);
	// spec 19 TL-111: columns wrap at the box height and the width follows them.
	const vertical = isVerticalText(content);
	const height = Math.max(1, Number.isFinite(box.height) ? (box.height as number) : 1);
	if (needsTypeset({ text: content })) {
		const family = (s: Pick<TextStyle, 'fontId' | 'weight' | 'italic'>) =>
			textFontFamily(s.fontId, faces, s.weight, s.italic);
		const across = vertical ? height : width;
		const key = JSON.stringify(['box', content, pointText ? 0 : across, faces.map((f) => [f.family, f.url])]);
		const lay = measureTypeset({ content, width, height, pointText, family }, key);
		let left = Number.POSITIVE_INFINITY;
		let right = 0;
		let bottom = 0;
		for (const g of lay.glyphs) {
			if (!g.rect) continue;
			left = Math.min(left, g.rect.left);
			right = Math.max(right, g.rect.left + g.rect.width);
			bottom = Math.max(bottom, g.rect.top + g.rect.height);
		}
		if (vertical)
			return { width: up(Number.isFinite(left) ? right - left : 0), height: up(pointText ? bottom : height) };
		return { width: up(pointText ? right : width), height: up(bottom) };
	}
	const p = document.createElement('p');
	applyCss(p, {
		...textBlockStyle({ text: content, box: { autoSize: box.autoSize } }, faces),
		...(vertical
			? {
					left: 0,
					right: 'auto',
					width: 'max-content',
					minWidth: 0,
					height: pointText ? 'max-content' : height,
				}
			: { width: pointText ? 'max-content' : `${width}px`, minHeight: 0, height: 'auto' }),
		contain: 'layout style',
	});
	const spans = content.runs?.length || vertical ? contentSpans(content) : null;
	if (!spans) p.textContent = content.text;
	else
		for (const s of spans) {
			const piece = content.text.slice(s.from, s.to);
			if (!s.style && !s.upright) p.append(document.createTextNode(piece));
			else {
				const span = document.createElement('span');
				applyCss(span, {
					...(s.style ? runLayoutCss(s.style, content.style, faces) : {}),
					...(s.upright ? UPRIGHT_TEXT_CSS : {}),
				});
				span.textContent = piece;
				p.append(span);
			}
		}
	textMeasureHost().append(p);
	const r = p.getBoundingClientRect();
	p.remove();
	if (vertical) return { width: up(r.width), height: up(pointText ? r.height : height) };
	return { width: up(pointText ? r.width : width), height: up(r.height) };
}

/** Resolves once every face of `faces` has settled (loaded or failed). */
export function whenFacesSettled(faces: readonly MeasureFace[]): Promise<void> {
	return Promise.all(faces.map((f) => loadFontFace(f))).then(() => undefined);
}

/** URL of the face a document font draws with at a weight / style; null = none (fallback stack); 'pending' = not known yet. */
export type FaceUrlResolver = (font: FontRef, weight: number, italic: boolean) => string | null | 'pending';

/** The faces a content needs from a document font table (as `buildRenderSnapshot` resolves them); null = pending. */
export function facesFor(
	content: TextContent,
	fonts: Readonly<Record<string, FontRef>>,
	faceUrl: FaceUrlResolver,
): MeasureFace[] | null {
	const out = new Map<string, MeasureFace>();
	for (const s of blockStyles(content)) {
		const font = fonts[s.fontId];
		if (!font) continue;
		const key = `${font.id}:${s.weight}:${s.italic}`;
		if (out.has(key)) continue;
		const url = faceUrl(font, s.weight, s.italic);
		if (url === 'pending') return null;
		if (url)
			out.set(key, {
				fontId: font.id,
				family: font.family,
				weight: s.weight,
				style: s.italic ? 'italic' : 'normal',
				url,
			});
	}
	return [...out.values()];
}

/** A measurer that tells when measurements it could not make (faces loading, fonts unknown) may now succeed. */
export type DomTextMeasurer = TextMeasurer & {
	/** Called when faces it started loading have settled, or after `notify()`. */
	onSettled(listener: () => void): () => void;
	/** The host learnt something that may unblock measurements (e.g. the font catalog loaded). */
	notify(): void;
};

/** The editor's measurer: lays text out in this page with the faces `faceUrl` names. */
export function createDomTextMeasurer(faceUrl: FaceUrlResolver): DomTextMeasurer {
	const listeners = new Set<() => void>();
	const fire = () => {
		for (const l of [...listeners]) {
			try {
				l();
			} catch {
				// a listener's failure must not stop the others
			}
		}
	};
	return {
		measure(content, box, fonts) {
			const faces = facesFor(content, fonts, faceUrl);
			if (!faces) return null;
			const r = measureTextBox(content, box, faces);
			if (!r) void whenFacesSettled(contentFaces(content, faces)).then(fire);
			return r;
		},
		onSettled(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		notify: fire,
	};
}

/** One measurement of the engine's batch (`__jasperTextMeasure.measure`). */
export type TextMeasureJob = {
	content: TextContent;
	box: Pick<TextBox, 'width' | 'autoSize'> & Partial<Pick<TextBox, 'height'>>;
	faces: MeasureFace[];
};

/**
 * Installs `window.__jasperTextMeasure` (the Remotion bundle's page, used by the engine's headless measurer):
 * `measure(jobs)` loads every face, then measures each job (null = could not measure).
 */
export function installTextMeasureHook(): void {
	if (typeof window === 'undefined') return;
	const w = window as unknown as { __jasperTextMeasure?: unknown };
	if (w.__jasperTextMeasure) return;
	w.__jasperTextMeasure = {
		async measure(jobs: TextMeasureJob[]): Promise<(MeasuredBox | null)[]> {
			const all = new Map<string, MeasureFace>();
			for (const j of jobs)
				for (const f of j.faces) all.set(`${f.family}|${f.weight}|${f.style}|${f.url}`, f);
			await whenFacesSettled([...all.values()]);
			if (document.fonts?.ready) await document.fonts.ready;
			return jobs.map((j) => {
				try {
					return measureTextBox(j.content, j.box, j.faces);
				} catch {
					return null;
				}
			});
		},
	};
}
