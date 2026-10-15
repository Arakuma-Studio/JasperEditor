// Sound Library (spec 12 §2.7, P1-R7): pure helpers — prefs parsing, request building, local collections, badges,
// accessible names, waveform columns, drag payload, track choice and peak-aligned placement, drop snapping.
import { FLICKS_PER_SECOND, flicksPerFrame, type Sequence } from '@jasper/project';
import fc from 'fast-check';
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveSoundDrop } from '../src/panels/timeline/model/sound-drop.ts';
import {
	chooseSoundTrack,
	JASPER_SOUND_MIME,
	nextSfxTrackName,
	planSoundPlacement,
	readSoundDrag,
	timingOf,
	trackIsFree,
	writeSoundDrag,
} from '../src/sound/insert.ts';
import {
	DEFAULT_FILTERS,
	decodeBase64,
	descriptorWords,
	licenseBadge,
	searchLocal,
	searchRequest,
	soundAccessibleName,
	usedSoundIds,
	waveformColumns,
} from '../src/sound/model.ts';
import {
	DEFAULT_SOUND_LIBRARY_PREFS,
	parseSoundLibraryPrefs,
	soundLibraryPrefs,
} from '../src/sound/prefs.ts';
import { soundEntry, soundId } from './sound-helpers.ts';
import { makeSession, videoAsset } from './timeline-helpers.ts';

describe('Sound Library prefs', () => {
	beforeEach(() => {
		localStorage.clear();
		soundLibraryPrefs.reload();
	});
	it('falls back to defaults for hostile values and keeps valid ids only', () => {
		expect(parseSoundLibraryPrefs(null)).toEqual(DEFAULT_SOUND_LIBRARY_PREFS);
		const p = parseSoundLibraryPrefs({
			favourites: [soundId(1), 'x', soundId(1), 7, soundId(2)],
			recents: 'nope',
			volumeDb: 900,
			density: 'huge',
			loop: 'yes',
			auditionOnHover: true,
		});
		expect(p.favourites).toEqual([soundId(1), soundId(2)]);
		expect(p.recents).toEqual([]);
		expect(p.volumeDb).toBe(6);
		expect(p.density).toBe('normal');
		expect(p.loop).toBe(false);
		expect(p.auditionOnHover).toBe(true);
	});
	it('never throws on arbitrary input (property)', () => {
		fc.assert(
			fc.property(fc.anything(), (raw) => {
				const p = parseSoundLibraryPrefs(raw);
				expect(Number.isFinite(p.volumeDb)).toBe(true);
				expect(p.favourites.length).toBeLessThanOrEqual(500);
				expect(p.recents.length).toBeLessThanOrEqual(50);
			}),
			{ numRuns: 300 },
		);
	});
	it('stars, unstars and records recents (most recent first, capped), persisted', () => {
		expect(soundLibraryPrefs.toggleFavourite(soundId(3))).toBe(true);
		expect(soundLibraryPrefs.isFavourite(soundId(3))).toBe(true);
		expect(soundLibraryPrefs.toggleFavourite(soundId(3))).toBe(false);
		expect(soundLibraryPrefs.toggleFavourite('bad')).toBe(false);
		for (let i = 0; i < 60; i++) soundLibraryPrefs.touchRecent(soundId(i));
		expect(soundLibraryPrefs.get().recents).toHaveLength(50);
		expect(soundLibraryPrefs.get().recents[0]).toBe(soundId(59));
		soundLibraryPrefs.touchRecent(soundId(30));
		expect(soundLibraryPrefs.get().recents[0]).toBe(soundId(30));
		soundLibraryPrefs.reload();
		expect(soundLibraryPrefs.get().recents[0]).toBe(soundId(30));
	});
	it('survives a damaged stored value', () => {
		localStorage.setItem('jasper:sound-library-prefs', '{not json');
		soundLibraryPrefs.reload();
		expect(soundLibraryPrefs.get()).toEqual(DEFAULT_SOUND_LIBRARY_PREFS);
	});
});

