import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EngineError } from '@jasper/engine-client';
import { createCounterIdSource, createEmptyProject } from '@jasper/project';
import { describe, expect, it, vi } from 'vitest';
import { makeContext, waitJob } from '../src/context.ts';
import { discoverEngine } from '../src/discovery.ts';
import { ToolError, toErrorResult } from '../src/errors.ts';
import { buildExportSettings, findExportPreset } from '../src/export-presets.ts';
import { EngineLink, EngineRequestAborted, withEngine } from '../src/link.ts';

const here = dirname(fileURLToPath(import.meta.url));

function fakeFetch(healthy: string[]): typeof fetch {
	return (async (input: string | URL) => {
		const url = String(input);
		if (healthy.some((h) => url === `${h}/health`))
			return new Response(JSON.stringify({ ok: true, version: '9.9.9', apiVersion: 1 }), {
				headers: { 'content-type': 'application/json' },
			});
		throw new TypeError('fetch failed: ECONNREFUSED');
	}) as typeof fetch;
}

function writeRuntime(appdir: string, info: Record<string, unknown>) {
	mkdirSync(join(appdir, 'engine'), { recursive: true });
	writeFileSync(join(appdir, 'engine', 'runtime.json'), JSON.stringify(info));
}

describe('engine discovery', () => {
	it.each([null, undefined, 'connection failed'])(
		'reports a non-Error health rejection: %s',
		async (reason) => {
			const log: string[] = [];
			const target = await discoverEngine({
				url: 'http://127.0.0.1:1',
				fetch: async () => {
					throw reason;
				},
				log: (line) => log.push(line),
			});
			expect(target?.source).toBe('explicit');
			expect(log[0]).toContain(String(reason));
		},
	);

	it('prefers explicit URL/token (flags over env)', async () => {
		const t = await discoverEngine({
			url: 'http://127.0.0.1:1',
			env: { JASPER_ENGINE_URL: 'http://127.0.0.1:2', JASPER_ENGINE_TOKEN: 'envtok' },
			fetch: fakeFetch(['http://127.0.0.1:1']),
		});
		expect(t).toMatchObject({
			url: 'http://127.0.0.1:1',
			token: 'envtok',
			source: 'explicit',
			version: '9.9.9',
		});
		const e = await discoverEngine({
			env: { JASPER_ENGINE_URL: 'http://127.0.0.1:2/' },
			fetch: fakeFetch([]),
		});
		// Down but explicit: still returned so errors name the configured URL.
		expect(e).toMatchObject({ url: 'http://127.0.0.1:2', token: null, source: 'explicit' });
	});

	it.skipIf(process.platform !== 'linux')(
		'reads <appdir>/engine/runtime.json (token included) and skips stale or dead entries',
		async () => {
			const stale = mkdtempSync(join(tmpdir(), 'jasper-mcp-stale-'));
			const down = mkdtempSync(join(tmpdir(), 'jasper-mcp-down-'));
			const data = mkdtempSync(join(tmpdir(), 'jasper-mcp-data-'));
			const live = join(data, 'jasper');
			writeRuntime(stale, { url: 'http://127.0.0.1:3', port: 3, pid: 2 ** 30, token: 'x' });
			writeRuntime(down, { url: 'http://127.0.0.1:4', port: 4, pid: process.pid, token: 'y' });
			writeRuntime(live, { url: 'http://127.0.0.1:5', port: 5, pid: process.pid, token: 'secret' });
			const env = { JASPER_APPDIR: down, XDG_DATA_HOME: data, XDG_CONFIG_HOME: data };
			const t = await discoverEngine({
				appdir: stale,
				env,
				fetch: fakeFetch(['http://127.0.0.1:5']),
			});
			expect(t).toMatchObject({ url: 'http://127.0.0.1:5', token: 'secret', source: 'runtime-file' });
			expect(t?.detail).toBe(join(live, 'engine', 'runtime.json'));
			const t2 = await discoverEngine({
				token: 'mine',
				env,
				fetch: fakeFetch(['http://127.0.0.1:5']),
			});
			expect(t2?.token).toBe('mine');
		},
	);

	it('falls back to the default dev port', async () => {
		const t = await discoverEngine({
			env: { XDG_DATA_HOME: '/nonexistent', XDG_CONFIG_HOME: '/nonexistent', HOME: '/nonexistent' },
			fetch: fakeFetch(['http://127.0.0.1:47900']),
		});
		expect(t).toMatchObject({ url: 'http://127.0.0.1:47900', source: 'default-port', token: null });
	});

	it('discovery rejects non-engine answers', async () => {
		const f = (async () => new Response(JSON.stringify({ hello: 1 }))) as unknown as typeof fetch;
		expect(
			await discoverEngine({
				env: { XDG_DATA_HOME: '/nonexistent', XDG_CONFIG_HOME: '/nonexistent' },
				fetch: f,
			}),
		).toBeNull();
	});

	it('EngineLink reports an actionable error when nothing runs', async () => {
		const link = new EngineLink({
			env: { XDG_DATA_HOME: '/nonexistent', XDG_CONFIG_HOME: '/nonexistent' },
			fetch: fakeFetch([]),
			log: () => {},
		});
		const err = await link.client().catch((e) => e);
		expect(err).toBeInstanceOf(ToolError);
		expect(err.code).toBe('ENGINE_NOT_FOUND');
		expect(err.hint).toMatch(/--start-engine/);
	});

	it('re-discovers after a refused read and returns the project list', async () => {
		let requests = 0;
		const link = new EngineLink({
			url: 'http://127.0.0.1:1',
			fetch: (async (input: string | URL) => {
				if (String(input).endsWith('/health')) return new Response(JSON.stringify({ ok: true }));
				if (++requests === 1)
					throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
				return new Response(JSON.stringify({ projects: [] }), { headers: { 'x-jasper-api': '1' } });
			}) as typeof fetch,
		});
		expect(await withEngine(link, (c) => c.listProjects())).toEqual({ projects: [] });
		expect(requests).toBe(2);
	});
});

