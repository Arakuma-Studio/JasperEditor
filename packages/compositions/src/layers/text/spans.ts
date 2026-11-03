// Spec 19 TL-036: what a text layer tells a look about its glyphs at this frame. Each drawing path (plain block, unit overlay
// of legacy text animations, typeset characters) knows where a glyph rests and how it is moved; this turns that into the
// records of `buildTextSpans`, reported in a layout effect, so the effect chain draws with them on the same paint. Only clips
// whose look has a gradient pay for any of it (`appearanceWantsTextSpans`).
import {
	buildTextSpans,
	type FxTextSpans,
	type PlacedGlyph,
	type SpanBox,
	type SpanGlyph,
	type TextRun,
	type TextStyle,
	textRunAt,
} from '@jasper/project';
import { useLayoutEffect } from 'react';
import { inkBounds, type TypesetLayout } from './measure.ts';

export type ReportSpans = (spans: FxTextSpans | null) => void;

const inkCache = new WeakMap<TypesetLayout, (SpanBox | null)[]>();

/** Ink box of every glyph at rest, text box px; null for spaces and glyphs that were not laid out. Once per layout. */
function inkBoxes(lay: TypesetLayout, family: (s: TextStyle) => string): (SpanBox | null)[] {
	const hit = inkCache.get(lay);
	if (hit) return hit;
	const out = lay.glyphs.map((g): SpanBox | null => {
		if (g.isSpace || !g.rect) return null;
		const s = lay.styles[g.style]!;
		const ink = inkBounds(g.text, s, family(s));
		const r = g.rect;
		// A column (TL-111) places each glyph by the middle of its cell, not on a horizontal baseline: its box is the
		// cell, which is where the glyph is drawn whether it stands upright or turns.
		if (lay.vertical) return [r.left, r.top, r.left + r.width, r.top + r.height];
		return ink
			? [r.left + ink.left, g.baseline - ink.ascent, r.left + ink.right, g.baseline + ink.descent]
			: [r.left, r.top, r.left + r.width, r.top + r.height];
	});
	inkCache.set(lay, out);
	return out;
}

/** TL-093: what the glyph at `offset` takes from its run: its finish, if the run gives one. */
function runFields(runs: readonly TextRun[] | undefined, offset: number): Pick<SpanGlyph, 'finish'> {
	const finish = runs?.length ? textRunAt(runs, offset)?.finish : undefined;
	return finish ? { finish } : {};
}

/** Text that is not moving: the plain block. `runs`: the content's (finishes per letter, TL-093). */
export function restSpans(
	lay: TypesetLayout,
	family: (s: TextStyle) => string,
	runs?: readonly TextRun[],
): FxTextSpans | null {
	const boxes = inkBoxes(lay, family);
	const out: SpanGlyph[] = [];
	lay.glyphs.forEach((g, i) => {
		const box = boxes[i];
		if (box) out.push({ box, line: g.lineIndex, ...runFields(runs, g.offset) });
	});
	return buildTextSpans(out);
}

/** An animated box of the unit overlay: its layout box, and rest → drawn, row-major 3×3; null when not drawn. */
export type UnitPlacement = {
	box: { left: number; top: number; width: number; height: number };
	toDrawn: readonly number[] | null;
};

/** `translate(x, y) scale(s) rotate(r)` about the centre of `box`: what the overlay's CSS transform does to it. */
export function unitTransform(
	box: UnitPlacement['box'],
	x: number,
	y: number,
	scale: number,
	rotateDeg: number,
): number[] {
	const a = (rotateDeg * Math.PI) / 180;
	const c = Math.cos(a) * scale;
	const s = Math.sin(a) * scale;
	const cx = box.left + box.width / 2;
	const cy = box.top + box.height / 2;
	return [c, -s, cx + x - c * cx + s * cy, s, c, cy + y - s * cx - c * cy, 0, 0, 1];
}

/** The unit overlay of legacy text animations: every glyph moves with the unit it sits in. */
export function unitSpans(
	lay: TypesetLayout,
	family: (s: TextStyle) => string,
	units: readonly UnitPlacement[],
	runs?: readonly TextRun[],
): FxTextSpans | null {
	const boxes = inkBoxes(lay, family);
	const out: SpanGlyph[] = [];
	lay.glyphs.forEach((g, i) => {
		const box = boxes[i];
		if (!box || !g.rect) return;
		const cx = g.rect.left + g.rect.width / 2;
		const cy = g.rect.top + g.rect.height / 2;
		const unit = units.find(
			(u) =>
				cx >= u.box.left &&
				cx <= u.box.left + u.box.width &&
				cy >= u.box.top &&
				cy <= u.box.top + u.box.height,
		);
		const fields = runFields(runs, g.offset);
		if (unit?.toDrawn) out.push({ box, line: g.lineIndex, toDrawn: unit.toDrawn, ...fields });
		else if (!unit) out.push({ box, line: g.lineIndex, ...fields });
	});
	return buildTextSpans(out);
}

/** Typeset characters: `placed` (the drawn ones) with their matrices, and per-character 3D's perspective when it is on. */
export function typesetSpans(
	lay: TypesetLayout,
	family: (s: TextStyle) => string,
	placed: readonly PlacedGlyph[],
	origins: readonly (readonly [number, number])[],
	perspective: { distance: number; origin: readonly [number, number] } | null,
	runs?: readonly TextRun[],
): FxTextSpans | null {
	const boxes = inkBoxes(lay, family);
	const out: SpanGlyph[] = [];
	for (const g of placed) {
		const box = boxes[g.index];
		if (!box) continue;
		const m = g.m;
		// Rest px → character space: the character's baseline origin sits at `local` there.
		const tx = g.local[0] - origins[g.index]![0];
		const ty = g.local[1] - origins[g.index]![1];
		const a = m[0]!;
		const b = m[1]!;
		const c = m[0]! * tx + m[1]! * ty + m[3]!;
		const d = m[4]!;
		const e = m[5]!;
		const f = m[4]! * tx + m[5]! * ty + m[7]!;
		let toDrawn = [a, b, c, d, e, f, 0, 0, 1];
		if (perspective) {
			// The CSS perspective around the camera; `m`'s Z runs away from the viewer (After Effects axes).
			const k = 1 / perspective.distance;
			const [ox, oy] = perspective.origin;
			const za = m[8]! * k;
			const zb = m[9]! * k;
			const zc = (m[8]! * tx + m[9]! * ty + m[11]!) * k;
			toDrawn = [
				a + ox * za,
				b + ox * zb,
				c + ox * zc,
				d + oy * za,
				e + oy * zb,
				f + oy * zc,
				za,
				zb,
				1 + zc,
			];
		}
		const glyph = lay.glyphs[g.index]!;
		out.push({ box, line: glyph.lineIndex, toDrawn, ...runFields(runs, glyph.offset) });
	}
	return buildTextSpans(out);
}

/** Reports `spans` to the text layer when they change. */
export function useReportSpans(report: ReportSpans | undefined, spans: FxTextSpans | null): void {
	// biome-ignore lint/correctness/useExhaustiveDependencies: the records are identified by their key
	useLayoutEffect(() => {
		report?.(spans);
	}, [report, spans?.key]);
}
