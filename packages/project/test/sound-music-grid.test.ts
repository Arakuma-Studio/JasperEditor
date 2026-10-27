// The stop-before on the music's bar line as ONE rule (spec 12 §4 P6-E11; final carry-over cleanup, item 5): the plan
// job had it, the cue menu's Stop Before Next and MCP set_sound_cues {stopBefore} kept the plain 0.25 s. The grid of
// a music clip (its analysed beats where they play), the bar line a stop ends on, the style switch, and the beat
// request every path shares (so a cached analysis is found again).
import { describe, expect, it } from 'vitest';
import {
	cachedMusicGrid,
	FLICKS_PER_SECOND,
	musicBeatRequest,
	musicClips,
	musicGridOf,
	type Sequence,
	STOP_BEFORE_DEFAULT,
	sequenceStopsOnBar,
	stopBeforeFor,
} from '../src/index.ts';
import { Harness, videoAsset } from './helpers.ts';

const S = FLICKS_PER_SECOND;
/** 120 BPM from 0.6 s, a downbeat every 4 beats (0.6, 2.6, 4.6 …), media seconds. */
const BEATS = Array.from({ length: 40 }, (_, k) => 0.6 + k * 0.5);
const DOWN = BEATS.filter((_, k) => k % 4 === 0);

/** A 20 s music clip on A1 at frame `at` (30 fps), In point `inSec`, Essential Sound music. */
function withMusic(at = 0, inSec = 0) {
	const h = new Harness();
	const r = h.ok([
		{ type: 'media.register', asset: videoAsset({ kind: 'audio', seconds: 20 }), ref: '$m' },
		{
			type: 'clip.place',
			source: { mediaId: '$m' },
			at,
			sourceRange: { in: { seconds: inSec }, out: { seconds: inSec + 10 } },
			tracks: { audio: 'A1' },
			ref: '$c',
		},
	]);
	h.ok([{ type: 'essentialSound.setType', clipIds: [r.refs.$c!], audioType: 'music' }]);
	return { h, clipId: r.refs.$c!, mediaId: r.refs.$m! };
}
const grid = (h: Harness, clipId: string) =>
	musicGridOf(h.doc, h.seq as Sequence, new Map([[clipId, { beats: BEATS, downbeats: DOWN }]]));

describe('the music grid and the stop on the bar line', () => {
	it('the beat request is the plan’s: the clip’s media range ±1 s on a half-second grid', () => {
		const { h } = withMusic(0, 3.2);
		const [c] = musicClips(h.doc, h.seq as Sequence);
		// media 3.2 s … its last frame at 13.2 s − 1/30 → 2 … 14.5 s (±1 s, outward to half seconds)
		expect(c!.mediaStartSec).toBeCloseTo(3.2, 6);
		expect(c!.mediaEndSec).toBeCloseTo(13.2 - 1 / 30, 6);
		expect(musicBeatRequest('mk_1', c!)).toEqual({
			mediaKey: 'mk_1',
			startSeconds: 2,
			durationSeconds: 12.5,
		});
		expect(musicBeatRequest('mk_1', c!, 3).timeSignature).toBe(3);
		expect(musicBeatRequest('mk_1', c!, 'auto')).not.toHaveProperty('timeSignature');
	});

	it('the grid is where the attacks play: moved by the clip’s start and In point, only inside the clip', () => {
		const { h, clipId } = withMusic(60, 1);
		const g = grid(h, clipId)[0]!;
		expect(g).toMatchObject({ clipId, start: 60, end: 360 });
		// the clip starts at 2 s with its In point at media 1 s: media 2.6 s (the first downbeat in it) plays at 3.6 s
		expect(g.downbeats[0]! / S).toBeCloseTo(3.6, 9);
		// only media 1 … 11 s plays (sequence 2 … 12 s)
		expect(Math.min(...g.beats) / S).toBeGreaterThanOrEqual(2);
		expect(Math.max(...g.beats) / S).toBeLessThan(12);
	});

	it('stopBeforeFor: the default stop on the bar line with the style on, plain with it off or without beats', () => {
		const { h, clipId } = withMusic();
		const g = grid(h, clipId);
		expect(sequenceStopsOnBar(h.seq as Sequence)).toBe(true);
		const on = stopBeforeFor(h.seq as Sequence, 90, g);
		expect(on.on).toBe('downbeat');
		expect(on.stopBefore.seconds).toBeCloseTo(0.4, 9);
		expect(on.stopBefore.depthDb).toBe(STOP_BEFORE_DEFAULT.depthDb);
		expect(stopBeforeFor(h.seq as Sequence, 90, [])).toEqual({
			stopBefore: { ...STOP_BEFORE_DEFAULT },
			on: null,
		});
		// explicit seconds are the window (as the plan treats a cue's own stop): 0.3 s holds no downbeat here
		expect(
			stopBeforeFor(h.seq as Sequence, 90, g, { seconds: 0.3, depthDb: -18 }, { explicit: true }),
		).toEqual({
			stopBefore: { seconds: 0.3, depthDb: -18 },
			on: null,
		});
		h.ok([{ type: 'soundDesign.setSettings', style: { stopOnBar: false } }]);
		expect(sequenceStopsOnBar(h.seq as Sequence)).toBe(false);
		expect(stopBeforeFor(h.seq as Sequence, 90, g).on).toBeNull();
	});

	it('cachedMusicGrid asks for every music clip with the shared request and skips what is not analysed', async () => {
		const { h, clipId } = withMusic();
		const asked: unknown[] = [];
		const g = await cachedMusicGrid(h.doc, h.seq as Sequence, async (req) => {
			asked.push(req);
			return { beats: BEATS, downbeats: DOWN };
		});
		expect(asked).toHaveLength(1);
		expect(asked[0]).toMatchObject({ mediaKey: expect.stringMatching(/^mk_/), startSeconds: 0 });
		expect(g.map((x) => x.clipId)).toEqual([clipId]);
		expect(await cachedMusicGrid(h.doc, h.seq as Sequence, async () => null)).toEqual([]);
		expect(
			await cachedMusicGrid(h.doc, h.seq as Sequence, async () => {
				throw new Error('offline');
			}),
		).toEqual([]);
	});
});
