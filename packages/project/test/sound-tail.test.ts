// Fix "SFX tail truncation" (spec 12 §2.3; wp-note): a placed clip never ends inside its sound. Registration pads
// trailing silence (`libraryTrailSilenceSamples`, `trailSilenceSec`), placement rounds the clip's whole frames UP to the
// sound's end (its −60 dB tail when the provenance knows it), and media without the trail (copies registered before the
// fix, sounds over 120 s, project audio) end less than one frame past their media (INV-005's tolerance: silence).
// Exported audio: apps/engine/test/sound-tail.test.ts.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	ALLOWED_SEQUENCE_RATES,
	type AudioClip,
	checkInvariants,
	FLICKS_PER_SECOND,
	flicksPerFrame,
	LIBRARY_PAD_MAX_SECONDS,
	LIBRARY_TRAIL_SILENCE_SEC,
	type LibraryProvenance,
	libraryDescriptorIssue,
	libraryTrailSilenceSamples,
	planSoundInsert,
	type Rational,
	readLibraryProvenance,
	repairDocument,
	shiftLibraryDescriptors,
	soundTimingOf,
} from '../src/index.ts';
import { Harness, videoAsset } from './helpers.ts';
import { LIB } from './sound-fixtures.ts';

const SR = 48_000;

let n = 0;
/** A registered library sound of `soundSec` with 50 ms of lead silence and `trailSec` of trailing silence. */
function media(
	h: Harness,
	o: { peakAfterLead: number; soundSec: number; trailSec?: number; tailSec?: number; types?: string[] },
): string {
	const lead = 0.05;
	const trail = o.trailSec ?? 0;
	const durationSec = lead + o.soundSec + trail;
	const library: LibraryProvenance = {
		...LIB,
		soundId: `snd_${(++n).toString(16).padStart(16, 'a')}`,
		types: o.types ?? ['click'],
		descriptors: {
			...LIB.descriptors!,
			peakSec: lead + o.peakAfterLead,
			onsetSec: lead,
			headQuietSec: lead,
			durationSec,
			...(o.tailSec !== undefined ? { tailSec: o.tailSec } : {}),
		},
		leadSilenceSec: lead,
		...(trail ? { trailSilenceSec: trail } : {}),
	};
	const r = h.ok([
		{ type: 'media.register', asset: { ...videoAsset({ kind: 'audio', seconds: durationSec }), library } },
	]);
	return (r.results[0] as { mediaId: string }).mediaId;
}

const clipOf = (h: Harness, r: { results: unknown[] }, i = 0) =>
	h.seq.clips[(r.results[i] as { clips: { clipId: string }[] }).clips[0]!.clipId] as AudioClip;

/** Content flicks a clip plays up to. */
const contentEnd = (h: Harness, c: AudioClip) =>
	c.sourceIn + c.duration * flicksPerFrame(h.seq.settings.frameRate) * c.speed.rate;

