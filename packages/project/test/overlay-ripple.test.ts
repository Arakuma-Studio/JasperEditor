// Generated overlays across ripple edits (overlay-ripple.ts; docs/wp-notes/edit-ux.md "Overlays across ripple
// edits"). Reported on a real cut: range.extract and ripple trims on sync-locked tracks split the V2 day cards — 363-frame
// text clips that pop in, shrink to a corner and pop out at their end — into pieces with gaps, losing the keyframes of
// the other part. A card spanning a ripple on another track now stays one clip: shortened / lengthened inside its
// still stretch, so the pop-in and shrink stay on its start and the pop-out on its end.
import { describe, expect, it } from 'vitest';
import { buildClipsPayload, checkInvariants, flicksPerFrame, RATES } from '../src/index.ts';
import { Harness } from './helpers.ts';

const F = flicksPerFrame(RATES.r30);
const S = 300; // the card's first frame
const LEN = 363;

/** Scale keys of the reported card (frames from its start): pop in, settle, shrink to the corner, hold, pop out. */
const SCALE: Array<[number, number]> = [
	[0, 0],
	[6, 640],
	[16, 560],
	[42, 560],
	[54, 82],
	[66, 100],
	[354, 100],
	[358, 125],
	[362, 0],
];
const POSITION: Array<[number, [number, number]]> = [
	[0, [960, 540]],
	[42, [960, 540]],
	[54, [232, 90]],
];

const solid = (at: number, duration: number, track: string) => ({
	type: 'clip.addSolid',
	at,
	duration,
	track,
	color: [0, 0, 0, 1],
});

/** V1 footage under the whole range, the day card on (sync-locked) V2. */
function dayCard(h: Harness, under: unknown[] = []) {
	const m = h.registerVideo({ seconds: 60, audio: false });
	const r = h.ok([
		...(under.length
			? under
			: [{ type: 'clip.place', source: { mediaId: m }, at: 0, tracks: { video: 'V1' } }]),
		{ type: 'clip.addText', at: S, duration: LEN, track: 'V2', content: { text: 'Día 1' }, ref: '$card' },
	]);
	const id = r.refs.$card!;
	const keys = (prop: string, list: Array<[number, unknown]>) => [
		{ type: 'param.setAnimated', target: ['clip', id, 'transform', prop], animated: true, at: { flicks: 0 } },
		...list.map(([f, value]) => ({
			type: 'param.set',
			target: ['clip', id, 'transform', prop],
			value,
			at: { flicks: f * F },
		})),
	];
	h.ok([...keys('scale', SCALE), ...keys('position', POSITION)]);
	return id;
}

/** The card's keys as [frame from its start, value]. */
function keysOf(h: Harness, id: string, prop: 'scale' | 'position') {
	const c = h.seq.clips[id] as unknown as {
		sourceIn: number;
		transform: Record<string, { keyframes: { time: number; value: unknown }[] }>;
	};
	return c.transform[prop]!.keyframes.map((k) => [(k.time - c.sourceIn) / F, k.value]);
}

/** The reported keys with those at or after `from` moved by `delta` frames. */
const moved = <T>(list: Array<[number, T]>, from: number, delta: number) =>
	list.map(([f, v]) => [f >= from ? f + delta : f, v]);

function expectWholeCard(h: Harness, id: string, start: number, duration: number) {
	expect(h.clips('V2').map((c) => c.id)).toEqual([id]);
	expect(h.spans('V2')).toEqual([[start, start + duration]]);
	expect(checkInvariants(h.doc)).toEqual([]);
}

