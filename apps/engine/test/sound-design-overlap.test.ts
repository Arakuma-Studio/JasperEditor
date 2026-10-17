// Overlapping sound effects through the real export mixer (spec 12 §2.4; wp-note "WP6.5b solver"): two heroes that
// overlap over a loud music bed, and an ambience (rain) under them. Measured with the bed render and the solo renders
// (`measureSfxEvents`), solved (`solveAt`, web delivery: −1 dBTP), the gains applied with `soundDesign.applyGains`, then
// rendered by the same mixer: (1) every sound effect together (the bed muted) has a BS.1770-4 true peak under the
// ceiling — each hero alone may sit at −1 dBTP, their sum may not; (2) each hero clears the bed AND the rain under it
// by the lift the solver reports (the rain counts in the hero's bed).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeWav } from '@jasper/audio-dsp';
import { bandLevels, OCTAVE_BAND_CENTRES_HZ } from '@jasper/audio-fx';
import type { LibraryProvenance, ProjectDocument } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MeasureCache, type MeasureDeps, measureSfxEvents, renderSequencePcm } from '../src/sound-design/bed.ts';
import { levelOptions, sfxInfoOf, solveAt, solverEventOf } from '../src/sound-design/levels.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, DocBuilder, makeApp, register, type TestApp } from './helpers.ts';
import { musicSamples, provenance, SR, writeBedFixture } from './sound-bed-fixture.ts';

let app: TestApp;
let deps: MeasureDeps;
let d: DocBuilder;
const ids: Record<string, string> = {};

const rainProvenance = (): LibraryProvenance => ({
	...provenance('hit', 7),
	soundId: 'snd_00000000000a0001',
	title: 'Test rain',
	types: ['ambience'],
	descriptors: {
		...(provenance('hit', 7).descriptors as object),
		durationSec: 3,
		octaveBandsDb: [-36, -38, -40, -42, -44, -46, -48],
		maxMomentaryLufs: -26,
		truePeakDb: -18,
	} as LibraryProvenance['descriptors'],
});

beforeAll(async () => {
	app = await makeApp();
	const core = coreServices(app);
	deps = { ff: core.ffmpeg, registry: core.registry, cache: new MeasureCache() };
	const dir = mkdtempSync(join(tmpdir(), 'jasper-overlap-'));
	const files = writeBedFixture(dir);
	const rainFile = join(dir, 'rain.wav');
	writeFileSync(rainFile, encodeWav(musicSamples(3).map((c) => c.map((x) => x * 0.6)), SR, 's16'));
	const b = new DocBuilder('hd-1080p-30', 300);
	const music = b.addMedia(await register(app, files.music));
	const hit = b.addMedia(await register(app, files.hit));
	const rain = b.addMedia(await register(app, rainFile));
	const r = b.tx([
		{ type: 'clip.place', source: { mediaId: music }, at: 0, tracks: { audio: 'A1' }, ref: '$m' },
		{ type: 'media.setLibraryInfo', mediaId: hit, library: provenance('hit') },
		{ type: 'media.setLibraryInfo', mediaId: rain, library: rainProvenance() },
	]);
	ids.music = r.refs.$m!;
	// a loud bed (+20 dB on the music): the heroes want more than their headroom
	b.tx([
		{ type: 'essentialSound.setType', clipIds: [ids.music], audioType: 'music' },
		{ type: 'audio.setGain', clipIds: [ids.music], mode: 'set', db: 20 },
	]);
	const place = (frame: number, mediaId: string, role: string, key: string) => {
		ids[key] = b.tx([
			{ type: 'soundDesign.place', frame, layers: [{ mediaId, role, align: 'peak', ref: '$x' }] },
		]).refs.$x!;
	};
	place(20, rain, 'support', 'rain'); // typed ambience: an ambient weight whatever its role
	place(45, hit, 'hero', 'h1');
	place(49, hit, 'hero', 'h2'); // 0.13 s later: the two hits overlap
	d = b;
}, 120_000);
afterAll(closeApps);

const SFX = ['rain', 'h1', 'h2'] as const;

