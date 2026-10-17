// Takes in the engine's sound library (spec 12 P6-E9; wp-note "Phase 6 → WP-E5"): a user folder of generated
// multi-hit recordings is indexed; the index splits them into takes with their own descriptors and judge, search
// offers the clean ones as rows (`takes=true`) and counts them on their recording (`takeCount`), a take id works on
// every sound route (entry, visual data, audio, register), registering a take copies exactly its range (with the lead
// and trailing silence of any library sound), and a take placed on a cue peaks on the cue frame in the EXPORTED audio.
// Also: materials and the material filter, the index stays deterministic, an index written before takes loads.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	type EngineJob,
	RegisterSoundResponseSchema,
	type SoundEntry,
	SoundEntrySchema,
	SoundIndexResultSchema,
	SoundSearchResponseSchema,
	SoundVisualSchema,
} from '@jasper/api';
import { analyzeSound } from '@jasper/audio-fx';
import { encodeWav } from '@jasper/audio-dsp';
import { appdirPaths } from '@jasper/config';
import { frameToSample, parseTakeId, takeIdOf } from '@jasper/project';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { entryTakes, pruneSoundCache } from '../src/sounds/index-job.ts';
import { takeRange } from '../src/sounds/service.ts';
import { takeVisualCacheFile } from '../src/sounds/visual.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, DocBuilder, H, JSON_H, makeApp, TEST_FFMPEG, tempAppdir } from './helpers.ts';
import { makeStarter } from './sound-fixtures.ts';

const SR = 48_000;
const ENV_KEYS = [
	'JASPER_SOUND_STARTER_DIR',
	'JASPER_SOUND_SYNTH_VARIANTS',
	'JASPER_SOUND_AUTO_INDEX',
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

/** LCG noise in [-1, 1). */
function rng(seed: number) {
	let s = seed >>> 0 || 1;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 0x80000000 - 1;
	};
}

/** Adds a click (noise + 3 kHz under an exponential decay τ) at sample `at`. */
function addClick(x: Float32Array, at: number, amp: number, tauMs: number, lenMs: number, seed: number) {
	const r = rng(seed);
	const tau = (tauMs / 1000) * SR;
	const len = Math.round((lenMs / 1000) * SR);
	for (let i = 0; i < len && at + i < x.length; i++)
		x[at + i] = x[at + i]! + amp * Math.exp(-i / tau) * (0.6 * r() + 0.4 * Math.sin((2 * Math.PI * 3000 * i) / SR));
}

/** Keyboard typing: 8 key presses 0.5 s apart (a down-stroke, an up-stroke 80 ms later), over a −70 dBFS floor. */
function typing(): Float32Array {
	const r = rng(77);
	const x = Float32Array.from({ length: Math.round(4.6 * SR) }, () => 3e-4 * r());
	for (let k = 0; k < 8; k++) {
		const down = Math.round((0.25 + k * 0.5) * SR);
		addClick(x, down, 0.6, 5, 60, 200 + k);
		addClick(x, down + Math.round(0.08 * SR), 0.3, 4, 60, 300 + k);
	}
	return x;
}

/** Ten wooden clicks separated by digital silence, then an eleventh cut off by the end of the file. */
function clickPack(): Float32Array {
	const x = new Float32Array(Math.round(4.2 * SR));
	for (let k = 0; k < 10; k++) addClick(x, Math.round((0.2 + k * 0.36) * SR), 0.6, 4, 60, 100 + k);
	addClick(x, x.length - Math.round(0.05 * SR), 0.6, 300, 2000, 999);
	return x;
}

/** A whoosh that swells twice (two onsets; not a single-hit type: no takes). */
function whoosh(): Float32Array {
	const r = rng(5);
	const n = Math.round(1.6 * SR);
	return Float32Array.from({ length: n }, (_, i) => 0.4 * r() * Math.sin((Math.PI * 2 * i) / n) ** 2);
}

