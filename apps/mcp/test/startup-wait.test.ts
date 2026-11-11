// Waiting for a starting engine (link.ts / discovery.ts): the runtime file's lifecycle decides whether the CLI and
// the MCP server wait (with backoff, bounded) or fail at once. Clock, sleep, pid liveness and /health are injected.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../src/errors.ts';
import { EngineLink } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';

const PID = 4242;
const URL5 = 'http://127.0.0.1:5';

type World = {
	appdir: string;
	now: number;
	slept: number[];
	answering: boolean;
	write(info: Record<string, unknown>): void;
	link(opts?: { startupTimeoutMs?: number; onSleep?(w: World): void; log?: string[] }): EngineLink;
};

function world(): World {
	const appdir = mkdtempSync(join(tmpdir(), 'jasper-startup-'));
	mkdirSync(join(appdir, 'engine'), { recursive: true });
	const w: World = {
		appdir,
		now: 1_000_000,
		slept: [],
		answering: false,
		write: (info) => writeFileSync(join(appdir, 'engine', 'runtime.json'), JSON.stringify(info)),
		link: (opts = {}) =>
			new EngineLink({
				appdir,
				env: { XDG_DATA_HOME: '/nonexistent', XDG_CONFIG_HOME: '/nonexistent', HOME: '/nonexistent' },
				now: () => w.now,
				pidAlive: (pid) => pid === PID,
				sleep: async (ms) => {
					w.slept.push(ms);
					w.now += ms;
					opts.onSleep?.(w);
				},
				startupTimeoutMs: opts.startupTimeoutMs,
				fetch: (async (input: string | URL) => {
					const url = String(input);
					if (w.answering && url.startsWith(URL5)) {
						if (url.endsWith('/health')) return new Response(JSON.stringify({ ok: true, version: '9.9.9' }));
						return new Response(JSON.stringify({ projects: [] }), { headers: { 'x-jasper-api': '1' } });
					}
					throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
				}) as typeof fetch,
				log: (l) => opts.log?.push(l),
			}),
	};
	return w;
}

const starting = (w: World) => ({ state: 'starting', pid: PID, heartbeatAt: w.now, startedAt: '' });
const ready = (w: World, extra: Record<string, unknown> = {}) => ({
	state: 'ready',
	url: URL5,
	port: 5,
	pid: PID,
	token: 'tok',
	readyAt: w.now,
	...extra,
});

describe('waiting for a starting engine', () => {
	it('waits with growing, capped delays while it starts, then connects once it is ready', async () => {
		const w = world();
		w.write(starting(w));
		const log: string[] = [];
		const link = w.link({
			log,
			// The engine keeps its heartbeat fresh and is ready after ~9 s.
			onSleep: (x) => {
				if (x.now - 1_000_000 < 9_000) x.write(starting(x));
				else {
					x.write(ready(x));
					x.answering = true;
				}
			},
		});
		const notes: string[] = [];
		link.notify = (m) => notes.push(m);
		await link.client();
		expect(link.target).toMatchObject({ url: URL5, token: 'tok', source: 'runtime-file' });
		expect(w.slept.slice(0, 4)).toEqual([200, 400, 800, 1600]);
		expect(Math.max(...w.slept)).toBe(2000);
		expect(log.some((l) => l.includes(`pid ${PID}`) && l.includes('is starting'))).toBe(true);
		expect(log.some((l) => /engine starting… \d+ s/.test(l))).toBe(true);
		expect(notes.at(-1)).toMatch(/engine ready on http:\/\/127\.0\.0\.1:5/);
	});

	it('gives up at the startup timeout with the step that fixes it', async () => {
		const w = world();
		w.write(starting(w));
		const err = await w
			.link({ startupTimeoutMs: 10_000, onSleep: (x) => x.write(starting(x)) })
			.client()
			.catch((e) => e);
		expect(err).toBeInstanceOf(ToolError);
		expect(err.code).toBe('ENGINE_NOT_READY');
		expect(err.hint).toMatch(/--startup-timeout/);
		expect(w.slept.reduce((a, b) => a + b, 0)).toBe(10_000);
	});

	it('does not wait for a stale heartbeat or a dead pid', async () => {
		const stale = world();
		stale.write({ ...starting(stale), heartbeatAt: stale.now - 60_000 });
		const e1 = await stale
			.link()
			.client()
			.catch((e) => e);
		expect(e1.code).toBe('ENGINE_NOT_FOUND');
		expect(e1.hint).toMatch(/no heartbeat for 60 s/);
		expect(stale.slept).toEqual([]);

		const dead = world();
		dead.write({ ...starting(dead), pid: PID + 1 });
		const e2 = await dead
			.link()
			.client()
			.catch((e) => e);
		expect(e2.code).toBe('ENGINE_NOT_FOUND');
		expect(e2.hint).toMatch(/is gone/);
		expect(dead.slept).toEqual([]);
	});

	it('uses a runtime file without a state at once and never waits for a silent one', async () => {
		const w = world();
		w.write({ url: URL5, port: 5, pid: PID, token: 'legacy' });
		w.answering = true;
		const link = w.link();
		await link.client();
		expect(link.target).toMatchObject({ url: URL5, token: 'legacy' });

		w.answering = false;
		const err = await w
			.link()
			.client()
			.catch((e) => e);
		expect(err.code).toBe('ENGINE_NOT_FOUND');
		expect(w.slept).toEqual([]);
	});

	it('waits for an engine that has just become ready but does not answer yet', async () => {
		const w = world();
		w.write(ready(w));
		const link = w.link({
			onSleep: (x) => {
				x.answering = x.now - 1_000_000 >= 1_000;
			},
		});
		await link.client();
		expect(link.target?.url).toBe(URL5);
		expect(w.slept.length).toBeGreaterThan(0);
	});

	it('reports the wait to MCP clients as logging notifications, not in the tool result', async () => {
		const w = world();
		w.write(starting(w));
		const link = w.link({
			onSleep: (x) => {
				x.write(ready(x));
				x.answering = true;
			},
		});
		const { server } = createJasperMcpServer({ link, toolsets: 'all' });
		const [a, b] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: 't', version: '1' });
		const logged: unknown[] = [];
		client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
			logged.push(n.params.data);
		});
		await Promise.all([server.connect(a), client.connect(b)]);
		const r = (await client.callTool({ name: 'list_projects', arguments: {} })) as {
			isError?: boolean;
			content: { text: string }[];
		};
		expect(r.isError).toBeFalsy();
		expect(r.content.map((c) => c.text).join('')).not.toMatch(/starting/);
		expect(logged.some((d) => String(d).includes('is starting'))).toBe(true);
		await client.close();
		await server.close();
	});
});
