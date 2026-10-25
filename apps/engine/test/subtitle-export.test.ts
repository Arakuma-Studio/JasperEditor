// spec 13 AS-072 / AS-074 end to end on the native path (ffmpeg, no Remotion): constant-picture layers of a track
// share one kernel stream (inputs do not grow with the clip count; frames equal the one-input-per-layer composite),
// the planner refuses a composite that cannot fit in memory, and a compositor killed by the system (as by the OOM
// killer) or starved by a memory cap ends the job with an error while the engine keeps serving.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildNativeGraph } from '../src/export/native.ts';
import { coreServices } from '../src/tools/services.ts';
import {
	closeApps,
	DocBuilder,
	ensureFixtures,
	JSON_H,
	makeApp,
	register,
	TEST_FFMPEG,
	type TestApp,
} from './helpers.ts';

const FWD_ENV: Record<string, string> = {};
for (const k of ['JASPER_FFMPEG', 'JASPER_FFPROBE']) if (process.env[k]) FWD_ENV[k] = process.env[k]!;
const W = 1920;
const H = 1080;

function makePicture(): string {
	const dir = mkdtempSync(join(tmpdir(), 'jasper-subexp-'));
	const out = join(dir, 'card.png');
	const r = spawnSync(TEST_FFMPEG, [
		...['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=1', '-frames:v', '1', out],
	]);
	if (r.status !== 0) throw new Error(r.stderr.toString());
	return out;
}

/** `n` stills back to back on V2 (8 frames each) over a dark solid, each with sub-pixel keyframed Motion. */
async function stillsDoc(app: TestApp, n: number) {
	const card = await register(app, makePicture());
	const d = new DocBuilder();
	const media = d.addMedia(card);
	d.tx([{ type: 'clip.addSolid', at: 0, duration: n * 8, track: 'V1', color: [0.08, 0.08, 0.08, 1] }]);
	const cmds: unknown[] = [];
	for (let i = 0; i < n; i++)
		cmds.push({
			type: 'clip.place',
			source: { mediaId: media },
			at: i * 8,
			duration: 8,
			tracks: { video: 'V2' },
			ref: `$c${i}`,
		});
	const refs = d.tx(cmds).refs;
	const keys: unknown[] = [];
	for (let i = 0; i < n; i++) {
		const t = (p: string) => ['clip', refs[`$c${i}`], 'transform', p];
		keys.push(
			{
				type: 'keyframe.add',
				target: t('position'),
				at: { sequenceFrame: i * 8 },
				value: [700.37 + i, 500.2],
			},
			{
				type: 'keyframe.add',
				target: t('position'),
				at: { sequenceFrame: i * 8 + 7 },
				value: [760.9, 530.6],
			},
			{ type: 'keyframe.add', target: t('scale'), at: { sequenceFrame: i * 8 }, value: 75 },
			{ type: 'keyframe.add', target: t('scale'), at: { sequenceFrame: i * 8 + 4 }, value: 108 },
			{ type: 'keyframe.add', target: t('scale'), at: { sequenceFrame: i * 8 + 7 }, value: 100 },
		);
	}
	d.tx(keys);
	return d;
}

const settings = (seqId: string, frames: number, engine: 'auto' | 'native' = 'auto') => ({
	sequenceId: seqId,
	range: { type: 'custom', startFrame: 0, endFrame: frames },
	container: 'mov',
	engine,
	video: {
		codec: 'prores',
		proresProfile: '4444',
		width: W,
		height: H,
		frameRate: { num: 30, den: 1 },
		scaling: 'fit',
		quality: { mode: 'crf', value: 10 },
		encoderSpeed: 'fast',
	},
});

function decodeAll(file: string): Buffer[] {
	const r = spawnSync(
		TEST_FFMPEG,
		['-v', 'error', '-i', file, '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'],
		{
			maxBuffer: 1 << 30,
		},
	);
	if (r.status !== 0) throw new Error(`decode failed: ${r.stderr}`);
	const size = W * H * 3;
	return Array.from({ length: r.stdout.length / size }, (_, i) =>
		r.stdout.subarray(i * size, (i + 1) * size),
	);
}

let app: TestApp;
beforeAll(async () => {
	ensureFixtures();
	app = await makeApp({ env: FWD_ENV });
}, 180_000);
afterAll(closeApps);

async function startExport(a: TestApp, d: DocBuilder, s: Record<string, unknown>) {
	const start = await a.inject({
		method: 'POST',
		url: '/api/exports',
		headers: JSON_H,
		payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: s },
	});
	expect(start.statusCode, start.body).toBe(202);
	return coreServices(a).queue.wait(start.json().id);
}

