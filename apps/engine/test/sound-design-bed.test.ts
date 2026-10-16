// Bed render and sound measurements for the masking solver (spec 12 §2.4, P4-R2; wp-note "Phase 4 → WP4.1b"), on a
// real engine with generated media: a music bed (A1), dialogue without a transcript (A2, speech from 4 s to 8 s) and
// placed sounds (a hero hit at 1 s, a support hit 0.1 s after it, a click under the speech at 5 s, a click at 9 s).
// Oracles: whole-sequence renders by the same export mixer — the bed is the mix with the SFX clips removed (measured
// only over cue clusters, it must equal the whole render over every window), and each sound alone at 0 dB equals its
// contribution to the full mix (full mix − mix without it) less its clip gain.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bandLevels, bedLocalPeakLu } from '@jasper/audio-fx';
import type { ProjectDocument } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	MeasureCache,
	type MeasureDeps,
	measureSfxEvents,
	renderSequencePcm,
	type SoundTarget,
} from '../src/sound-design/bed.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, DocBuilder, makeApp, register, type TestApp } from './helpers.ts';
import { provenance, writeBedFixture } from './sound-bed-fixture.ts';

let app: TestApp;
let deps: MeasureDeps;
let d: DocBuilder;
const ids: Record<string, string> = {};

/** The fixture project: music A1, dialogue A2, four placed sounds. */
async function buildDoc(a: TestApp): Promise<{ d: DocBuilder; ids: Record<string, string> }> {
	const files = writeBedFixture(mkdtempSync(join(tmpdir(), 'jasper-bed-')));
	const b = new DocBuilder('hd-1080p-30', 300);
	const music = b.addMedia(await register(a, files.music));
	const speech = b.addMedia(await register(a, files.speech));
	const hit = b.addMedia(await register(a, files.hit));
	const click = b.addMedia(await register(a, files.click));
	const out: Record<string, string> = {};
	const r = b.tx([
		{ type: 'clip.place', source: { mediaId: music }, at: 0, tracks: { audio: 'A1' }, ref: '$m' },
		{ type: 'clip.place', source: { mediaId: speech }, at: 0, tracks: { audio: 'A2' }, ref: '$s' },
		{ type: 'media.setLibraryInfo', mediaId: hit, library: provenance('hit') },
		{ type: 'media.setLibraryInfo', mediaId: click, library: provenance('click') },
	]);
	out.music = r.refs.$m!;
	out.speech = r.refs.$s!;
	b.tx([
		{ type: 'essentialSound.setType', clipIds: [out.music], audioType: 'music' },
		{ type: 'essentialSound.setType', clipIds: [out.speech], audioType: 'dialogue' },
	]);
	const place = (frame: number, mediaId: string, role: string, key: string, extra: object = {}) => {
		const p = b.tx([
			{ type: 'soundDesign.place', frame, layers: [{ mediaId, role, align: 'peak', ref: '$x', ...extra }] },
		]);
		out[key] = p.refs.$x!;
	};
	place(30, hit, 'hero', 'hero');
	place(33, hit, 'support', 'shadowed', { rate: 0.98, pan: -40 });
	place(150, click, 'support', 'inSpeech');
	place(270, click, 'support', 'clear', { gainDb: -6 });
	return { d: b, ids: out };
}

beforeAll(async () => {
	app = await makeApp();
	const core = coreServices(app);
	deps = { ff: core.ffmpeg, registry: core.registry, cache: new MeasureCache() };
	const built = await buildDoc(app);
	d = built.d;
	Object.assign(ids, built.ids);
}, 120_000);
afterAll(closeApps);

const without = (doc: ProjectDocument, seqId: string, drop: readonly string[]): ProjectDocument => {
	const seq = doc.sequences[seqId]!;
	return {
		...doc,
		sequences: {
			...doc.sequences,
			[seqId]: {
				...seq,
				clips: Object.fromEntries(Object.entries(seq.clips).filter(([id]) => !drop.includes(id))),
			},
		},
	};
};

const SFX = ['hero', 'shadowed', 'inSpeech', 'clear'] as const;
const WEIGHT: Record<(typeof SFX)[number], SoundTarget['weight']> = {
	hero: 'hero',
	shadowed: 'support',
	inSpeech: 'support',
	clear: 'support',
};

