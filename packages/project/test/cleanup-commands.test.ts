// `cleanup.apply`, `cleanup.configure` and the spec 14 TC-032 extensions of `transcript.removePauses` /
// `transcript.removeFillers`: results, linked partners, clip groups, sync lock, locked tracks, edge fades, J / L cuts,
// lift / mute / markers, undo (the previous document is untouched) / redo (re-applying is deterministic), refusals and
// invariants (every transaction runs the invariant checker in `verify` mode under tests).
import { describe, expect, it } from 'vitest';
import { analyzeSequenceCleanup } from '../src/cleanup/sequence.ts';
import {
	checkInvariants,
	encodeVoiceAnalysis,
	type ProjectDocument,
	readSequenceCleanup,
	sequenceCleanupSettings,
} from '../src/index.ts';
import { FLICKS_PER_SECOND } from '../src/time.ts';
import { resolveAudioTransitions } from '../src/transitions.ts';
import { GOLDEN_EVENTS, goldenSequence } from './cleanup-golden-fixture.ts';
import { synthRecording } from './cleanup-synth.ts';
import { Harness, videoAsset } from './helpers.ts';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const s = (x: number) => Math.round(x * FLICKS_PER_SECOND);

/** 30 fps: a 20 s talking-head clip on V1 + A1 (linked) with a Spanish transcript, music on A2, B-roll on V2. */
function talk() {
	const H = new Harness({ preset: 'hd-1080p-30' });
	const mediaId = H.registerVideo({ seconds: 20 });
	const music = (
		H.ok([{ type: 'media.register', asset: videoAsset({ seconds: 20, kind: 'audio' }) }]).results[0] as {
			mediaId: string;
		}
	).mediaId;
	const broll = H.registerVideo({ seconds: 20, audio: false });
	H.ok([
		{
			type: 'clip.place',
			source: { mediaId },
			at: 0,
			tracks: { video: 'V1', audio: ['A1'] },
			mode: 'overwrite',
		},
		{ type: 'clip.place', source: { mediaId: music }, at: 0, tracks: { audio: ['A2'] }, mode: 'overwrite' },
		{ type: 'clip.place', source: { mediaId: broll }, at: 0, tracks: { video: 'V2' }, mode: 'overwrite' },
	]);
	const words = ['Hola', 'eh', 'a', 'todos', 'hoy', 'vamos', 'a', 'programar', 'un', 'juego'].map(
		(text, i) => ({
			text,
			start: s(1 + i),
			end: s(1.5 + i),
			confidence: 0.9,
		}),
	);
	H.ok([{ type: 'transcript.create', mediaId, language: 'es', origin: 'manual', words }]);
	const a1 = H.clips('A1')[0]!.id;
	const v1 = H.clips('V1')[0]!.id;
	return { H, mediaId, a1, v1 };
}

const total = (H: Harness, track: string) => H.spans(track).reduce((n, [a, b]) => n + b - a, 0);

