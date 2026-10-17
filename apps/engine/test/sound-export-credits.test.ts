// spec 12 §2.11 (wp-note sound-design "Phase 6 → WP6.4"), on a real engine with generated media:
//   - the plan's W_SOUND_CREDITS (a CC BY sound heard without a credits sidecar; not when the range leaves it out, not
//     with a sidecar) and W_SOUND_CHECK_STALE (information: a stale or failed stored Sound Check);
//   - the export writes `<output>.credits.<txt|md|csv>` with the credits of what its mixer plays (range, nested
//     sequence, muted track and disabled clip left out), served by `/renders/:jobId/credits/:name`, copied next to the
//     destination file, listed in the job result with the warnings; no file when no library sound is heard;
//   - the oracle: the exported PCM of a mix with sound effects, the SFX Room (send + reverb), stop-before automation
//     and loudness normalisation equals the offline `renderMixdown` of the same snapshot, sample for sample (24-bit).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineJob, ExportSettings, RenderPlan } from '@jasper/api';
import { encodeWav } from '@jasper/audio-dsp';
import {
	type LibraryProvenance,
	mixFingerprint,
	soundCheckInputsHash,
	soundCredits,
	soundDesignSettingsOf,
} from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderMixdown, WAV_F32_HEADER_BYTES } from '../src/audio/mixdown.ts';
import { planExport } from '../src/export/planner.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, DocBuilder, JSON_H, makeApp, register, TEST_FFMPEG, type TestApp } from './helpers.ts';
import { hitSamples, provenance, SR, writeBedFixture } from './sound-bed-fixture.ts';

let app: TestApp;
let dir: string;
let files: ReturnType<typeof writeBedFixture>;
const FPS = 30;

const ccBy = (n: number, over: Partial<LibraryProvenance> = {}): LibraryProvenance => ({
	...provenance('hit', n),
	title: `Credited hit ${n}`,
	license: 'CC-BY-4.0',
	licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
	author: `Author ${n}`,
	attribution: `"Credited hit ${n}" by Author ${n} (CC BY 4.0)`,
	...over,
});

function settings(d: DocBuilder, over: Partial<ExportSettings> = {}): ExportSettings {
	return {
		sequenceId: d.seqId,
		destination: { type: 'download' },
		range: { type: 'entire' },
		container: 'mov',
		video: {
			codec: 'h264',
			width: 320,
			height: 180,
			frameRate: { num: FPS, den: 1 },
			scaling: 'fit',
			quality: { mode: 'crf', value: 35 },
			encoderSpeed: 'fast',
		},
		audio: { codec: 'pcm', sampleRate: SR, channels: 2 },
		engine: 'native',
		...over,
	};
}

async function plan(d: DocBuilder, over: Partial<ExportSettings> = {}): Promise<RenderPlan> {
	const r = await app.inject({
		method: 'POST',
		url: '/api/exports/plan',
		headers: JSON_H,
		payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d, over) },
	});
	expect(r.statusCode, r.body).toBe(200);
	return r.json() as RenderPlan;
}

async function exportJob(d: DocBuilder, over: Partial<ExportSettings> = {}) {
	const start = await app.inject({
		method: 'POST',
		url: '/api/exports',
		headers: JSON_H,
		payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d, over) },
	});
	expect(start.statusCode, start.body).toBe(202);
	const job = (await coreServices(app).queue.wait((start.json() as EngineJob).id)) as EngineJob;
	expect(job.error, JSON.stringify(job.error)).toBeUndefined();
	return job as EngineJob & {
		result: {
			credits?: { format: string; scope: string; count: number; name?: string; url?: string; path?: string };
			warnings?: { code: string; message: string; level?: string }[];
			path?: string;
		};
	};
}

/**
 * A1: music 0–10 s; A2: a CC BY hit at 1 s (frames 30–48) and a CC0-ish one at 6 s; A3 (muted): a CC BY hit at 3 s;
 * a disabled CC BY hit at 4 s on A2; A4: a nest at 7 s holding a CC BY hit.
 */