describe('bed render and sound measurements (real engine)', { timeout: 300_000 }, () => {
	it('the bed excludes every SFX clip and equals a whole-sequence render over each window; only clusters are rendered', async () => {
		const targets = SFX.map((k) => ({ doc: d.doc, clipId: ids[k]!, weight: WEIGHT[k] }));
		const m = await measureSfxEvents({ bedDoc: d.doc, sequenceId: d.seqId, targets }, deps);
		expect(m.missing).toEqual([]);
		expect(m.sounds.size).toBe(4);
		// Clusters: the hero's ±1 s around 1 s, the two clicks' ±0.15 s; never the whole 10 s.
		const total = m.clusters.reduce((n, c) => n + c.end - c.start, 0);
		expect(m.clusters.length).toBe(3);
		expect(total).toBeLessThan(6);
		expect(m.renders.bed).toBe(3);
		// Oracle: the whole sequence without its SFX clips, by the same mixer.
		const bedDoc = without(
			d.doc,
			d.seqId,
			SFX.map((k) => ids[k]!),
		);
		const whole = await renderSequencePcm(bedDoc, d.seqId, { start: 0, end: 320 }, null, deps);
		const sr = whole.sampleRate;
		for (const k of SFX) {
			const s = m.sounds.get(ids[k]!)!;
			const want = bandLevels(whole.channels, sr, s.window);
			s.bedBandsDb.forEach((v, i) => expect(Math.abs(v - want[i]!), `${k} band ${i}`).toBeLessThan(0.05));
			const lp = bedLocalPeakLu(whole.channels, sr, s.window, WEIGHT[k]);
			expect(Math.abs(s.bedLocalPeakLu! - lp), `${k} local peak`).toBeLessThan(0.05);
			// the bed is the music (pink noise ≈ −30 dBFS RMS, under −30 dB per octave band) plus the speech (1.5 kHz,
			// the 2 kHz band): never the sound effects (the hit reads ≈ −10 dB at 125 Hz)
			if (k === 'inSpeech') expect(s.bedBandsDb[4]!).toBeGreaterThan(-30);
			else expect(Math.max(...s.bedBandsDb)).toBeLessThan(-30);
		}
		// Bed tracks under each window; speech by voice activity on the untranscribed dialogue.
		expect(m.sounds.get(ids.hero!)!).toMatchObject({ speechOverlap: false, bedTracks: ['A1', 'A2'] });
		expect(m.sounds.get(ids.inSpeech!)!).toMatchObject({ speechOverlap: true, speechTracks: ['A2'] });
		expect(m.sounds.get(ids.clear!)!.speechOverlap).toBe(false);
	});

	it('each sound alone at 0 dB equals its contribution to the full mix less its gain (speed, pan, gain honoured)', async () => {
		const targets = SFX.map((k) => ({ doc: d.doc, clipId: ids[k]!, weight: WEIGHT[k] }));
		const m = await measureSfxEvents(
			{ bedDoc: d.doc, sequenceId: d.seqId, targets },
			{ ...deps, cache: new MeasureCache() },
		);
		const range = { start: 0, end: 320 };
		const full = await renderSequencePcm(d.doc, d.seqId, range, null, deps);
		const sr = full.sampleRate;
		for (const k of SFX) {
			const id = ids[k]!;
			const rest = await renderSequencePcm(without(d.doc, d.seqId, [id]), d.seqId, range, null, deps);
			const contribution = full.channels.map((c, ch) => c.map((x, i) => x - rest.channels[ch]![i]!));
			const s = m.sounds.get(id)!;
			const gain = d.doc.sequences[d.seqId]!.clips[id]!.gainDb as number;
			const want = bandLevels(contribution, sr, s.window);
			for (let i = 0; i < 7; i++) {
				if (want[i]! < -90) continue; // empty bands: quantisation noise of the difference
				expect(Math.abs(s.soundBandsDb[i]! + gain - want[i]!), `${k} band ${i}`).toBeLessThan(0.1);
			}
			// the active window lies inside the clip and starts after its lead silence
			const clip = d.doc.sequences[d.seqId]!.clips[id]!;
			expect(s.window.start).toBeGreaterThanOrEqual(clip.start / 30 - 1e-6);
			expect(s.window.end).toBeLessThanOrEqual((clip.start + clip.duration) / 30 + 0.5);
			expect(s.window.end - s.window.start).toBeGreaterThan(0.05);
			expect(s.truePeakDb).not.toBeNull();
		}
		// the click (3 kHz) is dominant in 2–4 kHz, the hit in 125 Hz
		const click = m.sounds.get(ids.clear!)!.soundBandsDb;
		expect(click.indexOf(Math.max(...click))).toBeGreaterThanOrEqual(4);
		const hit = m.sounds.get(ids.hero!)!.soundBandsDb;
		expect(hit.indexOf(Math.max(...hit))).toBeLessThanOrEqual(1);
	});

	it('a second measurement is served from the caches with the same result', async () => {
		const cache = new MeasureCache();
		const targets = SFX.map((k) => ({ doc: d.doc, clipId: ids[k]!, weight: WEIGHT[k] }));
		const a = await measureSfxEvents({ bedDoc: d.doc, sequenceId: d.seqId, targets }, { ...deps, cache });
		// a gain change does not change the bed or the sounds at 0 dB
		const changed = new DocBuilder();
		changed.doc = d.doc;
		changed.revision = d.revision;
		changed.tx([{ type: 'soundDesign.applyGains', gains: { [ids.hero!]: -12 } }]);
		const b = await measureSfxEvents(
			{ bedDoc: changed.doc, sequenceId: d.seqId, targets: targets.map((t) => ({ ...t, doc: changed.doc })) },
			{ ...deps, cache },
		);
		expect(b.renders).toMatchObject({ bed: 0, sound: 0 });
		expect(b.renders.cached).toBe(a.renders.bed + a.renders.sound);
		for (const [id, s] of a.sounds) expect(b.sounds.get(id)).toEqual(s);
	});

	it('reports sounds the mix does not play', async () => {
		const off = new DocBuilder();
		off.doc = d.doc;
		off.revision = d.revision;
		off.tx([{ type: 'clip.update', clipId: ids.clear!, patch: { enabled: false } }]);
		const m = await measureSfxEvents(
			{
				bedDoc: off.doc,
				sequenceId: d.seqId,
				targets: [{ doc: off.doc, clipId: ids.clear!, weight: 'support' }],
			},
			deps,
		);
		expect(m.sounds.size).toBe(0);
		expect(m.missing).toEqual([{ clipId: ids.clear, reason: expect.stringMatching(/not in the mix/) }]);
		expect(m.renders.bed).toBe(0);
	});
});