describe('requests, collections, badges, names', () => {
	it('builds the engine search from the filters', () => {
		expect(searchRequest(DEFAULT_FILTERS, { limit: 100, offset: 0 })).toEqual({
			limit: 100,
			offset: 0,
			license: 'commercial-safe',
		});
		const r = searchRequest(
			{
				query: '  boom ',
				collection: 'root:root_0123456789ab',
				types: ['hit', 'boom'],
				refine: { length: 'short', tone: 'dark' },
				commercialSafe: false,
				similarTo: { id: soundId(9), title: 'x' },
			},
			{ limit: 10, offset: 20 },
		);
		expect(r).toEqual({
			limit: 10,
			offset: 20,
			license: 'any',
			q: 'boom',
			types: ['hit', 'boom'],
			length: 'short',
			tone: 'dark',
			similarTo: soundId(9),
			rootId: 'root_0123456789ab',
		});
		expect(
			searchRequest({ ...DEFAULT_FILTERS, collection: 'source:synth' }, { limit: 1, offset: 0 }).sources,
		).toEqual(['synth']);
	});
	it('searches a local collection like the engine: filters, keeps its order without a query, facets', () => {
		const a = soundEntry({ title: 'Big boom', types: ['boom'] });
		const b = soundEntry({ title: 'Small hit', types: ['hit'] });
		const nc = soundEntry({ title: 'NC hit', types: ['hit'], license: 'CC-BY-NC-4.0' });
		const r = searchLocal([b, a, nc], DEFAULT_FILTERS, null);
		expect(r.results.map((e) => e.title)).toEqual(['Small hit', 'Big boom']);
		expect(r.facets.types).toEqual({ hit: 1, boom: 1 });
		expect(r.facets.licenses).toEqual({ cc0: 2, nc: 1 });
		const typed = searchLocal([b, a, nc], { ...DEFAULT_FILTERS, types: ['boom'] }, null);
		expect(typed.results.map((e) => e.title)).toEqual(['Big boom']);
		// disjunctive: the type counts ignore the type filter
		expect(typed.facets.types).toEqual({ hit: 1, boom: 1 });
		expect(searchLocal([b, a, nc], { ...DEFAULT_FILTERS, query: 'boom' }, null).results).toEqual([a]);
		expect(searchLocal([b, a, nc], { ...DEFAULT_FILTERS, commercialSafe: false }, null).total).toBe(3);
	});
	it('labels licences (state not by colour alone: NC, unknown and undeclared read differently)', () => {
		const src = { type: 'starter' as const, file: 'a.wav' };
		expect(licenseBadge({ license: 'CC0-1.0', source: src })).toMatchObject({ text: 'CC0', warn: false });
		expect(licenseBadge({ license: 'CC-BY-4.0', source: src }).text).toBe('BY');
		expect(licenseBadge({ license: 'CC-BY-SA-4.0', source: src }).text).toBe('BY-SA');
		expect(
			licenseBadge({ license: 'LicenseRef-JasperEditor', source: { type: 'synth', recipe: 'hit', seed: 1 } })
				.text,
		).toBe('Synth');
		expect(licenseBadge({ license: 'LicenseRef-UserRoyaltyFree', source: src })).toMatchObject({
			text: 'Yours',
			warn: false,
		});
		expect(licenseBadge({ license: 'LicenseRef-UserProvided', source: src })).toMatchObject({
			text: 'Yours?',
			warn: true,
		});
		expect(licenseBadge({ license: 'CC-BY-NC-4.0', source: src })).toMatchObject({ text: 'NC', warn: true });
		expect(licenseBadge({ license: 'Proprietary', source: src })).toMatchObject({ text: '?', warn: true });
	});
	it('gives rows descriptor-rich accessible names', () => {
		const e = soundEntry({ title: 'Door slam', types: ['hit', 'thump'], peakSec: 0.023, durationSec: 0.8 });
		const name = soundAccessibleName(e, true);
		expect(name).toContain('Door slam');
		expect(name).toContain('Hit, Thump');
		expect(name).toContain('0.80 s');
		expect(name).toContain('peak at 23 ms');
		expect(name).toContain('punchy');
		expect(name).toContain('dark');
		expect(name).toContain('heavy');
		expect(name).toContain('CC0');
		expect(name).toContain('favourite');
		expect(
			descriptorWords({ ...e.descriptors, riseMs: 80, centroidHz: 5000, below150Share: 0.01, flatness: 0.5 }),
		).toEqual(['soft attack', 'bright', 'light', 'noisy']);
	});
	it('lists the library sounds a project uses', () => {
		const { session } = makeSession();
		const r = session.apply({
			label: 'x',
			origin: 'user',
			commands: [
				{
					type: 'media.register',
					asset: {
						...videoAsset(1, true),
						kind: 'audio',
						library: {
							soundId: soundId(77),
							title: 'T',
							types: ['hit'],
							source: { type: 'starter' },
							license: 'CC0-1.0',
							author: '',
							attribution: null,
						},
					},
				},
				{ type: 'media.register', asset: videoAsset(1, true) },
			] as never,
		});
		expect(r.ok).toBe(true);
		expect(usedSoundIds(session.getCommitted())).toEqual([soundId(77)]);
	});
});

