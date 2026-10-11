import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
		expect(r.json()).toMatchObject({ ok: true, version: '0.1.0', apiVersion: 1 });
		expect(r.headers['x-jasper-api']).toBe('1');
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
		writeFileSync(join(web, 'assets', 'app-new.js'), 'console.log(2)');
		const fresh = await app.inject({ method: 'GET', url: '/assets/app-new.js', headers: H });
		expect(fresh.statusCode).toBe(200);
		expect(fresh.body).toContain('console.log(2)');
		const missing = await app.inject({
			method: 'GET',
			url: '/assets/gone.js',
			headers: { ...H, accept: '*/*' },
		});
		expect(missing.statusCode).toBe(404);
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
		expect(r.json()).toMatchObject({
			code: 'NOT_FOUND',
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

	it('writes <appdir>/engine/runtime.json (0600) for local tools and removes it on stop', async () => {
		const { existsSync, readFileSync, statSync } = await import('node:fs');
		const appdir = mkdtempSync(join(tmpdir(), 'jasper-engine-'));
		const engine = await startEngine({ appdir, port: 0, dev: false, token: 'tok_runtime', env: {} });
		const file = join(appdir, 'engine', 'runtime.json');
		const info = JSON.parse(readFileSync(file, 'utf8'));
		expect(info).toMatchObject({
			url: engine.url,
			port: engine.port,
			pid: process.pid,
			token: 'tok_runtime',
		});
		if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
		await engine.stop();
		expect(existsSync(file)).toBe(false);
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
	});
});
