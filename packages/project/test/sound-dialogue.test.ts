// Where dialogue is heard (`dialogueSpans`, spec 12 P6-R3; wp-note "Phase 6 → WP6.3"): transcript words first, else
// the engine's voice activity of Essential Sound dialogue clips (mapped through speed and reverse), else the whole
// clip; muted tracks and disabled clips are silent; `dialogueVadClips` names what to measure; `deriveCues` suppresses
// cuts and demotes derived heroes inside exactly these ranges (and only there when voice activity says so); hostile
// voice activity never throws.
import { describe, expect, it } from 'vitest';
import {
	type Clip,
	DIALOGUE_BRIDGE_SEC,
	DIALOGUE_PAD_SEC,
	deriveCues,
	dialogueFrameRanges,
	dialogueSpans,
	dialogueVadClips,
	type ExtraCue,
	sequenceDialogueRanges,
} from '../src/index.ts';
import type { Harness } from './helpers.ts';
import { newHarness, patchClip } from './sound-cues-fixtures.ts';

const F = 705_600_000 / 30;
const PAD = Math.round(DIALOGUE_PAD_SEC * 30);

function voiceClip(h: Harness, at: number, seconds = 10, track = 'A1'): string {
	const m = h.registerVideo({ kind: 'audio', seconds });
	const id = h.ok([{ type: 'clip.place', source: { mediaId: m }, at, tracks: { audio: track }, ref: '$c' }])
		.refs.$c!;
	h.ok([{ type: 'essentialSound.setType', clipIds: [id], audioType: 'dialogue' }]);
	return id;
}

describe('dialogueSpans', () => {
	it('a dialogue clip without measurement is dialogue over its whole span', () => {
		const h = newHarness();
		const a = voiceClip(h, 30, 4);
		expect(dialogueSpans(h.doc, h.seq)).toEqual([
			{ start: 30, end: 150, clipIds: [a], trackIds: [h.seq.clips[a]!.trackId], sources: ['clip'] },
		]);
		expect(dialogueVadClips(h.doc, h.seq)).toEqual([
			{
				clipId: a,
				mediaId: (h.seq.clips[a] as Clip & { mediaId: string }).mediaId,
				trackId: h.seq.clips[a]!.trackId,
				streamIndex: expect.any(Number),
				mediaStartSec: 0,
				mediaEndSec: 4,
			},
		]);
	});

	it('voice activity narrows it to the voiced media (padded, short pauses bridged); empty = no dialogue', () => {
		const h = newHarness();
		const a = voiceClip(h, 30, 10);
		// voiced 1–2 s and 2.5–3 s (a 0.5 s pause, bridged) and 7–8 s of the media
		const voice = {
			[a]: [
				[1, 2],
				[2.5, 3],
				[7, 8],
			] as [number, number][],
		};
		const spans = dialogueSpans(h.doc, h.seq, { voice });
		expect(spans.map((s) => [s.start, s.end])).toEqual([
			[30 + 30 - PAD, 30 + 90 + PAD],
			[30 + 210 - PAD, 30 + 240 + PAD],
		]);
		expect(spans.every((s) => s.sources.join() === 'vad')).toBe(true);
		expect(DIALOGUE_BRIDGE_SEC).toBe(0.75);
		expect(dialogueSpans(h.doc, h.seq, { voice: { [a]: [] } })).toEqual([]);
		expect(sequenceDialogueRanges(h.doc, h.seq, { voice })).toEqual(spans.map((s) => [s.start, s.end]));
	});

	it('maps voice activity through 200 % speed and reverse', () => {
		const h = newHarness();
		const a = voiceClip(h, 0, 10);
		h.ok([{ type: 'clip.setSpeed', clipIds: [a], rate: 2, ripple: false }]);
		const fast = dialogueFrameRanges(h.doc, h.seq, { voice: { [a]: [[4, 6]] } });
		// media 4–6 s plays at sequence 2–3 s (frames 60–90)
		expect(fast).toEqual([[60 - PAD, 90 + PAD]]);
		h.ok([{ type: 'clip.setSpeed', clipIds: [a], rate: 1, reverse: true, ripple: false }]);
		const rev = dialogueFrameRanges(h.doc, h.seq, { voice: { [a]: [[1, 2]] } });
		// media 1–2 s of a reversed 10 s clip plays at sequence 8–9 s
		expect(rev.length).toBe(1);
		expect(Math.abs(rev[0]![0] - (240 - PAD))).toBeLessThanOrEqual(1);
		expect(Math.abs(rev[0]![1] - (270 + PAD))).toBeLessThanOrEqual(1);
	});

	it('transcript words come first; muted tracks and disabled clips are silent', () => {
		const h = newHarness();
		const a = voiceClip(h, 0, 10);
		const mediaId = (h.seq.clips[a] as Clip & { mediaId: string }).mediaId;
		const doc = structuredClone(h.doc);
		doc.transcripts.trs_00000000000000T1 = {
			id: 'trs_00000000000000T1',
			mediaId,
			language: 'en',
			origin: 'manual',
			words: [{ text: 'hi', start: 60 * F, end: 75 * F, confidence: 1, speaker: null, breakBefore: 'none' }],
			speakers: {},
		};
		h.doc = doc;
		const spans = dialogueSpans(h.doc, h.seq, { voice: { [a]: [[0, 10]] } });
		expect(spans).toEqual([
			{
				start: 60 - PAD,
				end: 75 + PAD,
				clipIds: [a],
				trackIds: [h.seq.clips[a]!.trackId],
				sources: ['words'],
			},
		]);
		expect(dialogueVadClips(h.doc, h.seq)).toEqual([]);
		const b = voiceClip(h, 400, 2, 'A2');
		expect(dialogueSpans(h.doc, h.seq).map((s) => s.clipIds)).toEqual([[a], [b]]);
		patchClip(h, b, (c) => {
			c.enabled = false;
		});
		expect(dialogueSpans(h.doc, h.seq).map((s) => s.clipIds)).toEqual([[a]]);
		patchClip(h, b, (c) => {
			c.enabled = true;
		});
		h.ok([{ type: 'track.update', trackId: h.seq.clips[b]!.trackId, patch: { mute: true } }]);
		expect(dialogueSpans(h.doc, h.seq).map((s) => s.clipIds)).toEqual([[a]]);
	});

	it('hostile voice activity and documents never throw', () => {
		const h = newHarness();
		const a = voiceClip(h, 0, 4);
		for (const voice of [
			{ [a]: 'x' },
			{ [a]: [[Number.NaN, 1], [3, 1], 'bad', [0, Number.POSITIVE_INFINITY]] },
			{ [a]: null },
			null,
			[] as never,
			{ __proto__: { [a]: [[0, 1]] } },
		])
			expect(() => dialogueSpans(h.doc, h.seq, { voice: voice as never })).not.toThrow();
		expect(
			dialogueSpans(h.doc, h.seq, {
				voice: {
					[a]: [
						[Number.NaN, 1],
						[3, 1],
					],
				},
			}),
		).toEqual([]);
		expect(dialogueSpans(null as never, null as never)).toEqual([]);
		expect(dialogueVadClips({} as never, { clips: { x: { id: 'x' } } } as never)).toEqual([]);
		patchClip(h, a, (c) => {
			c.start = 2 ** 53 + 2;
		});
		expect(dialogueSpans(h.doc, h.seq)).toEqual([]);
	});
});

