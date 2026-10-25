// Placing a Find Moment result (spec 12 P6-E14, WP-E9): `planMomentPlacement` gives ordinary commands that put the
// moment's range of a registered sound at a frame — exact source range (lead silence of the registered copy counted),
// a free SFX track or a new one, never over other audio — applied as one transaction with the source document
// untouched; impossible ranges are refused with typed errors, hostile numbers never throw.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	type AudioClip,
	checkInvariants,
	FLICKS_PER_SECOND,
	type LibraryProvenance,
	planMomentPlacement,
} from '../src/index.ts';
import { Harness, videoAsset } from './helpers.ts';
import { LIB } from './sound-fixtures.ts';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

function recording(h: Harness, seconds = 40, leadSilenceSec = 0.05): string {
	const library: LibraryProvenance = {
		...LIB,
		soundId: 'snd_00000000000000f1',
		title: 'Field recording',
		types: [],
		descriptors: { ...LIB.descriptors!, durationSec: seconds + leadSilenceSec },
		...(leadSilenceSec ? { leadSilenceSec } : {}),
	};
	const r = h.ok([
		{
			type: 'media.register',
			asset: { ...videoAsset({ kind: 'audio', seconds: seconds + leadSilenceSec }), library },
		},
	]);
	return (r.results[0] as { mediaId: string }).mediaId;
}

describe('planMomentPlacement', () => {
	it('places the exact source range on a free SFX track without overwriting other audio', () => {
		const h = new Harness();
		const m = recording(h);
		const before = clone(h.doc);
		const plan = planMomentPlacement({
			seq: h.seq,
			mediaRef: m,
			startSec: 23.1,
			endSec: 24.0,
			leadSec: 0.05,
			at: 60,
		});
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.placement.track).toMatchObject({ kind: 'new', name: 'SFX 1' });
		const r = h.ok(plan.placement.commands);
		const clipId = r.refs.$momentClip!;
		const c = h.seq.clips[clipId] as AudioClip;
		expect(c.start).toBe(60);
		expect(c.sourceIn).toBe(Math.round(23.15 * FLICKS_PER_SECOND));
		expect(c.duration).toBe(27);
		expect(h.seq.audioTracks.find((t) => t.id === c.trackId)!.name).toBe('SFX 1');
		expect(checkInvariants(h.doc)).toEqual([]);
		expect(before.sequences[h.seqId]!.clips).toEqual({});
		// a second moment at the same frame goes on another track, never over the first
		const again = planMomentPlacement({ seq: h.seq, mediaRef: m, startSec: 3, endSec: 4, at: 60 });
		expect(again.ok && again.placement.track.kind === 'new' && again.placement.track.name).toBe('SFX 2');
		// a free SFX track is reused
		const later = planMomentPlacement({ seq: h.seq, mediaRef: m, startSec: 3, endSec: 4, at: 600 });
		expect(later.ok && later.placement.track.kind).toBe('existing');
	});

	it('clamps to the media and refuses impossible ranges', () => {
		const h = new Harness();
		const m = recording(h, 10, 0);
		const media = Math.round(10 * FLICKS_PER_SECOND);
		const p = planMomentPlacement({
			seq: h.seq,
			mediaRef: m,
			startSec: 9.5,
			endSec: 12,
			mediaDurationFlicks: media,
			at: 0,
		});
		expect(p.ok && p.placement.sourceOutFlicks).toBe(media);
		const bad = (o: Partial<Parameters<typeof planMomentPlacement>[0]>) =>
			planMomentPlacement({
				seq: h.seq,
				mediaRef: m,
				startSec: 1,
				endSec: 2,
				at: 0,
				mediaDurationFlicks: media,
				...o,
			});
		expect(bad({ startSec: 11, endSec: 12 })).toMatchObject({ ok: false, code: 'E_INVALID_PARAM' });
		expect(bad({ endSec: 1 })).toMatchObject({ ok: false, code: 'E_INVALID_PARAM' });
		expect(bad({ startSec: -1 })).toMatchObject({ ok: false, code: 'E_INVALID_PARAM' });
		expect(bad({ at: -3 })).toMatchObject({ ok: false, code: 'E_INVALID_PARAM' });
		expect(bad({ at: 1.5 })).toMatchObject({ ok: false, code: 'E_INVALID_PARAM' });
		fc.assert(
			fc.property(
				fc.double(),
				fc.double(),
				fc.double(),
				fc.integer({ min: -10, max: 1e6 }),
				(s, e, lead, at) => {
					const r = planMomentPlacement({
						seq: h.seq,
						mediaRef: m,
						startSec: s,
						endSec: e,
						leadSec: lead,
						at,
						mediaDurationFlicks: media,
					});
					if (r.ok) {
						expect(r.placement.frames).toBeGreaterThanOrEqual(1);
						expect(r.placement.sourceOutFlicks).toBeGreaterThan(r.placement.sourceInFlicks);
					}
				},
			),
			{ numRuns: 300 },
		);
	});
});
