// shape.addTrimTracer end to end: the follower's evaluated Position (and Rotation) against the tip computed here
// from the geometry (test/geometry.ts: dense sampling, hand-written transforms) and against the end points of the
// stroke the renderer actually draws; then the same values through the export paths' evaluation (render snapshot in
// Node as the native export samples it, and after JSON as the Remotion renderer rebinds it).
import {
	buildRenderSnapshot,
	clipContentTime,
	evaluateVectorShape,
	type RenderSnapshot,
	resolveLayerProps,
	resolveSceneAt,
	type ShapeClip,
	type ShapeItem,
	type VectorShapeData,
} from '@jasper/project';
import { beforeAll, describe, expect, it } from 'vitest';
import { bindSnapshotExpressions, loadExpressionEngine, propertyStatusAt, storedTimeAtFrame } from '../src/index.ts';
import { basicDoc, type Doc } from './fixture.ts';
import {
	type Aff,
	applyA,
	applyVec,
	type Cub,
	dist,
	groupMatrix,
	line,
	mapCub,
	measure,
	mulA,
	type Pt,
	T,
} from './geometry.ts';

beforeAll(async () => {
	await loadExpressionEngine();
});

const K = 0.5522847498307936;
const FRAMES = [0, 13, 30, 47, 66, 89];
const snapOpts = { resolveMedia: () => null, resolveFont: () => null };

type Gx = { position: Pt; rotation: number; scale: Pt; anchor: Pt };
const OUTER: Gx = { position: [50, -30], rotation: 20, scale: [120, 120], anchor: [10, 0] };
const INNER: Gx = { position: [-40, 10], rotation: -35, scale: [80, 130], anchor: [0, 5] };
const B: Gx = { position: [120, 60], rotation: 70, scale: [60, 60], anchor: [0, 0] };
/** The shape clip's Motion: Position, Rotation (clockwise), uniform Scale, Anchor Point (layer pixels). */
const MOTION = { position: [800, 500] as Pt, rotation: 15, scale: 150, anchor: [900, 520] as Pt };
const motion: Aff = groupMatrix({ ...MOTION, scale: [MOTION.scale, MOTION.scale] });
/** Content space (origin = box centre of the 1920×1080 layer) → sequence pixels. */
const CONTENT_TO_SEQ = mulA(motion, T(960, 540));

const WAVE: Cub[] = [
	[
		[-200, 0],
		[-100, -150],
		[100, 150],
		[200, 0],
	],
];
const RECT_REV: Cub[] = (() => {
	// 160×90 at (0, 0), reversed: tr → tl → bl → br → tr.
	const tr: Pt = [80, -45];
	const tl: Pt = [-80, -45];
	const bl: Pt = [-80, 45];
	const br: Pt = [80, 45];
	return [line(tr, tl), line(tl, bl), line(bl, br), line(br, tr)];
})();
const CIRCLE = (r: number, c: Pt): Cub[] => [
	[[c[0], c[1] - r], [c[0] + r * K, c[1] - r], [c[0] + r, c[1] - r * K], [c[0] + r, c[1]]],
	[[c[0] + r, c[1]], [c[0] + r, c[1] + r * K], [c[0] + r * K, c[1] + r], [c[0], c[1] + r]],
	[[c[0], c[1] + r], [c[0] - r * K, c[1] + r], [c[0] - r, c[1] + r * K], [c[0] - r, c[1]]],
	[[c[0] - r, c[1]], [c[0] - r, c[1] - r * K], [c[0] - r * K, c[1] - r], [c[0], c[1] - r]],
];

/** The renderer's Trim Paths semantics for a tip: Start / End clamped to 0…100 %, Offset wrapping by whole lengths. */
function tipU(start: number, end: number, offset: number, tip: 'start' | 'end'): number {
	const off = (((offset / 360) % 1) + 1) % 1;
	const x = Math.min(1, Math.max(0, (tip === 'start' ? start : end) / 100)) + off;
	return tip === 'start' ? (x >= 1 ? x - 1 : x) : x > 1 ? x - 1 : x;
}

