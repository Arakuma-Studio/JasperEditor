import type { EngineJob } from '@jasper/api';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { type Extra, progressReporter } from '../src/context.ts';
import type { EngineConnection } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';

type FakeEngine = {
	jobs: Map<string, EngineJob>;
	cancelled: string[];
	calls: string[];
};

function fakeJob(
	id: string,
	state: EngineJob['state'] = 'running',
	progress: number | null = 0.1,
): EngineJob {
	return {
		id,
		kind: 'export',
		title: 'Export',
		state,
		progress,
		priority: 'user',
		createdAt: new Date().toISOString(),
	} as unknown as EngineJob;
}

function fakeLink(engine: FakeEngine): EngineConnection {
	const client = {
		getJob: async (id: string) => {
			engine.calls.push(`getJob ${id}`);
			const j = engine.jobs.get(id);
			if (!j) throw new Error(`no job ${id}`);
			return structuredClone(j);
		},
		cancelJob: async (id: string) => {
			engine.calls.push(`cancelJob ${id}`);
			engine.cancelled.push(id);
			const j = engine.jobs.get(id);
			if (j) j.state = 'cancelled';
			return structuredClone(j ?? fakeJob(id, 'cancelled'));
		},
	};
	return {
		target: { url: 'http://127.0.0.1:1', token: null, source: 'explicit' },
		client: async () => client as never,
		invalidate() {},
		close: async () => {},
	};
}

let engine: FakeEngine;
let client: Client;

async function connect(extraTools?: (server: ReturnType<typeof createJasperMcpServer>['server']) => void) {
	engine = { jobs: new Map(), cancelled: [], calls: [] };
	const { server } = createJasperMcpServer({ link: fakeLink(engine), agentName: 'test' });
	extraTools?.(server);
	const [a, b] = InMemoryTransport.createLinkedPair();
	client = new Client({ name: 'conventions', version: '1' });
	await Promise.all([server.connect(a), client.connect(b)]);
}

const errorBody = (r: CallToolResult) =>
	JSON.parse((r.content[0] as { text: string }).text) as {
		error: { code: string; message: string; hint?: string; details?: unknown };
	};

describe('tool catalogue conventions', () => {
	let tools: Tool[];
	beforeEach(async () => {
		await connect();
		tools = (await client.listTools()).tools;
	});
	afterEach(async () => client.close());

	it('every tool has a title and all four annotation hints, set consistently', () => {
		const bad: string[] = [];
		for (const t of tools) {
			const a = t.annotations ?? {};
			if (!t.title) bad.push(`${t.name}: no title`);
			for (const k of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const)
				if (typeof a[k] !== 'boolean') bad.push(`${t.name}: ${k} missing`);
			if (a.readOnlyHint && a.destructiveHint) bad.push(`${t.name}: read-only and destructive`);
			if (a.readOnlyHint && !a.idempotentHint) bad.push(`${t.name}: read-only but not idempotent`);
			if (/^(list|get|describe)_/.test(t.name) && !a.readOnlyHint)
				bad.push(`${t.name}: a read should be read-only`);
			if (/^(delete|remove|clean|cancel)_/.test(t.name) && !a.destructiveHint)
				bad.push(`${t.name}: deletes but is not destructive`);
			if (/^(add|create|import|paste)_/.test(t.name) && (a.readOnlyHint || a.destructiveHint))
				bad.push(`${t.name}: an additive edit should be neither read-only nor destructive`);
		}
		expect(bad).toEqual([]);
		const byName = new Map(tools.map((t) => [t.name, t.annotations]));
		expect(byName.get('render_frame')).toMatchObject({ readOnlyHint: true, openWorldHint: false });
		expect(byName.get('apply_commands')).toMatchObject({ readOnlyHint: false, destructiveHint: true });
		expect(byName.get('add_clip')).toMatchObject({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
		});
		expect(byName.get('set_playhead')).toMatchObject({ readOnlyHint: false, idempotentHint: true });
		expect(byName.get('install_processing_model')).toMatchObject({ openWorldHint: true });
		expect(byName.get('test_remote_executor')).toMatchObject({ readOnlyHint: true, openWorldHint: true });
	});

	it('every fixed-shape object of every input schema forbids additional properties', () => {
		const loose: string[] = [];
		const walk = (s: unknown, path: string, tool: string) => {
			if (!s || typeof s !== 'object') return;
			const o = s as Record<string, unknown>;
			if (
				o.type === 'object' &&
				o.properties &&
				!o.propertyNames &&
				o.additionalProperties !== false &&
				o['x-jasper-open'] !== true
			)
				loose.push(`${tool}${path}`);
			for (const [k, v] of Object.entries(o)) {
				if (Array.isArray(v)) for (const [i, x] of v.entries()) walk(x, `${path}.${k}[${i}]`, tool);
				else if (v && typeof v === 'object') walk(v, `${path}.${k}`, tool);
			}
		};
		for (const t of tools) walk(t.inputSchema, '', t.name);
		expect(loose).toEqual([]);
	});
});

