// The plan job's event-loop blockage and wall time (wp-note WP6.5b item 7), opt-in: the plan-mix fixture (the Phase 2
// fixture + music on A1 + dialogue 4–8 s on A2, an indexed kit), the first plan with every style option (cold caches:
// a fresh engine per run), measured with perf_hooks `monitorEventLoopDelay` (10 ms resolution) and a 50 ms
// `/api/health` probe while it runs. One mode per run (the measurer is chosen when the engine starts):
//   SD_PLAN_BENCH=thread SD_PLAN_BENCH_OUT=/tmp/b.log pnpm vitest run apps/engine/test/sound-design-plan-bench.test.ts
//   SD_PLAN_BENCH=worker SD_PLAN_BENCH_OUT=/tmp/b.log pnpm vitest run apps/engine/test/sound-design-plan-bench.test.ts
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { type EngineJob, type SoundDesignPlanResult, SoundDesignPlanResultSchema } from '@jasper/api';
import { appdirPaths } from '@jasper/config';
import { makeEnvelope } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { soundDesignMeasurer } from '../src/sound-design/measure-pool.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, makeApp, register, tempAppdir } from './helpers.ts';
import { writeBedFixture } from './sound-bed-fixture.ts';
import { fixture } from './sound-design-fixture.ts';
import { PACK, writeWav } from './sound-fixtures.ts';

const MODE = process.env.SD_PLAN_BENCH ?? '';
const HERE = fileURLToPath(new URL('.', import.meta.url));

async function bundleWorker(): Promise<string> {
	const { build } = await import('esbuild');
	const out = join(mkdtempSync(join(tmpdir(), 'jasper-sd-bench-')), 'sd-measure-worker.mjs');
	await build({
		entryPoints: [join(HERE, '..', 'src', 'sound-design', 'measure-worker.ts')],
		outfile: out,
		bundle: true,
		platform: 'node',
		format: 'esm',
		target: 'node20',
		logLevel: 'silent',
		external: ['@remotion/*', 'remotion', 'esbuild', 'fsevents', '*.node'],
		banner: {
			js: "import { createRequire as __r } from 'node:module'; const require = __r(import.meta.url);",
		},
	});
	return out;
}

