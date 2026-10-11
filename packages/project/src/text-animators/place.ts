// Character placement of animated text: from the static layout of the characters
// (measured by the text layer) and their animation state (`charTransforms`) to where and how each character is
// drawn — tracking and Line Anchor shifts, Line Spacing, Anchor Point Grouping pivots, Path Options and the
// per-character matrix (anchor → scale → skew → X / Y / Z rotation → position). Pure.
//
// Ported from EffectCraft `crates/render/src/text.rs` `text_geom` (MIT OR Apache-2.0, Copyright (c) 2026 ArtCraft
// Team and the EffectCraft contributors; see licenses/ported/text-animators.md).
import type { RGBA } from '../schema/common.ts';
import type { TextMoreOptions } from '../schema/text-animators.ts';
import { adjustColor, type CharXf } from './evaluate.ts';
import { arcPositions, type PathMeasure, placeOnPath } from './path.ts';

/** One character of the static layout, in the text box's space (px, Y down). */
export type LaidGlyph = {
	/** Baseline origin (left edge of the advance, on the baseline). */
	origin: [number, number];
	advance: number;
	/** Font size of the character's run (em for tracking). */
	size: number;
	lineIndex: number;
	wordIndex: number;
	charIndex: number;
	isSpace: boolean;
	/** The run's fill and stroke (stroke width 0 = none). */
	fill: RGBA;
	stroke: RGBA;
	strokeWidth: number;
};

/** A drawn character. */
export type PlacedGlyph = {
	/** Index into the laid-out glyphs. */
	index: number;
	/** The character's baseline origin relative to its pivot (character space). */
	local: [number, number];
	/** Character space → text box space, row-major 4×4 (After Effects axes: Z away from the viewer). */
	m: number[];
	xf: CharXf;
	fill: RGBA;
	stroke: RGBA;
	strokeWidth: number;
	/** The pivot in the unanimated layout (text box space). */
	rest: [number, number];
};

export type PlaceOptions = {
	moreOptions?: {
		anchorPointGrouping: TextMoreOptions['anchorPointGrouping'];
		/** Evaluated Grouping Alignment (percent). */
		groupingAlignment: [number, number];
	};
	/** Per-character 3D on (else Z, X and Y rotation are ignored). */
	threeD: boolean;
	/** Path Options, evaluated. */
	path?: {
		measure: PathMeasure;
		perpendicular: boolean;
		force: boolean;
		firstMargin: number;
		lastMargin: number;
	};
	/** Line boxes `[x, baseline, width]` (for path alignment) and the paragraph alignment. */
	lineBoxes: [number, number, number][];
	align: 0 | 1 | 2;
	/** Extra advance per glyph from variable-font axis animation (default 0). */
	variableAdvance?: readonly number[];
	/** Advance of the substituted character drawn in a glyph's slot, when substituted (alignment in the slot). */
	substitutedAdvance?: readonly (number | null)[];
};

export type Mat4 = number[];
export const identity4 = (): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function mul4(a: Mat4, b: Mat4): Mat4 {
	const o = new Array<number>(16).fill(0);
	for (let r = 0; r < 4; r++)
		for (let c = 0; c < 4; c++) {
			let s = 0;
			for (let k = 0; k < 4; k++) s += a[r * 4 + k]! * b[k * 4 + c]!;
			o[r * 4 + c] = s;
		}
	return o;
}

export const translate4 = (x: number, y: number, z: number): Mat4 => [
	1,
	0,
	0,
	x,
	0,
	1,
	0,
	y,
	0,
	0,
	1,
	z,
	0,
	0,
	0,
	1,
];
export const scale4 = (x: number, y: number, z: number): Mat4 => [
	x,
	0,
	0,
	0,
	0,
	y,
	0,
	0,
	0,
	0,
	z,
	0,
	0,
	0,
	0,
	1,
];
const rad = (d: number) => (d * Math.PI) / 180;
export function rotateX4(deg: number): Mat4 {
	const s = Math.sin(rad(deg));
	const c = Math.cos(rad(deg));
	return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1];
}
export function rotateY4(deg: number): Mat4 {
	const s = Math.sin(rad(deg));
	const c = Math.cos(rad(deg));
	return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1];
}
export function rotateZ4(deg: number): Mat4 {
	const s = Math.sin(rad(deg));
	const c = Math.cos(rad(deg));
	return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}
