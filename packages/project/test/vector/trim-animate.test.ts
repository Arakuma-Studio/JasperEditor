// shape.animateTrim / shape.reversePathDirection / shape.addLine (docs/wp-notes/shapes.md § Trim Paths animations).
// Expected keys are written out here from the documented semantics, not taken from the planner.
import { describe, expect, it } from 'vitest';
import {
	type Animatable,
	checkInvariants,
	cubicToEases,
	evaluateVectorShape,
	flicksPerFrame,
	type ShapeClip,
	type ShapeItem,
	TRIM_ANIMATION_STYLES,
	type TrimAnimationStyle,
	type VectorShapeData,
} from '../../src/index.ts';
import { Harness } from '../helpers.ts';

const F = flicksPerFrame({ num: 30, den: 1 });
type Trim = Extract<ShapeItem, { type: 'trim' }>;
type Group = Extract<ShapeItem, { type: 'group' }>;
type Ok = {
	clips: { clipId: string; converted: boolean; trimIds: string[]; groupIds: string[]; partIds: string[] }[];
};

const ENTER = { kind: 'cubic', x1: 1 / 3, y1: 1 / 3, x2: 2 / 3, y2: 1 } as const;
const EXIT = { kind: 'cubic', x1: 1 / 3, y1: 0, x2: 2 / 3, y2: 2 / 3 } as const;
const LINEAR = { kind: 'cubic', x1: 1 / 3, y1: 1 / 3, x2: 2 / 3, y2: 2 / 3 } as const;
type Curve = { kind: 'cubic'; x1: number; y1: number; x2: number; y2: number };

function addVector(h: Harness, contents: unknown[], extra: Record<string, unknown> = {}, ref = '$s') {
	const r = h.ok([
		{
			type: 'clip.addShape',
			at: 0,
			duration: 90,
			track: 'V1',
			shape: { type: 'vector', contents },
			ref,
			...extra,
		},
	]);
	return r.refs[ref]!;
}
const LINE = [
	{ type: 'path', path: 'M -100 0 L 100 0' },
	{ type: 'stroke', color: [1, 1, 1, 1], width: 4 },
];
const contentsOf = (h: Harness, id: string) =>
	((h.seq.clips[id] as ShapeClip).shape as VectorShapeData).contents;
const trims = (items: readonly ShapeItem[]): Trim[] =>
	items.flatMap((it) => (it.type === 'trim' ? [it] : it.type === 'group' ? trims(it.contents) : []));
const animate = (h: Harness, clipIds: string[], o: Record<string, unknown>) =>
	h.ok([{ type: 'shape.animateTrim', clipIds, ...o }]).results[0] as Ok;

/** [from, to, startFrame, endFrame, curve] or a static value. */
type Ch = number | [number, number, number, number, Curve];
type Expect = { start: Ch; end: Ch; linked?: boolean };
/** D = 10, lag 0.5, N = 4 — the documented table. */
function expected(style: TrimAnimationStyle, rev: boolean): Expect {
	const s = 25;
	switch (style) {
		case 'in':
			return rev ? { start: [100, 0, 0, 10, ENTER], end: 100 } : { start: 0, end: [0, 100, 0, 10, ENTER] };
		case 'out':
			return rev ? { start: 0, end: [100, 0, 0, 10, EXIT] } : { start: [0, 100, 0, 10, EXIT], end: 100 };
		case 'inOut':
			return rev
				? { start: [100, 0, 0, 10, ENTER], end: [100, 0, 5, 15, EXIT] }
				: { start: [0, 100, 5, 15, EXIT], end: [0, 100, 0, 10, ENTER] };
		case 'middleIn':
			return rev
				? { start: 0, end: [0, 100, 0, 10, ENTER], linked: true }
				: { start: [50, 0, 0, 10, ENTER], end: [50, 100, 0, 10, ENTER] };
		case 'middleOut':
			return rev
				? { start: 0, end: [100, 0, 0, 10, EXIT], linked: true }
				: { start: [0, 50, 0, 10, EXIT], end: [100, 50, 0, 10, EXIT] };
		case 'divideIn':
			return rev ? { start: [s, 0, 0, 10, ENTER], end: s } : { start: 0, end: [0, s, 0, 10, ENTER] };
		case 'divideOut':
			return rev ? { start: 0, end: [s, 0, 0, 10, EXIT] } : { start: [0, s, 0, 10, EXIT], end: s };
	}
}

