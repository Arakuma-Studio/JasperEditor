// shape.animateTrim, rendered: the visible parts of the paths (with the offset / part expressions evaluated) match the
// documented definitions (docs/wp-notes/shapes.md § Trim Paths animations), on open and closed paths, several paths,
// Simultaneously / Individually; and the export path (a JSON render snapshot bound in the renderer) draws exactly
// what the document-bound preview evaluation draws.
import {
	buildRenderSnapshot,
	evaluateEaseCurve,
	evaluateVectorShape,
	flicksPerFrame,
	type ProjectDocument,
	resolveSceneAt,
	type ShapeClip,
	type ShapeItem,
	shapeGeom,
	TRIM_ANIMATION_STYLES,
	TRIM_ENTER_EASE,
	TRIM_EXIT_EASE,
	type TrimAnimationStyle,
	type VectorShapeData,
} from '@jasper/project';
import { beforeAll, describe, expect, it } from 'vitest';
import { bindDocumentExpressions, bindSnapshotExpressions, loadExpressionEngine } from '../src/index.ts';
import { Doc } from './fixture.ts';

beforeAll(async () => {
	await loadExpressionEngine();
});

const F = flicksPerFrame({ num: 30, den: 1 });
const D = 8;
const LAG = 0.5;
const N = 4;
const LINEAR = { kind: 'cubic', x1: 1 / 3, y1: 1 / 3, x2: 2 / 3, y2: 2 / 3 } as const;
const snapOpts = { resolveMedia: () => null, resolveFont: () => null };
type Iv = [number, number];
type P = readonly [number, number];

const stroke = { type: 'stroke', color: [1, 1, 1, 1], width: 2 };
const OPEN = { contents: [{ type: 'path', path: 'M -100 0 L 100 0' }, stroke], map: lineMap };
const CLOSED = {
	contents: [{ type: 'path', path: 'M -50 -50 L 50 -50 L 50 50 L -50 50 Z' }, stroke],
	map: squareMap,
};

/** Position along the line x = −100…100 (y = 0) or, for `twoLines`, laid end to end with the line at y = 50. */
function lineMap(p: P): number {
	return (p[0] + 100) / 200;
}
/** Perimeter fraction on the square from (−50, −50) clockwise; `end` picks 1 over 0 at the start corner. */
function squareMap(p: P, end = false): number {
	const [x, y] = p;
	const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
	let u: number;
	if (near(y, -50)) u = (x + 50) / 400;
	else if (near(x, 50)) u = 0.25 + (y + 50) / 400;
	else if (near(y, 50)) u = 0.5 + (50 - x) / 400;
	else u = 0.75 + (50 - y) / 400;
	return end && u < 1e-6 ? 1 : u;
}

/** Sorted, merged, non-empty intervals. */
function norm(ivs: Iv[]): Iv[] {
	const parts: Iv[] = [];
	for (const [a, b] of ivs) {
		if (b < a) parts.push([a, 1], [0, b]);
		else parts.push([a, b]);
	}
	const sorted = parts.filter(([a, b]) => b - a > 1e-6).sort((x, y) => x[0] - y[0]);
	const out: Iv[] = [];
	for (const iv of sorted) {
		const last = out[out.length - 1];
		if (last && iv[0] <= last[1] + 1e-6) last[1] = Math.max(last[1], iv[1]);
		else out.push([...iv]);
	}
	return out;
}
/** Intervals shifted by `o` along a closed parameter (mod 1). */
function shift(ivs: Iv[], o: number): Iv[] {
	const m = (v: number) => ((v % 1) + 1) % 1;
	return ivs.flatMap(([a, b]): Iv[] => {
		if (b - a >= 1 - 1e-9) return [[0, 1]];
		const s = m(a + o);
		const e = s + (b - a);
		return e <= 1
			? [[s, e]]
			: [
					[s, 1],
					[0, e - 1],
				];
	});
}

/** The visible parts by definition, at time fraction x (of D), with linear progress. */
function visible(style: TrimAnimationStyle, rev: boolean, x: number): Iv[] {
	const c = (v: number) => Math.min(1, Math.max(0, v));
	const p = c(x);
	const parts = (f: (i: number) => Iv) => Array.from({ length: N }, (_, k) => f(k + 1));
	switch (style) {
		case 'in':
			return rev ? [[1 - p, 1]] : [[0, p]];
		case 'out':
			return rev ? [[0, 1 - p]] : [[p, 1]];
		case 'inOut': {
			const head = p;
			const tail = c(x - LAG);
			return rev ? [[1 - head, 1 - tail]] : [[tail, head]];
		}
		case 'middleIn':
			return rev
				? [
						[0, p / 2],
						[1 - p / 2, 1],
					]
				: [[0.5 - p / 2, 0.5 + p / 2]];
		case 'middleOut':
			return rev
				? [
						[0, (1 - p) / 2],
						[1 - (1 - p) / 2, 1],
					]
				: [[p / 2, 1 - p / 2]];
		case 'divideIn':
			return rev ? parts((i) => [i / N - p / N, i / N]) : parts((i) => [(i - 1) / N, (i - 1) / N + p / N]);
		case 'divideOut':
			return rev ? parts((i) => [(i - 1) / N, i / N - p / N]) : parts((i) => [(i - 1) / N + p / N, i / N]);
	}
}

