// Stems in one pass (wp-note "Phase 5 → WP5.1"): every stem `renderStems` renders with shared decoders equals the export
// mixer's own render of the same clips (`renderMixdown({onlyClips})`) sample for sample, each clip is decoded once,
// and the Sound Check's delivered loudness equals the export's two-pass normalisation (`renderMixdown({normalize})`).
import { mkdtempSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mgRegistry } from '@jasper/mg-templates';
import { defaultRegistries, frameToSample, type Sequence } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderMixdown, WAV_F32_HEADER_BYTES } from '../src/audio/mixdown.ts';
import { audioWorld } from '../src/sound-design/bed.ts';
import { checkSequence } from '../src/sound-design/check.ts';
import { classifyStems, renderStems, STEM_NAMES } from '../src/sound-design/stems.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, makeApp, type TestApp } from './helpers.ts';
import { buildCheckDoc, type FixtureMedia, registerCheckMedia } from './sound-check-fixture.ts';

const TOKEN = 'tok_stems_0123456789abcdef012';
let app: TestApp;
let media: FixtureMedia;

beforeAll(async () => {
	app = await makeApp({ dev: false, token: TOKEN });
	media = await registerCheckMedia(app, mkdtempSync(join(tmpdir(), 'jasper-stems-')), TOKEN);
}, 180_000);
afterAll(closeApps);