function expectChannel(a: Animatable<number>, ch: Ch, t0 = 0) {
	if (typeof ch === 'number') {
		expect(a.value).toBe(ch);
		expect(a.keyframes).toEqual([]);
		return;
	}
	const [from, to, f0, f1, curve] = ch;
	const { easeOut, easeIn } = cubicToEases(curve);
	expect(a.value).toBe(from);
	expect(a.keyframes.map((k) => [k.time, k.value, k.interpolation])).toEqual([
		[Math.round((t0 + f0) * F), from, 'bezier'],
		[Math.round((t0 + f1) * F), to, 'bezier'],
	]);
	expect(a.keyframes[0]!.easeOut).toEqual(easeOut);
	expect(a.keyframes[1]!.easeIn).toEqual(easeIn);
}

describe('shape.animateTrim keys', () => {
	for (const style of TRIM_ANIMATION_STYLES)
		for (const reverse of [false, true])
			for (const animateOffset of [false, true])
				it(`${style}${reverse ? ' reversed' : ''}${animateOffset ? ' with offset' : ''}`, () => {
					const h = new Harness();
					const id = addVector(h, LINE);
					const r = animate(h, [id], { style, reverse, animateOffset });
					const exp = expected(style, reverse);
					const all = trims(contentsOf(h, id));
					const divide = style.startsWith('divide');
					expect(all.length).toBe(divide ? 4 : 1);
					const master = all.find((t) => t.id === r.clips[0]!.trimIds[0])!;
					expectChannel(master.start, exp.start);
					expectChannel(master.end, exp.end);
					const total = style === 'inOut' ? 15 : 10;
					const offsetCurve =
						style === 'inOut' ? LINEAR : ((exp.end as unknown[])[4] ?? (exp.start as unknown[])[4]);
					expectChannel(
						master.offset,
						animateOffset ? [0, reverse ? -180 : 180, 0, total, offsetCurve as Curve] : 0,
					);
					expect(master.offset.expression).toEqual(
						exp.linked ? { text: `value + -1.8 * content("${master.id}").end`, enabled: true } : undefined,
					);
					expect(master.start.expression).toBeUndefined();
					expect(master.end.expression).toBeUndefined();
					if (!divide) {
						const top = contentsOf(h, id);
						expect(top[top.length - 1]!.id).toBe(master.id);
						expect(top.map((i) => i.type)).toEqual(['path', 'stroke', 'trim']);
					}
					expect(checkInvariants(h.doc)).toEqual([]);
				});

	it('divide: N parts with fresh ids, the master in part 1, linked trims by id', () => {
		const h = new Harness();
		const id = addVector(h, LINE);
		const r = animate(h, [id], { style: 'divideIn', copies: 3 }).clips[0]!;
		const top = contentsOf(h, id) as Group[];
		expect(top.map((g) => [g.type, g.name])).toEqual([
			['group', 'Part 1'],
			['group', 'Part 2'],
			['group', 'Part 3'],
		]);
		expect(r.partIds).toEqual(top.map((g) => g.id));
		// The wrapper (contents were not one group) and parts 2…N are new.
		expect(r.groupIds).toEqual(top.map((g) => g.id));
		const ids = new Set<string>();
		const walk = (items: readonly ShapeItem[]) => {
			for (const it of items) {
				expect(ids.has(it.id)).toBe(false);
				ids.add(it.id);
				if (it.type === 'group') walk(it.contents);
			}
		};
		walk(top);
		const [p1, ...rest] = top;
		const master = p1!.contents[p1!.contents.length - 1] as Trim;
		expect(master.id).toBe(r.trimIds[0]);
		expect(p1!.contents.map((i) => i.type)).toEqual(['path', 'stroke', 'trim']);
		rest.forEach((g, k) => {
			const t = g.contents[g.contents.length - 1] as Trim;
			expect(t.id).toBe(r.trimIds[k + 1]);
			expect(g.contents.map((i) => i.type)).toEqual(['path', 'stroke', 'trim']);
			expect(t.start.expression!.text).toBe(`content("${p1!.id}").content("${master.id}").start`);
			expect(t.end.expression!.text).toBe(`content("${p1!.id}").content("${master.id}").end`);
			expect(t.offset.expression!.text).toBe(`value + content("${p1!.id}").content("${master.id}").offset`);
			expect(t.offset.value).toBeCloseTo(((k + 1) * 360) / 3, 12);
			expect(t.start.keyframes).toEqual([]);
		});
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('divide reuses a single top-level group as part 1 (no wrapper)', () => {
		const h = new Harness();
		const id = addVector(h, [{ type: 'group', name: 'Logo', contents: LINE }]);
		const groupId = contentsOf(h, id)[0]!.id;
		const r = animate(h, [id], { style: 'divideOut', copies: 2 }).clips[0]!;
		expect(r.partIds[0]).toBe(groupId);
		expect(r.groupIds).toEqual([r.partIds[1]]);
		expect(contentsOf(h, id)[0]!.name).toBe('Part 1');
	});

	it('at, durationFrames, offsetDegrees, inOutLag and curve', () => {
		const h = new Harness();
		const id = addVector(h, LINE, { at: 30 });
		const curve = { kind: 'cubic', x1: 0.2, y1: 0.1, x2: 0.3, y2: 0.9 } as const;
		animate(h, [id], {
			style: 'inOut',
			durationFrames: 20,
			inOutLag: 0.25,
			at: 40,
			curve,
			animateOffset: true,
			offsetDegrees: -90,
		});
		const t = trims(contentsOf(h, id))[0]!;
		// Keys in the clip's content time: sequence frame 40 is 10 frames into the clip.
		expectChannel(t.end, [0, 100, 0, 20, curve], 10);
		expectChannel(t.start, [0, 100, 5, 25, curve], 10);
		expectChannel(t.offset, [0, -90, 0, 25, curve], 10);
	});

	it('default at is each clip start; fractional lag keys stay exact', () => {
		const h = new Harness();
		const a = addVector(h, LINE, { at: 0 }, '$a');
		const b = addVector(h, LINE, { at: 50, track: 'V2' }, '$b');
		animate(h, [a, b], { style: 'inOut', durationFrames: 5 });
		for (const id of [a, b]) {
			const t = trims(contentsOf(h, id))[0]!;
			expect(t.end.keyframes.map((k) => k.time)).toEqual([0, 5 * F]);
			expect(t.start.keyframes.map((k) => k.time)).toEqual([Math.round(2.5 * F), Math.round(7.5 * F)]);
		}
	});

	it('speed and reverse speed: keys in content time, mirrored curve on reversed clips', () => {
		const h = new Harness();
		const fast = addVector(h, LINE, {}, '$f');
		const back = addVector(h, LINE, { track: 'V2' }, '$r');
		// Shape clips have no speed control today (kindCapabilities: clip.setSpeed leaves their rate alone), so the
		// speed fields are set on the document directly: the keys must still follow the clip's content-time mapping.
		const doc = structuredClone(h.doc);
		const clips = Object.values(doc.sequences)[0]!.clips;
		clips[fast]!.speed.rate = 2;
		clips[back]!.speed.reverse = true;
		h.doc = doc;
		animate(h, [fast, back], { style: 'in' });
		const tf = trims(contentsOf(h, fast))[0]!;
		expect(tf.end.keyframes.map((k) => [k.time, k.value])).toEqual([
			[0, 0],
			[20 * F, 100],
		]);
		const rc = h.seq.clips[back]!;
		const tr = trims(contentsOf(h, back))[0]!;
		// Sequence frame 0 shows content frame duration − 1; frame 10 shows duration − 11.
		expect(tr.end.keyframes.map((k) => [k.time, k.value])).toEqual([
			[(rc.duration - 11) * F, 100],
			[(rc.duration - 1) * F, 0],
		]);
		// The mirror of the entering curve cubic(⅓, ⅓, ⅔, 1) is cubic(⅓, 0, ⅔, ⅔).
		const mirrored = cubicToEases(EXIT);
		for (const [got, want] of [
			[tr.end.keyframes[0]!.easeOut, mirrored.easeOut],
			[tr.end.keyframes[1]!.easeIn, mirrored.easeIn],
		] as const) {
			expect(got.influence).toBeCloseTo(want.influence, 12);
			expect(got.slope).toBeCloseTo(want.slope, 12);
		}
	});

	it('refuses an animation before the clip content', () => {
		const h = new Harness();
		const id = addVector(h, LINE, { at: 30 });
		const r = h.tx([{ type: 'shape.animateTrim', clipIds: [id], style: 'in', at: 0 }]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.errors[0]!.code).toBe('E_INVALID_PARAM');
	});

	it('rejects out-of-range arguments at the schema', () => {
		const h = new Harness();
		const id = addVector(h, LINE);
		for (const bad of [
			{ style: 'sideways' },
			{ style: 'in', durationFrames: 0 },
			{ style: 'in', durationFrames: 1.5 },
			{ style: 'in', offsetDegrees: 40_000 },
			{ style: 'in', offsetDegrees: Number.NaN },
			{ style: 'divideIn', copies: 1 },
			{ style: 'divideIn', copies: 65 },
			{ style: 'inOut', inOutLag: 1.5 },
			{ style: 'in', curve: { kind: 'cubic', x1: 2, y1: 0, x2: 0.5, y2: 1 } },
			{ style: 'in', bogus: true },
		]) {
			const r = h.tx([{ type: 'shape.animateTrim', clipIds: [id], ...bad }]);
			expect(r.ok, JSON.stringify(bad)).toBe(false);
		}
		expect(h.tx([{ type: 'shape.animateTrim', clipIds: [], style: 'in' }]).ok).toBe(false);
	});

	it('refuses inOutLag 0 (nothing would ever be visible) and accepts the bounds just inside', () => {
		const h = new Harness();
		const id = addVector(h, LINE);
		const r = h.tx([{ type: 'shape.animateTrim', clipIds: [id], style: 'inOut', inOutLag: 0 }]);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.errors[0]!.code).toBe('E_SCHEMA');
			expect(r.errors[0]!.path).toEqual(['inOutLag']);
			expect(r.errors[0]!.message).toMatch(/greater than 0.*nothing is ever visible/);
		}
		expect(h.tx([{ type: 'shape.animateTrim', clipIds: [id], style: 'inOut', inOutLag: -0.1 }]).ok).toBe(
			false,
		);
		// The refusal leaves the document as it was; tiny and full lags still work.
		expect(trims(contentsOf(h, id))).toEqual([]);
		animate(h, [id], { style: 'inOut', inOutLag: 1e-6 });
		animate(h, [id], { style: 'inOut', inOutLag: 1 });
		expect(trims(contentsOf(h, id))[0]!.start.keyframes.map((k) => k.time)).toEqual([10 * F, 20 * F]);
	});
});