describe('overlapping sound effects on the real mixer', { timeout: 300_000 }, () => {
	it('the summed true peak of the overlapping heroes stays under the ceiling; the rain counts in their bed', async () => {
		const seq = d.doc.sequences[d.seqId]!;
		const infos = SFX.map((k) => sfxInfoOf(d.doc, seq, ids[k]!, 'web')!);
		expect(infos.map((i) => i.weight)).toEqual(['ambient', 'hero', 'hero']);
		const m = await measureSfxEvents(
			{
				bedDoc: d.doc,
				sequenceId: d.seqId,
				targets: infos.map((i) => ({ doc: d.doc, clipId: i.clipId, weight: i.weight })),
			},
			deps,
		);
		expect(m.missing).toEqual([]);
		const events = infos.map((i) => solverEventOf(i, m.sounds.get(i.clipId)!));
		expect(events.every((e) => e.energyProfile?.length === 33 && e.peakProfileDb?.length === 32)).toBe(true);
		const solved = solveAt(events, 'web');
		const ceiling = levelOptions('web').truePeakCeilingDb;
		expect(ceiling).toBe(-1);
		expect(solved.warnings.filter((w) => w.code === 'W_UNRESOLVED' || w.code === 'W_UNCONVERGED')).toEqual([]);
		const by = (k: (typeof SFX)[number]) => solved.events.find((e) => e.clipId === ids[k])!;
		// alone each hero would sit at its own headroom; together they share it
		for (const k of ['h1', 'h2'] as const) {
			expect(by(k).limitedBy, k).toContain('overlap-headroom');
			expect(by(k).maskedBy, k).toEqual([ids.rain]);
		}
		console.log(
			SFX.map(
				(k) =>
					`${k}: ${by(k).gainDb} dB, TP ${by(k).truePeakDb} (sum ${by(k).overlapTruePeakDb}) dBTP, lift ${by(k).achievedLiftDb} (masking +${by(k).sfxMaskingDb}) — ${by(k).reason}`,
			).join('\n'),
		);

		// apply the gains and render through the export mixer
		const applied = new DocBuilder();
		applied.doc = d.doc;
		applied.revision = d.revision;
		applied.tx([{ type: 'soundDesign.applyGains', gains: solved.gains }]);
		const range = { start: 0, end: 130 };
		const sfxOnly = await renderSequencePcm(applied.doc, d.seqId, range, new Set(SFX.map((k) => ids[k]!)), deps);
		console.log(`sound effects together: true peak ${sfxOnly.truePeakDb?.toFixed(2)} dBTP`);
		expect(sfxOnly.truePeakDb).not.toBeNull();
		expect(sfxOnly.truePeakDb!).toBeLessThanOrEqual(ceiling + 0.05);
		// before (each hero against its own ceiling): the same heroes at their per-event headroom sum over it
		const perEvent = Object.fromEntries(
			['h1', 'h2'].map((k) => [ids[k]!, Math.min(12, ceiling - m.sounds.get(ids[k]!)!.truePeakDb!)]),
		);
		const loud = new DocBuilder();
		loud.doc = applied.doc;
		loud.revision = applied.revision;
		loud.tx([{ type: 'soundDesign.applyGains', gains: perEvent }]);
		const both = await renderSequencePcm(loud.doc, d.seqId, range, new Set([ids.h1!, ids.h2!]), deps);
		console.log(`the heroes at their per-event headroom: true peak ${both.truePeakDb?.toFixed(2)} dBTP`);
		expect(both.truePeakDb!).toBeGreaterThan(ceiling + 0.5);

		// each hero's lift over the bed + the rain, measured on renders: hero alone vs the bed with the rain
		const without = (doc: ProjectDocument, keep: Set<string>) =>
			renderSequencePcm(doc, d.seqId, range, keep, deps);
		const maskedBed = await without(applied.doc, new Set([ids.music!, ids.rain!]));
		for (const k of ['h1', 'h2'] as const) {
			const r = by(k);
			const sound = await without(applied.doc, new Set([ids[k]!]));
			const w = m.sounds.get(ids[k]!)!.window;
			const rel = { start: w.start - range.start / 30, end: w.end - range.start / 30 };
			const dom = r.dominantBands.map((hz) => OCTAVE_BAND_CENTRES_HZ.indexOf(hz));
			const e = (bands: number[]) => 10 * Math.log10(dom.reduce((s, b) => s + 10 ** (bands[b]! / 10), 0));
			const lift = e(bandLevels(sound.channels, sound.sampleRate, rel)) - e(bandLevels(maskedBed.channels, maskedBed.sampleRate, rel));
			console.log(`${k}: lift over bed + rain measured ${lift.toFixed(2)} dB, reported ${r.achievedLiftDb}`);
			expect(Math.abs(lift - r.achievedLiftDb!), k).toBeLessThan(0.5);
		}
	});
});
