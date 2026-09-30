// Motion-graphics service and routes (WP-2G). The render tests need the jasper-mg binary
// (`pnpm mg:build`) and ffmpeg/ffprobe; they skip with a message otherwise.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineJobSchema, MgTemplatesResponseSchema } from '@jasper/api';
import { lowerThird, mgRegistry } from '@jasper/mg-templates';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, engineConfig } from '../src/index.ts';
import {
	createMgService,
	ffmpegArgs,
	type MgService,
	mgMasterHook,
	resolveMgBinary,
} from '../src/mg/index.ts';

const H = { host: '127.0.0.1:47900' };
const apps: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
	for (const a of apps.splice(0)) await a.close();
});

async function makeServer(env: Record<string, string | undefined>) {
	const saved: Record<string, string | undefined> = {};
	for (const [k, v] of Object.entries(env)) {
		saved[k] = process.env[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	try {
		const appdir = mkdtempSync(join(tmpdir(), 'jasper-mg-engine-'));
		const app = await createServer(
			engineConfig({ appdir, port: 47900, dev: true, token: null, webDir: null, env: {} }),
		);
		apps.push(app);
		return { app, appdir };
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

const lt150 = {
	template: { id: 'lower-third', version: 1 },
	params: { name: 'Ana Ruiz', title: 'Director' },
	width: 1920,
	height: 1080,
	fps: { num: 30, den: 1 },
	durationFrames: 150,
};

describe('jasper-mg resolution and capability', () => {
	it('an explicit JASPER_MG that does not exist is unavailable with a reason (no fallback)', () => {
		const r = resolveMgBinary({ env: { JASPER_MG: '/nonexistent/jasper-mg' } });
		expect(r.path).toBeNull();
		expect(r.path === null && r.reason).toContain('/nonexistent/jasper-mg');
	});

	it('reports unavailable outside a checkout without a binary', () => {
		const empty = mkdtempSync(join(tmpdir(), 'jasper-mg-none-'));
		const r = resolveMgBinary({ env: {}, searchFrom: [empty], resourcesPath: empty });
		expect(r.path).toBeNull();
	});

	it('degrades gracefully: TS catalog flagged native:false, render → 503 MG_UNAVAILABLE', async () => {
		const { app } = await makeServer({ JASPER_MG: '/nonexistent' });
		const res = await app.inject({ method: 'GET', url: '/api/motion-graphics/templates', headers: H });
		expect(res.statusCode).toBe(200);
		const body = MgTemplatesResponseSchema.parse(res.json());
		expect(body.renderer.status).toBe('unavailable');
		expect(body.renderer.reason).toContain('JASPER_MG=/nonexistent');
		expect(body.templates.map((t) => [t.id, t.native])).toEqual([
			['lower-third', false],
			['title-card', false],
		]);
		expect(body.templates[0]!.defaults).toEqual(lowerThird.defaults);
		const service = app.jasper.services.mg as MgService;
		expect(service.capability()).toEqual({
			fframes: 'unavailable',
			fframesReason: expect.stringContaining('/nonexistent'),
		});
		// Integration: the MG capability provider is registered with WP-2F's /api/capabilities.
		const caps = await app.inject({ method: 'GET', url: '/api/capabilities', headers: H });
		expect(caps.statusCode).toBe(200);
		expect(caps.json().render).toMatchObject({ fframes: 'unavailable' });
		const render = await app.inject({
			method: 'POST',
			url: '/api/motion-graphics/render',
			headers: { ...H, 'content-type': 'application/json' },
			payload: { spec: lt150, quality: 'master' },
		});
		expect(render.statusCode).toBe(503);
		expect(render.json()).toMatchObject({ code: 'MG_UNAVAILABLE' });
		expect(
			await service.mgMasterProvider(
				{
					source: { mg: { template: lt150.template, params: {}, canvas: { width: 1920, height: 1080 } } },
					duration: 30,
					sourceIn: 0,
				},
				{ fps: { num: 30, den: 1 } },
			),
		).toBeNull();
	});

	it('validates requests and file names', async () => {
		const { app } = await makeServer({ JASPER_MG: '/nonexistent' });
		const bad = await app.inject({
			method: 'POST',
			url: '/api/motion-graphics/render',
			headers: { ...H, 'content-type': 'application/json' },
			payload: { spec: { ...lt150, width: 0 }, quality: 'master' },
		});
		expect(bad.statusCode).toBe(400);
		expect(bad.json().code).toBe('VALIDATION_FAILED');
		for (const url of [
			'/mg/nothex/master.mov',
			`/mg/${'a'.repeat(40)}/master.mov`,
			`/mg/${'a'.repeat(40)}/..%2Fx`,
		]) {
			const r = await app.inject({ method: 'GET', url, headers: H });
			expect(r.statusCode, url).toBe(404);
		}
	});

	it('builds the documented ffmpeg pipe arguments', () => {
		const args = ffmpegArgs(lt150, { master: 'm.mov', preview: 'p.webm' }, 4);
		expect(args.join(' ')).toContain('-f rawvideo -pix_fmt rgba -s 1920x1080 -r 30/1 -i pipe:0');
		expect(args.join(' ')).toContain('-c:v prores_ks -profile:v 4 -pix_fmt yuva444p10le');
		expect(args.join(' ')).toContain('-c:v libvpx-vp9 -pix_fmt yuva420p');
		expect(ffmpegArgs(lt150, { master: 'm.mov' }, 4)).not.toContain('libvpx-vp9');
	});
});

// ------------------------------------------------------------------ real renders (gated)

const resolution = resolveMgBinary({ env: {} });
const hasFfmpeg =
	spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const canRender = resolution.path !== null && hasFfmpeg;
if (!canRender)
	console.info(
		`[mg] real render tests skipped: ${resolution.path === null ? `${resolution.reason}` : 'ffmpeg/ffprobe not on PATH'}`,
	);

function pixelAt(file: string, frame: number, x: number, y: number): number[] {
	const raw = execFileSync('ffmpeg', [
		'-v',
		'error',
		'-i',
		file,
		'-vf',
		`select=eq(n\\,${frame}),crop=1:1:${x}:${y},format=rgba`,
		'-frames:v',
		'1',
		'-f',
		'rawvideo',
		'-',
	]);
	return [...raw];
}

describe.skipIf(!canRender)('real jasper-mg renders', () => {
	let app: Awaited<ReturnType<typeof makeServer>>['app'];
	let appdir: string;
	beforeAll(async () => {
		({ app, appdir } = await makeServer({ JASPER_MG: undefined }));
		apps.splice(apps.indexOf(app), 1); // keep the server for the whole block
	});
	afterAll(async () => {
		await app?.close();
	});

	it('renders lower-third 1920x1080 @30 for 150 frames into a verified ProRes 4444 master', async () => {
		const templates = MgTemplatesResponseSchema.parse(
			(await app.inject({ method: 'GET', url: '/api/motion-graphics/templates', headers: H })).json(),
		);
		expect(templates.renderer.status).toBe('ready');
		expect(templates.templates.every((t) => t.native)).toBe(true);

		const res = await app.inject({
			method: 'POST',
			url: '/api/motion-graphics/render?wait=1',
			headers: { ...H, 'content-type': 'application/json' },
			payload: { spec: lt150, quality: 'preview' },
		});
		expect(res.statusCode).toBe(200);
		const job = EngineJobSchema.parse(res.json());
		expect(job).toMatchObject({ kind: 'mg-render', state: 'succeeded', cpuSlots: 4 });
		const { key, url } = job.result as { key: string; url: string };
		expect(url).toBe(`/mg/${key}/preview.webm`);
		const dir = join(appdir, 'mg', key);
		expect(readdirSync(dir).sort()).toEqual(['master.mov', 'meta.json', 'poster.png', 'preview.webm']);

		const probe = JSON.parse(
			execFileSync(
				'ffprobe',
				[
					'-v',
					'error',
					'-count_frames',
					'-select_streams',
					'v:0',
					'-show_entries',
					'stream=codec_name,pix_fmt,width,height,nb_read_frames',
					'-of',
					'json',
					join(dir, 'master.mov'),
				],
				{ encoding: 'utf8' },
			),
		).streams[0];
		expect(probe).toMatchObject({ codec_name: 'prores', width: 1920, height: 1080, nb_read_frames: '150' });
		expect(probe.pix_fmt).toMatch(/^yuva444p/);
		// straight alpha: the panel ([0.04, 0.06, 0.12, 0.78]) keeps its color at 78 % alpha
		const [r, g, b, a] = pixelAt(join(dir, 'master.mov'), 60, 300, 900);
		expect(a).toBeGreaterThan(190);
		expect(a).toBeLessThan(210);
		expect(Math.abs(r! - 10) + Math.abs(g! - 15) + Math.abs(b! - 31)).toBeLessThan(12);
		expect(pixelAt(join(dir, 'master.mov'), 60, 1500, 100)[3]).toBe(0);

		// Range requests on the cached master
		const ranged = await app.inject({
			method: 'GET',
			url: `/mg/${key}/master.mov`,
			headers: { ...H, range: 'bytes=0-99' },
		});
		expect(ranged.statusCode).toBe(206);
		expect(ranged.rawPayload.length).toBe(100);
		expect(ranged.headers['content-range']).toMatch(/^bytes 0-99\/\d+$/);
		const full = await app.inject({ method: 'GET', url: `/mg/${key}/preview.webm`, headers: H });
		expect(full.statusCode).toBe(200);
		expect(full.headers['content-type']).toBe('video/webm');

		// content-addressed cache: same spec (defaults spelled out) → immediate success, same key
		const again = await app.inject({
			method: 'POST',
			url: '/api/motion-graphics/render',
			headers: { ...H, 'content-type': 'application/json' },
			payload: { spec: { ...lt150, params: { ...lowerThird.defaults, ...lt150.params } }, quality: 'master' },
		});
		expect(again.json()).toMatchObject({ state: 'succeeded', result: { key } });

		// the native export hook returns the cached master for an equivalent clip
		const service = app.jasper.services.mg as MgService;
		const master = await service.mgMasterProvider(
			{
				source: {
					mg: { template: lt150.template, params: lt150.params, canvas: { width: 1920, height: 1080 } },
				},
				duration: 150,
				sourceIn: 0,
			},
			{ fps: { num: 30, den: 1 } },
		);
		expect(master).toBe(join(dir, 'master.mov'));
	}, 120_000);

	it('rejects invalid params with 400 and cancels running renders without leftovers', async () => {
		const bad = await app.inject({
			method: 'POST',
			url: '/api/motion-graphics/render',
			headers: { ...H, 'content-type': 'application/json' },
			payload: { spec: { ...lt150, params: { bogus: true } }, quality: 'master' },
		});
		expect(bad.statusCode).toBe(400);
		expect(bad.json().code).toBe('INVALID_SPEC');
		const unknown = await app.inject({
			method: 'POST',
			url: '/api/motion-graphics/render',
			headers: { ...H, 'content-type': 'application/json' },
			payload: { spec: { ...lt150, template: { id: 'nope', version: 1 } }, quality: 'master' },
		});
		expect(unknown.json().code).toBe('TEMPLATE_NOT_FOUND');

		const service = app.jasper.services.mg as MgService;
		const { job, done } = service.requestRender({ ...lt150, durationFrames: 3000 }, 'master');
		await new Promise((r) => setTimeout(r, 400));
		service.cancel(job.id);
		const final = await done;
		expect(final.state).toBe('cancelled');
		const dir = join(
			appdir,
			'mg',
			service.renderKey(service.validateSpec({ ...lt150, durationFrames: 3000 })),
		);
		expect(existsSync(join(dir, 'master.mov'))).toBe(false);
		expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);

		// the export hook (WP-2F registerMgMasterProvider shape) stops and cancels its render on abort
		const long = { ...lt150, durationFrames: 3001 };
		const ac = new AbortController();
		const pending = mgMasterHook(service)({
			clip: {
				source: {
					mg: { template: long.template, params: long.params, canvas: { width: 1920, height: 1080 } },
				},
				duration: long.durationFrames,
				sourceIn: 0,
			},
			fps: long.fps,
			signal: ac.signal,
		});
		await new Promise((r) => setTimeout(r, 400));
		const hookJob = service.listJobs().find((j) => j.state === 'running' && j.origin.type === 'system');
		expect(hookJob).toBeDefined();
		ac.abort();
		expect(await pending).toBeNull();
		await vi.waitFor(() => expect(service.getJob(hookJob!.id)?.state).toBe('cancelled'), { timeout: 10_000 });

		// shutdown cancels running renders and leaves no temp output behind
		const last = { ...lt150, durationFrames: 3002 };
		const { job: running, done: runningDone } = service.requestRender(last, 'master');
		await new Promise((r) => setTimeout(r, 400));
		await service.shutdown();
		expect((await runningDone).state).toBe('cancelled');
		expect(service.getJob(running.id)?.state).toBe('cancelled');
		const lastDir = join(appdir, 'mg', service.renderKey(service.validateSpec(last)));
		expect(existsSync(lastDir) ? readdirSync(lastDir) : []).toEqual([]);
	}, 60_000);
});

describe('service without a server', () => {
	it('uses the TS registry to validate and keys renders deterministically', async () => {
		const service = createMgService({
			mgDir: mkdtempSync(join(tmpdir(), 'jasper-mg-svc-')),
			env: { JASPER_MG: '/nonexistent' },
		});
		await service.refresh();
		const a = service.renderKey(service.validateSpec(lt150));
		const b = service.renderKey(
			service.validateSpec({ ...lt150, params: { title: 'Director', name: 'Ana Ruiz' } }),
		);
		expect(a).toMatch(/^[0-9a-f]{40}$/);
		expect(a).toBe(b);
		expect(service.renderKey(service.validateSpec({ ...lt150, durationFrames: 151 }))).not.toBe(a);
		expect(() => service.validateSpec({ ...lt150, template: { id: 'x', version: 1 } })).toThrow(
			/Unknown template/,
		);
		expect(() => service.requestRender(lt150, 'master')).toThrow();
		expect(mgRegistry.list()).toHaveLength(2);
	});
});