type Clip = ShapeClip & { shape: VectorShapeData };

function setup(contents: unknown[], o: Record<string, unknown>) {
	const d = new Doc();
	d.tx([
		{
			type: 'clip.addShape',
			at: 0,
			duration: 90,
			track: 'V1',
			shape: { type: 'vector', contents },
			ref: '$s',
		},
	]);
	d.tx([{ type: 'shape.animateTrim', clipIds: ['$s'], durationFrames: D, inOutLag: LAG, copies: N, ...o }]);
	return d;
}
const contentsIn = (doc: ProjectDocument, d: Doc) =>
	(doc.sequences[d.seqId]!.clips[d.refs.$s!] as Clip).shape.contents;

/** Visible intervals of the stroked paths at a frame, measured on the geometry. */
function measured(
	contents: ShapeItem[],
	frame: number,
	map: (p: P, end?: boolean) => number,
	which: (p: P) => number = () => 0,
	paths = 1,
	/** Only the pieces of path `only` (on its own parameter). */
	only?: number,
): Iv[] {
	const out: Iv[] = [];
	for (const draw of evaluateVectorShape(contents, frame * F)) {
		if (draw.kind !== 'stroke') continue;
		for (const sp of draw.paths) {
			if (!sp.segs.length) continue;
			const a = sp.segs[0]![0];
			const b = sp.segs[sp.segs.length - 1]![3];
			const k = which(a);
			if (only !== undefined && k !== only) continue;
			const g = (u: number) => (only !== undefined ? u : (k + u) / paths);
			out.push(sp.closed ? [g(0), g(1)] : [g(map(a)), g(map(b, true))]);
		}
	}
	return norm(out);
}

function expectIntervals(got: Iv[], want: Iv[], label: string) {
	const w = norm(want);
	expect(got.length, `${label}: ${JSON.stringify(got)} vs ${JSON.stringify(w)}`).toBe(w.length);
	got.forEach((iv, i) => {
		expect(iv[0], label).toBeCloseTo(w[i]![0], 3);
		expect(iv[1], label).toBeCloseTo(w[i]![1], 3);
	});
}

const XS = [0, 0.25, 0.5, 1];

describe('visible parts of every style', () => {
	for (const style of TRIM_ANIMATION_STYLES)
		for (const reverse of [false, true])
			for (const animateOffset of [false, true])
				it(`${style}${reverse ? ' reversed' : ''}${animateOffset ? ' + offset' : ''}`, {
					timeout: 120_000,
				}, () => {
					for (const shape of [OPEN, CLOSED]) {
						const d = setup(shape.contents, {
							style,
							reverse,
							animateOffset,
							offsetDegrees: 90,
							curve: LINEAR,
						});
						const bound = contentsIn(bindDocumentExpressions(d.doc), d);
						const total = style === 'inOut' ? D * (1 + LAG) : D;
						const xs = style === 'inOut' ? [...XS, 1.25, 1.5] : XS;
						for (const x of xs) {
							const q = Math.min(1, (x * D) / total);
							const o = animateOffset ? (reverse ? -0.25 : 0.25) * q : 0;
							const label = `${style} rev=${reverse} offset=${animateOffset} ${shape === OPEN ? 'open' : 'closed'} x=${x}`;
							expectIntervals(measured(bound, x * D, shape.map), shift(visible(style, reverse, x), o), label);
						}
					}
				});

	it('default eases: progress follows the entering / exiting curves', { timeout: 120_000 }, () => {
		for (const [style, curve] of [
			['in', TRIM_ENTER_EASE],
			['middleOut', TRIM_EXIT_EASE],
		] as const) {
			const d = setup(OPEN.contents, { style, reverse: true });
			const bound = contentsIn(bindDocumentExpressions(d.doc), d);
			for (const x of [0.25, 0.5, 0.75]) {
				const p = evaluateEaseCurve(curve, x);
				expectIntervals(measured(bound, x * D, lineMap), visible(style, true, p), `${style} x=${x}`);
			}
		}
	});

	const twoLines = [
		{ type: 'path', path: 'M -100 0 L 100 0' },
		{ type: 'path', path: 'M -100 50 L 100 50' },
		stroke,
	];
	const which = (p: P) => (Math.abs(p[1] - 50) < 1e-6 ? 1 : 0);
	for (const mode of ['simultaneous', 'individual'] as const)
		it(`several paths, ${mode}`, { timeout: 300_000 }, () => {
			for (const style of TRIM_ANIMATION_STYLES)
				for (const reverse of [false, true]) {
					const d = new Doc();
					d.tx([
						{
							type: 'clip.addShape',
							at: 0,
							track: 'V1',
							shape: { type: 'vector', contents: [...twoLines, { type: 'trim', mode }] },
							ref: '$s',
						},
					]);
					d.tx([
						{
							type: 'shape.animateTrim',
							clipIds: ['$s'],
							style,
							reverse,
							durationFrames: D,
							copies: N,
							curve: LINEAR,
						},
					]);
					const bound = contentsIn(bindDocumentExpressions(d.doc), d);
					for (const x of XS) {
						const want = visible(style, reverse, x);
						const label = `${mode} ${style} rev=${reverse} x=${x}`;
						if (mode === 'individual')
							// Both lines laid end to end: one parameter over the combined length.
							expectIntervals(measured(bound, x * D, lineMap, which, 2), want, label);
						else
							for (const k of [0, 1]) {
								const got = measured(bound, x * D, lineMap, which, 2, k);
								expectIntervals(got, want, `${label} path ${k + 1}`);
							}
					}
				}
		});
});