describe('deriveCues uses the same ranges', () => {
	function edit() {
		const h = newHarness();
		const m1 = h.registerVideo({ seconds: 20, audio: false });
		const m2 = h.registerVideo({ seconds: 20, audio: false });
		h.ok([{ type: 'clip.place', source: { mediaId: m1 }, at: 0, tracks: { video: 'V1' } }]);
		h.ok([{ type: 'clip.trim', clipId: h.clips('V1')[0]!.id, edge: 'out', deltaFrames: 90 - 600 }]);
		h.ok([{ type: 'clip.place', source: { mediaId: m2 }, at: 90, tracks: { video: 'V1' } }]);
		const vo = voiceClip(h, 0, 10, 'A1');
		return { h, vo };
	}

	it('a cut is silent in a dialogue clip without measurement, and sounds where voice activity says nobody talks', () => {
		const { h, vo } = edit();
		const cuts = (o = {}) =>
			deriveCues(h.doc, h.seqId, o)
				.cues.filter((c) => c.kind === 'cut')
				.map((c) => c.frame);
		expect(cuts()).toEqual([]);
		// voiced only 5–9 s: the cut at 3 s is not under dialogue
		expect(cuts({ voiceActivity: { [vo]: [[5, 9]] } })).toEqual([90]);
		// voiced around 3 s: silent again
		const r = deriveCues(h.doc, h.seqId, { voiceActivity: { [vo]: [[2.5, 3.5]] } });
		expect(r.cues.filter((c) => c.kind === 'cut')).toEqual([]);
		expect(r.stats.bySource.edits.suppressedByDialogue).toBe(1);
	});

	it('no derived hero under dialogue (support, counted); explicit sfx: markers stay heroes; off with respectDialogue false', () => {
		const { h, vo } = edit();
		const hero: ExtraCue = {
			frame: 200,
			kind: 'move',
			weight: 'hero',
			types: ['whoosh'],
			align: 'peak',
			anchor: { type: 'frame', frame: 200 } as never,
			confidence: 0.9,
			reason: 'Picture motion',
			from: 'pixel',
		};
		const r = deriveCues(h.doc, h.seqId, { extraCues: [hero], voiceActivity: { [vo]: [[6, 7.5]] } });
		const c = r.cues.find((x) => x.frame === 200)!;
		expect(c.weight).toBe('support');
		expect(c.reason).toContain('under dialogue');
		expect(r.stats.heroesUnderDialogue).toBe(1);
		// silence there (voiced elsewhere): the hero stays
		const quiet = deriveCues(h.doc, h.seqId, { extraCues: [hero], voiceActivity: { [vo]: [[0, 1]] } });
		expect(quiet.cues.find((x) => x.frame === 200)!.weight).toBe('hero');
		expect(
			deriveCues(h.doc, h.seqId, { extraCues: [hero], respectDialogue: false }).cues.find(
				(x) => x.frame === 200,
			)!.weight,
		).toBe('hero');
		// an sfx: marker is the user's request
		h.ok([{ type: 'marker.add', frame: 210, name: 'sfx: boom' }]);
		const m = deriveCues(h.doc, h.seqId, { voiceActivity: { [vo]: [[6, 7.5]] } }).cues.find(
			(x) => x.source === 'marker',
		);
		expect(m?.weight).toBe('hero');
	});
});