describe('mini waveform columns', () => {
	it('takes the largest peak per column over the duration', () => {
		const peaks = new Uint8Array([0, 255, 0, 128, 0, 0, 0, 0, 51, 0]);
		const cols = waveformColumns(peaks, 10, 1, 5);
		expect([...cols].map((v) => Math.round(v * 100) / 100)).toEqual([1, 0.5, 0, 0, 0.2]);
		// a longer duration than covered: the rest is silent
		expect([...waveformColumns(peaks, 10, 2, 4)].slice(2)).toEqual([0, 0]);
	});
	it('never throws and stays in 0…1 for hostile input (property)', () => {
		fc.assert(
			fc.property(
				fc.uint8Array({ maxLength: 400 }),
				fc.oneof(fc.double(), fc.constant(Number.NaN), fc.constant(0)),
				fc.oneof(fc.double(), fc.constant(Number.POSITIVE_INFINITY)),
				fc.oneof(fc.integer({ min: -5, max: 300 }), fc.double()),
				(p, per, dur, w) => {
					const c = waveformColumns(p, per, dur, w);
					for (const v of c) expect(v >= 0 && v <= 1).toBe(true);
				},
			),
			{ numRuns: 300 },
		);
		expect(decodeBase64('%%%')).toEqual(new Uint8Array(0));
		expect([...decodeBase64(btoa('\u0001ÿ'))]).toEqual([1, 255]);
	});
});

describe('drag payload', () => {
	const dt = () => {
		const data = new Map<string, string>();
		return {
			data,
			setData: (k: string, v: string) => data.set(k, v),
			getData: (k: string) => data.get(k) ?? '',
			get types() {
				return [...data.keys()];
			},
			effectAllowed: 'none',
		};
	};
	it('round-trips and refuses malformed payloads', () => {
		const e = soundEntry();
		const d = dt();
		writeSoundDrag(d as unknown as DataTransfer, e);
		expect(d.types).toContain(JASPER_SOUND_MIME);
		expect(readSoundDrag(d)).toEqual({ type: 'jasper/sound', soundId: e.id });
		for (const raw of [
			'{',
			'{"type":"jasper/sound","soundId":"../etc"}',
			'{"type":"x","soundId":"snd_0000000000000001"}',
			'7',
		]) {
			const bad = dt();
			bad.setData(JASPER_SOUND_MIME, raw);
			expect(readSoundDrag(bad)).toBeNull();
		}
		expect(readSoundDrag(null)).toBeNull();
	});
});

// ----------------------------------------------------------------------------------------------- placement

