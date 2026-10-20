// Dialogue is only where it is HEARD (`dialogueSpans`, spec 12 P6-R3; wp-note "WP6.5b solver"): a dialogue section the
// mix plays at or under DIALOGUE_AUDIBLE_DB (−40 dB of gain on the way from the clip to the Mix) is not speech for
// any consumer — the masking solver's dialogue guard, cue suppression, place_sound's hero warning, Sound Check. Clip
// gain, clip Volume keyframes, track mute (static and automated), track Volume automation, solo, submix faders and
// the Mix fader are evaluated with the renderers' own topology (`buildAudioMix`).
import { describe, expect, it } from 'vitest';
import {
	type Clip,
	DIALOGUE_AUDIBLE_DB,
	DIALOGUE_PAD_SEC,
	dialogueSpans,
	type Keyframe,
	type ProjectDocument,
	type Sequence,
} from '../src/index.ts';
import type { Harness } from './helpers.ts';
import { newHarness, patchClip } from './sound-cues-fixtures.ts';

const F = 705_600_000 / 30;
const PAD = Math.round(DIALOGUE_PAD_SEC * 30);

function voiceClip(h: Harness, at: number, seconds = 4, track = 'A1'): string {
	const m = h.registerVideo({ kind: 'audio', seconds });
	const id = h.ok([{ type: 'clip.place', source: { mediaId: m }, at, tracks: { audio: track }, ref: '$c' }])
		.refs.$c!;
	h.ok([{ type: 'essentialSound.setType', clipIds: [id], audioType: 'dialogue' }]);
	return id;
}

const key = (id: string, time: number, value: number): Keyframe<number> => ({
	id,
	time,
	value,
	interpolation: 'hold',
	easeIn: { influence: 1 / 3, slope: 0 },
	easeOut: { influence: 1 / 3, slope: 0 },
});

function patchSeq(h: Harness, f: (seq: Sequence) => void): void {
	const doc = structuredClone(h.doc) as ProjectDocument;
	f(doc.sequences[h.seqId]!);
	h.doc = doc;
}

const ranges = (h: Harness, voice?: Record<string, [number, number][]>) =>
	dialogueSpans(h.doc, h.seq, voice ? { voice } : {}).map((s) => [s.start, s.end]);

describe('dialogue that the mix does not let through is not dialogue', () => {
	it('clip gain: −∞ / under −40 dB removes the clip; −30 dB keeps it', () => {
		expect(DIALOGUE_AUDIBLE_DB).toBe(-40);
		const h = newHarness();
		const a = voiceClip(h, 30);
		expect(ranges(h)).toEqual([[30, 150]]);
		for (const g of [-200, -96, -41]) {
			patchClip(h, a, (c) => {
				c.gainDb = g;
			});
			expect(ranges(h), `${g} dB`).toEqual([]);
		}
		patchClip(h, a, (c) => {
			c.gainDb = -30;
		});
		expect(ranges(h)).toEqual([[30, 150]]);
	});

	it('clip Volume keyframes ducking out the second half of the clip leave only the first half', () => {
		const h = newHarness();
		const a = voiceClip(h, 30);
		// content time 2 s on: −60 dB (hold)
		patchClip(h, a, (c) => {
			(c as unknown as { volumeDb: { value: number; keyframes: Keyframe<number>[] } }).volumeDb = {
				value: 0,
				keyframes: [key('k0', 0, 0), key('k1', 60 * F, -60)],
			};
		});
		expect(ranges(h)).toEqual([[30, 90]]);
		// with voice activity over the whole media: the voiced pieces are cut at the duck too (no pad into it)
		expect(ranges(h, { [a]: [[0.5, 3.5]] })).toEqual([[30 + 15 - PAD, 90]]);
		// a duck to −30 dB still lets the voice through
		patchClip(h, a, (c) => {
			(c as unknown as { volumeDb: { value: number; keyframes: Keyframe<number>[] } }).volumeDb = {
				value: 0,
				keyframes: [key('k0', 0, 0), key('k1', 60 * F, -30)],
			};
		});
		expect(ranges(h)).toEqual([[30, 150]]);
	});

	it('track mute automation and track Volume automation (sequence time) silence their stretch', () => {
		const h = newHarness();
		const a = voiceClip(h, 0);
		const trackId = h.seq.clips[a]!.trackId;
		patchSeq(h, (seq) => {
			const t = seq.audioTracks.find((x) => x.id === trackId)! as Sequence['audioTracks'][number] & {
				mixer?: { lanes?: Record<string, unknown> };
			};
			t.mixer = {
				...(t.mixer ?? {}),
				lanes: { mute: { value: 0, keyframes: [key('m0', 0, 0), key('m1', 60 * F, 1)] } },
			};
		});
		expect(ranges(h)).toEqual([[0, 60]]);
		patchSeq(h, (seq) => {
			const t = seq.audioTracks.find((x) => x.id === trackId)! as Sequence['audioTracks'][number] & {
				mixer?: { lanes?: Record<string, unknown> };
			};
			delete t.mixer!.lanes!.mute;
			t.volumeDb = { value: 0, keyframes: [key('v0', 0, -96), key('v1', 30 * F, 0)] };
		});
		expect(ranges(h)).toEqual([[30, 120]]);
	});

	it('another track soloed, a silent submix or Mix fader: no dialogue', () => {
		const h = newHarness();
		const a = voiceClip(h, 0, 4, 'A1');
		voiceClip(h, 200, 2, 'A2');
		const t1 = h.seq.clips[a]!.trackId;
		expect(ranges(h)).toEqual([
			[0, 120],
			[200, 260],
		]);
		patchSeq(h, (seq) => {
			const other = seq.audioTracks.find((x) => x.id !== t1)! as { solo?: boolean };
			other.solo = true;
		});
		expect(ranges(h)).toEqual([[200, 260]]);
		patchSeq(h, (seq) => {
			for (const t of seq.audioTracks) (t as { solo?: boolean }).solo = false;
			seq.master.volumeDb = { value: -96, keyframes: [] };
		});
		expect(ranges(h)).toEqual([]);
	});

	it('transcript words in a muted stretch are not dialogue', () => {
		const h = newHarness();
		const a = voiceClip(h, 0, 10);
		const mediaId = (h.seq.clips[a] as Clip & { mediaId: string }).mediaId;
		const doc = structuredClone(h.doc);
		doc.transcripts.trs_00000000000000T1 = {
			id: 'trs_00000000000000T1',
			mediaId,
			language: 'en',
			origin: 'manual',
			words: [
				{ text: 'hi', start: 30 * F, end: 45 * F, confidence: 1, speaker: null, breakBefore: 'none' },
				{ text: 'there', start: 200 * F, end: 215 * F, confidence: 1, speaker: null, breakBefore: 'segment' },
			],
			speakers: {},
		};
		h.doc = doc;
		expect(ranges(h)).toEqual([
			[30 - PAD, 45 + PAD],
			[200 - PAD, 215 + PAD],
		]);
		patchClip(h, a, (c) => {
			(c as unknown as { volumeDb: { value: number; keyframes: Keyframe<number>[] } }).volumeDb = {
				value: 0,
				keyframes: [key('k0', 0, 0), key('k1', 150 * F, -100)],
			};
		});
		expect(ranges(h)).toEqual([[30 - PAD, 45 + PAD]]);
	});
});
