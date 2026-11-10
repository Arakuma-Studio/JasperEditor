// Join fades of range cuts (docs/wp-notes/transcript-cleanup.md "Join fades of range cuts"): `range.extract`,
// `range.lift`, `transcript.extract` / `transcript.lift` and `clip.extract` give the audio edges they cut Clean Up's
// 4 ms equal-power `edgeFades` in the same undo step (`joinFades: false` keeps hard cuts), and `audio.smoothJoins`
// fades the hard audio joins already in a sequence. Rendered through the offline mixer every export path uses, the
// join no longer has a click step over verify_export's threshold.
import { describe, expect, it } from 'vitest';
import {
	buildRenderSnapshot,
	type ClipReader,
	checkInvariants,
	type ProjectDocument,
	type RenderAudioClip,
	renderMixToBuffers,
} from '../src/index.ts';
import { FLICKS_PER_SECOND } from '../src/time.ts';
import { Harness } from './helpers.ts';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const fadesOf = (c: unknown) => (c as { edgeFades?: unknown }).edgeFades;
const s = (x: number) => Math.round(x * FLICKS_PER_SECOND);

/** 30 fps: a 20 s clip with sound placed at 0 on V1 + A1 (linked, 600 frames). */
function take() {
	const H = new Harness();
	const mediaId = H.registerVideo({ seconds: 20 });
	H.ok([{ type: 'clip.place', source: { mediaId }, at: 0, tracks: { video: 'V1', audio: ['A1'] } }]);
	return { H, mediaId };
}

/** Two 10 s audio recordings butted on A1: X [0, 300), Y [300, 600). */
function twoRecordings() {
	const H = new Harness();
	const x = H.registerVideo({ seconds: 10, kind: 'audio' });
	const y = H.registerVideo({ seconds: 10, kind: 'audio' });
	H.ok([
		{ type: 'clip.place', source: { mediaId: x }, at: 0, tracks: { audio: 'A1' } },
		{ type: 'clip.place', source: { mediaId: y }, at: 300, tracks: { audio: 'A1' } },
	]);
	return H;
}

/** Runs `commands` as one transaction; checks it is one revision, leaves the previous document untouched and valid. */
function oneStep(H: Harness, commands: unknown[]) {
	const before = H.doc;
	const snap = clone(before);
	const rev = H.revision;
	const r = H.ok(commands);
	expect(H.revision).toBe(rev + 1);
	expect(before).toEqual(snap);
	expect(checkInvariants(H.doc)).toEqual([]);
	return { r, before };
}

