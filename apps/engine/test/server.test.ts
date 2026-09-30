import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROUTES } from '@jasper/api';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, engineConfig, startEngine } from '../src/index.ts';

const apps: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
	for (const a of apps.splice(0)) await a.close();
});

async function make(opts: { token?: string | null; dev?: boolean; webDir?: string | null } = {}) {
	const appdir = mkdtempSync(join(tmpdir(), 'jasper-engine-'));
	const config = engineConfig({
		appdir,
		port: 47900,
		dev: opts.dev ?? true,
		token: opts.token ?? null,
		webDir: opts.webDir ?? null,
		env: {},
	});
	const app = await createServer(config, { env: { PATH: process.env.PATH } });
	apps.push(app);
	return app;
}
const H = { host: '127.0.0.1:47900' };

describe('engine server (ARCHITECTURE §9.1, §4.2)', () => {
	it('GET /health returns ok with the API header', async () => {
		const app = await make();
		const r = await app.inject({ method: 'GET', url: '/health', headers: H });
		expect(r.statusCode).toBe(200);
		expect(r.json()).toEqual({ ok: true, version: '0.1.0', apiVersion: 1 });
		expect(r.headers['x-jasper-api']).toBe('1');
	});

	it('every §9.2 route is registered: WP-2F routes are implemented, others answer 501', async () => {
		const app = await make();
		for (const [name, route] of Object.entries(ROUTES)) {
			// /events streams (tested in events.test.ts); mg* are implemented by WP-2G (test/mg.test.ts) and
			// agent* by WP-2H (test/agent.test.ts).
			if (name === 'health' || name === 'events' || name.startsWith('mg') || name.startsWith('agent'))
				continue;
			const url = route.path
				.replace(/:([A-Za-z]+)/g, (_, p: string) => (p === 'projectId' ? 'prj_0000000000000001' : `x${p}`))
				.replace('*', 'inter/400.woff2');
			const r = await app.inject({
				method: route.method,
				url:
					route.path.includes('/api/uploads/:uploadId') && route.method === 'PUT' ? `${url}?offset=0` : url,
				headers: {
					...H,
					...(route.method === 'POST' || route.method === 'PUT'
						? { 'content-type': 'application/json' }
						: {}),
				},
				payload: route.method === 'POST' || route.method === 'PUT' ? '{}' : undefined,
			});
			expect(r.headers['x-jasper-api'], `${route.method} ${route.path}`).toBe('1');
			if (route.owner === 'WP-2F') {
				expect(r.statusCode, `${route.method} ${route.path}`).not.toBe(501);
				if (r.statusCode >= 400) expect(r.json()).toHaveProperty('code');
			} else {
				expect(r.statusCode, `${route.method} ${route.path}`).toBe(501);
				expect(r.json()).toMatchObject({ code: 'NOT_IMPLEMENTED', retryable: false });
			}
		}
	});

	it('rejects foreign Host headers (DNS-rebinding defense)', async () => {
		const app = await make();
		const r = await app.inject({ method: 'GET', url: '/health', headers: { host: 'evil.example:47900' } });
		expect(r.statusCode).toBe(403);
		expect(r.json()).toMatchObject({ code: 'FORBIDDEN_HOST' });
		expect(
			(await app.inject({ method: 'GET', url: '/health', headers: { host: 'localhost:47900' } })).statusCode,
		).toBe(200);
		expect(
			(await app.inject({ method: 'GET', url: '/health', headers: { host: '127.0.0.1:5173' } })).statusCode,
		).toBe(200);
		const prod = await make({ dev: false });
		expect(
			(await prod.inject({ method: 'GET', url: '/health', headers: { host: '127.0.0.1:5173' } })).statusCode,
		).toBe(403);
	});

	it('local token mode requires the bearer token or session cookie, except /health', async () => {
		const app = await make({ dev: false, token: 's3cret' });
		expect((await app.inject({ method: 'GET', url: '/health', headers: H })).statusCode).toBe(200);
		const denied = await app.inject({ method: 'GET', url: '/api/capabilities', headers: H });
		expect(denied.statusCode).toBe(401);
		expect(denied.json()).toMatchObject({ code: 'UNAUTHORIZED' });
		expect(
			(
				await app.inject({
					method: 'GET',
					url: '/api/capabilities',
					headers: { ...H, authorization: 'Bearer s3cret' },
				})
			).statusCode,
		).toBe(200);
		expect(
			(
				await app.inject({
					method: 'GET',
					url: '/api/capabilities',
					headers: { ...H, cookie: 'a=b; jasper_session=s3cret' },
				})
			).statusCode,
		).toBe(200);
		expect(
			(
				await app.inject({
					method: 'GET',
					url: '/api/capabilities',
					headers: { ...H, authorization: 'Bearer nope' },
				})
			).statusCode,
		).toBe(401);
	});

	it('serves the SPA with a fallback that never shadows engine paths', async () => {
		const web = mkdtempSync(join(tmpdir(), 'jasper-web-'));
		mkdirSync(join(web, 'assets'));
		writeFileSync(join(web, 'index.html'), '<!doctype html><div id="root"></div>');
		writeFileSync(join(web, 'assets', 'app.js'), 'console.log(1)');
		const app = await make({ webDir: web });
		const index = await app.inject({ method: 'GET', url: '/', headers: { ...H, accept: 'text/html' } });
		expect(index.statusCode).toBe(200);
		expect(index.body).toContain('id="root"');
		const deep = await app.inject({
			method: 'GET',
			url: '/project/prj_1',
			headers: { ...H, accept: 'text/html' },
		});
		expect(deep.body).toContain('id="root"');
		expect((await app.inject({ method: 'GET', url: '/assets/app.js', headers: H })).body).toContain(
			'console.log',
		);
		for (const url of [
			'/api/nope',
			'/events/x',
			'/media/mk_1/unknown/x',
			'/mg/a/b/c',
			'/renders/x',
			'/agent/x',
			'/fonts',
			'/health/x',
		]) {
			const r = await app.inject({ method: 'GET', url, headers: { ...H, accept: 'text/html' } });
			expect(r.statusCode, url).toBe(404);
			expect(r.json()).toMatchObject({ code: 'NOT_FOUND' });
		}
	});

	it('uses the ENG-022 error shape for bad requests and unknown routes', async () => {
		const app = await make();
		const r = await app.inject({ method: 'POST', url: '/api/nothing', headers: H });
		expect(r.statusCode).toBe(404);
		expect(r.json()).toEqual({
			code: 'NOT_FOUND',
			message: 'No route for POST /api/nothing',
			retryable: false,
		});
		const bad = await app.inject({
			method: 'POST',
			url: '/api/projects',
			headers: { ...H, 'content-type': 'application/json' },
			payload: '{bad',
		});
		expect(bad.statusCode).toBe(400);
		expect(bad.json().code).toBe('VALIDATION_FAILED');
	});

	it('rejects cross-origin requests (same-origin only, S04:SC-001)', async () => {
		const app = await make();
		const post = (origin?: string) =>
			app.inject({
				method: 'POST',
				url: '/api/jobs/x/cancel',
				headers: { ...H, ...(origin !== undefined ? { origin } : {}) },
			});
		const evil = await post('https://evil.example');
		expect(evil.statusCode).toBe(403);
		expect(evil.json()).toMatchObject({ code: 'FORBIDDEN_ORIGIN' });
		expect((await post('null')).statusCode).toBe(403);
		// Allowed origins reach the route (404: the job does not exist).
		expect((await post('http://127.0.0.1:47900')).statusCode).toBe(404);
		expect((await post('http://localhost:5173')).statusCode).toBe(404);
		expect((await post()).statusCode).toBe(404);
	});

	it('refuses a non-loopback bind without a token (M1 is loopback only)', async () => {
		const appdir = mkdtempSync(join(tmpdir(), 'jasper-engine-'));
		await expect(startEngine({ appdir, port: 0, host: '0.0.0.0', dev: true, env: {} })).rejects.toThrow(
			/Refusing to bind/,
		);
	});

	it('startEngine listens on a random port and prepares the appdir', async () => {
		const appdir = mkdtempSync(join(tmpdir(), 'jasper-engine-'));
		const engine = await startEngine({ appdir, port: 0, dev: true, env: {} });
		apps.push({ close: () => engine.stop() });
		expect(engine.port).toBeGreaterThan(0);
		const res = await fetch(`${engine.url}/health`);
		expect(res.status).toBe(200);
		expect((await res.json()).ok).toBe(true);
	});
});

describe('appdir preparation', () => {
	it('wipes tmp/ but keeps .gitkeep', async () => {
		const { prepareAppdir } = await import('../src/index.ts');
		const appdir = mkdtempSync(join(tmpdir(), 'jasper-appdir-'));
		mkdirSync(join(appdir, 'tmp', 'job'), { recursive: true });
		writeFileSync(join(appdir, 'tmp', '.gitkeep'), '');
		writeFileSync(join(appdir, 'tmp', 'job', 'x'), 'x');
		prepareAppdir(appdir);
		const { readdirSync } = await import('node:fs');
		expect(readdirSync(join(appdir, 'tmp'))).toEqual(['.gitkeep']);
		expect(readdirSync(appdir).sort()).toEqual([
			'cache',
			'engine',
			'media',
			'mg',
			'projects',
			'renders',
			'tmp',
		]);
	});
});
