// Detect Peak on the engine (`POST /api/sound-design/peak`, spec 12 §2.7; wp-note "Final verification B"): the agent's
// twin of the editor's Clip ▸ Detect Peak. The peak of the part of the media a clip uses equals the browser's measurement
// (`analyzeSound` on the same decoded range: the oracle below), within one sample; a clip longer than 120 s is searched in
// its first 120 s (truncated); refusals are typed (unknown project / sequence / clip, a video clip, a reversed clip,
// silence, a hostile body).
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeWav } from '@jasper/audio-dsp';
import { analyzeSound } from '@jasper/audio-fx';
import { appdirPaths } from '@jasper/config';
import { FLICKS_PER_SECOND, makeEnvelope, type ProjectDocument } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApps, DocBuilder, makeApp, register, TEST_FFMPEG, TEST_HOST, type TestApp } from './helpers.ts';

const HAVE_FFMPEG = spawnSync(TEST_FFMPEG, ['-version'], { encoding: 'utf8' }).status === 0;
const JSON_H = { host: TEST_HOST, 'content-type': 'application/json' };
const SR = 48_000;

let app: TestApp;
let dir = '';
let projects = 0;

function seed(doc: ProjectDocument): string {
	const projectId = `prj_${(9100 + ++projects).toString().padStart(16, '0')}`;
	const file = appdirPaths(app.appdir).projectFile(projectId);
	mkdirSync(join(file, '..'), { recursive: true });
	writeFileSync(
		file,
		JSON.stringify(
			makeEnvelope(
				{ ...doc, projectId },
				{ revision: 1, savedAt: '2026-10-18T00:00:00.000Z', platform: 'test' },
			),
		),
	);
	return projectId;
}

async function peak(body: unknown) {
	const r = await app.inject({
		method: 'POST',
		url: '/api/sound-design/peak',
		headers: JSON_H,
		payload: JSON.stringify(body),
	});
	return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, unknown> };
}

/** Low noise with short tone bursts (a click) at the given seconds and levels. */
function clicks(seconds: number, sr: number, at: [number, number][]): Float32Array {
	const x = new Float32Array(Math.round(seconds * sr));
	let s = 7;
	for (let i = 0; i < x.length; i++) {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		x[i] = ((s >>> 8) / (1 << 24) - 0.5) * 0.004;
	}
	for (const [t, a] of at) {
		const i0 = Math.round(t * sr);
		for (let k = 0; k < Math.round(0.0015 * sr); k++)
			x[i0 + k] =
				(x[i0 + k] ?? 0) + a * Math.sin((2 * Math.PI * 3000 * k) / sr) * Math.exp(-k / (0.0004 * sr));
	}
	return x;
}

/** The browser's measurement (detect-peak.ts) as an oracle: the same range decoded, `analyzeSound`. */
function oracle(file: string, fromSec: number, durSec: number): number {
	const r = spawnSync(
		TEST_FFMPEG,
		[
			'-v',
			'error',
			'-ss',
			String(fromSec),
			'-t',
			String(durSec),
			'-i',
			file,
			'-ac',
			'2',
			'-ar',
			String(SR),
			'-f',
			'f32le',
			'pipe:1',
		],
		{ maxBuffer: 1 << 30 },
	);
	const b = r.stdout as Buffer;
	const n = Math.floor(b.byteLength / 8);
	const l = new Float32Array(n);
	const rr = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		l[i] = b.readFloatLE(i * 8);
		rr[i] = b.readFloatLE(i * 8 + 4);
	}
	return analyzeSound([l, rr], SR).peakSec;
}

