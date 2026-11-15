// A sound clip covers its whole media, rounded UP to the frame: a 1.128 s file is 67.68 frames at 60 fps, and its
// clip may be 68 frames long (the last partial frame plays the file's last 8 ms, then silence). Pictures keep whole
// frames inside their media.
import { describe, expect, it } from 'vitest';
import { FLICKS_PER_SECOND, loadProject } from '../src/index.ts';
import { Harness, videoAsset } from './helpers.ts';

function setup() {
	const h = new Harness({ preset: 'hd-1080p-60' });
	const asset = videoAsset({ kind: 'audio', seconds: 1.128 });
	const mediaId = (h.ok([{ type: 'media.register', asset }]).results[0] as { mediaId: string }).mediaId;
	return { h, mediaId };
}

describe('a sound clip covers its media rounded up to the frame', () => {
	it('places a 1.128 s sound on a 60 fps sequence as 68 frames', () => {
		const { h, mediaId } = setup();
		// the repro: the whole file asked for by its length in seconds
		h.ok([
			{
				type: 'clip.place',
				source: { mediaId },
				sourceRange: { in: { seconds: 0 }, out: { seconds: 1.128 } },
				at: 0,
				tracks: { audio: 'A1' },
			},
			// the default range (the whole media)
			{ type: 'clip.place', source: { mediaId }, at: 100, tracks: { audio: 'A2' } },
		]);
		expect([...h.clips('A1'), ...h.clips('A2')].map((c) => [c.sourceIn, c.duration])).toEqual([
			[0, 68],
			[0, 68],
		]);
	});

	it('extends a 67-frame clip to the rounded-up end and refuses one frame more with a reason', () => {
		const { h, mediaId } = setup();
		h.ok([
			{
				type: 'clip.place',
				source: { mediaId },
				sourceRange: { in: { flicks: 0 }, out: { flicks: (67 * FLICKS_PER_SECOND) / 60 } },
				at: 0,
				tracks: { audio: 'A1' },
			},
		]);
		const [clip] = h.clips('A1');
		expect(clip!.duration).toBe(67);
		// a project saved with the 67-frame clip loads unchanged
		const loaded = loadProject(JSON.parse(JSON.stringify(h.doc)));
		expect([loaded.repairs, loaded.issues]).toEqual([[], []]);
		expect(Object.values(loaded.document.sequences)[0]!.clips[clip!.id]).toEqual(clip);
		const t = h.ok([{ type: 'clip.trim', clipId: clip!.id, edge: 'out', deltaFrames: 1 }]);
		expect((t.results[0] as { deltaFrames: number }).deltaFrames).toBe(1);
		expect(h.clips('A1')[0]!.duration).toBe(68);
		const r = h.tx([{ type: 'clip.trim', clipId: clip!.id, edge: 'out', deltaFrames: 1 }]);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.errors[0]).toMatchObject({ code: 'E_OUT_OF_MEDIA' });
			expect(r.errors[0]!.message).toMatch(/nothing left after its Out/);
		}
	});
});