/** Positional shape of the contents: types, names and trims' values / keys / expression shapes, ids replaced. */
function signature(items: readonly ShapeItem[]): unknown {
	const ids = new Map<string, string>();
	const tok = (id: string) => {
		if (!ids.has(id)) ids.set(id, `#${ids.size}`);
		return ids.get(id)!;
	};
	const anim = (a: Animatable<number>) => ({
		v: a.value,
		k: a.keyframes.map((k) => [k.time, k.value, k.easeIn, k.easeOut]),
		e: a.expression?.text.replace(/"shp_[^"]+"/g, (m) => tok(m.slice(1, -1))),
	});
	const walk = (list: readonly ShapeItem[]): unknown =>
		list.map((it) => {
			const id = tok(it.id);
			// Group names aside: part 1 keeps the name "Part 1" when a later run merges the parts back.
			if (it.type === 'group') return { id, c: walk(it.contents) };
			if (it.type === 'trim')
				return { id, t: it.mode ?? 'simultaneous', s: anim(it.start), e: anim(it.end), o: anim(it.offset) };
			return { id, type: it.type };
		});
	return walk(items);
}

describe('re-running replaces the earlier animation', () => {
	it('reuses the last top-level trim (id, name, mode) and re-enables it', () => {
		const h = new Harness();
		const id = addVector(h, [
			...LINE,
			{ type: 'trim', name: 'My Trim', end: 40, mode: 'individual', enabled: false },
		]);
		const trimId = contentsOf(h, id)[2]!.id;
		animate(h, [id], { style: 'middleIn', reverse: true, animateOffset: true });
		const r = animate(h, [id], { style: 'out' }).clips[0]!;
		expect(r.trimIds).toEqual([trimId]);
		const t = contentsOf(h, id)[2] as Trim;
		expect([t.name, t.mode, t.enabled]).toEqual(['My Trim', 'individual', undefined]);
		// Replacing a linked reversed animation removes its old offset expression and end keys.
		expectChannel(t.start, [0, 100, 0, 10, EXIT]);
		expectChannel(t.end, 100);
		expectChannel(t.offset, 0);
		expect(t.offset.expression).toBeUndefined();
		// The divide styles keep the reused trim (as the master) and its mode on every part.
		const d = animate(h, [id], { style: 'divideIn', copies: 2 }).clips[0]!;
		expect(d.trimIds[0]).toBe(trimId);
		expect(trims(contentsOf(h, id)).map((x) => x.mode)).toEqual(['individual', 'individual']);
	});

	it('merges parts back when the user added items next to them', () => {
		const h = new Harness();
		const id = addVector(h, LINE);
		animate(h, [id], { style: 'divideIn', copies: 4 });
		h.ok([
			{ type: 'shape.addItems', clipId: id, items: [{ type: 'ellipse', size: [10, 10] }, { type: 'fill' }] },
		]);
		animate(h, [id], { style: 'in' });
		const top = contentsOf(h, id);
		expect(top.map((i) => i.type)).toEqual(['group', 'ellipse', 'fill', 'trim']);
		expect(trims(top).length).toBe(1);
	});
});