describe('renderStems', { timeout: 600_000 }, () => {
	it('every stem equals renderMixdown of its clips; each clip is decoded once', async () => {
		const fx = buildCheckDoc(media);
		const doc = fx.doc();
		const seqId = Object.keys(doc.sequences)[0]!;
		const core = coreServices(app);
		const world = await audioWorld(doc, seqId, core.registry);
		const snap = world.snapshot;
		const sr = snap.audioMix!.sampleRate;
		const stems = classifyStems(
			doc.sequences[seqId] as Sequence,
			snap.audioClips.map((c) => c.clipId),
		);
		expect([...stems.sfx].sort()).toEqual([fx.ids.clipA, fx.ids.clipB, fx.ids.clipC].sort());
		expect([...stems.music]).toEqual([fx.ids.music]);
		expect([...stems.dialogue]).toEqual([fx.ids.speech]);
		expect(stems.bed.size).toBe(2);
		// 0.5 s … 9.5 s (a start that is not a block boundary, clips starting inside blocks)
		const start = frameToSample(15, snap.settings.fps, sr);
		const samples = frameToSample(285, snap.settings.fps, sr) - start;
		const got = STEM_NAMES.map(() => [new Float32Array(samples), new Float32Array(samples)]);
		const res = await renderStems({
			ff: core.ffmpeg,
			snapshot: snap,
			media: world.media,
			startSample: start,
			samples,
			stems: STEM_NAMES.map((s) => ({ name: s, clipIds: s === 'mix' ? null : stems[s] })),
			onBlock: (i, planar, n, at) => {
				for (let c = 0; c < 2; c++) got[i]![c]!.set(planar[c]!.subarray(0, n), at - start);
			},
		});
		expect(res.rendered).toEqual(['mix', 'sfx', 'dialogue', 'music', 'bed']);
		// five clips, each decoded once although the mix, its stem and the bed all play it
		expect(res.decoders).toBe(5);
		const scratch = mkdtempSync(join(tmpdir(), 'jasper-stems-ref-'));
		for (const [i, s] of STEM_NAMES.entries()) {
			if (s === 'ambience') continue;
			const r = await renderMixdown({
				ff: core.ffmpeg,
				snapshot: snap,
				media: world.media,
				range: { start: 15, end: 285 },
				outputLayout: 'stereo',
				scratchDir: scratch,
				withoutLoudness: true,
				...(s === 'mix' ? {} : { onlyClips: stems[s] }),
			});
			const buf = await readFile(r.path!);
			let maxErr = 0;
			let energy = 0;
			for (let k = 0; k < samples; k++)
				for (let c = 0; c < 2; c++) {
					const ref = buf.readFloatLE(WAV_F32_HEADER_BYTES + (k * 2 + c) * 4);
					maxErr = Math.max(maxErr, Math.abs(ref - got[i]![c]![k]!));
					energy += ref * ref;
				}
			expect(energy, s).toBeGreaterThan(0);
			expect(maxErr, s).toBe(0);
			await rm(r.path!, { force: true });
		}
	});

	it("the check's delivered loudness equals the export's two-pass normalisation", async () => {
		const fx = buildCheckDoc(media);
		const doc = fx.doc();
		const seq = doc.sequences[Object.keys(doc.sequences)[0]!] as Sequence;
		const core = coreServices(app);
		const scratch = mkdtempSync(join(tmpdir(), 'jasper-stems-norm-'));
		const report = await checkSequence(
			doc,
			seq,
			{ projectId: 'prj_0000000000000001', revision: null, preset: 'web' },
			{
				ff: core.ffmpeg,
				registry: core.registry,
				registries: defaultRegistries(mgRegistry),
				mgTemplates: mgRegistry,
				scratchDir: scratch,
			},
		);
		const world = await audioWorld(doc, seq.id, core.registry);
		const r = await renderMixdown({
			ff: core.ffmpeg,
			snapshot: world.snapshot,
			media: world.media,
			range: { start: 0, end: 300 },
			outputLayout: 'stereo',
			normalize: { targetLufs: -14, truePeakDb: -1 },
			scratchDir: scratch,
		});
		expect(report.loudness.integratedLufs).toBeCloseTo(r.loudness.integrated, 2);
		expect(report.loudness.truePeakDb).toBeCloseTo(r.loudness.truePeakDb, 2);
		expect(report.loudness.normalization.gainDb).toBeCloseTo(r.normalized!.gainDb, 2);
		expect(report.loudness.before.integratedLufs).toBeCloseTo(r.normalized!.before.integrated, 2);
		await rm(r.path!, { force: true });
	});

	it("with an export's AAC encoding the check delivers and judges exactly what that export does", async () => {
		const fx = buildCheckDoc(media);
		const doc = fx.doc();
		const seq = doc.sequences[Object.keys(doc.sequences)[0]!] as Sequence;
		const core = coreServices(app);
		const scratch = mkdtempSync(join(tmpdir(), 'jasper-stems-codec-'));
		const report = await checkSequence(
			doc,
			seq,
			{
				projectId: 'prj_0000000000000001',
				revision: null,
				preset: 'web',
				exportAudio: { codec: 'aac', bitrateKbps: 128 },
			},
			{
				ff: core.ffmpeg,
				registry: core.registry,
				registries: defaultRegistries(mgRegistry),
				mgTemplates: mgRegistry,
				scratchDir: scratch,
			},
		);
		const world = await audioWorld(doc, seq.id, core.registry);
		const r = await renderMixdown({
			ff: core.ffmpeg,
			snapshot: world.snapshot,
			media: world.media,
			range: { start: 0, end: 300 },
			outputLayout: 'stereo',
			normalize: { targetLufs: -14, truePeakDb: -1 },
			deliver: { codec: 'aac', bitrateKbps: 128, sampleRate: 48000, channels: 2 },
			scratchDir: scratch,
		});
		const d = r.normalized!.delivery;
		const n = report.loudness.normalization;
		expect(n.limiterCeilingDb).toBeCloseTo(d.params.ceilingDb, 2);
		expect(n.limiterCeilingDb).toBe(-2.5);
		expect(n.codecHeadroomDb).toBe(1.5);
		expect(n.gainDb).toBeCloseTo(d.params.gainDb, 2);
		expect(n.encodePasses).toBe(d.encodePasses);
		expect(n.localCorrections).toEqual({ count: d.corrections.hops, maxDb: Math.round(d.corrections.maxDb * 100) / 100 });
		// the decoded audio is what LOUDNESS / TRUE_PEAK judge, and it is the export's
		const del = report.loudness.delivered!;
		expect(del).toMatchObject({ codec: 'aac', bitrateKbps: 128, sampleRate: 48000, truePeakMet: true });
		expect(del.truePeakDb).toBeCloseTo(d.decoded!.truePeakDb, 2);
		expect(del.integratedLufs).toBeCloseTo(d.decoded!.integrated, 2);
		expect(del.truePeakDb!).toBeLessThanOrEqual(-1);
		expect(report.issues.some((i) => i.code === 'TRUE_PEAK')).toBe(false);
		expect(report.loudness.integratedLufs).toBeCloseTo(r.loudness.integrated, 2);
		await rm(r.path!, { force: true });
	});
});