describe('registration: trailing silence', () => {
	it('pads sounds that do not end in 50 ms of quiet, or whose end is unknown; never sounds over 120 s', () => {
		const pad = Math.ceil(LIBRARY_TRAIL_SILENCE_SEC * SR);
		expect(pad).toBe(2400);
		// a 30 ms click fading to −60 dB at its last sample
		expect(libraryTrailSilenceSamples({ peakSec: 0.001, tailSec: 0.029, durationSec: 0.03 }, SR)).toBe(pad);
		// 60 ms of quiet after the tail: nothing to add
		expect(libraryTrailSilenceSamples({ peakSec: 0.001, tailSec: 0.029, durationSec: 0.09 }, SR)).toBe(0);
		expect(libraryTrailSilenceSamples({ peakSec: 0.001, tailSec: 0.029, durationSec: 0.0789 }, SR)).toBe(pad);
		// no tail measured, or the analysis stopped before the end of the file: padded
		expect(libraryTrailSilenceSamples({ peakSec: 0.001, durationSec: 0.5 }, SR)).toBe(pad);
		expect(
			libraryTrailSilenceSamples({ peakSec: 1, tailSec: 2, durationSec: 60 }, SR, { analysedSec: 30 }),
		).toBe(pad);
		expect(
			libraryTrailSilenceSamples({ peakSec: 1, tailSec: 2, durationSec: 60 }, SR, { analysedSec: 60 }),
		).toBe(0);
		// beds over 120 s are never copied; hostile numbers give 0
		expect(libraryTrailSilenceSamples({ peakSec: 1, durationSec: LIBRARY_PAD_MAX_SECONDS + 1 }, SR)).toBe(0);
		for (const bad of [Number.NaN, -1, 0, Number.POSITIVE_INFINITY])
			expect(libraryTrailSilenceSamples({ peakSec: 0, tailSec: 0, durationSec: bad }, SR)).toBe(0);
		expect(libraryTrailSilenceSamples({ peakSec: 0, durationSec: 1 }, Number.NaN)).toBe(0);
		expect(libraryTrailSilenceSamples({ peakSec: 0, durationSec: 1 }, 44_100)).toBe(2205);
	});

	it('the registered file’s descriptors: lead moves the time points, the trail lengthens the file only', () => {
		const d = shiftLibraryDescriptors({ ...LIB.descriptors!, tailSec: 0.4 }, 0.05, 0.05);
		expect(d.peakSec).toBeCloseTo(LIB.descriptors!.peakSec + 0.05, 12);
		expect(d.durationSec).toBeCloseTo(LIB.descriptors!.durationSec + 0.1, 12);
		expect(d.tailSec).toBe(0.4);
		expect(shiftLibraryDescriptors(LIB.descriptors!, 0, 0)).toBe(LIB.descriptors);
	});

	it('provenance carries trailSilenceSec and tailSec; bad values are dropped on read, impossible ones refused', () => {
		const p = { ...LIB, trailSilenceSec: 0.05, descriptors: { ...LIB.descriptors!, tailSec: 0.3 } };
		expect(readLibraryProvenance(p)).toEqual(p);
		const bad = readLibraryProvenance({ ...p, trailSilenceSec: -1 });
		expect(bad?.trailSilenceSec).toBeUndefined();
		expect(bad?.descriptors?.tailSec).toBe(0.3);
		expect(libraryDescriptorIssue(p)).toBeNull();
		expect(
			libraryDescriptorIssue({ ...p, descriptors: { ...p.descriptors, tailSec: 5 } } as LibraryProvenance),
		).toMatch(/tailSec/);
		expect(libraryDescriptorIssue({ ...p, trailSilenceSec: 0.9 } as LibraryProvenance)).toMatch(
			/trailSilenceSec/,
		);
		// media.setLibraryInfo refuses the impossible one
		const h = new Harness();
		const m = media(h, { peakAfterLead: 0.001, soundSec: 0.03 });
		const r = h.tx([
			{
				type: 'media.setLibraryInfo',
				mediaId: m,
				library: { ...p, descriptors: { ...p.descriptors, tailSec: 5 } },
			},
		]);
		expect(r.ok).toBe(false);
	});

	it('repairDocument drops a damaged trailSilenceSec and keeps the rest (INV-LIBRARY flags it)', () => {
		const h = new Harness();
		const m = media(h, { peakAfterLead: 0.001, soundSec: 0.03, trailSec: 0.05, tailSec: 0.029 });
		expect(checkInvariants(h.doc)).toEqual([]);
		const doc = JSON.parse(JSON.stringify(h.doc));
		doc.media[m].library.trailSilenceSec = -3;
		expect(checkInvariants(doc).some((i) => i.invariant === 'INV-LIBRARY')).toBe(true);
		const { document, report } = repairDocument(doc, h.ids);
		expect(report).toContainEqual(expect.objectContaining({ action: 'repair-library', entity: m }));
		const lib = document.media[m]!.library!;
		expect(lib.trailSilenceSec).toBeUndefined();
		expect(lib.descriptors?.tailSec).toBe(0.029);
		expect(checkInvariants(document)).toEqual([]);
		expect(repairDocument(document, h.ids).report).toEqual([]);
	});

	it('soundTimingOf: the sound ends before the trail; it has faded at peak + tail', () => {
		const t = soundTimingOf(
			{
				trailSilenceSec: 0.05,
				descriptors: { peakSec: 0.051, onsetSec: 0.05, headQuietSec: 0.05, durationSec: 0.13, tailSec: 0.02 },
			},
			{ peakSec: 0, onsetSec: 0, headQuietSec: 0, durationSec: 1 },
		);
		expect(t.endSec).toBeCloseTo(0.08, 12);
		expect(t.tailEndSec).toBeCloseTo(0.071, 12);
		// an old copy: no trail, no tail → the sound runs to the end of the file
		const old = soundTimingOf(
			{ descriptors: { peakSec: 0.051, onsetSec: 0.05, headQuietSec: 0.05, durationSec: 0.08 } },
			{ peakSec: 0, onsetSec: 0, headQuietSec: 0, durationSec: 1 },
		);
		expect(old.endSec).toBeUndefined();
		expect(old.tailEndSec).toBeUndefined();
	});
});