/** Interleaved f32 samples of a file's first audio stream. */
function decodeF32(file: string, channels = 1): Float32Array {
	const out = execFileSync(TEST_FFMPEG, [
		'-v',
		'error',
		'-i',
		file,
		'-map',
		'0:a:0',
		'-ac',
		String(channels),
		'-f',
		'f32le',
		'-',
	]);
	return new Float32Array(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
}

let app: FastifyInstance;
let appdir = '';
let folder = '';
let projectId = '';
const files = { typing: '', clicksWav: '', clicks: '', whoosh: '' };

async function waitJob(id: string): Promise<EngineJob> {
	return coreServices(app).queue.wait(id);
}

async function index(body: Record<string, unknown> = {}) {
	const r = await app.inject({ method: 'POST', url: '/api/sounds/index', headers: JSON_H, payload: body });
	expect(r.statusCode).toBe(202);
	const job = await waitJob((r.json() as EngineJob).id);
	expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
	return SoundIndexResultSchema.parse(job.result);
}

async function search(qs: string) {
	const r = await app.inject({ method: 'GET', url: `/api/sounds?${qs}`, headers: H });
	expect(r.statusCode, r.body).toBe(200);
	return SoundSearchResponseSchema.parse(r.json());
}

async function getSound(id: string): Promise<SoundEntry> {
	const r = await app.inject({ method: 'GET', url: `/api/sounds/${id}`, headers: H });
	expect(r.statusCode, r.body).toBe(200);
	return SoundEntrySchema.parse(r.json());
}

async function recording(title: string): Promise<SoundEntry> {
	const s = await search('sources=folder&license=any&limit=100');
	const row = s.results.find((r) => r.sound.title === title);
	if (!row) throw new Error(`no ${title}: ${s.results.map((r) => r.sound.title).join(', ')}`);
	return getSound(row.sound.id);
}

beforeAll(async () => {
	process.env.JASPER_SOUND_STARTER_DIR = makeStarter(tempAppdir('jasper-takes-starter-'));
	process.env.JASPER_SOUND_SYNTH_VARIANTS = '0';
	process.env.JASPER_SOUND_AUTO_INDEX = '0';
	appdir = tempAppdir('jasper-takes-app-');
	app = await makeApp({ appdir });
	folder = tempAppdir('jasper-takes-sfx-');
	mkdirSync(join(folder, 'Takes'), { recursive: true });
	const t = typing();
	files.typing = join(folder, 'Takes', 'keyboard typing.wav');
	writeFileSync(files.typing, encodeWav([t, t], SR, 's16'));
	const c = clickPack();
	files.clicksWav = join(folder, 'Takes', 'wooden clicks.wav');
	writeFileSync(files.clicksWav, encodeWav([c], SR, 's16'));
	// the same clicks as FLAC (a non-PCM decoder: the take range is cut from the full decode)
	files.clicks = join(folder, 'Takes', 'wooden clicks flac.flac');
	execFileSync(TEST_FFMPEG, ['-v', 'error', '-y', '-i', files.clicksWav, '-c:a', 'flac', files.clicks]);
	const w = whoosh();
	files.whoosh = join(folder, 'Takes', 'air whoosh.wav');
	writeFileSync(files.whoosh, encodeWav([w], SR, 's16'));
	// hostile files: one sample, all silence
	writeFileSync(join(folder, 'Takes', 'one sample click.wav'), encodeWav([new Float32Array([0.5])], SR, 's16'));
	writeFileSync(join(folder, 'Takes', 'silent clicks.wav'), encodeWav([new Float32Array(SR)], SR, 's16'));
	const put = await app.inject({
		method: 'PUT',
		url: '/api/sounds/roots',
		headers: JSON_H,
		payload: { roots: [{ path: folder, license: 'CC0-1.0' }] },
	});
	expect(put.statusCode, put.body).toBe(200);
	const job = await waitJob((put.json() as { job: EngineJob }).job.id);
	expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
	const created = await app.inject({
		method: 'POST',
		url: '/api/projects',
		headers: JSON_H,
		payload: { name: 'Takes', preset: 'hd-1080p-30' },
	});
	projectId = (created.json() as { projectId: string }).projectId;
}, 300_000);

afterAll(async () => {
	await closeApps();
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

describe('indexing splits multi-hit recordings into takes', { timeout: 300_000 }, () => {
	it('a typing run gives 8 joined key presses, each judged as one key (the recording stays multi-hit)', async () => {
		const e = await recording('keyboard typing');
		expect(e.types[0]).toBe('key');
		expect(e.judge?.reasons).toContain('multi-hit');
		expect(e.takes).toHaveLength(8);
		for (const t of e.takes!) {
			expect(t.flags).toEqual([]);
			expect(t.strokes).toBe(2);
			expect(t.judge?.type).toBe('key');
			expect(t.judge?.reasons).not.toContain('multi-hit');
			expect(t.descriptors.durationSec).toBeCloseTo(t.endSec - t.startSec, 3);
		}
		expect(e.takes!.map((t) => t.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
	});

	it('ten clicks in digital silence give 10 clean takes; the 11th, cut by the end of the file, is recorded as cut', async () => {
		for (const title of ['wooden clicks', 'wooden clicks flac']) {
			const e = await recording(title);
			expect(e.takes, title).toHaveLength(11);
			expect(e.takes!.slice(0, 10).every((t) => t.flags.length === 0)).toBe(true);
			expect(e.takes![10]!.flags).toContain('tail-cut');
			expect(e.materials).toEqual(['wood']);
		}
	});

	it('no takes for a type that is not single-hit, for one sample or for silence', async () => {
		expect((await recording('air whoosh')).takes).toBeUndefined();
		expect((await recording('one sample click')).takes).toBeUndefined();
		expect((await recording('silent clicks')).takes).toBeUndefined();
	});

	it('entryTakes: single-hit or untyped sounds only, judged with singleHit off', async () => {
		const { judge: _j, ...cached } = (await recording('keyboard typing')).takes![0]!;
		expect(entryTakes(['whoosh', 'key'], [cached])).toBeUndefined();
		expect(entryTakes(['key'], [])).toBeUndefined();
		expect(entryTakes(['key'], undefined)).toBeUndefined();
		const keyed = entryTakes(['key', 'click'], [{ ...cached, descriptors: { ...cached.descriptors, onsetCount: 2 } }])!;
		expect(keyed[0]!.judge).toMatchObject({ type: 'key' });
		expect(keyed[0]!.judge!.reasons).not.toContain('multi-hit');
		expect(entryTakes(['future-type'], [cached])![0]!.judge).toBeNull();
	});
});

describe('search, entries, visual data and audio of takes', { timeout: 300_000 }, () => {
	it('rows count a recording’s offered takes and leave them out; takes=true ranks the clean takes as rows', async () => {
		const plain = await search('sources=folder&license=any&limit=100');
		const typingRow = plain.results.find((r) => r.sound.title === 'keyboard typing')!;
		expect(typingRow.takeCount).toBe(8);
		expect(typingRow.sound.takes).toBeUndefined();
		expect(plain.results.find((r) => r.sound.title === 'wooden clicks')!.takeCount).toBe(10);
		expect(plain.results.some((r) => parseTakeId(r.sound.id))).toBe(false);
		const withTakes = await search('sources=folder&license=any&limit=200&takes=true');
		const takeRows = withTakes.results.filter((r) => parseTakeId(r.sound.id));
		// 8 + 10 + 10 offered takes; never the cut 11th
		expect(takeRows).toHaveLength(28);
		expect(takeRows.some((r) => r.sound.take?.index === 11)).toBe(false);
		// for "key", the joined key presses rank above their multi-hit recording
		const keys = await search('types=key&license=any&takes=true&limit=20');
		const first = keys.results.findIndex((r) => r.sound.take?.soundId === typingRow.sound.id);
		const rec = keys.results.findIndex((r) => r.sound.id === typingRow.sound.id);
		expect(first).toBeGreaterThanOrEqual(0);
		expect(rec === -1 || first < rec).toBe(true);
	});

	it('material filter and its facet', async () => {
		const wood = await search('sources=folder&license=any&material=wood&limit=100');
		expect(wood.results.map((r) => r.sound.title).sort()).toEqual(['wooden clicks', 'wooden clicks flac']);
		const all = await search('sources=folder&license=any&limit=100');
		expect(all.facets.materials?.wood).toBe(2);
		expect(all.facets.materials?.air).toBe(1);
		// the material facet ignores its own filter
		expect(wood.facets.materials?.air).toBe(1);
		const bad = await app.inject({ method: 'GET', url: '/api/sounds?material=lava', headers: H });
		expect(bad.statusCode).toBe(400);
	});

	it('a take id names a take entry: the recording’s licence and source, its own descriptors and judge', async () => {
		const rec = await recording('keyboard typing');
		const take = await getSound(takeIdOf(rec.id, 3));
		expect(take.take).toMatchObject({ soundId: rec.id, index: 3, flags: [] });
		expect(take.license).toBe(rec.license);
		expect(take.source).toEqual(rec.source);
		expect(take.descriptors).toEqual(rec.takes![2]!.descriptors);
		expect(take.judge).toEqual(rec.takes![2]!.judge);
		expect(take.takes).toBeUndefined();
		for (const bad of [`${rec.id}~t9`, `${rec.id}~t0`, `${rec.id}~x`])
			expect((await app.inject({ method: 'GET', url: `/api/sounds/${bad}`, headers: H })).statusCode).toBe(404);
	});

	it('visual data of a take covers the take alone (cached by the index, recomputed when gone)', async () => {
		const rec = await recording('keyboard typing');
		const id = takeIdOf(rec.id, 2);
		const get = async () => {
			const r = await app.inject({ method: 'GET', url: `/api/sounds/${id}/visual`, headers: H });
			expect(r.statusCode, r.body).toBe(200);
			return SoundVisualSchema.parse(r.json());
		};
		const v = await get();
		expect(v.soundId).toBe(id);
		expect(v.coveredSec).toBeCloseTo(rec.takes![1]!.endSec - rec.takes![1]!.startSec, 3);
		const cache = appdirPaths(appdir).soundCacheDir;
		const hex = rec.fingerprint.replace(/^q1:/, '');
		const file = takeVisualCacheFile(cache, hex, 2);
		writeFileSync(file, '{broken');
		expect(await get()).toEqual(v);
	});

	it('the audio of a take is exactly its range of the recording (WAV and FLAC sources)', async () => {
		for (const [title, src] of [
			['keyboard typing', files.typing],
			['wooden clicks flac', files.clicks],
		] as const) {
			const rec = await recording(title);
			const t = rec.takes![4]!;
			const r = await app.inject({ method: 'GET', url: `/api/sounds/${takeIdOf(rec.id, 5)}/audio`, headers: H });
			expect(r.statusCode).toBe(200);
			expect(String(r.headers['content-type'])).toContain('audio/');
			const out = join(tempAppdir('jasper-take-audio-'), 'take.wav');
			writeFileSync(out, r.rawPayload);
			const got = decodeF32(out);
			const whole = decodeF32(src);
			const range = takeRange(t, SR)!;
			expect(got.length, title).toBe(range.endSample - range.startSample);
			let worst = 0;
			for (let i = 0; i < got.length; i++) worst = Math.max(worst, Math.abs(got[i]! - whole[range.startSample + i]!));
			expect(worst, title).toBeLessThan(1e-6);
		}
	});
});

describe('registering and placing a take', { timeout: 600_000 }, () => {
	async function registerSound(id: string) {
		const r = await app.inject({
			method: 'POST',
			url: `/api/sounds/${id}/register`,
			headers: JSON_H,
			payload: { projectId },
		});
		return r;
	}

	it('registers a copy of the take’s range with lead and trailing silence; provenance names the recording', async () => {
		const rec = await recording('wooden clicks flac');
		const t = rec.takes![3]!;
		const r = await registerSound(takeIdOf(rec.id, 4));
		expect(r.statusCode, r.body).toBe(200);
		const reg = RegisterSoundResponseSchema.parse(r.json());
		expect(reg.library.soundId).toBe(takeIdOf(rec.id, 4));
		expect(reg.library.take).toEqual({
			soundId: rec.id,
			index: 4,
			sourceStartSec: t.startSec,
			sourceEndSec: t.endSec,
		});
		expect(reg.library.license).toBe(rec.license);
		expect(reg.library.leadSilenceSec).toBe(0.05);
		expect(reg.inexact).toBeUndefined();
		const copyPath = await coreServices(app).registry.resolvePath(reg.mediaKey);
		if (!copyPath) throw new Error("the copy is offline");
		const copy = decodeF32(copyPath);
		const whole = decodeF32(files.clicksWav);
		const range = takeRange(t, SR)!;
		const lead = 2400;
		for (let i = 0; i < lead; i++) expect(copy[i]).toBe(0);
		let worst = 0;
		for (let i = 0; i < range.endSample - range.startSample; i++)
			worst = Math.max(worst, Math.abs(copy[lead + i]! - whole[range.startSample + i]!));
		expect(worst).toBeLessThan(1e-6);
		// the same take again is the same media; another take is another one
		const again = RegisterSoundResponseSchema.parse((await registerSound(takeIdOf(rec.id, 4))).json());
		expect(again.fingerprint).toBe(reg.fingerprint);
		const other = RegisterSoundResponseSchema.parse((await registerSound(takeIdOf(rec.id, 5))).json());
		expect(other.fingerprint).not.toBe(reg.fingerprint);
	});

	it('refuses a cut take (never offered) and an unknown one', async () => {
		const rec = await recording('wooden clicks');
		const cut = await registerSound(takeIdOf(rec.id, 11));
		expect(cut.statusCode).toBe(422);
		expect(cut.json().code).toBe('SOUND_TAKE_CUT');
		expect((await registerSound(takeIdOf(rec.id, 12))).statusCode).toBe(404);
	});

	it('a registered take placed on a cue peaks on the cue frame in the exported audio (measured, 4 rates)', async () => {
		const rec = await recording('keyboard typing');
		const whole = decodeF32(files.typing);
		for (const [label, fps] of [
			['23.976', { num: 24000, den: 1001 }],
			['25', { num: 25, den: 1 }],
			['30', { num: 30, den: 1 }],
			['60', { num: 60, den: 1 }],
		] as const) {
			const b = new DocBuilder(`hd-1080p-${label}`, 700);
			const cues: { frame: number; take: NonNullable<SoundEntry['takes']>[number] }[] = [];
			for (const [i, n] of [2, 5, 7].entries()) {
				const reg = RegisterSoundResponseSchema.parse((await registerSound(takeIdOf(rec.id, n))).json());
				const { mediaKey: _k, browserPlayable: _b, library, existingMediaId: _x, ...asset } = reg;
				const r0 = b.tx([{ type: 'media.register', asset: { ...asset, derivation: null, library } }]);
				const mediaId = (r0.results[0] as { mediaId: string }).mediaId;
				const frame = Math.round((0.5 + 0.8 * i) * (fps.num / fps.den)) + i;
				const r = b.tx([
					{
						type: 'soundCue.add',
						cues: [{ frame, kind: 'appear', weight: 'support', source: 'user', align: 'peak', ref: '$c' }],
					},
					{ type: 'soundDesign.place', cueId: '$c', layers: [{ mediaId, gainDb: 0 }] },
				]);
				expect((r.results[1] as { clips: { errorFlicks: number }[] }).clips[0]!.errorFlicks).toBe(0);
				cues.push({ frame, take: rec.takes![n - 1]! });
			}
			const settings = {
				sequenceId: b.seqId,
				range: { type: 'entire' },
				container: 'mov',
				video: {
					codec: 'h264',
					width: 320,
					height: 180,
					frameRate: fps,
					scaling: 'fit',
					quality: { mode: 'crf', value: 35 },
					encoderSpeed: 'fast',
				},
				audio: { codec: 'pcm', sampleRate: SR, channels: 2 },
				engine: 'native',
			};
			const start = await app.inject({
				method: 'POST',
				url: '/api/exports',
				headers: JSON_H,
				payload: { envelope: b.envelope(), sequenceId: b.seqId, settings },
			});
			expect(start.statusCode, start.body).toBe(202);
			const done = await waitJob(start.json().id);
			expect(done.error).toBeUndefined();
			const x = decodeF32((await coreServices(app).exports.outputFile(start.json().id))!);
			for (const c of cues) {
				const expected = frameToSample(c.frame, fps, SR);
				const range = takeRange(c.take, SR)!;
				// the clip plays the take to its −60 dB end (`peakSec + tailSec`), whole frames: compare that much
				const len = Math.min(
					range.endSample - range.startSample,
					Math.round((c.take.descriptors.peakSec + c.take.descriptors.tailSec) * SR),
				);
				// where the take's first sample plays: the offset where the export matches the source take
				let best = -1;
				let bestErr = Number.POSITIVE_INFINITY;
				for (let o = expected - Math.round(0.3 * SR); o < expected + Math.round(0.1 * SR); o++) {
					let err = 0;
					for (let k = 0; k < len && err < bestErr; k += 7) err += Math.abs(x[o + k]! - whole[range.startSample + k]!);
					if (err < bestErr) {
						bestErr = err;
						best = o;
					}
				}
				expect(bestErr / (len / 7), `${label} fps: mean error at the match`).toBeLessThan(1e-4);
				// the take's descriptor peak lands on the cue frame (to the sample)
				const peakAt = best + c.take.descriptors.peakSec * SR;
				expect(Math.abs(peakAt - expected), `${label} fps cue ${c.frame}`).toBeLessThanOrEqual(1);
				// and the export's own loudest 2 ms (analysed like the library does) is within 0.5 ms of it
				const win = x.slice(expected - Math.round(0.1 * SR), expected + Math.round(0.1 * SR));
				const d = analyzeSound([win], SR);
				expect(Math.abs(d.peakSec - 0.1), `${label} fps: measured peak`).toBeLessThanOrEqual(0.0005 + 1e-9);
			}
		}
	});
});

describe('determinism, old indexes and the cache', { timeout: 300_000 }, () => {
	it('a full re-index gives the same snapshot and the same takes', async () => {
		const before = await recording('keyboard typing');
		const a = await search('sources=folder&license=any');
		const r = await index({ full: true });
		expect(r.snapshotHash).toBe(a.snapshotHash);
		expect((await recording('keyboard typing')).takes).toEqual(before.takes);
	});

	it('an index written before takes and materials loads, asks for a re-index and gets them', async () => {
		const paths = appdirPaths(appdir);
		await closeApps();
		const raw = JSON.parse(readFileSync(paths.soundLibraryIndex, 'utf8'));
		for (const e of Object.values(raw.sounds) as Record<string, unknown>[]) {
			delete e.takes;
			delete e.materials;
			e.analysisVersion = 1001;
			const d = e.descriptors as Record<string, unknown>;
			delete d.rolloff95Hz;
			delete d.floorDb;
			delete d.dcDb;
		}
		writeFileSync(paths.soundLibraryIndex, JSON.stringify(raw));
		app = await makeApp({ appdir });
		const status = await app.inject({ method: 'GET', url: '/api/sounds/status', headers: H });
		expect(status.statusCode).toBe(200);
		expect(status.json()).toMatchObject({ recovered: false, needsIndex: true });
		expect((status.json() as { sounds: number }).sounds).toBe(Object.keys(raw.sounds).length);
		const old = await search('sources=folder&license=any&limit=100');
		expect(old.results.length).toBeGreaterThan(0);
		expect(old.results.every((r) => r.takeCount === undefined)).toBe(true);
		expect(old.facets.materials).toEqual({});
		// the re-index analyses again (a new analysis version) and brings the takes back
		await index();
		expect((await recording('keyboard typing')).takes).toHaveLength(8);
		const after = await app.inject({ method: 'GET', url: '/api/sounds/status', headers: H });
		expect(after.json()).toMatchObject({ needsIndex: false });
	});

	it('pruning removes take files the index no longer lists', async () => {
		const dir = tempAppdir('jasper-takes-prune-');
		const hex = 'a'.repeat(64);
		mkdirSync(join(dir, hex), { recursive: true });
		for (const f of ['take-1-visual-v1.json', 'take-2-visual-v1.json', 'take-1-audio-v1.wav', 'take-1-visual-v0.json'])
			writeFileSync(join(dir, hex, f), 'x');
		const entry = {
			fingerprint: `q1:${hex}`,
			source: { type: 'starter', file: 'x.wav' },
			takes: [{ index: 1 }],
		} as unknown as SoundEntry;
		const r = await pruneSoundCache({ cacheDir: dir, synthDir: join(dir, 'synth') }, { sounds: { x: entry }, files: {} });
		expect(r.files).toBe(2);
	});
});