describe('cleanup.apply', () => {
	it('extracts many ranges in one undo step on the speech clip, its link and sync-locked tracks', () => {
		const { H, a1, v1 } = talk();
		const before = H.doc;
		const snap = clone(before);
		const rev = H.revision;
		const r = H.ok([
			{
				type: 'cleanup.apply',
				clipIds: [a1],
				ranges: [
					{ start: 30, end: 45 },
					{ start: 90, end: 120 },
					{ start: 100, end: 130 },
				],
			},
		]);
		expect(H.revision).toBe(rev + 1);
		const res = r.results[0] as { merged: number; frames: number; joins: number; ranges: unknown[] };
		expect(res.merged).toBe(2);
		expect(res.frames).toBe(15 + 40);
		expect(res.joins).toBe(2);
		expect(res.ranges).toHaveLength(3);
		expect(H.spans('A1')).toEqual([
			[0, 30],
			[30, 75],
			[75, 545],
		]);
		expect(H.spans('V1')).toEqual(H.spans('A1'));
		// sync-locked tracks get the same edit
		expect(total(H, 'A2')).toBe(600 - 55);
		expect(total(H, 'V2')).toBe(600 - 55);
		// pieces at the same time stay linked
		const a = H.clips('A1');
		const v = H.clips('V1');
		for (let i = 0; i < a.length; i++) {
			expect(a[i]!.linkId).toBeTruthy();
			expect(a[i]!.linkId).toBe(v[i]!.linkId);
		}
		expect(new Set(a.map((c) => c.linkId)).size).toBe(3);
		expect(a.map((c) => c.sourceIn / (FLICKS_PER_SECOND / 30))).toEqual([0, 45, 130]);
		expect(checkInvariants(H.doc)).toEqual([]);
		// undo: the previous document is untouched; redo: the same edit again gives the same document
		expect(before).toEqual(snap);
		expect(H.clips('V1').map((c) => c.id)).toContain(v1);
	});

	it('re-applying the same edit gives the same timeline (redo)', () => {
		const run = () => {
			const { H, a1 } = talk();
			H.ok([
				{
					type: 'cleanup.apply',
					clipIds: [a1],
					ranges: [
						{ start: 30, end: 45 },
						{ start: 200, end: 260 },
					],
				},
			]);
			return ['V1', 'V2', 'A1', 'A2'].map((t) =>
				H.clips(t).map((c) => [c.id, c.start, c.duration, c.sourceIn, c.linkId]),
			);
		};
		expect(run()).toEqual(run());
	});

	it('leaves non-sync-locked and locked tracks alone; refuses a locked speech track', () => {
		const { H, a1 } = talk();
		H.ok([
			{ type: 'track.update', trackId: 'A2', patch: { syncLock: false } },
			{ type: 'track.update', trackId: 'V2', patch: { locked: true } },
		]);
		H.ok([{ type: 'cleanup.apply', clipIds: [a1], ranges: [{ start: 60, end: 90 }] }]);
		expect(H.spans('A2')).toEqual([[0, 600]]);
		expect(H.spans('V2')).toEqual([[0, 600]]);
		expect(total(H, 'A1')).toBe(570);
		const { H: L, a1: la } = talk();
		L.ok([{ type: 'track.update', trackId: 'V1', patch: { locked: true } }]);
		const bad = L.tx([{ type: 'cleanup.apply', clipIds: [la], ranges: [{ start: 60, end: 90 }] }]);
		expect(bad.ok).toBe(false);
		if (!bad.ok) {
			expect(bad.errors[0]!.code).toBe('E_TRACK_LOCKED');
			expect(bad.errors[0]!.blocking).toEqual([L.clips('V1')[0]!.id]);
		}
	});

	it('cuts clip-group members on other tracks', () => {
		const { H, a1 } = talk();
		H.ok([{ type: 'track.update', trackId: 'A2', patch: { syncLock: false } }]);
		const music = H.clips('A2')[0]!.id;
		H.ok([{ type: 'clip.group', clipIds: [a1, music] }]);
		H.ok([{ type: 'cleanup.apply', clipIds: [a1], ranges: [{ start: 60, end: 90 }] }]);
		expect(total(H, 'A2')).toBe(570);
	});

	it('maps source ranges (media flicks) through the clip; refuses reversed clips and empty ranges', () => {
		const { H, a1 } = talk();
		const F = FLICKS_PER_SECOND / 30;
		const r = H.ok([{ type: 'cleanup.apply', ranges: [{ clipId: a1, start: 60 * F, end: 90 * F }] }]);
		expect((r.results[0] as { frames: number }).frames).toBe(30);
		expect(total(H, 'A1')).toBe(570);
		const { H: R, a1: ra } = talk();
		R.ok([{ type: 'clip.setSpeed', clipIds: [ra], reverse: true, ripple: false }]);
		const bad = R.tx([{ type: 'cleanup.apply', ranges: [{ clipId: ra, start: 0, end: 30 * F }] }]);
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.errors[0]!.code).toBe('E_UNSUPPORTED');
		const empty = R.tx([{ type: 'cleanup.apply', clipIds: [ra], ranges: [{ start: 40, end: 40 }] }]);
		expect(empty.ok).toBe(false);
		const unknown = R.tx([{ type: 'cleanup.apply', clipIds: ['clp_nope'], ranges: [{ start: 1, end: 4 }] }]);
		expect(unknown.ok).toBe(false);
		if (!unknown.ok) expect(unknown.errors[0]!.code).toBe('E_NOT_FOUND');
	});

	it('refuses without any speech clip', () => {
		const H = new Harness({ preset: 'hd-1080p-30' });
		const m = H.registerVideo({ seconds: 5 });
		H.ok([
			{
				type: 'clip.place',
				source: { mediaId: m },
				at: 0,
				tracks: { video: 'V1', audio: ['A1'] },
				mode: 'overwrite',
			},
		]);
		const r = H.tx([{ type: 'cleanup.apply', ranges: [{ start: 10, end: 20 }] }]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.errors[0]!.code).toBe('E_INVALID_PARAM');
	});

	it('gives every audio cut edge an equal-power micro-fade that renders as a sub-frame fade', () => {
		const { H, a1 } = talk();
		H.ok([{ type: 'cleanup.apply', clipIds: [a1], ranges: [{ start: 60, end: 90 }], fadeMs: 4 }]);
		const [left, right] = H.clips('A1');
		expect((left as { edgeFades?: unknown }).edgeFades).toEqual({ outMs: 4 });
		expect((right as { edgeFades?: unknown }).edgeFades).toEqual({ inMs: 4 });
		// music on the sync-locked track is cut too and declicked
		const [m0, m1] = H.clips('A2');
		expect((m0 as { edgeFades?: unknown }).edgeFades).toEqual({ outMs: 4 });
		expect((m1 as { edgeFades?: unknown }).edgeFades).toEqual({ inMs: 4 });
		expect((H.clips('V1')[0] as { edgeFades?: unknown }).edgeFades).toBeUndefined();
		const fades = resolveAudioTransitions(H.doc, H.seq);
		const lf = fades.clips.get(left!.id)!.fades;
		expect(lf).toEqual([{ type: 'out', start: 60 - 0.12, frames: 0.12, curve: 'equal-power', edge: true }]);
		expect(fades.clips.get(right!.id)!.fades).toEqual([
			{ type: 'in', start: 60, frames: 0.12, curve: 'equal-power', edge: true },
		]);
		expect(checkInvariants(H.doc)).toEqual([]);
		// a razor cut keeps each fade on its edge; joining the through edit brings them back together
		H.ok([{ type: 'clip.split', clipIds: [right!.id], at: 200 }]);
		const parts = H.clips('A1');
		expect(parts.map((c) => (c as { edgeFades?: unknown }).edgeFades)).toEqual([
			{ outMs: 4 },
			{ inMs: 4 },
			undefined,
		]);
	});

	it('J and L cuts move the sound edit by jlFrames where the media has handles', () => {
		const { H, a1 } = talk();
		H.ok([{ type: 'cleanup.apply', clipIds: [a1], ranges: [{ start: 60, end: 90 }], jlFrames: 3 }]);
		expect(H.spans('V1')).toEqual([
			[0, 60],
			[60, 570],
		]);
		expect(H.spans('A1')).toEqual([
			[0, 57],
			[57, 570],
		]);
		expect(H.clips('A1')[1]!.sourceIn).toBe(87 * (FLICKS_PER_SECOND / 30));
		const { H: L, a1: la } = talk();
		L.ok([{ type: 'cleanup.apply', clipIds: [la], ranges: [{ start: 60, end: 90 }], jlFrames: -2 }]);
		expect(L.spans('A1')).toEqual([
			[0, 62],
			[62, 570],
		]);
		expect(checkInvariants(L.doc)).toEqual([]);
	});

	it('lift leaves gaps; markers mode only marks; mute writes Volume keys', () => {
		const { H, a1 } = talk();
		H.ok([{ type: 'cleanup.apply', clipIds: [a1], ranges: [{ start: 60, end: 90 }], mode: 'lift' }]);
		expect(H.spans('A1')).toEqual([
			[0, 60],
			[90, 600],
		]);
		expect(H.spans('A2')).toEqual([[0, 600]]);
		const { H: M, a1: ma } = talk();
		M.ok([
			{
				type: 'cleanup.apply',
				clipIds: [ma],
				ranges: [
					{ start: 60, end: 90 },
					{ start: 300, end: 330 },
				],
				mode: 'markers',
			},
		]);
		expect(M.spans('A1')).toEqual([[0, 600]]);
		expect(M.seq.markers.map((m) => [m.frame, m.duration, m.name])).toEqual([
			[60, 30, 'Clean Up'],
			[300, 30, 'Clean Up'],
		]);
		const { H: U, a1: ua } = talk();
		U.ok([
			{ type: 'cleanup.apply', clipIds: [ua], ranges: [{ start: 60, end: 90 }], mode: 'mute', fadeMs: 10 },
		]);
		expect(U.spans('A1')).toEqual([[0, 600]]);
		const keys = (
			U.clips('A1')[0] as unknown as { volumeDb: { keyframes: Array<{ time: number; value: number }> } }
		).volumeDb.keyframes;
		const F = FLICKS_PER_SECOND / 30;
		expect(keys.map((k) => [k.time, k.value])).toEqual([
			[60 * F - s(0.01), 0],
			[60 * F, -96],
			[90 * F, -96],
			[90 * F + s(0.01), 0],
		]);
		// the video and the music are untouched
		expect(
			(U.clips('A2')[0] as unknown as { volumeDb: { keyframes: unknown[] } }).volumeDb.keyframes,
		).toEqual([]);
		expect(checkInvariants(U.doc)).toEqual([]);
	});

	it('applies 1 500 ranges as one edit (no command limit) and keeps the timeline consistent', () => {
		const { H, a1 } = talk();
		// 20 s = 600 frames is too short: stretch the speech clip with a long media first
		const big = H.registerVideo({ seconds: 3600 });
		H.ok([
			{
				type: 'clip.place',
				source: { mediaId: big },
				at: 600,
				tracks: { video: 'V1', audio: ['A1'] },
				mode: 'overwrite',
			},
		]);
		const clip = H.clips('A1')[1]!.id;
		const ranges = Array.from({ length: 1500 }, (_, i) => ({
			start: 600 + i * 60 + 20,
			end: 600 + i * 60 + 35,
		}));
		const r = H.ok([{ type: 'cleanup.apply', clipIds: [clip, a1], ranges, fadeMs: 4 }]);
		expect((r.results[0] as { frames: number }).frames).toBe(1500 * 15);
		expect(H.clips('A1')).toHaveLength(1 + 1501);
		expect(checkInvariants(H.doc)).toEqual([]);
	});
});

