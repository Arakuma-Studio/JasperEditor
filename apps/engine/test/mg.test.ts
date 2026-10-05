// Motion-graphics service and routes (WP-2G). The render tests need the jasper-mg binary
// (`pnpm mg:build`) and ffmpeg/ffprobe; they skip with a message otherwise.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineJobSchema, MgTemplatesResponseSchema } from '@jasper/api';
import { lowerThird } from '@jasper/mg-templates';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, engineConfig } from '../src/index.ts';
import { createMgService, type MgService, resolveMgBinary } from '../src/mg/index.ts';

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
	it('degrades gracefully: TS catalog flagged native:false, render → 503 MG_UNAVAILABLE', async () => {
		const { app } = await makeServer({ JASPER_MG: '/nonexistent' });
		const res = await app.inject({ method: 'GET', url: '/api/motion-graphics/templates', headers: H });
		expect(res.statusCode).toBe(200);
		const body = MgTemplatesResponseSchema.parse(res.json());
		expect(body.renderer.status).toBe('unavailable');
		expect(body.renderer.reason).toContain('JASPER_MG=/nonexistent');
		expect(body.templates.some((t) => t.id === 'lower-third' && t.native === false)).toBe(true);
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
	});

	it('validates requests and file names', async () => {
		const { app, appdir } = await makeServer({ JASPER_MG: '/nonexistent' });
		const bad = await app.inject({
			method: 'POST',
			url: '/api/motion-graphics/render',
			headers: { ...H, 'content-type': 'application/json' },
			payload: { spec: { ...lt150, width: 0 }, quality: 'master' },
		});
		expect(bad.statusCode).toBe(400);
		expect(bad.json().code).toBe('VALIDATION_FAILED');
		const key = 'a'.repeat(40);
		for (const name of [key, 'nothex']) {
			mkdirSync(join(appdir, 'mg', name), { recursive: true });
			writeFileSync(join(appdir, 'mg', name, 'master.mov'), 'cached master');
		}
		writeFileSync(join(appdir, 'mg', 'x'), 'private file');
		const valid = await app.inject({ method: 'GET', url: `/mg/${key}/master.mov`, headers: H });
		expect(valid.statusCode).toBe(200);
		expect(valid.body).toBe('cached master');
		for (const url of ['/mg/nothex/master.mov', `/mg/${key}/..%2Fx`]) {
			const r = await app.inject({ method: 'GET', url, headers: H });
			expect(r.statusCode, url).toBe(404);
		}
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
		const res = await app.inject({
			method: 'POST',
			url: '/api/motion-graphics/render?wait=1',
			headers: { ...H, 'content-type': 'application/json' },
			payload: { spec: lt150, quality: 'preview' },
		});
		expect(res.statusCode).toBe(200);
		const job = EngineJobSchema.parse(res.json());
		expect(job).toMatchObject({ kind: 'mg-render', state: 'succeeded' });
		const { key, url } = job.result as { key: string; url: string };
		expect(url).toBe(`/mg/${key}/preview.webm`);
		const dir = join(appdir, 'mg', key);

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
	}, 600_000);

	it('mg-render jobs are listed, cancelled and retried through /api/jobs (WP-3I)', async () => {
		const spec = { ...lt150, durationFrames: 2990 };
		const started = await app.inject({
			method: 'POST',
			url: '/api/motion-graphics/render',
			headers: { ...H, 'content-type': 'application/json' },
			payload: { spec, quality: 'master' },
		});
		expect(started.statusCode).toBe(202);
		const id = started.json().id as string;
		const listed = (await app.inject({ method: 'GET', url: '/api/jobs?active=1', headers: H })).json().jobs;
		expect(listed.some((j: { id: string; kind: string }) => j.id === id && j.kind === 'mg-render')).toBe(
			true,
		);
		const one = await app.inject({ method: 'GET', url: `/api/jobs/${id}`, headers: H });
		expect(one.statusCode).toBe(200);
		expect(one.json()).toMatchObject({ id, kind: 'mg-render' });
		await new Promise((r) => setTimeout(r, 300));
		const cancelled = await app.inject({ method: 'POST', url: `/api/jobs/${id}/cancel`, headers: H });
		expect(cancelled.statusCode).toBe(200);
		const service = app.jasper.services.mg as MgService;
		await vi.waitFor(() => expect(service.getJob(id)?.state).toBe('cancelled'), { timeout: 10_000 });
		const retried = await app.inject({ method: 'POST', url: `/api/jobs/${id}/retry`, headers: H });
		expect(retried.statusCode).toBe(200);
		const retryId = retried.json().id as string;
		expect(retryId).not.toBe(id);
		expect(retried.json()).toMatchObject({ kind: 'mg-render' });
		await app.inject({ method: 'POST', url: `/api/jobs/${retryId}/cancel`, headers: H });
		await vi.waitFor(() => expect(service.getJob(retryId)?.state).toBe('cancelled'), { timeout: 10_000 });
		const unknown = await app.inject({ method: 'GET', url: '/api/jobs/job_mg_doesnotexist', headers: H });
		expect(unknown.statusCode).toBe(404);
	}, 60_000);

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
		expect(a).toBe(b);
		expect(service.renderKey(service.validateSpec({ ...lt150, durationFrames: 151 }))).not.toBe(a);
	});
});