describe('range cuts fade the audio edges they make', () => {
	it('range.extract: both faces of the join, in one undo step; picture and untouched edges keep none', () => {
		const { H } = take();
		const { r, before } = oneStep(H, [{ type: 'range.extract', from: 100, to: 150 }]);
		expect((r.results[0] as { fades: number }).fades).toBe(2);
		const [left, right] = H.clips('A1');
		expect(H.spans('A1')).toEqual([
			[0, 100],
			[100, 550],
		]);
		expect(fadesOf(left)).toEqual({ outMs: 4 });
		expect(fadesOf(right)).toEqual({ inMs: 4 });
		for (const v of H.clips('V1')) expect(fadesOf(v)).toBeUndefined();
		// undo restores the previous document: no fades there
		for (const c of Object.values(Object.values((before as ProjectDocument).sequences)[0]!.clips))
			expect(fadesOf(c)).toBeUndefined();
	});

	it('range.lift fades the faces it leaves at the gap', () => {
		const { H } = take();
		oneStep(H, [{ type: 'range.lift', from: 100, to: 150 }]);
		const [left, right] = H.clips('A1');
		expect(H.spans('A1')).toEqual([
			[0, 100],
			[150, 600],
		]);
		expect(fadesOf(left)).toEqual({ outMs: 4 });
		expect(fadesOf(right)).toEqual({ inMs: 4 });
	});

	it('a range starting at a clip edge leaves that edge as it was', () => {
		const H = twoRecordings();
		const r = H.ok([{ type: 'range.extract', from: 300, to: 330 }]);
		expect((r.results[0] as { fades: number }).fades).toBe(1);
		const [x, y] = H.clips('A1');
		expect(fadesOf(x)).toBeUndefined();
		expect(fadesOf(y)).toEqual({ inMs: 4 });
	});

	it('joinFades: false keeps hard cuts', () => {
		const { H } = take();
		const r = H.ok([
			{ type: 'range.extract', from: 100, to: 150, joinFades: false },
			{ type: 'range.lift', from: 200, to: 220, joinFades: false },
		]);
		expect(r.results.map((x) => (x as { fades: number }).fades)).toEqual([0, 0]);
		for (const c of H.clips()) expect(fadesOf(c)).toBeUndefined();
	});

	it('transcript.extract / transcript.lift fade the cut, or keep it hard with joinFades: false', () => {
		const words = () => {
			const { H, mediaId } = take();
			H.ok([
				{
					type: 'transcript.create',
					mediaId,
					language: 'en',
					origin: 'manual',
					words: ['one', 'two', 'three', 'four', 'five'].map((text, i) => ({
						text,
						start: s(1 + i),
						end: s(1.5 + i),
						confidence: 0.9,
					})),
				},
			]);
			return H;
		};
		const H = words();
		const { r } = oneStep(H, [{ type: 'transcript.extract', fromWord: 1, toWord: 2 }]);
		expect(r.results[0]).toMatchObject({ from: 60, to: 105, fades: 2 });
		const [left, right] = H.clips('A1');
		expect(fadesOf(left)).toEqual({ outMs: 4 });
		expect(fadesOf(right)).toEqual({ inMs: 4 });

		const L = words();
		L.ok([{ type: 'transcript.lift', fromWord: 1, toWord: 2 }]);
		expect(L.clips('A1').map(fadesOf)).toEqual([{ outMs: 4 }, { inMs: 4 }]);

		const hard = words();
		hard.ok([{ type: 'transcript.extract', fromWord: 1, toWord: 2, joinFades: false }]);
		for (const c of hard.clips('A1')) expect(fadesOf(c)).toBeUndefined();
	});

	it('removeFillers / removePauses default to the join fade; fadeMs: 0 keeps hard cuts', () => {
		const run = (fadeMs?: number) => {
			const { H, mediaId } = take();
			H.ok([
				{
					type: 'transcript.create',
					mediaId,
					language: 'en',
					origin: 'manual',
					words: ['so', 'um', 'rivers'].map((text, i) => ({
						text,
						start: s(1 + i),
						end: s(1.5 + i),
						confidence: 0.9,
					})),
				},
			]);
			H.ok([{ type: 'transcript.removeFillers', ...(fadeMs !== undefined ? { fadeMs } : {}) }]);
			return H.clips('A1').map(fadesOf);
		};
		expect(run()).toEqual([{ outMs: 4 }, { inMs: 4 }]);
		expect(run(0)).toEqual([undefined, undefined]);
	});
});

describe('clip.extract (ripple delete)', () => {
	it('fades the new join between two pieces of one recording (split + ripple delete)', () => {
		const { H } = take();
		H.ok([
			{ type: 'clip.split', tracks: ['A1'], at: 100 },
			{ type: 'clip.split', tracks: ['A1'], at: 150 },
		]);
		// splits alone are through edits: nothing fades
		for (const c of H.clips()) expect(fadesOf(c)).toBeUndefined();
		const mid = [H.clips('A1')[1]!.id, H.clips('V1')[1]!.id];
		const { r } = oneStep(H, [{ type: 'clip.extract', clipIds: mid }]);
		expect((r.results[0] as { fades: number }).fades).toBe(2);
		expect(H.spans('A1')).toEqual([
			[0, 100],
			[100, 550],
		]);
		expect(H.clips('A1').map(fadesOf)).toEqual([{ outMs: 4 }, { inMs: 4 }]);
		for (const v of H.clips('V1')) expect(fadesOf(v)).toBeUndefined();
	});

	it('keeps hard cuts with joinFades: false, and leaves joins between different recordings alone', () => {
		const { H } = take();
		H.ok([
			{ type: 'clip.split', tracks: ['A1'], at: 100 },
			{ type: 'clip.split', tracks: ['A1'], at: 150 },
		]);
		H.ok([{ type: 'clip.extract', clipIds: [H.clips('A1')[1]!.id, H.clips('V1')[1]!.id], joinFades: false }]);
		for (const c of H.clips()) expect(fadesOf(c)).toBeUndefined();

		const D = twoRecordings();
		const z = D.registerVideo({ seconds: 10, kind: 'audio' });
		// X [0, 300), Z [300, 600), Y [600, 900): deleting Z butts X against Y
		D.ok([{ type: 'clip.place', source: { mediaId: z }, at: 300, tracks: { audio: 'A1' }, mode: 'insert' }]);
		const zc = D.clips('A1').find((c) => (c as { mediaId?: string }).mediaId === z)!;
		D.ok([{ type: 'clip.extract', clipIds: [zc.id] }]);
		for (const c of D.clips('A1')) expect(fadesOf(c)).toBeUndefined();
	});
});