describe('cleanup.configure', () => {
	it('stores settings, script, lists and rejected fingerprints; merges and resets', () => {
		const { H } = talk();
		const before = clone(H.doc);
		H.ok([
			{
				type: 'cleanup.configure',
				settings: { presetId: 'builtin.natural', overrides: { gaps: { maxGapS: 0.3 } } },
				script: { name: 'Guion', text: 'Hola a todos.' },
				lists: { es: { fillers: ['eh', 'mmm'] } },
				reject: ['med_x~1~pause~10~12~00000000'],
			},
		]);
		let c = readSequenceCleanup(H.seq as { cleanup?: unknown });
		expect(c.settings).toEqual({ presetId: 'builtin.natural', overrides: { gaps: { maxGapS: 0.3 } } });
		expect(sequenceCleanupSettings(H.seq).gaps.maxGapS).toBe(0.3);
		expect(sequenceCleanupSettings(H.seq).edges.mode).toBe('speech');
		H.ok([
			{ type: 'cleanup.configure', settings: { overrides: { joins: { fadeMs: 6 } } }, mergeOverrides: true },
		]);
		c = readSequenceCleanup(H.seq as { cleanup?: unknown });
		expect(c.settings).toEqual({
			presetId: 'builtin.natural',
			overrides: { gaps: { maxGapS: 0.3 }, joins: { fadeMs: 6 } },
		});
		H.ok([
			{
				type: 'cleanup.configure',
				unreject: ['med_x~1~pause~10~12~00000000'],
				reject: ['a~0~retake~1~2~00000001'],
				lists: { es: null },
			},
		]);
		c = readSequenceCleanup(H.seq as { cleanup?: unknown });
		expect(c.rejected).toEqual(['a~0~retake~1~2~00000001']);
		expect(c.lists).toBeUndefined();
		H.ok([{ type: 'cleanup.configure', settings: null, script: null, clearRejected: true }]);
		expect((H.seq as { cleanup?: unknown }).cleanup).toBeUndefined();
		expect(checkInvariants(H.doc)).toEqual([]);
		expect(before.sequences[H.seqId]!).not.toHaveProperty('cleanup');
	});

	it('refuses bad input: a script over 256 KB, a malformed fingerprint, unknown override keys', () => {
		const { H } = talk();
		const big = H.tx([{ type: 'cleanup.configure', script: { name: 'x', text: 'ñ'.repeat(140_000) } }]);
		expect(big.ok).toBe(false);
		const fp = H.tx([{ type: 'cleanup.configure', reject: ['has space'] }]);
		expect(fp.ok).toBe(false);
		const ov = H.tx([{ type: 'cleanup.configure', settings: { overrides: { gaps: { maxGap: 1 } } } }]);
		expect(ov.ok).toBe(false);
	});
});