describe('clips that cannot take a trim', () => {
	it('converts rectangle / ellipse clips in the same transaction', () => {
		const h = new Harness();
		const id = h.ok([
			{
				type: 'clip.addShape',
				at: 0,
				track: 'V1',
				shape: { type: 'rect', size: [200, 100], stroke: { color: [1, 0, 0, 1], width: 6 } },
				ref: '$r',
			},
		]).refs.$r!;
		const r = animate(h, [id], { style: 'in' }).clips[0]!;
		expect(r.converted).toBe(true);
		const c = h.seq.clips[id] as ShapeClip;
		expect(c.shape.type).toBe('vector');
		expect(contentsOf(h, id).map((i) => i.type)).toEqual(['rect', 'stroke', 'fill', 'trim']);
		// The picture stays put: the anchor moved by half the box change (box centre → frame centre).
		expect(c.transform.anchor.value).toEqual(c.transform.position.value);
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('skips other clips with W_TRIM_SKIPPED and refuses when none apply', () => {
		const h = new Harness();
		const shape = addVector(h, LINE);
		const fillOnly = addVector(h, [{ type: 'fill' }], { track: 'V2' }, '$f');
		const text = h.ok([
			{ type: 'clip.addText', at: 0, duration: 30, track: 'V3', content: { text: 'Hi' }, ref: '$t' },
		]).refs.$t!;
		const r = h.ok([{ type: 'shape.animateTrim', clipIds: [shape, fillOnly, text], style: 'in' }]);
		const res = r.results[0] as Ok & { skipped: string[] };
		expect(res.clips.map((c) => c.clipId)).toEqual([shape]);
		expect(res.skipped).toEqual([fillOnly, text]);
		expect(r.warnings.map((w) => w.code)).toEqual(['W_TRIM_SKIPPED']);
		expect(r.warnings[0]!.message).toContain(fillOnly);
		expect(r.warnings[0]!.message).toContain(text);
		const bad = h.tx([{ type: 'shape.animateTrim', clipIds: [fillOnly, text], style: 'in' }]);
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.errors[0]!.code).toBe('E_INVALID_PARAM');
		const missing = h.tx([{ type: 'shape.animateTrim', clipIds: ['clp_00000000000000zz'], style: 'in' }]);
		expect(!missing.ok && missing.errors[0]!.code).toBe('E_NOT_FOUND');
	});

	it('refuses clips on locked tracks', () => {
		const h = new Harness();
		const id = addVector(h, LINE);
		h.ok([{ type: 'track.update', trackId: 'V1', patch: { locked: true } }]);
		for (const c of [
			{ type: 'shape.animateTrim', clipIds: [id], style: 'in' },
			{ type: 'shape.reversePathDirection', clipIds: [id] },
		]) {
			const r = h.tx([c]);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.errors[0]!.code).toBe('E_TRACK_LOCKED');
		}
	});

	it('caps divided item counts', () => {
		const h = new Harness();
		const many = Array.from({ length: 400 }, () => ({ type: 'path', path: 'M 0 0 L 1 1' }));
		const id = addVector(h, many);
		const r = h.tx([{ type: 'shape.animateTrim', clipIds: [id], style: 'divideIn', copies: 64 }]);
		expect(!r.ok && r.errors[0]!.code).toBe('E_LIMIT');
	});
});

