// Essential Sound Auto Tag on the engine (`POST /api/audio/classify`, spec 12 P6-R3; wp-note "Phase 6 → WP6.3"):
// the labelled accuracy table (real speech: the LJ Speech public-domain fixture as clips of one media; the 61 starter-kit
// effects; the synth kit; generated music, ambience and long effects — a "tuning" set the thresholds were chosen on and
// a "held-out" set of other seeds, rates, levels, lengths and noisy speech) with the confusion matrix printed and ≥ 90 %
// asserted on each; the route: clips through their media range, media keys, caching, the job, refusals, item errors,
// silence, long media (sampled windows).
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AudioClassifyResult, AudioClassifyResultSchema, type EngineJob } from '@jasper/api';
import { encodeWav } from '@jasper/audio-dsp';
import { renderSynth, SYNTH_RECIPES } from '@jasper/audio-fx';
import { appdirPaths } from '@jasper/config';
import { makeEnvelope, type ProjectDocument } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	ambienceSet,
	arpeggio,
	drumLoop,
	type Labelled,
	longSfxSet,
	melody,
	musicSet,
	padMusic,
	pianoProgression,
} from '../../../packages/audio-fx/test/category-fixtures.ts';
import { testMusic } from '../../../packages/audio-fx/test/music.ts';
import { coreServices } from '../src/tools/services.ts';
import {
	closeApps,
	DocBuilder,
	makeApp,
	ROOT,
	register,
	TEST_FFMPEG,
	TEST_HOST,
	type TestApp,
} from './helpers.ts';

const HAVE_FFMPEG = spawnSync(TEST_FFMPEG, ['-version'], { encoding: 'utf8' }).status === 0;
const JSON_H = { host: TEST_HOST, 'content-type': 'application/json' };
const LJ = join(ROOT, 'fixtures', 'speech', 'lj-composite.flac');
const LJ_TRUTH = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'speech', 'lj-composite.json'), 'utf8')) as {
	utterances: { start: number; end: number }[];
};
const KIT = join(ROOT, 'apps', 'engine', 'sounds', 'starter');
const CATS = ['dialogue', 'music', 'sfx', 'ambience'] as const;
type Cat = (typeof CATS)[number];

let app: TestApp;
let dir = '';
let projects = 0;

function decode(path: string, sr: number, ss: number, t: number): Float32Array {
	const r = spawnSync(
		TEST_FFMPEG,
		[
			'-v',
			'error',
			'-ss',
			String(ss),
			'-t',
			String(t),
			'-i',
			path,
			'-ac',
			'1',
			'-ar',
			String(sr),
			'-f',
			'f32le',
			'pipe:1',
		],
		{
			maxBuffer: 1 << 30,
		},
	);
	const b = r.stdout as Buffer;
	const out = new Float32Array(b.byteLength / 4);
	Buffer.from(out.buffer).set(b.subarray(0, out.length * 4));
	return out;
}

function seed(doc: ProjectDocument): string {
	const projectId = `prj_${(9000 + ++projects).toString().padStart(16, '0')}`;
	const file = appdirPaths(app.appdir).projectFile(projectId);
	mkdirSync(join(file, '..'), { recursive: true });
	writeFileSync(
		file,
		JSON.stringify(
			makeEnvelope(
				{ ...doc, projectId },
				{ revision: 1, savedAt: '2026-10-17T00:00:00.000Z', platform: 'test' },
			),
		),
	);
	return projectId;
}

async function post(url: string, body: unknown) {
	const r = await app.inject({ method: 'POST', url, headers: JSON_H, payload: JSON.stringify(body) });
	return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, unknown> };
}

async function classify(body: Record<string, unknown>): Promise<AudioClassifyResult> {
	const r = await post('/api/audio/classify', body);
	expect(r.status, JSON.stringify(r.body)).toBe(202);
	const job = await coreServices(app).queue.wait((r.body as unknown as EngineJob).id);
	expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
	return AudioClassifyResultSchema.parse(job.result);
}