describe('transcript.removePauses / removeFillers (spec 14 TC-032)', () => {
	it('keeps the old defaults (transcript mode, 1 s, 0.1 s air), adds asymmetric pads and fades', () => {
		const { H } = talk();
		H.ok([{ type: 'transcript.removePauses', minSeconds: 0.4 }]);
		// gaps of 0.5 s between words: each keeps 0.1 s next to both words → 0.3 s (9 frames) cut, 9 pauses
		expect(total(H, 'A1')).toBe(600 - 9 * 9);
		const { H: A } = talk();
		A.ok([{ type: 'transcript.removePauses', minSeconds: 0.4, padAfter: 0, padBefore: 0.2, fadeMs: 4 }]);
		// 0.3 s kept before each word, none after → 0.3 s cut (9 frames)
		expect(total(A, 'A1')).toBe(600 - 9 * 9);
		expect((A.clips('A1')[1] as { edgeFades?: unknown }).edgeFades).toEqual({ inMs: 4, outMs: 4 });
		expect(checkInvariants(A.doc)).toEqual([]);
	});

	it('removes Spanish fillers by default from a Spanish transcript', () => {
		const { H } = talk();
		const r = H.ok([{ type: 'transcript.removeFillers' }]);
		expect((r.results[0] as { fillers: number }).fillers).toBe(1); // "eh"
		expect(total(H, 'A1')).toBe(600 - 15);
		const { H: E } = talk();
		const r2 = E.ok([{ type: 'transcript.removeFillers', language: 'en' }]);
		expect((r2.results[0] as { fillers: number }).fillers).toBe(0);
	});

	it('level mode cuts pauses from the voice analysis with level-referenced edges', () => {
		const rec = synthRecording(GOLDEN_EVENTS, 7);
		const { H, mediaId } = goldenSequence(rec);
		const analysis = Buffer.from(encodeVoiceAnalysis(rec.voice)).toString('base64');
		const before = total(H, 'A1');
		const r = H.ok([
			{ type: 'transcript.removePauses', mode: 'level', minSeconds: 0.12, voice: [{ mediaId, analysis }] },
		]);
		const out = before - total(H, 'A1');
		expect((r.results[0] as { pauses: number }).pauses).toBeGreaterThan(10);
		expect(out).toBeGreaterThan(30 * 8);
		expect(checkInvariants(H.doc)).toEqual([]);
		const missing = goldenSequence(rec).H.tx([{ type: 'transcript.removePauses', mode: 'level' }]);
		expect(missing.ok).toBe(false);
	});
});

describe('analysis → apply', () => {
	it('applying the dry-run plan gives the planned output duration in one step', () => {
		const rec = synthRecording(GOLDEN_EVENTS, 7);
		const { H } = goldenSequence(rec);
		const a = analyzeSequenceCleanup({ doc: H.doc as ProjectDocument, seq: H.seq, voice: () => rec.voice });
		if (!a.ok) throw new Error(a.message);
		const rev = H.revision;
		H.ok(
			[
				{
					type: 'cleanup.apply',
					clipIds: a.plan.clipIds,
					ranges: a.plan.ranges.map((x) => ({ start: x.start, end: x.end })),
					fadeMs: a.plan.fadeMs,
				},
			],
			{ label: `Clean Up Voice: ${a.plan.stats.joins} cuts` },
		);
		expect(H.revision).toBe(rev + 1);
		expect(total(H, 'A1') / 30).toBeCloseTo(a.plan.stats.outputDuration, 5);
	});
});
