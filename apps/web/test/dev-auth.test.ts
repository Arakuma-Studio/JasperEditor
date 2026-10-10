// @vitest-environment node
// The dev server's authentication to the engine (security review DEV-1 / AGT-2, apps/web/dev-auth.ts): the token
// comes from the runtime file the engine's /health names and is added to what the proxy forwards; page loads get
// the dev editor key as an HttpOnly cookie.
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { authenticateProxy, createDevAuth, editorCookieMiddleware } from '../dev-auth.ts';

const KEY = 'k'.repeat(43);

function appdir(port: number, token: string | null, opts: { editorKey?: string | null } = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'jasper-devauth-'));
	mkdirSync(join(dir, 'engine'));
	const runtimeFile = join(dir, 'engine', 'runtime.json');
	let stamp = Date.now() / 1000;
	const write = (t: string | null, p = port) => {
		writeFileSync(
			runtimeFile,
			JSON.stringify({ url: `http://127.0.0.1:${p}`, port: p, pid: process.pid, token: t }),
		);
		// Distinct modification times even on coarse file systems.
		stamp += 2;
		utimesSync(runtimeFile, stamp, stamp);
	};
	write(token);
	if (opts.editorKey !== null)
		writeFileSync(join(dir, 'engine', 'editor-key.dev'), `${opts.editorKey ?? KEY}\n`);
	return { dir, runtimeFile, write };
}

/** An engine's /health as the dev server sees it. */
const health = (runtimeFile: string | null) =>
	(async () => {
		if (runtimeFile === null) throw new Error('ECONNREFUSED');
		return new Response(JSON.stringify({ ok: true, runtimeFile }));
	}) as unknown as typeof fetch;