describe('generated overlays across ripple edits', () => {
	it('range.extract inside a 363-frame day card keeps it whole, its pop-out still on its end', () => {
		const h = new Harness();
		const card = dayCard(h);
		const r = h.ok([{ type: 'range.extract', from: S + 200, to: S + 230 }]);
		expect(r.warnings.map((w) => w.code)).toContain('W_OVERLAY_FITTED');
		expectWholeCard(h, card, S, LEN - 30);
		expect(keysOf(h, card, 'scale')).toEqual(moved(SCALE, 200, -30));
		expect(keysOf(h, card, 'position')).toEqual(POSITION);
		// V1 footage is cut as before
		expect(h.spans('V1')).toEqual([
			[0, S + 200],
			[S + 200, 1770],
		]);
	});

	it('a cut inside the shrink takes its frames from the still corner hold instead', () => {
		const h = new Harness();
		const card = dayCard(h);
		h.ok([{ type: 'range.extract', from: S + 45, to: S + 60 }]);
		expectWholeCard(h, card, S, LEN - 15);
		expect(keysOf(h, card, 'scale')).toEqual(moved(SCALE, 354, -15));
		expect(keysOf(h, card, 'position')).toEqual(POSITION);
	});

	it('several Clean Up cuts inside the card (one pass) keep it whole', () => {
		const h = new Harness();
		const a = h.registerVideo({ seconds: 60, kind: 'audio' });
		const card = dayCard(h, [{ type: 'clip.place', source: { mediaId: a }, at: 0, tracks: { audio: 'A1' } }]);
		const speech = h.clips('A1')[0]!.id;
		h.ok([
			{
				type: 'cleanup.apply',
				clipIds: [speech],
				ranges: [
					{ start: S + 100, end: S + 110 },
					{ start: S + 250, end: S + 262 },
				],
			},
		]);
		expectWholeCard(h, card, S, LEN - 22);
		expect(keysOf(h, card, 'scale')).toEqual(moved(SCALE, 354, -22));
	});

	it('ripple trims on V1 shorten or lengthen the card instead of refusing or splitting it', () => {
		const h = new Harness();
		const card = dayCard(h, [solid(0, S + 180, 'V1'), solid(S + 180, 600, 'V1')]);
		const first = h.clips('V1')[0]!.id;
		h.ok([{ type: 'clip.trim', clipId: first, edge: 'out', deltaFrames: -30, mode: 'ripple' }]);
		expectWholeCard(h, card, S, LEN - 30);
		expect(keysOf(h, card, 'scale')).toEqual(moved(SCALE, 354, -30));
		h.ok([{ type: 'clip.trim', clipId: first, edge: 'out', deltaFrames: 50, mode: 'ripple' }]);
		expectWholeCard(h, card, S, LEN + 20);
		expect(keysOf(h, card, 'scale')).toEqual(moved(SCALE, 354, 20));
		expect(keysOf(h, card, 'position')).toEqual(POSITION);
	});

	it('clip.extract of a shot under the card shortens it instead of refusing', () => {
		const h = new Harness();
		const card = dayCard(h, [solid(0, S + 150, 'V1'), solid(S + 150, 30, 'V1'), solid(S + 180, 600, 'V1')]);
		h.ok([{ type: 'clip.extract', clipIds: [h.clips('V1')[1]!.id] }]);
		expectWholeCard(h, card, S, LEN - 30);
		expect(keysOf(h, card, 'scale')).toEqual(moved(SCALE, 354, -30));
	});

	it('a ripple trim that would remove a whole title is still refused', () => {
		const h = new Harness();
		h.ok([solid(0, 200, 'V1'), solid(200, 200, 'V1')]);
		h.ok([{ type: 'clip.addText', at: 175, duration: 10, track: 'V2', content: { text: 'x' } }]);
		const r = h.tx([
			{ type: 'clip.trim', clipId: h.clips('V1')[0]!.id, edge: 'out', deltaFrames: -30, mode: 'ripple' },
		]);
		expect(r).toMatchObject({ ok: false, errors: [{ code: 'E_SYNC_CONFLICT' }] });
		if (!r.ok) expect(r.errors[0]!.blocking).toEqual(h.clips('V2').map((c) => c.id));
	});

	it('a track the extract names is cut as before', () => {
		const h = new Harness();
		dayCard(h);
		h.ok([{ type: 'range.extract', from: S + 200, to: S + 230, tracks: ['V1', 'V2'] }]);
		expect(h.spans('V2')).toEqual([
			[S, S + 200],
			[S + 200, S + LEN - 30],
		]);
	});
});