describe.skipIf(!HAVE_FFMPEG)('POST /api/sound-design/peak', () => {
	beforeAll(async () => {
		app = await makeApp();
		dir = mkdtempSync(join(tmpdir(), 'jasper-peak-'));
	}, 120_000);
	afterAll(closeApps);

	it('finds the peak of the clip’s part of its media, as the browser measures it; one sample', {
		timeout: 120_000,
	}, async () => {
		// a soft click at 0.8 s (before the clip's In point) and the loud one at 1.9137 s
		const x = clicks(4, SR, [
			[0.8, 0.9],
			[1.9137, 0.5],
		]);
		const file = join(dir, 'hit.wav');
		writeFileSync(file, encodeWav([x, x.slice()], SR, 's16'));
		const b = new DocBuilder('hd-1080p-30', 31);
		const m = b.addMedia(await register(app, file));
		const r = b.tx([
			{
				type: 'clip.place',
				source: { mediaId: m },
				sourceRange: { in: { seconds: 1 }, out: { seconds: 3.5 } },
				at: 30,
				tracks: { audio: 'A1' },
				ref: '$a',
			},
		]);
		const clipId = r.refs.$a!;
		const projectId = seed(b.doc);
		const res = await peak({ projectId, clipId });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const clip = b.doc.sequences[b.seqId]!.clips[clipId]!;
		const c0 = clip.sourceIn / FLICKS_PER_SECOND;
		const want = oracle(file, c0, 2.5);
		expect(res.body.truncated).toBe(false);
		expect(Math.abs((res.body.peakSec as number) - want)).toBeLessThanOrEqual(1 / SR + 1e-4);
		// content flicks from the media start: the click at 1.9137 s (the centre of its loudest 2 ms, within 1 ms)
		const peakAt = (res.body.peakFlicks as number) / FLICKS_PER_SECOND;
		expect(Math.abs(peakAt - 1.9137)).toBeLessThan(0.0015);
		expect(res.body.revision).toBe(1);
		// what the command it feeds accepts
		const set = b.tx([{ type: 'soundDesign.setPeak', clipId, peakFlicks: res.body.peakFlicks }]);
		expect(set.results.length).toBe(1);
	});

	it('searches the first 120 s of a longer clip and says so', { timeout: 180_000 }, async () => {
		const sr = 8000;
		const x = clicks(125, sr, [
			[10.5, 0.3],
			[122, 0.95],
		]);
		const file = join(dir, 'long.wav');
		writeFileSync(file, encodeWav([x], sr, 's16'));
		const b = new DocBuilder('hd-1080p-30', 32);
		const m = b.addMedia(await register(app, file));
		const r = b.tx([
			{ type: 'clip.place', source: { mediaId: m }, at: 0, tracks: { audio: 'A1' }, ref: '$a' },
		]);
		const projectId = seed(b.doc);
		const res = await peak({ projectId, clipId: r.refs.$a! });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.truncated).toBe(true);
		expect(res.body.analysedSec).toBe(120);
		expect(Math.abs((res.body.peakFlicks as number) / FLICKS_PER_SECOND - 10.5)).toBeLessThan(0.003);
	});

	it('refuses with typed errors', { timeout: 120_000 }, async () => {
		const silentFile = join(dir, 'silent.wav');
		writeFileSync(silentFile, encodeWav([new Float32Array(SR)], SR, 's16'));
		const b = new DocBuilder('hd-1080p-30', 33);
		const silent = b.addMedia(await register(app, silentFile));
		const hitFile = join(dir, 'hit2.wav');
		writeFileSync(hitFile, encodeWav([clicks(2, SR, [[0.5, 0.8]])], SR, 's16'));
		const hit = b.addMedia(await register(app, hitFile));
		const r = b.tx([
			{ type: 'clip.place', source: { mediaId: silent }, at: 0, tracks: { audio: 'A1' }, ref: '$s' },
			{ type: 'clip.place', source: { mediaId: hit }, at: 0, tracks: { audio: 'A2' }, ref: '$h' },
			{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [1, 0, 0, 1], ref: '$v' },
		]);
		b.tx([{ type: 'clip.setSpeed', clipIds: [r.refs.$h!], rate: 1, reverse: true, ripple: false }]);
		const projectId = seed(b.doc);
		expect((await peak({ projectId, clipId: r.refs.$s! })).body).toMatchObject({ code: 'SILENT' });
		expect(await peak({ projectId, clipId: r.refs.$h! })).toMatchObject({
			status: 400,
			body: { code: 'REVERSED' },
		});
		expect(await peak({ projectId, clipId: r.refs.$v! })).toMatchObject({
			status: 400,
			body: { code: 'NOT_AUDIO' },
		});
		expect(await peak({ projectId, clipId: 'clp_nope' })).toMatchObject({
			status: 404,
			body: { code: 'CLIP_NOT_FOUND' },
		});
		expect(await peak({ projectId, sequenceId: 'seq_nope', clipId: r.refs.$s! })).toMatchObject({
			status: 404,
			body: { code: 'SEQUENCE_NOT_FOUND' },
		});
		expect(await peak({ projectId: 'prj_0000000000009999', clipId: 'x' })).toMatchObject({
			status: 404,
			body: { code: 'PROJECT_NOT_FOUND' },
		});
		for (const bad of [
			{},
			{ projectId, clipId: 7 },
			{ projectId: '../x', clipId: 'a' },
			{ projectId, clipId: 'a', extra: 1 },
		])
			expect((await peak(bad)).status, JSON.stringify(bad)).toBe(400);
	});
});