/** AE Skew along Skew Axis: `R(axis) · [[1, tan(skew)], [0, 1]] · R(−axis)` (EffectCraft `skew_deg`). */
export function skew4(skewDeg: number, axisDeg: number): Mat4 {
	const k = Math.tan(rad(skewDeg));
	return mul4(mul4(rotateZ4(axisDeg), [1, k, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), rotateZ4(-axisDeg));
}

/** Applies a row-major 4×4 to a 2D point (z = 0), with the perspective divide when w ≠ 1. */
export function apply4(m: Mat4, p: [number, number]): [number, number] {
	const x = m[0]! * p[0] + m[1]! * p[1] + m[3]!;
	const y = m[4]! * p[0] + m[5]! * p[1] + m[7]!;
	const w = m[12]! * p[0] + m[13]! * p[1] + m[15]!;
	return w !== 1 && w !== 0 ? [x / w, y / w] : [x, y];
}

/**
 * CSS `matrix3d(…)` of an AE-space matrix: CSS has Z toward the viewer, so the matrix is conjugated by
 * `diag(1, 1, −1, 1)`; CSS lists the matrix column-major.
 */
export function cssMatrix3d(m: Mat4): string {
	const f = [1, 1, -1, 1];
	const v: number[] = [];
	for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) v.push(m[r * 4 + c]! * f[r]! * f[c]!);
	return `matrix3d(${v.map((x) => (Math.abs(x) < 1e-12 ? 0 : Number(x.toPrecision(12)))).join(',')})`;
}

/** The character's own matrix (pivot at the origin): rotations, skew, scale, anchor. */
export function charMatrix(x: CharXf): Mat4 {
	return mul4(
		mul4(
			mul4(mul4(rotateZ4(x.rotation), rotateY4(x.rotationY)), rotateX4(x.rotationX)),
			skew4(-x.skew, x.skewAxis),
		),
		mul4(
			scale4(x.scale[0] / 100, x.scale[1] / 100, x.scale[2] / 100),
			translate4(-x.anchor[0], -x.anchor[1], -x.anchor[2]),
		),
	);
}

/**
 * Places every non-space character. `xfs[i]` is the animation state of `glyphs[i]`. Characters whose opacity is
 * not positive are still returned (callers skip drawing them) so indices stay aligned with what was evaluated.
 */