async function creditsDoc() {
	const d = new DocBuilder('hd-1080p-30', 600);
	const music = d.addMedia(await register(app, files.music));
	// each library sound is its own file (the same file registers once): the hit at a slightly different level
	let n = 0;
	const add = async (lib: LibraryProvenance) => {
		const g = 0.9 ** ++n;
		const path = join(dir, `hit-${n}-${Math.random().toString(36).slice(2)}.wav`);
		writeFileSync(path, encodeWav(hitSamples().map((c) => c.map((x) => x * g)), SR, 's16'));
		const m = d.addMedia(await register(app, path));
		d.tx([{ type: 'media.setLibraryInfo', mediaId: m, library: lib }]);
		return m;
	};
	const hitA = await add(ccBy(1));
	const own = await add({ ...provenance('hit', 2), title: 'Own hit 2' });
	const muted = await add(ccBy(3));
	const off = await add(ccBy(4));
	const nested = await add(ccBy(5, { license: 'CC-BY-SA-4.0', attribution: null }));
	const r = d.tx([
		{ type: 'clip.place', source: { mediaId: music }, at: 0, tracks: { audio: 'A1' } },
		{ type: 'track.add', kind: 'audio', count: 3 },
		{ type: 'clip.place', source: { mediaId: hitA }, at: 30, tracks: { audio: 'A2' }, ref: '$a' },
		{ type: 'clip.place', source: { mediaId: own }, at: 180, tracks: { audio: 'A2' } },
		{ type: 'clip.place', source: { mediaId: off }, at: 120, tracks: { audio: 'A2' }, ref: '$off' },
		{ type: 'clip.place', source: { mediaId: muted }, at: 90, tracks: { audio: 'A3' } },
		{ type: 'clip.place', source: { mediaId: nested }, at: 210, tracks: { audio: 'A4' }, ref: '$n' },
	]);
	d.tx([
		{ type: 'clip.update', clipId: r.refs.$off!, patch: { enabled: false } },
		{ type: 'track.update', trackId: 'A3', patch: { mute: true } },
		{ type: 'clip.nest', clipIds: [r.refs.$n!], name: 'Nested hit' },
	]);
	return { d, ids: { hitA, own, muted, off, nested } };
}

beforeAll(async () => {
	app = await makeApp();
	dir = mkdtempSync(join(tmpdir(), 'jasper-credits-'));
	files = writeBedFixture(dir);
}, 120_000);
afterAll(closeApps);