const lin = (f: number, a: number, b: number) => a + ((b - a) * f) / 90;
const keys = (prop: string, trimId: string, a: number, b: number) =>
	[0, 90].map((frame, i) => ({
		type: 'keyframe.add',
		target: ['clip', '$s', 'shape', 'items', trimId, prop],
		at: { frames: frame },
		value: i ? b : a,
		interpolation: 'linear',
	}));

function build(contents: unknown[]): { d: Doc; items: Map<string, string> } {
	const d = basicDoc();
	d.tx([
		{
			type: 'clip.addShape',
			at: 0,
			duration: 120,
			track: 'V4',
			name: 'Shape',
			shape: { type: 'vector', contents },
			transform: MOTION,
			ref: '$s',
		},
	]);
	const items = new Map<string, string>();
	const walk = (list: readonly ShapeItem[]) => {
		for (const it of list) {
			items.set(it.name, it.id);
			if (it.type === 'group') walk(it.contents);
		}
	};
	walk(((d.doc.sequences[d.seqId]!.clips[d.refs.$s!] as ShapeClip).shape as VectorShapeData).contents);
	return { d, items };
}

function addTracer(d: Doc, cmd: Record<string, unknown>) {
	const r = d.tx([{ type: 'shape.addTrimTracer', clipId: '$s', ref: '$f', ...cmd }]);
	return r.results[0] as { clipId: string; tip: string; mode: string };
}

const at = (d: Doc, owner: string, path: string, frame: number) => {
	const ref = { seq: d.seqId, owner, path };
	const st = propertyStatusAt(d.doc, ref, storedTimeAtFrame(d.doc, ref, frame))!;
	expect(st.expressionError).toBeNull();
	return st.value as never;
};

/** The tip the renderer draws: the first / last point of the trimmed stroke, in sequence pixels (null = nothing). */
function drawnTip(d: Doc, frame: number, tip: 'start' | 'end'): Pt | null {
	const snap = buildRenderSnapshot(d.doc, d.seqId, snapOpts);
	const layer = resolveSceneAt(snap, frame).find((l) => l.clip.clipId === d.refs.$s)!;
	const draws = evaluateVectorShape(
		(layer.clip.source as { shape: VectorShapeData }).shape.contents,
		layer.contentTime,
	).filter((x) => x.kind === 'stroke');
	const subs = draws.flatMap((x) => x.paths).filter((sp) => sp.segs.length);
	if (!subs.length) return null;
	const p =
		tip === 'start' ? subs[0]!.segs[0]![0] : subs[subs.length - 1]!.segs[subs[subs.length - 1]!.segs.length - 1]![3];
	return applyA(CONTENT_TO_SEQ, [p[0], p[1]]);
}

/** Checks the follower against the geometric tip (and the drawn tip when `drawn` says the frame draws one piece). */
function verify(
	d: Doc,
	follower: string,
	tip: 'start' | 'end',
	expected: (frame: number) => Pt,
	drawn: (frame: number) => boolean,
) {
	let compared = 0;
	for (const f of FRAMES) {
		const got = at(d, follower, 'transform.position', f) as Pt;
		const want = expected(f);
		expect(dist(got, want), `frame ${f}: ${got} vs ${want}`).toBeLessThan(0.5);
		expect(dist(got, want)).toBeLessThan(0.01); // measured: the kernel lands within 1e-3 px of the reference
		if (drawn(f)) {
			const r = drawnTip(d, f, tip)!;
			expect(dist(got, r), `frame ${f}: drawn ${r}`).toBeLessThan(0.01);
			compared++;
		}
	}
	return compared;
}