describe('kernel streams (spec 13 AS-072)', () => {
	it('stills with sub-pixel Motion on one track: one pipe, and the same frames as one input per layer', async () => {
		const n = 12;
		const d = await stillsDoc(app, n);
		const s = settings(d.seqId, n * 8);
		const planned = await coreServices(app).exports.plan({
			envelope: d.envelope(),
			sequenceId: d.seqId,
			settings: s as never,
		});
		expect(planned.plan.path).toBe('native');
		const graph = (trackStreams: boolean) =>
			buildNativeGraph({
				snapshot: planned.snapshot,
				output: planned.output,
				outputFile: '/tmp/x.mov',
				sources: { media: (id) => planned.media[id] ?? null, mgMaster: () => null },
				threads: 2,
				extensions: { list: [], prepared: new Map() },
				trackStreams,
			});
		const grouped = graph(true);
		const single = graph(false);
		expect(grouped.streams).toHaveLength(1);
		expect(single.streams).toHaveLength(n);
		expect(grouped.inputs.length).toBe(1);
		expect(single.inputs.length).toBe(n);

		const a = await startExport(app, d, s);
		expect(a.error, JSON.stringify(a.error)).toBeUndefined();
		process.env.JASPER_EXPORT_TRACK_STREAMS = '0';
		let b: Awaited<ReturnType<typeof startExport>>;
		try {
			b = await startExport(app, d, s);
		} finally {
			delete process.env.JASPER_EXPORT_TRACK_STREAMS;
		}
		expect(b.error, JSON.stringify(b.error)).toBeUndefined();
		const fa = decodeAll((await coreServices(app).exports.outputFile(a.id))!);
		const fb = decodeAll((await coreServices(app).exports.outputFile(b.id))!);
		expect(fa).toHaveLength(n * 8);
		expect(fb).toHaveLength(n * 8);
		let worst = 0;
		for (let f = 0; f < fa.length; f++)
			for (let i = 0; i < fa[f]!.length; i++) worst = Math.max(worst, Math.abs(fa[f]![i]! - fb[f]![i]!));
		expect(worst, 'max channel difference').toBe(0);
	}, 600_000);

	it('the composite’s inputs do not grow with the clip count (300 stills: still one pipe)', async () => {
		const d = await stillsDoc(app, 300);
		const planned = await coreServices(app).exports.plan({
			envelope: d.envelope(),
			sequenceId: d.seqId,
			settings: settings(d.seqId, 2400) as never,
		});
		const g = buildNativeGraph({
			snapshot: planned.snapshot,
			output: planned.output,
			outputFile: '/tmp/x.mov',
			sources: { media: (id) => planned.media[id] ?? null, mgMaster: () => null },
			threads: 2,
			extensions: { list: [], prepared: new Map() },
		});
		expect(g.streams).toHaveLength(1);
		expect(g.inputs).toHaveLength(1);
		expect((g.filter.match(/overlay=/g) ?? []).length).toBe(1);
	}, 300_000);
});

describe('memory preflight and killed compositors (spec 13 AS-074)', () => {
	it('a composite over the memory budget is refused by name: auto goes to Remotion, native is not eligible', async () => {
		const d = await stillsDoc(app, 4);
		process.env.JASPER_EXPORT_MEMORY_BUDGET_MB = '1';
		try {
			const r = await app.inject({
				method: 'POST',
				url: '/api/exports/plan',
				headers: JSON_H,
				payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId, 32) },
			});
			expect(r.statusCode, r.body).toBe(200);
			const p = r.json() as { path: string; blockers: { reason: string }[] };
			expect(p.path).toBe('remotion');
			expect(p.blockers.map((b) => b.reason).join('\n')).toMatch(/native composite needs ≈ .* GB of memory/);
			const n = await app.inject({
				method: 'POST',
				url: '/api/exports/plan',
				headers: JSON_H,
				payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId, 32, 'native') },
			});
			expect(n.statusCode).toBe(409);
			expect(n.json().code).toBe('PATH_NOT_ELIGIBLE');
		} finally {
			delete process.env.JASPER_EXPORT_MEMORY_BUDGET_MB;
		}
	}, 300_000);

	/** An engine whose ffmpeg runs the composite (the call with an overlay) through `wrap`. */
	async function wrappedEngine(wrap: string): Promise<TestApp> {
		const dir = mkdtempSync(join(tmpdir(), 'jasper-oom-'));
		const bin = join(dir, 'ffmpeg');
		writeFileSync(bin, `#!/bin/sh\ncase " $* " in *overlay=*) ${wrap} ;; esac\nexec "${TEST_FFMPEG}" "$@"\n`);
		chmodSync(bin, 0o755);
		return makeApp({ env: { ...FWD_ENV, JASPER_FFMPEG: bin } });
	}

	it('a compositor killed by the system (SIGKILL, as by the OOM killer) fails the job with OUT_OF_MEMORY; the engine lives', async () => {
		const killer = await wrappedEngine('kill -9 $$');
		const d = await stillsDoc(killer, 3);
		const done = await startExport(killer, d, settings(d.seqId, 24, 'native'));
		expect(done.state).toBe('failed');
		expect(done.error?.code).toBe('OUT_OF_MEMORY');
		expect(done.error?.message).toMatch(/killed by the system.*out of memory/);
		// The engine still plans and answers.
		const again = await killer.inject({
			method: 'POST',
			url: '/api/exports/plan',
			headers: JSON_H,
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId, 24) },
		});
		expect(again.statusCode).toBe(200);
	}, 300_000);

	it('a compositor under a memory cap fails the job with its error; the engine lives', async () => {
		const capped = await wrappedEngine('ulimit -v 150000');
		const d = await stillsDoc(capped, 3);
		const done = await startExport(capped, d, settings(d.seqId, 24, 'native'));
		expect(done.state).toBe('failed');
		expect(done.error?.code).toMatch(/^(TOOL_FAILED|OUT_OF_MEMORY)$/);
		expect(done.error?.message.length).toBeGreaterThan(10);
		const again = await capped.inject({ method: 'GET', url: '/api/exports', headers: JSON_H });
		expect(again.statusCode).toBeLessThan(500);
	}, 300_000);
});