describe('export plan sound warnings (spec 12 §2.11)', { timeout: 300_000 }, () => {
	it('W_SOUND_CREDITS when a heard sound needs a credit and no sidecar is written; none with one or outside the range', async () => {
		const { d } = await creditsDoc();
		const p = await plan(d);
		const w = p.warnings.find((x) => x.code === 'W_SOUND_CREDITS');
		expect(w?.message).toMatch(/^2 sounds heard in this export need a credit \(CC-BY-4\.0, CC-BY-SA-4\.0/);
		expect(w?.level).toBeUndefined();
		expect((await plan(d, { credits: { sidecar: 'md' } })).warnings.map((x) => x.code)).not.toContain(
			'W_SOUND_CREDITS',
		);
		expect((await plan(d, { credits: { sidecar: null } })).warnings.map((x) => x.code)).toContain(
			'W_SOUND_CREDITS',
		);
		// frames 60–200: the first hit is over, the muted and the disabled ones are not heard, the nest starts at 210
		const mid = await plan(d, { range: { type: 'custom', startFrame: 60, endFrame: 200 } });
		expect(mid.warnings.map((x) => x.code)).not.toContain('W_SOUND_CREDITS');
		// a picture-only render (previews) has no sound to credit
		expect((await plan(d, { videoOnly: true })).warnings.map((x) => x.code)).not.toContain('W_SOUND_CREDITS');
	});

	it('W_SOUND_CHECK_STALE (info) for a stale or failed stored Sound Check, none for a current pass', async () => {
		const { d } = await creditsDoc();
		const preset = soundDesignSettingsOf(d.doc.sequences[d.seqId]!).delivery;
		const summary = (verdict: string) => ({
			mixHash: mixFingerprint(d.doc, d.seqId),
			verdict,
			counts: verdict === 'fail' ? { error: 2, OUT_OF_SYNC: 2 } : {},
			at: '2026-10-17T10:00:00.000Z',
			preset,
			inputsHash: soundCheckInputsHash(d.doc, d.seqId, preset),
		});
		d.tx([{ type: 'soundDesign.setCheck', summary: summary('pass') }]);
		expect((await plan(d)).warnings.map((x) => x.code)).not.toContain('W_SOUND_CHECK_STALE');
		d.tx([{ type: 'soundDesign.setCheck', summary: summary('fail') }]);
		let w = (await plan(d)).warnings.find((x) => x.code === 'W_SOUND_CHECK_STALE');
		expect(w).toMatchObject({ level: 'info' });
		expect(w!.message).toBe(
			'The last Sound Check of this sequence failed (2 errors): review its findings before delivering',
		);
		d.tx([{ type: 'soundDesign.setCheck', summary: summary('pass') }]);
		d.tx([{ type: 'track.update', trackId: 'A1', patch: { volumeDb: -3 } }]);
		w = (await plan(d)).warnings.find((x) => x.code === 'W_SOUND_CHECK_STALE');
		expect(w).toMatchObject({ level: 'info' });
		expect(w!.message).toMatch(/out of date \(the mix changed since\)/);
	});
});

describe('the credits sidecar (spec 12 §2.11)', { timeout: 600_000 }, () => {
	it('writes the credits of what the export plays (Markdown), serves it and lists it in the result', async () => {
		const { d } = await creditsDoc();
		const job = await exportJob(d, { credits: { sidecar: 'md' } });
		const c = job.result.credits!;
		expect(c).toMatchObject({ format: 'md', scope: 'all', count: 3, name: 'output.credits.md' });
		expect(job.result.warnings?.map((w) => w.code) ?? []).not.toContain('W_SOUND_CREDITS');
		const r = await app.inject({ method: 'GET', url: c.url!, headers: JSON_H });
		expect(r.statusCode).toBe(200);
		const text = r.body;
		expect(text.split('\n')[0]).toBe('## Sound credits');
		expect(text).toContain('"Credited hit 1" by Author 1 (CC BY 4.0)');
		expect(text).toContain('Credited hit 5');
		expect(text).toContain('Own hit 2');
		// muted track and disabled clip: not heard, not credited
		expect(text).not.toContain('Credited hit 3');
		expect(text).not.toContain('Credited hit 4');
		// the whole-project credits list those too (File ▸ Export ▸ Sound Credits…)
		expect(soundCredits(d.doc, d.seqId).rows).toHaveLength(5);
		// hostile names are not served
		for (const bad of ['..%2Foutput.credits.md', 'output.credits.exe', 'output.mov', 'x.credits.md'])
			expect(
				(await app.inject({ method: 'GET', url: `/renders/${job.id}/credits/${bad}`, headers: JSON_H }))
					.statusCode,
			).toBe(404);
	});

	it('TXT and CSV, only-attribution scope, range-restricted, next to a destination file without overwriting', async () => {
		const { d } = await creditsDoc();
		const out = join(dir, 'dest', 'cut.mov');
		const job = await exportJob(d, {
			credits: { sidecar: 'txt', scope: 'attribution' },
			range: { type: 'custom', startFrame: 0, endFrame: 200 },
			destination: { type: 'path', path: out },
		});
		expect(job.result.credits).toMatchObject({ format: 'txt', scope: 'attribution', count: 1 });
		// the video's extension is the container's (MOV, or MP4 when the H.264 encoder writes MP4); the credits follow
		// its name
		expect(job.result.path!.replace(/\.(mov|mp4)$/, '')).toBe(join(dir, 'dest', 'cut'));
		expect(job.result.credits!.path).toBe(join(dir, 'dest', 'cut.credits.txt'));
		expect(readFileSync(join(dir, 'dest', 'cut.credits.txt'), 'utf8')).toBe(
			'Sound credits\n\n"Credited hit 1" by Author 1 (CC BY 4.0)\n',
		);
		// again: the video and its credits get " (2)", nothing is overwritten
		const again = await exportJob(d, {
			credits: { sidecar: 'csv' },
			range: { type: 'custom', startFrame: 0, endFrame: 200 },
			destination: { type: 'path', path: out },
		});
		expect(again.result.path!.replace(/\.(mov|mp4)$/, '')).toBe(join(dir, 'dest', 'cut (2)'));
		expect(again.result.credits!.path).toBe(join(dir, 'dest', 'cut (2).credits.csv'));
		const csv = readFileSync(again.result.credits!.path!, 'utf8').trimEnd().split('\r\n');
		expect(csv[0]).toBe(
			'mediaId,soundId,title,author,license,licenseUrl,sourceUrl,attribution,requiresAttribution,usedIn',
		);
		expect(csv.slice(1).map((l) => l.split(',')[2])).toEqual(['Credited hit 1', 'Own hit 2']);
		expect(existsSync(join(dir, 'dest', 'cut.credits.txt'))).toBe(true);
	});

	it('no file when no library sound is heard; the result says so and repeats the sound warnings', async () => {
		const { d } = await creditsDoc();
		const preset = soundDesignSettingsOf(d.doc.sequences[d.seqId]!).delivery;
		d.tx([
			{
				type: 'soundDesign.setCheck',
				summary: {
					mixHash: 'stale',
					verdict: 'pass',
					counts: {},
					at: '2026-10-17T10:00:00.000Z',
					preset,
				},
			},
		]);
		const job = await exportJob(d, {
			credits: { sidecar: 'md' },
			range: { type: 'custom', startFrame: 60, endFrame: 90 },
		});
		expect(job.result.credits).toEqual({ format: 'md', scope: 'all', count: 0 });
		expect(job.result.warnings?.find((w) => w.code === 'W_SOUND_CHECK_STALE')).toMatchObject({ level: 'info' });
		const none = await app.inject({
			method: 'GET',
			url: `/renders/${job.id}/credits/output.credits.md`,
			headers: JSON_H,
		});
		expect(none.statusCode).toBe(404);
		// without a sidecar the result carries W_SOUND_CREDITS
		const plain = await exportJob(d, { range: { type: 'custom', startFrame: 0, endFrame: 90 } });
		expect(plain.result.credits).toBeUndefined();
		expect(plain.result.warnings?.map((w) => w.code)).toContain('W_SOUND_CREDITS');
	});
});

describe('oracle: exported mix = offline render (spec 12 §2.11)', { timeout: 600_000 }, () => {
	it('SFX + SFX Room + stop-before automation + normalisation: the exported PCM equals renderMixdown', async () => {
		const d = new DocBuilder('hd-1080p-30', 900);
		const music = d.addMedia(await register(app, files.music));
		const hit = d.addMedia(await register(app, files.hit));
		const click = d.addMedia(await register(app, files.click));
		d.tx([
			{ type: 'media.setLibraryInfo', mediaId: hit, library: provenance('hit') },
			{ type: 'media.setLibraryInfo', mediaId: click, library: { ...provenance('click'), types: ['click'] } },
		]);
		const r = d.tx([
			{ type: 'clip.place', source: { mediaId: music }, at: 0, tracks: { audio: 'A1' }, ref: '$m' },
			{ type: 'essentialSound.setType', clipIds: ['$m'], audioType: 'music' },
			{ type: 'track.add', kind: 'audio', count: 2 },
			{
				type: 'soundCue.add',
				cues: [
					{
						frame: 150,
						kind: 'land',
						weight: 'hero',
						source: 'user',
						stopBefore: { seconds: 0.25, depthDb: -18 },
						ref: '$c',
					},
				],
			},
		]);
		d.tx([
			{ type: 'soundDesign.place', cueId: r.refs.$c!, layers: [{ mediaId: hit, track: 'A2', role: 'hero' }] },
			{ type: 'soundDesign.place', frame: 240, layers: [{ mediaId: click, track: 'A3' }] },
		]);
		d.tx([
			{ type: 'soundDesign.applyStopBefore', cueId: r.refs.$c! },
			{ type: 'soundDesign.ensureBus', roomGlue: { sendDb: -12, decay: 0.8 } },
			{ type: 'mixer.setLoudness', enabled: true, targetLufs: -16, truePeakDb: -1 },
		]);
		const seq = d.doc.sequences[d.seqId]!;
		expect(seq.submixTracks).toHaveLength(1);
		expect(seq.audioTracks[0]!.volumeDb.keyframes.length).toBeGreaterThan(0);
		const s = settings(d, { range: { type: 'custom', startFrame: 15, endFrame: 285 } });
		// 24-bit PCM is written into MOV: ProRes keeps the container MOV whatever H.264 encoder this ffmpeg has
		s.video = { ...s.video!, codec: 'prores' };
		const job = await exportJob(d, s);
		const file = (await coreServices(app).exports.outputFile(job.id))!;
		const dec = spawnSync(
			TEST_FFMPEG,
			['-v', 'error', '-i', file, '-vn', '-map', '0:a:0', '-f', 'f32le', '-acodec', 'pcm_f32le', '-'],
			{ maxBuffer: 256 * 1024 * 1024 },
		);
		expect(dec.status, String(dec.stderr)).toBe(0);
		const exported = new Float32Array(dec.stdout.buffer.slice(dec.stdout.byteOffset, dec.stdout.byteOffset + dec.stdout.byteLength));

		// the offline render of the same plan (the mixer the Program monitor's mix is compared with in Phase 4)
		const core = coreServices(app) as unknown as { registry: never; fonts: never; ffmpeg: never };
		const planned = await planExport(
			{ envelope: d.envelope() as never, sequenceId: d.seqId, settings: s },
			{
				registry: core.registry,
				fonts: core.fonts,
				capabilities: { native: true, remotionLocal: 'unavailable', fframes: 'unavailable', mgMasters: false },
			},
		);
		const sr = planned.snapshot.audioMix!.sampleRate;
		const mix = await renderMixdown({
			ff: core.ffmpeg,
			snapshot: planned.snapshot,
			media: (id) => {
				const m = planned.media[id];
				return m
					? { path: m.path, streams: m.record.probe.streams.filter((x) => x.type === 'audio') as never }
					: null;
			},
			range: planned.range,
			length: Math.round(planned.output.durationSec * sr),
			outputLayout: 'stereo',
			normalize: planned.output.normalize,
			scratchDir: mkdtempSync(join(tmpdir(), 'jasper-oracle-')),
		});
		expect(mix.normalized).toBeDefined();
		const wav = await readFile(mix.path!);
		const offline = new Float32Array(
			wav.buffer.slice(wav.byteOffset + WAV_F32_HEADER_BYTES, wav.byteOffset + wav.byteLength),
		);
		expect(exported.length).toBe(offline.length);
		expect(exported.length).toBe(2 * 9 * sr);
		let maxDiff = 0;
		let energy = 0;
		for (let i = 0; i < offline.length; i++) {
			maxDiff = Math.max(maxDiff, Math.abs(exported[i]! - offline[i]!));
			energy += offline[i]! * offline[i]!;
		}
		// 24-bit PCM: one step is 2^-23; the rest must be identical
		expect(maxDiff, `max |Δ| ${maxDiff}`).toBeLessThanOrEqual(2 ** -23 + 1e-9);
		expect(Math.sqrt(energy / offline.length)).toBeGreaterThan(0.01);
		// the hit (with its room tail) is in it: 4.5–5.6 s of the sequence = 4.0–5.1 s of the export
		const at = (sec: number) => 2 * Math.round((sec - 0.5) * sr);
		let hitPeak = 0;
		for (let i = at(5); i < at(5.2); i++) hitPeak = Math.max(hitPeak, Math.abs(offline[i]!));
		let dip = 0;
		for (let i = at(4.8); i < at(4.95); i++) dip = Math.max(dip, Math.abs(offline[i]!));
		expect(hitPeak).toBeGreaterThan(dip * 2);
		expect(Math.abs(mix.loudness.integrated - -16)).toBeLessThan(1);
	});
});