function seqOf(session: ReturnType<typeof makeSession>['session'], seqId: string): Sequence {
	return session.getCommitted().sequences[seqId] as Sequence;
}

function placeAudio(
	session: ReturnType<typeof makeSession>['session'],
	at: number,
	track: string,
	seconds = 2,
) {
	const r = session.apply({
		label: 'x',
		origin: 'user',
		commands: [
			{ type: 'media.register', asset: { ...videoAsset(seconds, true), kind: 'audio' }, ref: '$m' },
			{ type: 'clip.place', source: { mediaId: '$m' }, at, tracks: { audio: track }, video: false },
		] as never,
	});
	expect(r.ok, JSON.stringify(r)).toBe(true);
}

describe('track choice and peak-aligned placement (spec 12 §2.3)', () => {
	it('puts the peak on the cue frame (frame-accurate; the rest < 1 frame late or trimmed from a quiet head)', () => {
		const { session, seqId } = makeSession();
		const seq = seqOf(session, seqId);
		const F = flicksPerFrame(seq.settings.frameRate);
		const e = soundEntry({ peakSec: 0.2325, durationSec: 1.3 });
		const r = planSoundPlacement({ seq, timing: timingOf(e), cueFrame: 45, align: 'peak' });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const p = r.placement;
		// the aligned point in sequence flicks: start + (peak − In)
		const at = p.start * F + (0.2325 * FLICKS_PER_SECOND - p.sourceInFlicks);
		expect(at - 45 * F).toBeGreaterThanOrEqual(-2);
		expect(at - 45 * F).toBeLessThan(F);
		expect(p.track).toMatchObject({ kind: 'existing', label: 'A1' });
		expect(p.start + p.alignOffsetFrames).toBeCloseTo(45 + p.errorFlicks / F, 6);
	});
	it('aligns the start with Alt (align start) and clamps a start before 0 by trimming the head', () => {
		const { session, seqId } = makeSession();
		const seq = seqOf(session, seqId);
		const e = soundEntry({ peakSec: 1.5, durationSec: 3 });
		const s = planSoundPlacement({ seq, timing: timingOf(e), cueFrame: 30, align: 'start' });
		expect(s.ok && s.placement.start).toBe(30);
		const c = planSoundPlacement({ seq, timing: timingOf(e), cueFrame: 10, align: 'peak' });
		expect(c.ok && c.placement.start).toBe(0);
		// the peak still lands on frame 10: the head before it is cut from the In point
		expect(c.ok && c.placement.sourceInFlicks / FLICKS_PER_SECOND).toBeGreaterThan(1);
	});
	it('prefers the drop track, then targeted, then an SFX track, then the first free one, else a new SFX n', () => {
		const { session, seqId } = makeSession();
		placeAudio(session, 0, 'A1', 4);
		let seq = seqOf(session, seqId);
		const [a1, a2, a3] = seq.audioTracks.map((t) => t.id);
		const span = { start: 30, frames: 20 };
		expect(trackIsFree(seq, a1!, 30, 20)).toBe(false);
		expect(chooseSoundTrack(seq, span)).toMatchObject({ trackId: a2, label: 'A2' });
		expect(chooseSoundTrack(seq, span, { preferredTrackId: a1 })).toMatchObject({ trackId: a2 });
		expect(chooseSoundTrack(seq, span, { preferredTrackId: a3 })).toMatchObject({ trackId: a3 });
		expect(chooseSoundTrack(seq, span, { targeted: [a3!] })).toMatchObject({ trackId: a3 });
		const renamed = session.apply({
			label: 'n',
			origin: 'user',
			commands: [{ type: 'track.update', sequenceId: seqId, trackId: a3, patch: { name: 'SFX' } }] as never,
		});
		expect(renamed.ok, JSON.stringify(renamed)).toBe(true);
		seq = seqOf(session, seqId);
		expect(chooseSoundTrack(seq, span)).toMatchObject({ trackId: a3 });
		placeAudio(session, 0, 'A2', 4);
		placeAudio(session, 0, 'A3', 4);
		seq = seqOf(session, seqId);
		expect(chooseSoundTrack(seq, span)).toEqual({ kind: 'new', name: 'SFX 1', label: 'A4' });
		// after the span every track is free again: the SFX-named one wins over A1
		expect(chooseSoundTrack(seq, { start: 200, frames: 10 })).toMatchObject({ trackId: a3 });
		expect(nextSfxTrackName({ audioTracks: [{ name: 'SFX 1' }, { name: 'sfx 2' }] } as never)).toBe('SFX 3');
	});
	it('never chooses a track with audio over the span (property)', () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						at: fc.integer({ min: 0, max: 200 }),
						track: fc.constantFrom('A1', 'A2', 'A3'),
						s: fc.integer({ min: 1, max: 4 }),
					}),
					{
						maxLength: 8,
					},
				),
				fc.integer({ min: 0, max: 300 }),
				fc.double({ min: 0, max: 2, noNaN: true }),
				(clips, cue, peak) => {
					const { session, seqId } = makeSession();
					for (const c of clips) {
						const r = session.apply({
							label: 'x',
							origin: 'user',
							commands: [
								{ type: 'media.register', asset: { ...videoAsset(c.s, true), kind: 'audio' }, ref: '$m' },
								{
									type: 'clip.place',
									source: { mediaId: '$m' },
									at: c.at,
									tracks: { audio: c.track },
									video: false,
								},
							] as never,
						});
						if (!r.ok) return;
					}
					const seq = seqOf(session, seqId);
					const e = soundEntry({ peakSec: peak, durationSec: 2.5 });
					const r = planSoundPlacement({ seq, timing: timingOf(e), cueFrame: cue, align: 'peak' });
					expect(r.ok).toBe(true);
					if (!r.ok) return;
					const p = r.placement;
					if (p.track.kind === 'existing')
						expect(trackIsFree(seq, p.track.trackId, p.start, p.frames)).toBe(true);
					else for (const t of seq.audioTracks) expect(trackIsFree(seq, t.id, p.start, p.frames)).toBe(false);
				},
			),
			{ numRuns: 60 },
		);
	});
});