describe('engine request guard (no unbounded waits, no blind re-apply)', () => {
	const errorOf = (r: ReturnType<typeof toErrorResult>) =>
		JSON.parse((r.content[0] as { text: string }).text).error as { code: string; hint?: string };
	const failWith = (code: string) =>
		(async () => {
			throw Object.assign(new TypeError('fetch failed'), { cause: { code } });
		}) as unknown as typeof fetch;

	it('a request that never answers ends with ENGINE_TIMEOUT instead of hanging', async () => {
		vi.useFakeTimers();
		const deadline = new AbortController();
		const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
			setTimeout(
				() => deadline.abort(new DOMException('Controlled request deadline', 'TimeoutError')),
				milliseconds,
			);
			return deadline.signal;
		});
		let healthSeen!: () => void;
		const healthStarted = new Promise<void>((resolve) => {
			healthSeen = resolve;
		});
		let requestStarted = false;
		const never = ((input: string | URL, init?: RequestInit) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
				if (String(input).endsWith('/health')) healthSeen();
				else requestStarted = true;
			})) as unknown as typeof fetch;
		try {
			const link = new EngineLink({
				url: 'http://127.0.0.1:1',
				token: 'secret-token',
				fetch: never,
				healthTimeoutMs: 40,
				requestTimeoutMs: 40,
				log: () => {},
			});
			let calls = 0;
			const pending = withEngine(link, (c) => {
				calls++;
				return c.listProjects();
			}).catch((e) => e);
			await healthStarted;
			await vi.advanceTimersByTimeAsync(40);
			expect(requestStarted).toBe(true);
			await vi.advanceTimersByTimeAsync(40);
			expect(deadline.signal.aborted).toBe(true);
			const err = await pending;
			expect(err).toBeInstanceOf(EngineRequestAborted);
			expect(calls).toBe(1);
			const body = errorOf(toErrorResult(err));
			expect(body.code).toBe('ENGINE_TIMEOUT');
			expect(JSON.stringify(body)).not.toContain('secret-token');
		} finally {
			vi.clearAllTimers();
			timeout.mockRestore();
			vi.useRealTimers();
		}
	});

	describe('waiting on a job of an engine that stops answering', () => {
		// the CLI's engine (its --appdir) froze mid-wait; the dev engine on the default port answered instead and did
		// not know the job: "JOB_NOT_FOUND Unknown job" for a job that was still running
		const json = (body: unknown, status = 200) =>
			new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
		const running = {
			id: 'job_1',
			kind: 'probe',
			title: 'Clean Up',
			origin: { type: 'user' },
			state: 'running',
			progress: 0.5,
			createdAt: '2026-11-14T00:00:00.000Z',
			priority: 'user',
			cpuSlots: 1,
		};
		const setup = () => {
			const appdir = mkdtempSync(join(tmpdir(), 'jasper-quiet-'));
			writeRuntime(appdir, { url: 'http://127.0.0.1:5', port: 5, pid: process.pid, token: 'own' });
			const own = { fail: null as string | null };
			const fetchImpl = (async (input: string | URL) => {
				const url = String(input);
				if (url.startsWith('http://127.0.0.1:5/')) {
					if (own.fail) throw Object.assign(new TypeError('fetch failed'), { cause: { code: own.fail } });
					return url.endsWith('/health') ? json({ ok: true }) : json(running);
				}
				if (url === 'http://127.0.0.1:47900/health') return json({ ok: true });
				if (url.startsWith('http://127.0.0.1:47900/'))
					return json({ code: 'JOB_NOT_FOUND', message: 'Unknown job', retryable: false }, 404);
				throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
			}) as typeof fetch;
			const link = new EngineLink({ appdir, env: {}, fetch: fetchImpl, healthTimeoutMs: 40, log: () => {} });
			return { own, ctx: makeContext({} as never, link, 'test') };
		};

		it('a poll the engine never answers says the job may still be running', async () => {
			const { own, ctx } = setup();
			expect((await waitJob(ctx, 'job_1', 0)).job.state).toBe('running');
			own.fail = 'UND_ERR_HEADERS_TIMEOUT';
			const err = await waitJob(ctx, 'job_1', 0).catch((e) => e);
			expect(err).toBeInstanceOf(ToolError);
			expect(err).toMatchObject({ code: 'ENGINE_TIMEOUT', hint: expect.stringContaining('wait_for_job') });
			expect(err.message).toContain('may still be running');
		});

		it('a lost engine is never replaced by another one mid-call', async () => {
			const { own, ctx } = setup();
			await waitJob(ctx, 'job_1', 0);
			own.fail = 'ECONNRESET';
			await expect(waitJob(ctx, 'job_1', 0)).rejects.toMatchObject({ code: 'NETWORK' });
		});
	});

	it('a write cut off mid-flight is reported, not retried (it may have been applied)', async () => {
		let sent = 0;
		const link = new EngineLink({
			url: 'http://127.0.0.1:1',
			fetch: (async (input: string | URL) => {
				if (String(input).endsWith('/health')) return new Response(JSON.stringify({ ok: true }));
				sent++;
				throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
			}) as typeof fetch,
		});
		const err = await withEngine(link, (c) =>
			c.agentTx({ projectId: 'prj_x', transaction: {} as never }),
		).catch((e) => e);
		expect(sent).toBe(1);
		const body = errorOf(toErrorResult(err));
		expect(body.code).toBe('ENGINE_CONNECTION_LOST');
	});

	it('a write that never reached the engine, and any read, stay retryable NETWORK errors', async () => {
		const refused = await new EngineLink({
			url: 'http://127.0.0.1:1',
			fetch: failWith('ECONNREFUSED'),
			log: () => {},
		}).client();
		await expect(refused.agentTx({ projectId: 'p', transaction: {} as never })).rejects.toMatchObject({
			code: 'NETWORK',
		});
		const reset = await new EngineLink({
			url: 'http://127.0.0.1:1',
			fetch: failWith('ECONNRESET'),
			log: () => {},
		}).client();
		await expect(reset.listProjects()).rejects.toMatchObject({ code: 'NETWORK' });
	});
});