/** V1 footage: [0, S+150), a 30-frame shot [S+150, S+180), [S+180, …) — each a separate video clip. */
function shots(h: Harness, gap = false) {
	const m = h.registerVideo({ seconds: 60, audio: false });
	const place = (at: number, from: number, frames: number) => ({
		type: 'clip.place',
		source: { mediaId: m },
		at,
		sourceRange: { in: { sourceFrames: from }, out: { sourceFrames: from + frames } },
		tracks: { video: 'V1' },
	});
	return [place(0, 0, S + 150), ...(gap ? [] : [place(S + 150, 600, 30)]), place(S + 180, 900, 600)];
}

describe('generated overlays across insert edits', () => {
	it('insert placement inside the card lengthens it instead of splitting it', () => {
		const h = new Harness();
		const card = dayCard(h);
		const m = h.registerVideo({ seconds: 10, audio: false });
		h.ok([
			{
				type: 'clip.place',
				source: { mediaId: m },
				at: S + 180,
				mode: 'insert',
				sourceRange: { in: { sourceFrames: 0 }, out: { sourceFrames: 30 } },
				tracks: { video: 'V1' },
			},
		]);
		expectWholeCard(h, card, S, LEN + 30);
		expect(keysOf(h, card, 'scale')).toEqual(moved(SCALE, 354, 30));
		expect(keysOf(h, card, 'position')).toEqual(POSITION);
	});

	it('paste insert inside the card lengthens it', () => {
		const h = new Harness();
		const card = dayCard(h);
		h.ok([solid(3000, 30, 'V3')]);
		const copied = buildClipsPayload(h.doc, h.seqId, [h.clips('V3')[0]!.id]);
		const payload = JSON.parse(JSON.stringify(copied));
		h.ok([{ type: 'clip.paste', payload, at: S + 180, mode: 'insert', tracks: { video: 'V1' } }]);
		expectWholeCard(h, card, S, LEN + 30);
		expect(keysOf(h, card, 'scale')).toEqual(moved(SCALE, 354, 30));
	});

	it('an insert move onto V1 inside the card lengthens it', () => {
		const h = new Harness();
		const card = dayCard(h);
		h.ok([solid(3000, 30, 'V3')]);
		h.ok([
			{
				type: 'clip.move',
				clipIds: [h.clips('V3')[0]!.id],
				deltaFrames: S + 180 - 3000,
				deltaTracks: -2,
				mode: 'insert',
			},
		]);
		expectWholeCard(h, card, S, LEN + 30);
		expect(keysOf(h, card, 'scale')).toEqual(moved(SCALE, 354, 30));
	});

	it('Insert Frame Hold Segment inside the card lengthens it', () => {
		const h = new Harness();
		const card = dayCard(h);
		h.ok([{ type: 'clip.insertFrameHoldSegment', clipId: h.clips('V1')[0]!.id, at: S + 180, duration: 30 }]);
		expectWholeCard(h, card, S, LEN + 30);
		expect(keysOf(h, card, 'scale')).toEqual(moved(SCALE, 354, 30));
	});

	it('a ripple speed change under the card lengthens or shortens it', () => {
		const h = new Harness();
		const card = dayCard(h, shots(h));
		const shot = h.clips('V1')[1]!.id;
		h.ok([{ type: 'clip.setSpeed', clipIds: [shot], rate: 0.5, ripple: true }]);
		expectWholeCard(h, card, S, LEN + 30);
		expect(keysOf(h, card, 'scale')).toEqual(moved(SCALE, 354, 30));
		h.ok([{ type: 'clip.setSpeed', clipIds: [shot], rate: 2, ripple: true }]);
		expectWholeCard(h, card, S, LEN - 15);
		expect(keysOf(h, card, 'scale')).toEqual(moved(SCALE, 354, -15));
	});

	it('gap.close under the card shortens it instead of refusing', () => {
		const h = new Harness();
		const card = dayCard(h, shots(h, true));
		h.ok([{ type: 'gap.close', trackId: 'V1', at: S + 160 }]);
		expectWholeCard(h, card, S, LEN - 30);
		expect(keysOf(h, card, 'scale')).toEqual(moved(SCALE, 354, -30));
	});
});
