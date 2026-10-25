// Sound Library (spec 12 §2.7, P1-R7): pure helpers — prefs parsing, request building, local collections, badges,
// waveform columns, drag payload and drop snapping.
import { flicksPerFrame, type Sequence } from '@jasper/project';
import fc from 'fast-check';
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveSoundDrop } from '../src/panels/timeline/model/sound-drop.ts';
import { JASPER_SOUND_MIME, readSoundDrag, writeSoundDrag } from '../src/sound/insert.ts';
import {
	DEFAULT_FILTERS,
	decodeBase64,
	licenseBadge,
	searchLocal,
	searchRequest,
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
				includeShareAlike: false,
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
		// "Include ShareAlike" (spec 12 P6-E13): commercial-safe plus CC BY-SA; it means nothing without Commercial-safe
		expect(
			searchRequest({ ...DEFAULT_FILTERS, includeShareAlike: true }, { limit: 1, offset: 0 }).license,
		).toBe('commercial-safe-sa');
		expect(
			searchRequest(
				{ ...DEFAULT_FILTERS, commercialSafe: false, includeShareAlike: true },
				{ limit: 1, offset: 0 },
			).license,
		).toBe('any');
		expect(DEFAULT_FILTERS.includeShareAlike).toBe(false);
		// Describe (spec 12 P6-E14): the query goes as a description, untranslated and without q; off by default
		expect(DEFAULT_FILTERS.describe).toBe(false);
		expect(
			searchRequest(
				{ ...DEFAULT_FILTERS, describe: true, query: '  glass bottle shattering ' },
				{ limit: 1, offset: 0 },
			),
		).toEqual({ limit: 1, offset: 0, license: 'commercial-safe', describe: 'glass bottle shattering' });
		expect(
			searchRequest({ ...DEFAULT_FILTERS, describe: true, query: '   ' }, { limit: 1, offset: 0 }),
		).toEqual({
			limit: 1,
			offset: 0,
			license: 'commercial-safe',
		});
		expect(
			searchRequest({ ...DEFAULT_FILTERS, describe: true, query: 'x'.repeat(400) }, { limit: 1, offset: 0 })
				.describe,
		).toHaveLength(300);
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
		// ShareAlike (spec 12 P6-E13): flagged, and the title says what it asks of the video
		expect(licenseBadge({ license: 'CC-BY-SA-4.0', source: src })).toMatchObject({
			shareAlike: true,
			warn: false,
		});
		expect(licenseBadge({ license: 'CC-BY-SA-4.0', source: src }).title).toMatch(/shared under CC BY-SA/);
		expect(licenseBadge({ license: 'CC-BY-4.0', source: src }).shareAlike).toBeUndefined();
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
					// one assertion per run (an expect() per column made this property take > 15 s under load)
					expect(c.findIndex((v) => !(v >= 0 && v <= 1))).toBe(-1);
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

describe('timeline drop: the peak is the primary snap edge', () => {
	it('snaps the peak to the playhead first, the clip edges only when the peak finds nothing', () => {
		const { session, seqId } = makeSession();
		const seq = session.getCommitted().sequences[seqId] as Sequence;
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
		// Alt: the start (onset) is under the pointer, and the insert is asked for `start`
		const alt = resolveSoundDrop({ ...base, alt: true, pointerFrame: 50, playhead: null });
		expect(alt).toMatchObject({ align: 'start', request: 'start', cue: 50 });
		expect(alt.plan!.start + alt.plan!.alignOffsetFrames).toBeCloseTo(50, 6);
		expect(peak.request).toBe('auto');
		// a riser aligns its END under the pointer (its type's default), the insert decides by type too
		const riser = soundEntry({ types: ['riser'], peakSec: 1.9, durationSec: 2 });
		const r = resolveSoundDrop({ ...base, info: riser, snapping: false, pointerFrame: 120, playhead: null });
		expect(r).toMatchObject({ align: 'end', request: 'auto', cue: 120 });
		expect(r.plan!.start + r.plan!.frames).toBeGreaterThanOrEqual(120);
		expect(r.plan!.start + r.plan!.alignOffsetFrames).toBeCloseTo(
			120 + r.plan!.errorFlicks / flicksPerFrame(seq.settings.frameRate),
			6,
		);
		// unknown sound (another window): the pointer frame, no plan
		expect(resolveSoundDrop({ ...base, info: null, pointerFrame: 12, playhead: null })).toMatchObject({
			cue: 12,
			plan: null,
		});
	});
});