describe('timeline drop: the peak is the primary snap edge', () => {
	it('snaps the peak to the playhead first, the clip edges only when the peak finds nothing', () => {
		const { session, seqId } = makeSession();
		const seq = seqOf(session, seqId);
		const e = soundEntry({ peakSec: 0.5, durationSec: 2 }); // peak 15 frames in at 29.97
		const base = { seq, info: e, preferredTrackId: null, alt: false, snapping: true, thresholdFrames: 4 };
		const peak = resolveSoundDrop({ ...base, pointerFrame: 98, playhead: 100 });
		expect(peak).toMatchObject({ cue: 100, snapFrame: 100, snapEdge: 'peak', align: 'peak' });
		// the clip's start lands on the playhead when the peak is far from any target
		const start = peak.plan!;
		const k = 100 - start.start;
		const edge = resolveSoundDrop({ ...base, pointerFrame: 100 + k + 2, playhead: 100 });
		expect(edge.snapEdge).toBe('start');
		expect(edge.plan!.start).toBe(100);
		// off: no snapping
		expect(resolveSoundDrop({ ...base, snapping: false, pointerFrame: 98, playhead: 100 })).toMatchObject({
			cue: 98,
			snapFrame: null,
		});
		// Alt: the start is under the pointer
		const alt = resolveSoundDrop({ ...base, alt: true, pointerFrame: 50, playhead: null });
		expect(alt).toMatchObject({ align: 'start', cue: 50 });
		expect(alt.plan!.start).toBe(50);
		// unknown sound (another window): the pointer frame, no plan
		expect(resolveSoundDrop({ ...base, info: null, pointerFrame: 12, playhead: null })).toMatchObject({
			cue: 12,
			plan: null,
		});
	});
});