describe('placement never ends inside the sound', () => {
	it('planSoundInsert (property): every rate, speed, peak and length; inside the media when it is padded', () => {
		fc.assert(
			fc.property(
				fc.constantFrom(...ALLOWED_SEQUENCE_RATES),
				fc.integer({ min: 30, max: 5000 }),
				fc.integer({ min: 0, max: 4000 }), // peak, samples after the lead
				fc.integer({ min: 1, max: 6000 }), // sound length after the peak, samples
				fc.constantFrom(0.98, 1, 1.0123, 1.02, 2 ** (3 / 12), 2 ** (-3 / 12)),
				fc.boolean(), // padded with the trail (else an old head-only copy)
				fc.constantFrom<'peak' | 'start' | 'end'>('peak', 'start', 'end'),
				(fps: Rational, cue, peakS, afterS, rate, padded, align) => {
					const lead = 0.05;
					const peakSec = lead + peakS / SR;
					const endSec = peakSec + afterS / SR;
					const trail = padded ? LIBRARY_TRAIL_SILENCE_SEC : 0;
					const durationSec = endSec + trail;
					const timing = soundTimingOf(
						{
							...(trail ? { trailSilenceSec: trail } : {}),
							descriptors: { peakSec, onsetSec: lead, headQuietSec: lead, durationSec },
						},
						{ peakSec: 0, onsetSec: 0, headQuietSec: 0, durationSec: 1 },
					);
					const durFlicks = Math.round(durationSec * FLICKS_PER_SECOND);
					const r = planSoundInsert({
						cueFrame: cue,
						fps,
						align,
						timing,
						mediaDurationFlicks: durFlicks,
						rate,
						clampStart: true,
					});
					expect(r.ok).toBe(true);
					if (!r.ok) return;
					const p = r.placement;
					const F = flicksPerFrame(fps);
					const reach = p.sourceInFlicks + p.frames * F * rate;
					// the whole sound plays
					expect(reach).toBeGreaterThanOrEqual(endSec * FLICKS_PER_SECOND - 1);
					expect(p.soundEndFlicks).toBe(Math.round(endSec * FLICKS_PER_SECOND));
					// never more than INV-005's one frame past the media; inside it when the trail covers a frame
					expect(reach).toBeLessThanOrEqual(durFlicks + F * rate + 1);
					// (whole frames inside the media keep `FRAME_EPS`, 1/1000 of a frame, as `clip.place` does)
					if (padded && F * rate <= trail * FLICKS_PER_SECOND)
						expect(reach).toBeLessThanOrEqual(durFlicks + F * rate * 1e-3 + 1);
					// the trailing silence is not played for its own sake: at most the frame holding the end of the sound
					expect(reach).toBeLessThan(endSec * FLICKS_PER_SECOND + F * rate * (1 + 1e-3) + 1);
					// `end` aligns the end of the sound, not of the trailing silence
					if (align === 'end') expect(p.alignFlicks).toBe(Math.round(endSec * FLICKS_PER_SECOND));
				},
			),
			{ numRuns: 2000 },
		);
	});

	it('a known −60 dB tail is enough to reach; without trail info a clip ends past the media by under one frame', () => {
		const fps = { num: 30, den: 1 };
		const F = flicksPerFrame(fps);
		const base = { peakSec: 0.051, onsetSec: 0.05, headQuietSec: 0.05 };
		// a file with 70 ms of quiet after its tail: the tail is reached and the clip stays in the media
		const quiet = planSoundInsert({
			cueFrame: 40,
			fps,
			align: 'peak',
			timing: { ...base, durationSec: 0.15, tailEndSec: 0.08 },
			mediaDurationFlicks: 0.15 * FLICKS_PER_SECOND,
		});
		expect(quiet.ok && quiet.placement.sourceInFlicks + quiet.placement.frames * F).toBeLessThanOrEqual(
			0.15 * FLICKS_PER_SECOND,
		);
		// a sound over 120 s (never padded): its last partial frame is not dropped
		const bed = planSoundInsert({
			cueFrame: 0,
			fps,
			align: 'start',
			timing: { peakSec: 3, onsetSec: 0, headQuietSec: 0, durationSec: 130.01 },
			mediaDurationFlicks: 130.01 * FLICKS_PER_SECOND,
		});
		expect(bed.ok).toBe(true);
		if (!bed.ok) return;
		const reach = bed.placement.sourceInFlicks + bed.placement.frames * F;
		expect(reach).toBeGreaterThanOrEqual(130.01 * FLICKS_PER_SECOND);
		expect(reach - 130.01 * FLICKS_PER_SECOND).toBeLessThan(F);
	});
});