export function placeGlyphs(
	glyphs: readonly LaidGlyph[],
	xfsIn: readonly CharXf[],
	o: PlaceOptions,
): PlacedGlyph[] {
	const n = glyphs.length;
	const xfs = xfsIn;
	const vadv = (gi: number) => o.variableAdvance?.[gi] ?? 0;
	const advance = (gi: number) => glyphs[gi]!.advance + vadv(gi);
	// Tracking (before / after each character) and Line Anchor, per line.
	const shift = new Array<number>(n).fill(0);
	let liStart = 0;
	while (liStart < n) {
		const line = glyphs[liStart]!.lineIndex;
		let liEnd = liStart;
		while (liEnd < n && glyphs[liEnd]!.lineIndex === line) liEnd++;
		let pen = 0;
		let la = 0;
		let laK = 0;
		for (let gi = liStart; gi < liEnd; gi++) {
			const x = xfs[gi]!;
			const em = glyphs[gi]!.size / 1000;
			pen += x.trackBefore * em;
			shift[gi] = pen;
			pen += x.trackAfter * em + vadv(gi);
			if (x.lineAnchorK > laK) {
				la = x.lineAnchor;
				laK = x.lineAnchorK;
			}
		}
		const back = (pen * la) / 100;
		for (let gi = liStart; gi < liEnd; gi++) shift[gi]! -= back;
		liStart = liEnd;
	}
	const origin = (gi: number): [number, number] => {
		const g = glyphs[gi]!;
		const x = xfs[gi]!;
		return [
			g.origin[0] + shift[gi]! + x.lineSpacing[0] * g.lineIndex,
			g.origin[1] + x.lineSpacing[1] * g.lineIndex,
		];
	};
	const grouping = o.moreOptions?.anchorPointGrouping ?? 'character';
	const galign = o.moreOptions?.groupingAlignment ?? [0, 0];
	const groupKey = (g: LaidGlyph): number | null => {
		switch (grouping) {
			case 'word':
				return g.wordIndex * 4096 + g.lineIndex;
			case 'line':
				return g.lineIndex;
			case 'all':
				return 0;
			default:
				return null;
		}
	};
	const extents = new Map<number, [number, number, number, number]>();
	if (grouping !== 'character') {
		for (let gi = 0; gi < n; gi++) {
			const g = glyphs[gi]!;
			if (g.isSpace && grouping === 'word') continue;
			const p = origin(gi);
			const key = groupKey(g)!;
			const e = extents.get(key) ?? [Infinity, Infinity, -Infinity, -Infinity];
			e[0] = Math.min(e[0], p[0]);
			e[2] = Math.max(e[2], p[0] + advance(gi));
			e[1] = Math.min(e[1], p[1]);
			e[3] = Math.max(e[3], p[1]);
			extents.set(key, e);
		}
	}
	// Path Options: arc position of every pivot, line by line.
	const firstBaseline = o.lineBoxes[0]?.[1] ?? 0;
	const arc = new Array<number>(n).fill(0);
	if (o.path) {
		let i = 0;
		while (i < n) {
			const line = glyphs[i]!.lineIndex;
			let j = i;
			while (j < n && glyphs[j]!.lineIndex === line) j++;
			const xs: number[] = [];
			for (let gi = i; gi < j; gi++) xs.push(origin(gi)[0] + advance(gi) / 2);
			const lb = o.lineBoxes[line] ?? [0, 0, 0];
			const pos = arcPositions(
				xs,
				[lb[0], lb[0] + lb[2]],
				o.align,
				o.path.measure.length,
				o.path.firstMargin,
				o.path.lastMargin,
				o.path.force,
			);
			for (let k = 0; k < pos.length; k++) arc[i + k] = pos[k]!;
			i = j;
		}
	}
	const out: PlacedGlyph[] = [];
	for (let gi = 0; gi < n; gi++) {
		const g = glyphs[gi]!;
		if (g.isSpace) continue;
		const x: CharXf = {
			...xfs[gi]!,
			offset: [...xfs[gi]!.offset],
			anchor: [...xfs[gi]!.anchor],
			scale: [...xfs[gi]!.scale],
		};
		if (!o.threeD) {
			x.offset[2] = 0;
			x.anchor[2] = 0;
			x.scale[2] = 100;
			x.rotationX = 0;
			x.rotationY = 0;
		}
		const p = origin(gi);
		const adv = advance(gi);
		const key = groupKey(g);
		const e = key === null ? undefined : extents.get(key);
		const pivot: [number, number] = e
			? [
					(e[0] + e[2]) / 2 + (galign[0] / 100) * (e[2] - e[0]),
					(e[1] + e[3]) / 2 + (galign[1] / 100) * g.size,
				]
			: [p[0] + adv / 2 + (galign[0] / 100) * adv, p[1] + (galign[1] / 100) * g.size];
		const local: [number, number] = [p[0] - pivot[0], p[1] - pivot[1]];
		const cm = charMatrix(x);
		let m: Mat4;
		if (o.path) {
			// Position X slides along the path, Y moves off it.
			const centre = p[0] + adv / 2;
			const s = arc[gi]! + (pivot[0] - centre) + x.offset[0];
			const placed = placeOnPath(
				o.path.measure,
				s,
				pivot[1] - firstBaseline + x.offset[1],
				o.path.perpendicular,
			);
			m = mul4(mul4(translate4(placed.point[0], placed.point[1], x.offset[2]), rotateZ4(placed.angle)), cm);
		} else {
			m = mul4(translate4(pivot[0] + x.offset[0], pivot[1] + x.offset[1], x.offset[2]), cm);
		}
		out.push({
			index: gi,
			local,
			m,
			xf: x,
			fill: adjustColor(g.fill, x.fill, x.fillK, x.fillHsb, x.fillOpacity),
			stroke: adjustColor(g.stroke, x.stroke, x.strokeK, x.strokeHsb, x.strokeOpacity),
			strokeWidth: Math.max(0, g.strokeWidth + x.strokeWidth),
			rest: [pivot[0] - (p[0] - g.origin[0]), pivot[1] - (p[1] - g.origin[1])],
		});
	}
	return out;
}