function writeWav(name: string, ch: Float32Array[], sr: number): string {
	const f = join(dir, `${name.replace(/[^a-z0-9]+/gi, '-')}.wav`);
	writeFileSync(f, encodeWav(ch, sr, 's16'));
	return f;
}

const gain = (ch: Float32Array[], db: number) => ch.map((c) => c.map((v) => v * 10 ** (db / 20)));

type Case = { name: string; label: Cat; set: 'tuning' | 'held-out'; key?: string; clipId?: string };

function table(cases: Case[], got: Map<Case, Cat | null>) {
	const m: Record<string, Record<string, number>> = {};
	for (const a of CATS) m[a] = Object.fromEntries([...CATS, 'silent'].map((b) => [b, 0]));
	let ok = 0;
	for (const c of cases) {
		const g = got.get(c) ?? null;
		m[c.label]![g ?? 'silent']!++;
		if (g === c.label) ok++;
	}
	return { matrix: m, ok, n: cases.length, accuracy: ok / Math.max(1, cases.length) };
}

describe.skipIf(!HAVE_FFMPEG)('Auto Tag classification (engine)', () => {
	beforeAll(async () => {
		app = await makeApp();
		dir = mkdtempSync(join(tmpdir(), 'jasper-autotag-'));
	}, 120_000);
	afterAll(closeApps);

	it('labelled set: ≥ 90 % on the tuning and on the held-out set (confusion matrices printed)', {
		timeout: 1_800_000,
	}, async () => {
		const cases: Case[] = [];
		const files: { file: string; c: Case }[] = [];
		const add = (x: Labelled, set: Case['set'], name = x.name) =>
			files.push({ file: writeWav(`${set}-${name}`, x.channels, x.sr), c: { name, label: x.label, set } });
		// tuning set
		for (const f of readdirSync(KIT).filter((f) => f.endsWith('.ogg')))
			files.push({ file: join(KIT, f), c: { name: f, label: 'sfx', set: 'tuning' } });
		for (const r of SYNTH_RECIPES)
			for (const s of [0, 1]) {
				const x = renderSynth(r.id, s);
				add({ name: `${r.id}#${s}`, label: 'sfx', channels: x.channels, sr: x.sampleRate }, 'tuning');
			}
		for (const x of [...musicSet(44_100, 20), ...ambienceSet(48_000, 20), ...longSfxSet(48_000)])
			add(x, 'tuning');
		// held-out set: other seeds, tempi, rates, levels and lengths
		const m = (name: string, channels: Float32Array[], sr: number): Labelled => ({
			name,
			label: 'music',
			channels,
			sr,
		});
		for (const x of [
			m('band 105 BPM 45 s', testMusic(44_100, 105, 20, 7).audio, 44_100),
			m('band 76 BPM 8 s', testMusic(48_000, 76, 3, 8).audio, 48_000),
			m('band 160 BPM −24 dB', gain(testMusic(48_000, 160, 20, 9).audio, -24), 48_000),
			m('pad 30 s seed 5', padMusic(48_000, 30, 5), 48_000),
			m('arpeggio 90 BPM 22 kHz', arpeggio(22_050, 12, 90, 3), 22_050),
			m('melody seed 21', melody(48_000, 15, 21), 48_000),
			m('drums 140 BPM', drumLoop(48_000, 10, 140, 5), 48_000),
			m('piano seed 4', pianoProgression(44_100, 25, 4), 44_100),
		])
			add(x, 'held-out');
		for (const x of ambienceSet(44_100, 40))
			add({ ...x, channels: gain(x.channels, -12) }, 'held-out', `${x.name} 40 s`);
		for (const x of ambienceSet(22_050, 9).slice(0, 4)) add(x, 'held-out', `${x.name} 9 s`);
		for (const r of SYNTH_RECIPES) {
			const x = renderSynth(r.id, 5);
			add({ name: `${r.id}#5`, label: 'sfx', channels: x.channels, sr: x.sampleRate }, 'held-out');
		}
		for (const x of longSfxSet(44_100))
			add({ ...x, channels: gain(x.channels, -10) }, 'held-out', `${x.name} 44.1 kHz`);
		// noisy speech (air-conditioner noise at 20 / 10 dB SNR), 22.05 kHz
		const ac = ambienceSet(22_050, 10).find((x) => x.name === 'air conditioner')!.channels[0]!;
		const rms = (c: Float32Array) => Math.sqrt(c.reduce((a, b) => a + b * b, 0) / Math.max(1, c.length));
		LJ_TRUTH.utterances.forEach((u, i) => {
			if (i % 2) return;
			const v = decode(LJ, 22_050, Math.max(0, u.start - 0.5), u.end - u.start + 1);
			const snr = i % 4 === 0 ? 20 : 10;
			const g = (rms(v) / rms(ac)) * 10 ** (-snr / 20);
			const mix = v.map((s, k) => 0.25 * (s + g * ac[k % ac.length]!));
			add({ name: `speech ${i} SNR ${snr} dB`, label: 'dialogue', channels: [mix], sr: 22_050 }, 'held-out');
		});
		// register every file; speech as clips of the LJ media (the clip → media range path)
		for (const f of files) {
			const r = await register(app, f.file);
			f.c.key = r.mediaKey;
			cases.push(f.c);
		}
		const lj = await register(app, LJ);
		const b = new DocBuilder('hd-1080p-30', 900);
		const ljId = b.addMedia(lj);
		const ljCases: Case[] = [];
		let at = 0;
		const place = (inS: number, outS: number, name: string, set: Case['set']) => {
			const r = b.tx([
				{
					type: 'clip.place',
					source: { mediaId: ljId },
					sourceRange: { in: { seconds: inS }, out: { seconds: outS } },
					at,
					tracks: { audio: 'A1' },
					ref: '$c',
				},
			]);
			at += Math.ceil((outS - inS) * 30) + 30;
			ljCases.push({ name, label: 'dialogue', set, clipId: r.refs.$c! });
		};
		for (const [i, u] of LJ_TRUTH.utterances.entries())
			place(Math.max(0, u.start - 0.3), u.end + 0.3, `LJ utterance ${i}`, 'tuning');
		place(0, 30, 'LJ 0–30 s', 'tuning');
		place(30, 60, 'LJ 30–60 s', 'tuning');
		place(10, 70, 'LJ 10–70 s (60 s)', 'held-out');
		place(20, 34, 'LJ 20–34 s', 'held-out');
		const projectId = seed(b.doc);
		const got = new Map<Case, Cat | null>();
		const t0 = Date.now();
		const res = await classify({ mediaKeys: cases.map((c) => c.key!) });
		res.items.forEach((it, i) => {
			expect(it.error, it.name).toBeUndefined();
			got.set(cases[i]!, it.result?.category ?? null);
		});
		const clips = await classify({ projectId, clipIds: ljCases.map((c) => c.clipId!) });
		clips.items.forEach((it, i) => {
			expect(it.error, it.name).toBeUndefined();
			expect(it.currentType).toBeNull();
			got.set(ljCases[i]!, it.result?.category ?? null);
		});
		const all = [...cases, ...ljCases];
		const ms = Date.now() - t0;
		const report: Record<string, unknown> = { ms, items: all.length };
		for (const set of ['tuning', 'held-out'] as const) {
			const t = table(
				all.filter((c) => c.set === set),
				got,
			);
			report[set] = { accuracy: Math.round(t.accuracy * 1000) / 10, n: t.n, matrix: t.matrix };
			expect(t.accuracy, `${set}: ${JSON.stringify(t.matrix)}`).toBeGreaterThanOrEqual(0.9);
		}
		report.wrong = all
			.filter((c) => got.get(c) !== c.label)
			.map((c) => `${c.set} ${c.name}: ${c.label} → ${got.get(c)}`);
		console.log(`AUTO_TAG_ACCURACY ${JSON.stringify(report, null, 1)}`);
		if (process.env.AUTO_TAG_REPORT)
			writeFileSync(process.env.AUTO_TAG_REPORT, JSON.stringify(report, null, 2));
		// a second run is served from the cache
		const again = await classify({ mediaKeys: cases.slice(0, 20).map((c) => c.key!) });
		expect(again.items.every((i) => i.cached)).toBe(true);
	});

	it('route: clips, item errors, silence, long media windows, refusals', { timeout: 600_000 }, async () => {
		const silent = await register(app, writeWav('silence', [new Float32Array(48_000 * 3)], 48_000));
		const long = await register(app, writeWav('long-bed', ambienceSet(16_000, 150)[0]!.channels, 16_000));
		const vid = spawnSync(
			TEST_FFMPEG,
			['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=30:d=1', '-an', join(dir, 'pic.mp4')],
			{ encoding: 'utf8' },
		);
		expect(vid.status).toBe(0);
		const pic = await register(app, join(dir, 'pic.mp4'));
		const r = await classify({ mediaKeys: [silent.mediaKey, long.mediaKey, pic.mediaKey] });
		expect(r.items[0]!.result).toMatchObject({ category: null, silent: true, confidence: 0 });
		expect(r.items[1]!.result).toMatchObject({ category: 'ambience' });
		expect(r.items[1]!.result!.durationSec).toBeCloseTo(150, 0);
		expect(r.items[1]!.result!.analysedSec).toBeCloseTo(60, 0);
		expect(r.items[2]!.error!.code).toBe('NO_AUDIO_STREAM');
		expect(r.counts).toMatchObject({ ambience: 1, silent: 1, failed: 1 });
		// clips: the media range each plays; a video clip and an unknown id are item errors
		const b = new DocBuilder('hd-1080p-30', 901);
		const bed = b.addMedia(long);
		const pv = b.addMedia(pic);
		const c1 = b.tx([
			{
				type: 'clip.place',
				source: { mediaId: bed },
				sourceRange: { in: { seconds: 10 }, out: { seconds: 25 } },
				at: 0,
				tracks: { audio: 'A1' },
				ref: '$a',
			},
		]).refs.$a!;
		b.tx([{ type: 'essentialSound.setType', clipIds: [c1], audioType: 'sfx' }]);
		const v1 = b.tx([
			{ type: 'clip.place', source: { mediaId: pv }, at: 600, tracks: { video: 'V1' }, ref: '$v' },
		]).refs.$v!;
		const projectId = seed(b.doc);
		const c = await classify({ projectId, clipIds: [c1, v1, 'clp_nope'] });
		expect(c.items[0]).toMatchObject({
			clipId: c1,
			currentType: 'sfx',
			autoTagged: false,
			startSeconds: 10,
			result: { category: 'ambience' },
		});
		expect(c.items[0]!.durationSeconds).toBeCloseTo(15, 1);
		expect(c.items[1]!.error!.code).toBe('NOT_AUDIO');
		expect(c.items[2]!.error!.code).toBe('CLIP_NOT_FOUND');
		// the editor's way: wait=1 answers with the finished job
		const w = await app.inject({
			method: 'POST',
			url: '/api/audio/classify?wait=1',
			headers: JSON_H,
			payload: JSON.stringify({ projectId, clipIds: [c1] }),
		});
		expect(w.statusCode).toBe(200);
		expect(AudioClassifyResultSchema.parse((w.json() as EngineJob).result).items[0]!.cached).toBe(true);
		// refusals
		const bad = async (body: unknown) => (await post('/api/audio/classify', body)).status;
		expect(await bad({})).toBe(400);
		expect(await bad({ mediaKeys: [silent.mediaKey], clipIds: [c1], projectId })).toBe(400);
		expect(await bad({ clipIds: [c1] })).toBe(400);
		expect(await bad({ mediaKeys: ['../etc/passwd'] })).toBe(400);
		expect(await bad({ mediaKeys: [`mk_${'0'.repeat(24)}`] })).toBe(404);
		expect(await bad({ projectId: 'prj_9999999999999999', clipIds: [c1] })).toBe(404);
		expect(await bad({ projectId, sequenceId: 'seq_nope', clipIds: [c1] })).toBe(404);
		expect(await bad({ projectId, clipIds: ['clp_nope'] })).toBe(404);
		expect(await bad({ mediaKeys: Array(501).fill(silent.mediaKey) })).toBe(400);
	});
});