describe('strict arguments', () => {
	beforeEach(async () => {
		await connect((server) => {
			// A tool registered without defineTool (as another module might) is still validated strictly.
			server.registerTool(
				'raw_echo',
				{ title: 'Echo', description: 'Echo', inputSchema: { text: z.string() } },
				async ({ text }) => ({ content: [{ type: 'text', text }] }),
			);
		});
	});
	afterEach(async () => client.close());

	it('rejects an unknown top-level key, naming it and the accepted keys', async () => {
		const r = (await client.callTool({
			name: 'get_job',
			arguments: { jobId: 'j1', jobid: 'j1' },
		})) as CallToolResult;
		expect(r.isError).toBe(true);
		const { error } = errorBody(r);
		expect(error.code).toBe('E_UNKNOWN_ARGUMENT');
		expect(error.details).toMatchObject({
			unknown: [{ path: '', keys: ['jobid'], accepted: ['jobId'] }],
		});
		expect(engine.calls).toEqual([]);
	});

	it('rejects unknown keys inside nested objects and union members', async () => {
		const r = (await client.callTool({
			name: 'start_export',
			arguments: { projectId: 'prj_x', range: { from: 0, to: 30, step: 2 } },
		})) as CallToolResult;
		const { error } = errorBody(r);
		expect(error.code).toBe('E_UNKNOWN_ARGUMENT');
		expect(error.details).toMatchObject({
			unknown: [{ path: 'range', keys: ['step'], accepted: ['from', 'to'] }],
		});
	});

	it('applies to tools registered directly on the server', async () => {
		const ok = (await client.callTool({ name: 'raw_echo', arguments: { text: 'hi' } })) as CallToolResult;
		expect(ok.isError).toBeFalsy();
		const r = (await client.callTool({
			name: 'raw_echo',
			arguments: { text: 'hi', txt: 'x' },
		})) as CallToolResult;
		expect(errorBody(r).error).toMatchObject({ code: 'E_UNKNOWN_ARGUMENT' });
	});

	it('reports schema mismatches with the accepted and required keys', async () => {
		const r = (await client.callTool({
			name: 'wait_for_job',
			arguments: { timeoutSeconds: 'soon' },
		})) as CallToolResult;
		const { error } = errorBody(r);
		expect(error.code).toBe('E_INVALID_ARGUMENT');
		expect(error.message).toMatch(/jobId|timeoutSeconds/);
		expect(error.hint).toContain('jobId');
	});
});

describe('progress and cancellation', () => {
	afterEach(async () => client?.close());

	function fakeExtra(token?: string, latest?: () => number) {
		const sent: { progress: number; total?: number; message?: string; at: number; expected?: number }[] = [];
		const ac = new AbortController();
		const extra = {
			signal: ac.signal,
			_meta: token ? { progressToken: token } : undefined,
			sendNotification: async (n: { params: { progress: number; total?: number; message?: string } }) => {
				sent.push({ ...n.params, at: Date.now(), expected: latest?.() });
			},
		} as unknown as Extra;
		return { extra, sent };
	}

	it('throttles progress to one notification per 100 ms, increasing, latest value wins', async () => {
		vi.useFakeTimers();
		let latest = 0;
		const { extra, sent } = fakeExtra('t1', () => latest);
		const report = progressReporter(extra);
		try {
			for (let i = 1; i <= 50; i++) {
				latest = i;
				report(i, 100, `step ${i}`);
				await vi.advanceTimersByTimeAsync(5);
			}
			report(40, 100, 'going back is ignored');
			latest = 100;
			report(100, 100, 'done');
			const flushed = report.flush();
			await vi.runAllTimersAsync();
			await flushed;
			expect(sent.length).toBeGreaterThan(1);
			expect(sent.map((s) => s.progress)).toEqual(sent.map((s) => s.expected));
			for (let i = 1; i < sent.length; i++) {
				expect(sent[i]!.at - sent[i - 1]!.at).toBeGreaterThanOrEqual(100);
				expect(sent[i]!.progress).toBeGreaterThan(sent[i - 1]!.progress);
			}
			expect(sent.at(-1)).toMatchObject({ progress: 100, message: 'done' });
			expect(sent.some((s) => s.message === 'going back is ignored')).toBe(false);
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	});

	it('sends nothing without a progress token', async () => {
		const { extra, sent } = fakeExtra();
		const report = progressReporter(extra);
		report(1, 2);
		await report.flush();
		expect(sent).toEqual([]);
	});

	it('notifications/cancelled on wait_for_job cancels the engine job', async () => {
		await connect();
		engine.jobs.set('job_2', fakeJob('job_2'));
		const ac = new AbortController();
		const progress: number[] = [];
		const call = client.callTool({ name: 'wait_for_job', arguments: { jobId: 'job_2' } }, undefined, {
			signal: ac.signal,
			onprogress: (p) => progress.push(p.progress),
		});
		await expect.poll(() => progress.length, { timeout: 5000 }).toBeGreaterThan(0);
		ac.abort('user stopped it');
		await expect(call).rejects.toThrow();
		await expect.poll(() => engine.cancelled, { timeout: 5000 }).toEqual(['job_2']);
		expect(progress.length).toBeGreaterThan(0);
	});
});