const ENV_KEYS = [
	'JASPER_SOUND_STARTER_DIR',
	'JASPER_SOUND_SYNTH_VARIANTS',
	'JASPER_SOUND_AUTO_INDEX',
	'JASPER_SD_MEASURE_WORKER',
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const HOST = { host: '127.0.0.1:47900' };
const TOKEN = 'tok_pben_0123456789abcdef0123';
const KEY = 'key_pben_0123456789abcdef0123';
const AGENT_H = { ...HOST, authorization: `Bearer ${TOKEN}`, 'x-jasper-agent': 'plan-agent' };
const EDITOR_H = { ...HOST, cookie: `jasper_session_47900=${TOKEN}; jasper_editor_47900=${KEY}` };
const json = (h: Record<string, string>) => ({ ...h, 'content-type': 'application/json' });
const F = 705_600_000 / 30;

type App = Awaited<ReturnType<typeof makeApp>>;
let app: App;
let projectId: string;
let seqId: string;

function makeKit(dir: string): string {
	const files: [string, 'hit' | 'whoosh' | 'click', number, string, string[]][] = [
		['hit_a.wav', 'hit', 0.5, 'Punch hit', ['hit']],
		['hit_b.wav', 'hit', 0.4, 'Crunch hit', ['hit']],
		['thump_a.wav', 'hit', 0.45, 'Soft thump', ['thump']],
		['boom_a.wav', 'hit', 0.9, 'Low boom', ['boom']],
		['whoosh_a.wav', 'whoosh', 0.7, 'Air whoosh', ['whoosh']],
		['whoosh_b.wav', 'whoosh', 0.9, 'Fast whoosh', ['whoosh']],
		['key_a.wav', 'click', 0.08, 'Key a', ['key']],
		['key_b.wav', 'click', 0.09, 'Key b', ['key']],
	];
	files.forEach(([file, shape, sec], i) => {
		writeWav(join(dir, file), shape, sec, i + 1);
	});
	writeFileSync(
		join(dir, 'manifest.json'),
		JSON.stringify({
			version: 1,
			packs: [PACK],
			sounds: files.map(([file, , , title, types]) => ({
				file,
				title,
				types,
				tags: ['test'],
				author: 'Test Author',
				license: 'CC0-1.0',
				sourceUrl: 'https://example.invalid/sounds',
				packId: PACK.id,
			})),
		}),
	);
	return dir;
}

async function plan(body: unknown): Promise<{ job: EngineJob; result: SoundDesignPlanResult; ms: number }> {
	const t0 = Date.now();
	const r = await app.inject({
		method: 'POST',
		url: '/api/sound-design/plan',
		headers: json(AGENT_H),
		payload: JSON.stringify(body),
	});
	expect(r.statusCode, r.body).toBe(202);
	const job = await coreServices(app).queue.wait((r.json() as EngineJob).id);
	expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
	return { job, result: SoundDesignPlanResultSchema.parse(job.result), ms: Date.now() - t0 };
}

beforeAll(async () => {
	if (!MODE) return;
	process.env.JASPER_SOUND_STARTER_DIR = makeKit(tempAppdir('jasper-pmix-kit-'));
	process.env.JASPER_SOUND_SYNTH_VARIANTS = '1';
	process.env.JASPER_SOUND_AUTO_INDEX = '0';
	process.env.JASPER_SD_MEASURE_WORKER = MODE === 'worker' ? await bundleWorker() : 'off';
	app = await makeApp({ dev: false, token: TOKEN, editorKey: KEY });
	const idx = await app.inject({
		method: 'POST',
		url: '/api/sounds/index',
		headers: json(EDITOR_H),
		payload: '{}',
	});
	expect(idx.statusCode, idx.body).toBe(202);
	expect((await coreServices(app).queue.wait((idx.json() as EngineJob).id)).state).toBe('succeeded');
	// The Phase 2 fixture with a bed: music under everything (A1), dialogue from 4 s to 8 s (A2).
	const f = fixture();
	const files = writeBedFixture(mkdtempSync(join(tmpdir(), 'jasper-pmix-bed-')));
	const auth = { authorization: `Bearer ${TOKEN}` };
	const asset = (m: Awaited<ReturnType<typeof register>>) => {
		const { mediaKey: _k, browserPlayable: _b, ...rest } = m;
		return { ...rest, derivation: null };
	};
	const music = await register(app, files.music, auth);
	const speech = await register(app, files.speech, auth);
	f.tx([
		{ type: 'media.register', asset: asset(music), ref: '$mm' },
		{ type: 'media.register', asset: asset(speech), ref: '$sm' },
		{ type: 'clip.place', source: { mediaId: '$mm' }, at: 0, tracks: { audio: 'A1' }, ref: '$m' },
		{
			type: 'clip.place',
			source: { mediaId: '$sm' },
			sourceRange: { in: { flicks: 4 * 30 * F }, out: { flicks: 8 * 30 * F } },
			at: 120,
			tracks: { audio: 'A2' },
			ref: '$s',
		},
		{ type: 'essentialSound.setType', clipIds: ['$m'], audioType: 'music' },
		{ type: 'essentialSound.setType', clipIds: ['$s'], audioType: 'dialogue' },
	]);
	projectId = 'prj_0000000000000PBN';
	seqId = f.seqId;
	const file = appdirPaths(app.appdir).projectFile(projectId);
	mkdirSync(join(file, '..'), { recursive: true });
	writeFileSync(
		file,
		JSON.stringify(
			makeEnvelope(
				{ ...f.get(), projectId },
				{ revision: 3, savedAt: '2026-10-16T00:00:00.000Z', platform: 'test' },
			),
		),
	);
}, 600_000);
afterAll(async () => {
	if (MODE) await closeApps();
	for (const k of ENV_KEYS) {
		if (savedEnv[k] === undefined) delete process.env[k];
		else process.env[k] = savedEnv[k];
	}
});

describe.skipIf(!MODE)('plan job: event-loop delay and wall time', { timeout: 3_600_000 }, () => {
	it(`first plan with every style option (${MODE})`, async () => {
		const STYLE = { seed: 11, roomGlue: true, stopBefore: true, build: true, delivery: 'web' } as const;
		const h = monitorEventLoopDelay({ resolution: 10 });
		let probeMax = 0;
		let probes = 0;
		let stop = false;
		const probe = (async () => {
			while (!stop) {
				const t = performance.now();
				const r = await app.inject({ method: 'GET', url: '/health', headers: HOST });
				probeMax = Math.max(probeMax, performance.now() - t);
				probes++;
				expect(r.statusCode).toBe(200);
				await new Promise((res) => setTimeout(res, 50));
			}
		})();
		const load0 = loadavg();
		h.enable();
		const run = await plan({ projectId, sequenceId: seqId, style: STYLE });
		h.disable();
		stop = true;
		await probe;
		const load1 = loadavg();
		const ms = (ns: number) => Math.round(ns / 1e5) / 10;
		const line = {
			mode: MODE,
			measurer: soundDesignMeasurer().lastMode,
			wallMs: run.ms,
			loopDelayMs: { max: ms(h.max), p99: ms(h.percentile(99)), p90: ms(h.percentile(90)), mean: ms(h.mean) },
			healthProbe: { maxMs: Math.round(probeMax), count: probes },
			placed: run.result.report.counts.placed,
			warnings: run.result.report.warnings.map((w) => w.code),
			levels: run.result.report.levels ?? null,
			load: { before: load0.map((x) => Math.round(x)), after: load1.map((x) => Math.round(x)) },
			cpus: cpus().length,
			at: new Date().toISOString(),
		};
		process.stderr.write(`SD_PLAN_BENCH ${JSON.stringify(line)}\n`);
		if (process.env.SD_PLAN_BENCH_OUT)
			appendFileSync(process.env.SD_PLAN_BENCH_OUT, `${JSON.stringify(line)}\n`);
		expect(line.measurer).toBe(MODE === 'worker' ? 'worker' : 'thread');
	});
});