describe('soundDesign.place / swap keep the whole sound (commands)', () => {
	it.each([
		['23.976', { num: 24000, den: 1001 }],
		['29.97', { num: 30000, den: 1001 }],
		['30', { num: 30, den: 1 }],
		['60', { num: 60, den: 1 }],
	])('%s fps: a 30 ms click placed by its peak reaches its end, inside the padded media', (_l, fps) => {
		const h = new Harness();
		h.ok([{ type: 'sequence.updateSettings', sequenceId: h.seqId, settings: { frameRate: fps } }]);
		const m = media(h, { peakAfterLead: 0.001, soundSec: 0.03, trailSec: 0.05, tailSec: 0.029 });
		const before = h.doc;
		const r = h.ok([{ type: 'soundDesign.place', frame: 47, layers: [{ mediaId: m }] }]);
		const c = clipOf(h, r);
		expect(contentEnd(h, c)).toBeGreaterThanOrEqual(0.08 * FLICKS_PER_SECOND - 1);
		expect(contentEnd(h, c)).toBeLessThanOrEqual(0.13 * FLICKS_PER_SECOND + 1);
		expect(checkInvariants(h.doc)).toEqual([]);
		// the result says how long the clip is
		expect((r.results[0] as { clips: { duration: number }[] }).clips[0]!.duration).toBe(c.duration);
		// undo = the document before, untouched
		expect(before.sequences[h.seqId]!.clips[c.id]).toBeUndefined();
	});

	it('an old head-only copy: place and a same-media swap run the clip to the sound’s end (past the media < 1 frame)', () => {
		const h = new Harness();
		const F = flicksPerFrame(h.seq.settings.frameRate);
		// 85 ms copy (50 ms lead + 35 ms sound), peaking at 58 ms: the defect WP5.1 measured
		const m = media(h, { peakAfterLead: 0.008, soundSec: 0.035 });
		const dur = 0.085 * FLICKS_PER_SECOND;
		const r = h.ok([{ type: 'soundDesign.place', frame: 213, layers: [{ mediaId: m }] }]);
		const c = clipOf(h, r);
		expect(contentEnd(h, c)).toBeGreaterThanOrEqual(dur);
		expect(contentEnd(h, c) - dur).toBeLessThan(F);
		expect(checkInvariants(h.doc)).toEqual([]);
		// a clip placed by the old rule (whole frames inside the media: it ends on its peak) …
		h.ok([{ type: 'clip.trim', clipId: c.id, edge: 'out', deltaFrames: -1 }]);
		const cut = h.seq.clips[c.id] as AudioClip;
		expect(contentEnd(h, cut)).toBeLessThan(0.058 * FLICKS_PER_SECOND + 1);
		// … a swap to its own media re-plans it: the aligned point stays, the whole sound plays again
		const s = h.ok([{ type: 'soundDesign.swap', clipId: c.id, mediaId: m }]);
		const fixed = h.seq.clips[c.id] as AudioClip;
		expect(fixed.start).toBe(c.start);
		expect(fixed.sourceIn).toBe(c.sourceIn);
		expect(contentEnd(h, fixed)).toBeGreaterThanOrEqual(dur);
		expect((s.results[0] as { alignedFrame: number }).alignedFrame).toBe(213);
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('a swap to a trail-padded copy keeps the aligned frame, role, gain and pan and ends inside the new media', () => {
		const h = new Harness();
		const old = media(h, { peakAfterLead: 0.008, soundSec: 0.035 });
		const fresh = media(h, { peakAfterLead: 0.008, soundSec: 0.035, trailSec: 0.05, tailSec: 0.03 });
		const r = h.ok([
			{
				type: 'soundDesign.place',
				frame: 90,
				layers: [{ mediaId: old, gainDb: -9, pan: -30, role: 'hero' }],
			},
		]);
		const c = clipOf(h, r);
		h.ok([{ type: 'soundDesign.swap', clipId: c.id, mediaId: fresh }]);
		const s = h.seq.clips[c.id] as AudioClip & { sfx?: { role: string } };
		expect(s.mediaId).toBe(fresh);
		expect(s.gainDb).toBe(-9);
		expect(s.pan.value).toBe(-30);
		expect(s.sfx!.role).toBe('hero');
		const F = flicksPerFrame(h.seq.settings.frameRate);
		expect(s.start * F + (0.058 * FLICKS_PER_SECOND - s.sourceIn)).toBeCloseTo(90 * F, -1);
		expect(contentEnd(h, s)).toBeGreaterThanOrEqual(0.085 * FLICKS_PER_SECOND);
		expect(contentEnd(h, s)).toBeLessThanOrEqual(0.135 * FLICKS_PER_SECOND + 1);
	});

	it('resync and applyGains move or re-level a placed sound without shortening it', () => {
		const h = new Harness();
		const m = media(h, { peakAfterLead: 0.001, soundSec: 0.03, trailSec: 0.05, tailSec: 0.029 });
		h.ok([
			{ type: 'marker.add', frame: 60, ref: '$mk' },
			{
				type: 'soundCue.add',
				cues: [
					{
						frame: 60,
						kind: 'cut',
						weight: 'support',
						source: 'user',
						anchor: { type: 'marker', markerId: '$mk' },
						ref: '$c',
					},
				],
			},
			{ type: 'soundDesign.place', cueId: '$c', layers: [{ mediaId: m }] },
		]);
		const id = Object.keys(h.seq.clips)[0]!;
		const dur = h.seq.clips[id]!.duration;
		const markerId = (h.seq.markers as unknown as { id: string }[])[0]!.id;
		h.ok([{ type: 'marker.update', markerId, frame: 75 }]);
		h.ok([{ type: 'soundCue.resync' }]);
		expect(h.seq.clips[id]!.start).toBeGreaterThan(60);
		expect(h.seq.clips[id]!.duration).toBe(dur);
		h.ok([{ type: 'soundDesign.applyGains', gains: { [id]: -12 } }]);
		expect(h.seq.clips[id]!.duration).toBe(dur);
	});
});