describe('errors', () => {
	it('maps tool, engine and transaction errors to isError results with hints', () => {
		const a = toErrorResult(new ToolError('E_NOT_FOUND', 'nope', 'look it up'));
		expect(a.isError).toBe(true);
		expect(JSON.parse((a.content[0] as { text: string }).text)).toEqual({
			error: { code: 'E_NOT_FOUND', message: 'nope', hint: 'look it up' },
		});
		const b = toErrorResult(
			new EngineError('NO_SESSION', 'needs a session', { status: 409, detail: { code: 'E_NO_SESSION' } }),
		);
		const body = JSON.parse((b.content[0] as { text: string }).text);
		expect(body.error.code).toBe('E_NO_SESSION');
		expect(body.error.hint).toMatch(/open_project_in_editor/);
		const c = toErrorResult(new EngineError('NETWORK', 'down'));
		expect(JSON.parse((c.content[0] as { text: string }).text).error.hint).toMatch(/--start-engine/);
	});
});

it('caller quality overrides take precedence over export preset defaults', () => {
	const doc = createEmptyProject({ ids: createCounterIdSource(7), name: 'Overrides', preset: 'hd-1080p-30' });
	const seq = Object.values(doc.sequences)[0]!;
	const preset = findExportPreset('master-h264-high')!;
	const settings = buildExportSettings(seq, preset, {
		range: { type: 'entire' },
		engine: 'auto',
		crf: 12,
		videoBitrateKbps: 16000,
	});
	expect(settings.video).toMatchObject({ quality: { mode: 'crf', value: 12 }, bitrateKbps: 16000 });
});

it('the overlay preset exports a transparent background: straight-alpha ProRes 4444 in MOV, no audio (social-comment §7.11)', () => {
	const doc = createEmptyProject({
		ids: createCounterIdSource(7),
		name: 'Overlay',
		preset: 'vertical-1080x1920-30',
	});
	const seq = Object.values(doc.sequences)[0]!;
	const settings = buildExportSettings(seq, findExportPreset('overlay-prores-4444-alpha')!, {
		range: { type: 'entire' },
		engine: 'auto',
	});
	expect(settings.container).toBe('mov');
	expect(settings.video).toMatchObject({
		codec: 'prores',
		proresProfile: '4444',
		alpha: true,
		width: 1080,
		height: 1920,
	});
	expect(settings.videoOnly).toBe(true);
	const master = buildExportSettings(seq, findExportPreset('master-prores-422hq')!, {
		range: { type: 'entire' },
		engine: 'auto',
	});
	expect([master.video?.alpha, master.video?.proresProfile, master.videoOnly]).toEqual([
		undefined,
		undefined,
		undefined,
	]);
});

it('the --version CLI reports the package version', () => {
	const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
	const result = spawnSync(
		process.execPath,
		['--import', 'tsx', join(here, '..', 'src', 'cli.ts'), '--version'],
		{
			encoding: 'utf8',
		},
	);
	expect(result.status).toBe(0);
	expect(result.stdout.trim()).toBe(pkg.version);
});