describe('dev server authentication (DEV-1)', () => {
	it('finds the token through /health and the runtime file, and follows an engine restart', async () => {
		const a = appdir(47900, 'token-1');
		const auth = createDevAuth('http://127.0.0.1:47900', { fetch: health(a.runtimeFile), env: {} });
		await auth.refresh();
		expect(auth.token()).toBe('token-1');
		// `tsx watch` restarts the engine: a new token in the same file, picked up without a refresh or a reload.
		a.write('token-2');
		expect(auth.token()).toBe('token-2');
		rmSync(a.dir, { recursive: true, force: true });
	});

	it('ignores a runtime file that describes another engine', async () => {
		const a = appdir(48000, 'other-engine');
		const auth = createDevAuth('http://127.0.0.1:47900', { fetch: health(a.runtimeFile), env: {} });
		await auth.refresh();
		expect(auth.token()).toBeNull();
		expect(auth.editorCookie()).toBeNull();
		rmSync(a.dir, { recursive: true, force: true });
	});

	it('without an engine yet: no token, and it is found once the engine is up', async () => {
		const a = appdir(47900, 'late');
		let up = false;
		const auth = createDevAuth('http://127.0.0.1:47900', {
			fetch: ((...args: Parameters<typeof fetch>) =>
				health(up ? a.runtimeFile : null)(...args)) as typeof fetch,
			// No appdir hint, and the checkout's own .stage does not describe port 47900 with this token.
			env: { JASPER_APPDIR: join(a.dir, 'nowhere') },
		});
		await auth.refresh();
		expect(auth.token()).not.toBe('late');
		up = true;
		await auth.refresh();
		expect(auth.token()).toBe('late');
		rmSync(a.dir, { recursive: true, force: true });
	});

	it('falls back to JASPER_APPDIR when /health is not answering', async () => {
		const a = appdir(47900, 'from-appdir');
		const auth = createDevAuth('http://127.0.0.1:47900', {
			fetch: health(null),
			env: { JASPER_APPDIR: a.dir },
		});
		await auth.refresh();
		expect(auth.token()).toBe('from-appdir');
		rmSync(a.dir, { recursive: true, force: true });
	});

	it('adds the token to proxied HTTP and WebSocket requests, and keeps a client’s own credentials', async () => {
		const a = appdir(47900, 'proxy-token');
		const auth = createDevAuth('http://127.0.0.1:47900', { fetch: health(a.runtimeFile), env: {} });
		await auth.refresh();
		const proxy = new EventEmitter();
		authenticateProxy(auth)(proxy);
		const forward = (event: 'proxyReq' | 'proxyReqWs', headers: Record<string, string> = {}) => {
			const set: Record<string, string> = {};
			proxy.emit(event, { setHeader: (n: string, v: string) => (set[n] = v) }, { headers });
			return set;
		};
		expect(forward('proxyReq')).toEqual({ authorization: 'Bearer proxy-token' });
		expect(forward('proxyReqWs')).toEqual({ authorization: 'Bearer proxy-token' });
		expect(forward('proxyReq', { authorization: 'Bearer mine' })).toEqual({});
		rmSync(a.dir, { recursive: true, force: true });
	});

	it('page loads and the /health poll receive the dev editor key as an HttpOnly, SameSite=Strict cookie', async () => {
		const a = appdir(47900, 't');
		const auth = createDevAuth('http://127.0.0.1:47900', { fetch: health(a.runtimeFile), env: {} });
		await auth.refresh();
		const cookie = `jasper_editor_47900=${KEY}; Path=/; HttpOnly; SameSite=Strict`;
		expect(auth.editorCookie()).toBe(cookie);

		const load = (url: string, headers: Record<string, string>, method = 'GET') => {
			const set: Record<string, string> = {};
			let passed = false;
			editorCookieMiddleware(auth)(
				{ url, method, headers } as unknown as IncomingMessage,
				{ setHeader: (n: string, v: string) => (set[n] = v) } as unknown as ServerResponse,
				() => {
					passed = true;
				},
			);
			expect(passed).toBe(true);
			return set['Set-Cookie'] ?? null;
		};
		expect(load('/', { 'sec-fetch-dest': 'document', accept: 'text/html' })).toBe(cookie);
		expect(load('/project/prj_1', { 'sec-fetch-dest': 'document' })).toBe(cookie);
		expect(load('/', { accept: 'text/html,*/*' })).toBe(cookie);
		// Not for scripts, images, frames, proxied engine paths or writes.
		expect(load('/src/main.tsx', { 'sec-fetch-dest': 'script', accept: '*/*' })).toBeNull();
		expect(
			load('/mg/sandbox/cap/key/index.html', { 'sec-fetch-dest': 'iframe', accept: 'text/html' }),
		).toBeNull();
		expect(
			load('/mg/sandbox/cap/key/index.html', { 'sec-fetch-dest': 'document', accept: 'text/html' }),
		).toBeNull();
		expect(load('/api/projects', { accept: 'text/html' })).toBeNull();
		expect(load('/', { 'sec-fetch-dest': 'document' }, 'POST')).toBeNull();

		// The proxied /health answer carries it too (a page that loaded before the engine was up).
		const proxy = new EventEmitter();
		authenticateProxy(auth)(proxy);
		const answer = (url: string, statusCode: number) => {
			const res = { statusCode, headers: {} as Record<string, unknown> };
			proxy.emit('proxyRes', res, { url, headers: {} });
			return res.headers['set-cookie'] ?? null;
		};
		expect(answer('/health', 200)).toEqual([cookie]);
		expect(answer('/health?x=1', 200)).toEqual([cookie]);
		expect(answer('/api/projects', 200)).toBeNull();
		expect(answer('/health', 503)).toBeNull();
		rmSync(a.dir, { recursive: true, force: true });
	});

	it('an engine that is not a dev engine has no key file: no cookie is made up', async () => {
		const a = appdir(47900, 't', { editorKey: null });
		const auth = createDevAuth('http://127.0.0.1:47900', { fetch: health(a.runtimeFile), env: {} });
		await auth.refresh();
		expect(auth.editorCookie()).toBeNull();
		const b = appdir(47900, 't', { editorKey: 'short; Path=/evil' });
		const bad = createDevAuth('http://127.0.0.1:47900', { fetch: health(b.runtimeFile), env: {} });
		await bad.refresh();
		expect(bad.editorCookie()).toBeNull();
		for (const d of [a.dir, b.dir]) rmSync(d, { recursive: true, force: true });
	});
});