describe('audio.smoothJoins', () => {
	/** A1: one recording with a hard cut at 100 (an extract without fades) and a through edit at 300; A2: two recordings
	 * butted at 300. */
	function project() {
		const { H } = take();
		const x = H.registerVideo({ seconds: 10, kind: 'audio' });
		const y = H.registerVideo({ seconds: 10, kind: 'audio' });
		H.ok([
			{ type: 'range.extract', from: 100, to: 150, joinFades: false },
			{ type: 'clip.split', tracks: ['A1'], at: 300 },
			{ type: 'clip.place', source: { mediaId: x }, at: 0, tracks: { audio: 'A2' } },
			{ type: 'clip.place', source: { mediaId: y }, at: 300, tracks: { audio: 'A2' } },
		]);
		return H;
	}

	it('fades both sides of every hard audio join in one undo step; through edits and existing fades stay', () => {
		const H = project();
		const { r } = oneStep(H, [{ type: 'audio.smoothJoins', tracks: ['A2'], fadeMs: 6 }]);
		expect(r.results[0]).toEqual({ joins: 1, fades: 2, fadeMs: 6 });
		expect(H.clips('A2').map(fadesOf)).toEqual([{ outMs: 6 }, { inMs: 6 }]);
		expect(H.clips('A1').map(fadesOf)).toEqual([undefined, undefined, undefined]);
		const all = oneStep(H, [{ type: 'audio.smoothJoins' }]);
		expect(all.r.results[0]).toEqual({ joins: 2, fades: 2, fadeMs: 4 });
		expect(H.clips('A1').map(fadesOf)).toEqual([{ outMs: 4 }, { inMs: 4 }, undefined]);
		expect(H.clips('A2').map(fadesOf)).toEqual([{ outMs: 6 }, { inMs: 6 }]);
		for (const v of H.clips('V1')) expect(fadesOf(v)).toBeUndefined();
		// a second pass finds nothing left to fade
		expect(H.ok([{ type: 'audio.smoothJoins' }]).results[0]).toMatchObject({ joins: 2, fades: 0 });
	});

	it('`at` limits it to the joins within a frame of the given times and lists the times with none', () => {
		const H = project();
		const r = H.ok([{ type: 'audio.smoothJoins', at: [101, 450], fadeMs: 8 }]);
		expect(r.results[0]).toEqual({ joins: 1, fades: 2, fadeMs: 8, unmatched: [450] });
		expect(H.clips('A1').map(fadesOf)).toEqual([{ outMs: 8 }, { inMs: 8 }, undefined]);
		expect(H.clips('A2').map(fadesOf)).toEqual([undefined, undefined]);
	});

	it('refuses picture tracks and a named locked track; skips locked tracks by default', () => {
		const H = project();
		const bad = H.tx([{ type: 'audio.smoothJoins', tracks: ['V1'] }]);
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.errors[0]!.code).toBe('E_INVALID_PARAM');
		H.ok([{ type: 'track.update', trackId: 'A1', patch: { locked: true } }]);
		const locked = H.tx([{ type: 'audio.smoothJoins', tracks: ['A1'] }]);
		expect(locked.ok).toBe(false);
		if (!locked.ok) expect(locked.errors[0]!.code).toBe('E_TRACK_LOCKED');
		const r = H.ok([{ type: 'audio.smoothJoins' }]);
		expect(r.results[0]).toMatchObject({ joins: 1 });
		expect(H.clips('A1').map(fadesOf)).toEqual([undefined, undefined, undefined]);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// The join as every export path mixes it (`renderMixToBuffers`), with a 220 Hz tone: a hard cut jumps in phase.

const SR = 48_000;
const SPF = SR / 30;

/** A 220 Hz tone at 0.5 in media time, following the clip's placement. */
const tone = (clip: RenderAudioClip, at: { offset: number; length: number }): ClipReader => {
	const ch = clip.channels.map.length || 2;
	const s0 = (clip.start - (clip.headHandle ?? 0)) * SPF;
	let pos = at.offset;
	const stop = at.offset + at.length;
	return {
		channels: ch,
		read(out, frames) {
			const n = Math.max(0, Math.min(frames, stop - pos));
			for (let i = 0; i < n; i++) {
				const t = clip.sourceIn / FLICKS_PER_SECOND + (s0 + pos + i) / SR - clip.start / 30;
				const v = 0.5 * Math.sin(2 * Math.PI * 220 * t);
				for (let c = 0; c < ch; c++) out[c]![i] = v;
			}
			pos += n;
			return n;
		},
		close() {},
	};
};

/**
 * verify_export's `cut-click` measure (apps/engine/src/export/verify.ts): the largest sample step within ±10 ms of
 * the join over the RMS of the steps in the centred 20 ms without ±2 ms around it, in dB. Over 12 dB is a click.
 */
async function clickDb(H: Harness, joinFrame: number): Promise<number> {
	const snapshot = buildRenderSnapshot(H.doc, H.seqId, {
		resolveMedia: (a) => ({
			url: a.id,
			proxyUrl: null,
			kind: a.kind,
			width: null,
			height: null,
			durationFlicks: a.probe.durationFlicks,
			hasAudio: true,
			rotation: 0,
		}),
		resolveFont: () => null,
	});
	const out = await renderMixToBuffers({
		snapshot,
		openClip: tone,
		startSample: (joinFrame - 1) * SPF,
		length: 2 * SPF,
	});
	const x = out[0]!;
	const J = SPF;
	const win = 0.01 * SR;
	const iso = 0.002 * SR;
	let peak = 0;
	let at = J;
	for (let i = J - win; i <= J + win; i++) {
		const d = Math.abs(x[i]! - x[i - 1]!);
		if (d > peak) [peak, at] = [d, i];
	}
	let sum = 0;
	let n = 0;
	for (let i = at - win; i <= at + win; i++) {
		if (Math.abs(i - at) <= iso) continue;
		sum += (x[i]! - x[i - 1]!) ** 2;
		n++;
	}
	return 20 * Math.log10(peak / Math.sqrt(sum / n));
}

describe('the join in the export mix', () => {
	it('a range.extract join no longer clicks; a hard cut does', async () => {
		// 31 frames of a 220 Hz tone are 227⅓ cycles: the hard cut jumps a third of a cycle
		const { H } = take();
		H.ok([{ type: 'range.extract', from: 60, to: 91 }]);
		const { H: hard } = take();
		hard.ok([{ type: 'range.extract', from: 60, to: 91, joinFades: false }]);
		expect(await clickDb(hard, 60)).toBeGreaterThan(12);
		expect(await clickDb(H, 60)).toBeLessThan(12);
	});

	it('audio.smoothJoins removes the click of an existing hard cut', async () => {
		const { H } = take();
		H.ok([{ type: 'range.extract', from: 60, to: 91, joinFades: false }]);
		H.ok([{ type: 'audio.smoothJoins', at: [60] }]);
		expect(await clickDb(H, 60)).toBeLessThan(12);
	});
});