describe('shape.addTrimTracer: the follower rides the trim tip', { timeout: 300_000 }, () => {
	it('End animated on an open path in nested groups (position, rotation, non-uniform scale, anchor) and Motion', () => {
		const { d, items } = build([
			{
				type: 'group',
				name: 'Outer',
				transform: OUTER,
				contents: [
					{ type: 'group', name: 'Inner', transform: INNER, contents: [{ type: 'path', name: 'Wave', path: 'M-200 0 C-100 -150 100 150 200 0' }] },
					{ type: 'trim', name: 'Trim', start: 0, end: 0 },
					{ type: 'stroke', width: 4 },
				],
			},
		]);
		d.tx(keys('end', items.get('Trim')!, 0, 100));
		const r = addTracer(d, { trimItemId: items.get('Trim'), orient: true });
		expect(r.tip).toBe('end');
		// the trim measures the wave in Outer's space (after Inner's non-uniform scale)
		const m = measure(WAVE.map((c) => mapCub(groupMatrix(INNER), c)));
		const outer = mulA(CONTENT_TO_SEQ, groupMatrix(OUTER));
		const n = verify(
			d,
			r.clipId,
			'end',
			(f) => applyA(outer, m(tipU(0, lin(f, 0, 100), 0, 'end')).p),
			(f) => f > 0,
		);
		expect(n).toBe(5);
		// orient: Rotation = the path direction in sequence space
		for (const f of FRAMES.slice(1)) {
			const tan = applyVec(outer, m(tipU(0, lin(f, 0, 100), 0, 'end')).tan);
			const want = (Math.atan2(tan[1], tan[0]) * 180) / Math.PI;
			expect(Math.abs((at(d, r.clipId, 'transform.rotation', f) as number) - want), `frame ${f}`).toBeLessThan(0.05);
		}
	});

	it('Start animated (erase) on a reversed closed path, with Offset animated: auto picks Start', () => {
		const { d, items } = build([
			{
				type: 'group',
				name: 'Box',
				transform: { position: [-60, 40], rotation: -25, scale: [90, 140], anchor: [5, 5] },
				contents: [
					{ type: 'rect', name: 'R', size: [160, 90], direction: 'reversed' },
					{ type: 'stroke', width: 3 },
				],
			},
			{ type: 'trim', name: 'Trim', start: 0, end: 100, offset: 0 },
		]);
		const trim = items.get('Trim')!;
		d.tx([...keys('start', trim, 0, 100), ...keys('offset', trim, 0, 200)]);
		const r = addTracer(d, { trimItemId: trim });
		expect(r.tip).toBe('start');
		const box = groupMatrix({ position: [-60, 40], rotation: -25, scale: [90, 140], anchor: [5, 5] });
		const m = measure(RECT_REV.map((c) => mapCub(box, c)));
		verify(
			d,
			r.clipId,
			'start',
			(f) => applyA(CONTENT_TO_SEQ, m(tipU(lin(f, 0, 100), 100, lin(f, 0, 200), 'start')).p),
			(f) => f > 0 && f < 90,
		);
	});

	it('Offset wrapping twice around a closed path and across the ends of an open path (End tip)', () => {
		const closed = build([
			{ type: 'ellipse', name: 'E', size: [180, 180], position: [30, -20] },
			{ type: 'trim', name: 'Trim', start: 10, end: 40, offset: 0 },
			{ type: 'stroke' },
		]);
		closed.d.tx(keys('offset', closed.items.get('Trim')!, 0, 720));
		const rc = addTracer(closed.d, { trimItemId: closed.items.get('Trim') });
		expect(rc.tip).toBe('end');
		const mc = measure(CIRCLE(90, [30, -20]));
		verify(
			closed.d,
			rc.clipId,
			'end',
			(f) => applyA(CONTENT_TO_SEQ, mc(tipU(10, 40, lin(f, 0, 720), 'end')).p),
			() => true,
		);
		const open = build([
			{ type: 'path', name: 'Wave', path: 'M-200 0 C-100 -150 100 150 200 0' },
			{ type: 'trim', name: 'Trim', start: 0, end: 50, offset: 0 },
			{ type: 'stroke' },
		]);
		open.d.tx(keys('offset', open.items.get('Trim')!, -90, 450));
		const ro = addTracer(open.d, { trimItemId: open.items.get('Trim'), tip: 'end' });
		const mo = measure(WAVE);
		verify(
			open.d,
			ro.clipId,
			'end',
			(f) => applyA(CONTENT_TO_SEQ, mo(tipU(0, 50, lin(f, -90, 450), 'end')).p),
			() => true,
		);
	});

	it('Individually: the tip runs over the paths laid end to end; Simultaneously: it follows the chosen path', () => {
		const contents = (mode: string) => [
			{ type: 'group', name: 'A', transform: { ...OUTER }, contents: [{ type: 'path', name: 'Line', path: 'M-100 0 L100 40' }] },
			{ type: 'group', name: 'B', transform: B, contents: [{ type: 'ellipse', name: 'Circle', size: [120, 120] }] },
			{ type: 'trim', name: 'Trim', start: 0, end: 0, mode },
			{ type: 'stroke' },
		];
		const lineA = [line([-100, 0], [100, 40])].map((c) => mapCub(groupMatrix(OUTER), c));
		const circleB = CIRCLE(60, [0, 0]).map((c) => mapCub(groupMatrix(B), c));

		const ind = build(contents('individual'));
		ind.d.tx(keys('end', ind.items.get('Trim')!, 0, 100));
		const ri = addTracer(ind.d, { trimItemId: ind.items.get('Trim') });
		expect(ri.mode).toBe('individual');
		const all = measure([...lineA, ...circleB]);
		verify(
			ind.d,
			ri.clipId,
			'end',
			(f) => applyA(CONTENT_TO_SEQ, all(lin(f, 0, 100) / 100).p),
			(f) => f > 0,
		);

		const sim = build(contents('simultaneous'));
		sim.d.tx(keys('end', sim.items.get('Trim')!, 0, 100));
		const rs = addTracer(sim.d, { trimItemId: sim.items.get('Trim'), pathItemId: sim.items.get('Circle') });
		const circle = measure(circleB);
		verify(
			sim.d,
			rs.clipId,
			'end',
			(f) => applyA(CONTENT_TO_SEQ, circle(lin(f, 0, 100) / 100).p),
			() => false,
		);
		// renaming items and the clip does not break the id-addressed expression
		sim.d.tx([
			{ type: 'shape.updateItem', clipId: '$s', itemId: sim.items.get('Circle'), patch: { name: 'Renamed' } },
			{ type: 'clip.update', clipId: '$s', patch: { name: 'Other name' } },
		]);
		const got = at(sim.d, rs.clipId, 'transform.position', 47) as Pt;
		expect(dist(got, applyA(CONTENT_TO_SEQ, circle(lin(47, 0, 100) / 100).p))).toBeLessThan(0.01);
	});

	it('export paths evaluate the same values: the Node snapshot (native sampling) and the JSON snapshot (Remotion)', () => {
		const { d, items } = build([
			{
				type: 'group',
				name: 'Outer',
				transform: OUTER,
				contents: [
					{ type: 'group', name: 'Inner', transform: INNER, contents: [{ type: 'path', name: 'Wave', path: 'M-200 0 C-100 -150 100 150 200 0' }] },
					{ type: 'trim', name: 'Trim', start: 0, end: 0 },
					{ type: 'stroke', width: 4 },
				],
			},
		]);
		d.tx(keys('end', items.get('Trim')!, 0, 100));
		const r = addTracer(d, { trimItemId: items.get('Trim'), orient: true });
		const native = buildRenderSnapshot(d.doc, d.seqId, snapOpts);
		const remotion = bindSnapshotExpressions(JSON.parse(JSON.stringify(native)) as RenderSnapshot);
		const props = (snap: RenderSnapshot, f: number) => {
			const layer = resolveSceneAt(snap, f).find((l) => l.clip.clipId === r.clipId)!;
			// what native.ts samples per frame
			return resolveLayerProps(layer.clip, clipContentTime(layer.clip, f, snap.settings.fps)).transform!;
		};
		for (const f of FRAMES) {
			const a = props(native, f);
			const b = props(remotion, f);
			expect(b.position).toEqual(a.position);
			expect(b.rotation).toEqual(a.rotation);
			expect(a.position).toEqual(at(d, r.clipId, 'transform.position', f));
		}
	});
});
