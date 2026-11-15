// Sound Check on a long sequence (wp-note "Phase 5 → Sound Check engine review"): wall time, engine CPU, peak RSS /
// heap / array buffers, load and the report's size for generated media — music (pink noise) and a gated 1.5 kHz
// "voice" over the whole sequence, BENCH_SFX hits on cues. Opt-in (skipped unless SOUND_CHECK_BENCH_MIN is set):
//   SOUND_CHECK_BENCH_MIN=30 SOUND_CHECK_BENCH_OUT=/tmp/bench.log pnpm vitest run apps/engine/test/sound-check-bench.test.ts
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineJob } from '@jasper/api';
import { SoundCheckResultSchema } from '@jasper/api';
import { appdirPaths } from '@jasper/config';
import { makeEnvelope } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreServices } from '../src/tools/services.ts';
import {
	closeApps,
	DocBuilder,
	editorCookie,
	makeApp,
	register,
	TEST_HOST,
	type TestApp,
} from './helpers.ts';
import { provenance, writeBedFixture } from './sound-bed-fixture.ts';

const MIN = Number(process.env.SOUND_CHECK_BENCH_MIN ?? 0);
const HOST = { host: TEST_HOST };
const TOKEN = 'tok_check_0123456789abcdef012';
const KEY = 'key_check_0123456789abcdef012';
const EDITOR_H = { ...HOST, cookie: editorCookie(TOKEN, KEY) };
let app: TestApp;

beforeAll(async () => {
	if (MIN > 0) app = await makeApp({ dev: false, token: TOKEN, editorKey: KEY });
}, 60_000);
afterAll(async () => {
	if (MIN > 0) await closeApps();
});

describe.skipIf(!(MIN > 0))('Sound Check bench', { timeout: 7_200_000 }, () => {
	it(`checks a ${MIN}-minute sequence`, async () => {
		const dir = mkdtempSync(join(tmpdir(), 'jasper-bench-'));
		const secs = MIN * 60;
		const music = join(dir, 'music.flac');
		const speech = join(dir, 'speech.flac');
		execFileSync('ffmpeg', [
			'-v',
			'error',
			'-f',
			'lavfi',
			'-i',
			`anoisesrc=color=pink:amplitude=0.05:sample_rate=48000:seed=7:duration=${secs}`,
			'-ac',
			'2',
			'-c:a',
			'flac',
			'-y',
			music,
		]);
		execFileSync('ffmpeg', [
			'-v',
			'error',
			'-f',
			'lavfi',
			'-i',
			`aevalsrc=0.2*sin(2*PI*1500*t)*(0.5-0.5*cos(2*PI*4*t))*gt(mod(t\\,20)\\,4)*lt(mod(t\\,20)\\,12):s=48000:d=${secs}`,
			'-ac',
			'2',
			'-c:a',
			'flac',
			'-y',
			speech,
		]);
		const files = writeBedFixture(dir);
		const auth = { authorization: `Bearer ${TOKEN}` };
		const m = await register(app, music, auth);
		const s = await register(app, speech, auth);
		const h = await register(app, files.hit, auth);
		const b = new DocBuilder('hd-1080p-30', 900);
		const mm = b.addMedia(m);
		const sm = b.addMedia(s);
		const hm = b.addMedia(h);
		const r = b.tx([
			{ type: 'media.setLibraryInfo', mediaId: hm, library: provenance('hit') },
			{ type: 'clip.place', source: { mediaId: mm }, at: 0, tracks: { audio: 'A1' }, ref: '$m' },
			{ type: 'clip.place', source: { mediaId: sm }, at: 0, tracks: { audio: 'A2' }, ref: '$s' },
		]);
		b.tx([
			{ type: 'essentialSound.setType', clipIds: [r.refs.$m!], audioType: 'music' },
			{ type: 'essentialSound.setType', clipIds: [r.refs.$s!], audioType: 'dialogue' },
			{ type: 'mixer.setLoudness', enabled: true, targetLufs: -14, truePeakDb: -1 },
		]);
		const n = Number(process.env.SOUND_CHECK_BENCH_SFX ?? 40);
		for (let i = 0; i < n; i++) {
			const frame = Math.round(((i + 0.5) * secs * 30) / n);
			b.tx([
				{ type: 'soundCue.add', cues: [{ frame, kind: 'cut', weight: 'hero', source: 'user', ref: '$c' }] },
				{ type: 'soundDesign.place', cueId: '$c', layers: [{ mediaId: hm, role: 'hero', align: 'peak' }] },
			]);
		}
		const projectId = 'prj_9000000000000001';
		const file = appdirPaths(app.appdir).projectFile(projectId);
		mkdirSync(join(file, '..'), { recursive: true });
		writeFileSync(
			file,
			JSON.stringify(
				makeEnvelope(
					{ ...b.doc, projectId },
					{ revision: 3, savedAt: '2026-10-16T00:00:00.000Z', platform: 'test' },
				),
			),
		);
		global.gc?.();
		let peak = process.memoryUsage().rss;
		let peakHeap = process.memoryUsage().heapUsed;
		let peakExt = process.memoryUsage().arrayBuffers;
		const base = process.memoryUsage();
		const loads: number[] = [];
		const timer = setInterval(() => {
			const u = process.memoryUsage();
			peak = Math.max(peak, u.rss);
			peakHeap = Math.max(peakHeap, u.heapUsed);
			peakExt = Math.max(peakExt, u.arrayBuffers);
			loads.push(loadavg()[0]!);
		}, 250);
		const t0 = Date.now();
		const cpu0 = process.cpuUsage();
		const res = await app.inject({
			method: 'POST',
			url: '/api/sound-design/check',
			headers: { ...EDITOR_H, 'content-type': 'application/json' },
			payload: JSON.stringify({ projectId }),
		});
		expect(res.statusCode, res.body).toBe(202);
		const job: EngineJob = await coreServices(app).queue.wait((res.json() as EngineJob).id);
		const wall = Date.now() - t0;
		const cpu = process.cpuUsage(cpu0);
		clearInterval(timer);
		expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
		const rep = SoundCheckResultSchema.parse(job.result).report;
		const mb = (x: number) => Math.round(x / 1048576);
		const line = `Sound Check bench ${MIN} min, ${n} sfx: wall ${wall} ms; engine cpu user ${Math.round(cpu.user / 1000)} ms sys ${Math.round(cpu.system / 1000)} ms; rss base ${mb(base.rss)} MB peak ${mb(peak)} MB; heapUsed base ${mb(base.heapUsed)} peak ${mb(peakHeap)} MB; arrayBuffers base ${mb(base.arrayBuffers)} peak ${mb(peakExt)} MB; load ${Math.min(...loads).toFixed(1)}–${Math.max(...loads).toFixed(1)}; report ${JSON.stringify(rep).length} bytes; timings ${JSON.stringify(rep.timings)}; verdict ${rep.verdict} ${JSON.stringify(rep.counts)}; curves ${rep.curves.points}; segments ${rep.speech.segments.length}; integrated ${rep.loudness.integratedLufs}; events found ${rep.events.filter((e) => e.located === 'found').length}`;
		console.log(line);
		const out = process.env.SOUND_CHECK_BENCH_OUT;
		if (out) appendFileSync(out, `${line}\n`);
		expect(rep.curves.points).toBeLessThanOrEqual(1200);
		expect(rep.events.filter((e) => e.located === 'found').length).toBe(n);
		rmSync(dir, { recursive: true, force: true });
	});
});