describe('undo / redo', () => {
	it('the earlier document is untouched and the edit re-applies identically', () => {
		const h = new Harness();
		const id = addVector(h, [{ type: 'rect', size: [100, 60] }, { type: 'stroke' }]);
		animate(h, [id], { style: 'middleIn', reverse: true });
		const before = h.doc;
		const frozen = structuredClone(before);
		const rev = h.revision;
		animate(h, [id], { style: 'divideOut', copies: 3, animateOffset: true });
		const after = structuredClone(h.doc);
		// Undo restores the snapshot (History keeps `before`): it was not mutated by the edit.
		expect(before).toEqual(frozen);
		// Redo: the same command on the restored document gives the same contents (ids aside).
		h.doc = before;
		h.revision = rev;
		animate(h, [id], { style: 'divideOut', copies: 3, animateOffset: true });
		expect(signature(contentsOf(h, id))).toEqual(
			signature(((after.sequences[h.seqId]!.clips[id] as ShapeClip).shape as VectorShapeData).contents),
		);
		expect(checkInvariants(h.doc)).toEqual([]);
	});
});

describe('shape.reversePathDirection', () => {
	it('toggles every path item at all depths; twice restores the contents', () => {
		const h = new Harness();
		const id = addVector(h, [
			{
				type: 'group',
				contents: [
					{ type: 'ellipse', size: [50, 50] },
					{ type: 'group', contents: [{ type: 'rect' }] },
				],
			},
			{ type: 'polystar', direction: 'reversed' },
			{ type: 'path', path: 'M 0 0 L 10 0' },
			{ type: 'stroke' },
		]);
		const orig = structuredClone(contentsOf(h, id));
		const r = h.ok([{ type: 'shape.reversePathDirection', clipIds: [id] }]);
		expect(r.results[0]).toEqual({ clips: [{ clipId: id, paths: 4 }] });
		const dirs: (string | undefined)[] = [];
		const walk = (items: readonly ShapeItem[]) => {
			for (const it of items) {
				if ('direction' in it || ['rect', 'ellipse', 'polystar', 'path'].includes(it.type))
					dirs.push((it as { direction?: string }).direction);
				if (it.type === 'group') walk(it.contents);
			}
		};
		walk(contentsOf(h, id));
		expect(dirs).toEqual(['reversed', 'reversed', undefined, 'reversed']);
		h.ok([{ type: 'shape.reversePathDirection', clipIds: [id] }]);
		expect(contentsOf(h, id)).toEqual(orig);
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('the renderer honours the direction for trims', () => {
		const h = new Harness();
		const id = addVector(h, [...LINE, { type: 'trim', end: 25 }]);
		const span = () => {
			const draws = evaluateVectorShape(contentsOf(h, id), 0);
			const seg = draws[0]!.paths[0]!.segs;
			return [seg[0]![0][0], seg[seg.length - 1]![3][0]];
		};
		// [0, 25 %] of a line from x = −100 to 100: from the start, or (reversed) from the end.
		expect(span()[0]).toBeCloseTo(-100, 3);
		expect(span()[1]).toBeCloseTo(-50, 3);
		h.ok([{ type: 'shape.reversePathDirection', clipIds: [id] }]);
		expect(span()[0]).toBeCloseTo(100, 3);
		expect(span()[1]).toBeCloseTo(50, 3);
	});

	it('skips rectangle / ellipse and non-shape clips', () => {
		const h = new Harness();
		const id = addVector(h, LINE);
		const rect = h.ok([{ type: 'clip.addShape', at: 0, track: 'V2', shape: { type: 'rect' }, ref: '$r' }])
			.refs.$r!;
		const r = h.ok([{ type: 'shape.reversePathDirection', clipIds: [id, rect] }]);
		expect(r.warnings.map((w) => w.code)).toEqual(['W_TRIM_SKIPPED']);
		expect(h.tx([{ type: 'shape.reversePathDirection', clipIds: [rect] }]).ok).toBe(false);
	});
});

describe('shape.addLine', () => {
	it('a centred, stroke-only open line with its anchor at its centre', () => {
		const h = new Harness();
		const r = h.ok([{ type: 'shape.addLine', orientation: 'horizontal', ref: '$l' }]);
		const res = r.results[0] as { clipId: string; pathId: string; strokeId: string; length: number };
		expect(res.clipId).toBe(r.refs.$l);
		expect(res.length).toBeCloseTo(1152, 9);
		const c = h.seq.clips[res.clipId] as ShapeClip;
		expect(c.name).toBe('Line');
		expect([c.start, c.duration]).toEqual([0, 150]);
		expect(c.transform.anchor.value).toEqual([960, 540]);
		expect(c.transform.position.value).toEqual([960, 540]);
		const items = contentsOf(h, res.clipId);
		expect(items.map((i) => [i.type, i.id])).toEqual([
			['path', res.pathId],
			['stroke', res.strokeId],
		]);
		const p = items[0] as Extract<ShapeItem, { type: 'path' }>;
		expect(p.path.value.closed).toBe(false);
		expect(p.path.value.vertices.map((v) => v.p)).toEqual([
			[-576, 0],
			[576, 0],
		]);
		expect(items[1]).toMatchObject({ color: { value: [1, 1, 1, 1] }, width: { value: 8 } });
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('vertical, explicit options, default track rule', () => {
		const h = new Harness();
		addVector(h, LINE); // V1 busy over 0…90
		const r = h.ok([
			{
				type: 'shape.addLine',
				orientation: 'vertical',
				length: 300,
				strokeWidth: 3,
				color: [0, 1, 0, 0.5],
				at: 10,
				durationFrames: 40,
				name: 'Divider',
			},
		]);
		const { clipId } = r.results[0] as { clipId: string };
		const c = h.seq.clips[clipId] as ShapeClip;
		// Default track: the top video track (free over the range), not the busy V1.
		expect(c.trackId).toBe(h.seq.videoTracks[h.seq.videoTracks.length - 1]!.id);
		expect(c.trackId).not.toBe(h.seq.videoTracks[0]!.id);
		expect([c.start, c.duration, c.name]).toEqual([10, 40, 'Divider']);
		const [p, s] = contentsOf(h, clipId) as [
			Extract<ShapeItem, { type: 'path' }>,
			Extract<ShapeItem, { type: 'stroke' }>,
		];
		expect(p.path.value.vertices.map((v) => v.p)).toEqual([
			[0, -150],
			[0, 150],
		]);
		expect([s.color.value, s.width.value]).toEqual([[0, 1, 0, 0.5], 3]);
		const onV2 = h.ok([{ type: 'shape.addLine', orientation: 'vertical', trackId: 'V2', at: 200 }]);
		const c2 = h.seq.clips[(onV2.results[0] as { clipId: string }).clipId]!;
		expect(c2.trackId).toBe(h.seq.videoTracks[1]!.id);
		expect(h.seq.clips[clipId]!.duration).toBe(40);
	});

	it('refuses bad arguments', () => {
		const h = new Harness();
		for (const bad of [
			{ orientation: 'diagonal' },
			{ orientation: 'horizontal', length: 0 },
			{ orientation: 'horizontal', strokeWidth: -1 },
			{ orientation: 'horizontal', color: [2, 0, 0, 1] },
			{ orientation: 'horizontal', durationFrames: 0 },
			{ orientation: 'horizontal', trackId: 'Q9' },
		])
			expect(h.tx([{ type: 'shape.addLine', ...bad }]).ok, JSON.stringify(bad)).toBe(false);
	});
});