describe('re-running gives the same picture as a fresh run', () => {
	it('every style pair', { timeout: 600_000 }, () => {
		for (const [i, first] of TRIM_ANIMATION_STYLES.entries())
			for (const [j, second] of TRIM_ANIMATION_STYLES.entries()) {
				const reverse = (i + j) % 2 === 1;
				const o = { style: second, reverse, curve: LINEAR, animateOffset: j % 3 === 0 };
				const rerun = setup(CLOSED.contents, { style: first, copies: 3, animateOffset: true });
				rerun.tx([
					{ type: 'shape.animateTrim', clipIds: ['$s'], durationFrames: D, inOutLag: LAG, copies: N, ...o },
				]);
				const fresh = setup(CLOSED.contents, o);
				const a = contentsIn(bindDocumentExpressions(rerun.doc), rerun);
				const b = contentsIn(bindDocumentExpressions(fresh.doc), fresh);
				for (const x of [0.5, 1])
					expect(measured(a, x * D, squareMap), `${first} → ${second} x=${x}`).toEqual(
						measured(b, x * D, squareMap),
					);
			}
	});
});

describe('preview / export fidelity of the expression-linked trims', () => {
	for (const o of [
		{ style: 'middleIn', reverse: true, animateOffset: true },
		{ style: 'middleOut', reverse: true },
		{ style: 'divideIn', animateOffset: true },
		{ style: 'divideOut', reverse: true },
	] as const)
		it(`${o.style}${'reverse' in o ? ' reversed' : ''}: the JSON render snapshot draws what the document draws`, {
			timeout: 120_000,
		}, () => {
			const d = setup(CLOSED.contents, { ...o, offsetDegrees: 120 });
			const preview = contentsIn(bindDocumentExpressions(d.doc), d);
			// The export renderer receives the snapshot as JSON and binds its expressions itself.
			const snap = bindSnapshotExpressions(
				JSON.parse(JSON.stringify(buildRenderSnapshot(d.doc, d.seqId, snapOpts))),
			);
			for (const frame of [0, 1, 3, 5, 8, 12]) {
				const layer = resolveSceneAt(snap, frame).find((l) => l.clip.clipId === d.refs.$s)!;
				const exported = evaluateVectorShape(
					(layer.clip.source as { shape: VectorShapeData }).shape.contents,
					layer.contentTime,
				);
				const shown = evaluateVectorShape(preview, frame * F);
				expect(layer.contentTime).toBe(frame * F);
				expect(exported.map((x) => shapeGeom.toSvgPath(x.paths))).toEqual(
					shown.map((x) => shapeGeom.toSvgPath(x.paths)),
				);
				// …and the expressions really ran (the unbound document would not trim this way).
				if (frame === 3 && o.style.startsWith('middle'))
					expect(shown.map((x) => shapeGeom.toSvgPath(x.paths))).not.toEqual(
						evaluateVectorShape(contentsIn(d.doc, d), frame * F).map((x) => shapeGeom.toSvgPath(x.paths)),
					);
			}
		});
});
