// Workstream `previews`: the MCP tools get_render_bar_state, render_previews, delete_render_files and perf_stats over a
// fake engine (the hashes come from @jasper/project, the engine answers which have files).
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type ProjectDocument,
	previewSegments,
} from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { EngineLink } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';

function makeDoc(): ProjectDocument {
	const ids = createCounterIdSource(3);
	const base = createEmptyProject({ ids, name: 'P', preset: 'hd-1080p-30' });
	const { document, result } = applyTransaction(
		base,
		{
			label: 'setup',
			origin: 'user',
			commands: [
				{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [1, 0, 0, 1] },
				{ type: 'clip.addSolid', at: 30, duration: 30, track: 'V1', color: [0, 0, 1, 1] },
				{ type: 'clip.addSolid', at: 10, duration: 10, track: 'V2', color: [0, 1, 0, 1] },
			] as never,
		},
		{ ids, now: () => 't', revision: 0, registries: defaultRegistries() },
	);
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
	return document;
}

async function connect(doc: ProjectDocument, green: string[]) {
	const calls: { path: string; body: unknown }[] = [];
	const job = {
		id: 'job_0000000000000001',
		kind: 'preview',
		title: 'Render Previews – 2 segments',
		state: 'succeeded',
		priority: 'user',
		progress: 1,
		createdAt: '2026-10-01T00:00:00.000Z',
		cpuSlots: 4,
		origin: { type: 'user' },
		result: {
			rendered: [],
			existing: 0,
			skipped: [],
			frames: 30,
			seconds: 3,
			bytes: 1000,
			paths: { native: 2 },
			formatKey: 'f',
		},
	};
	const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
		const u = new URL(String(url));
		const body = init?.body ? JSON.parse(String(init.body)) : null;
		calls.push({ path: u.pathname, body });
		const ok = (v: unknown, status = 200) =>
			new Response(JSON.stringify(v), {
				status,
				headers: { 'x-jasper-api': '1', 'content-type': 'application/json' },
			});
		switch (u.pathname) {
			case '/api/agent/query':
				return ok({ ok: true, result: doc, revision: 4, via: 'headless' });
			case '/api/previews/status':
				return ok({
					formatKey: 'ffffffffffffffff',
					video: (body.video as string[]).filter((h) => green.includes(h)),
					audio: [],
					videoUrl: '/renders/previews/ffffffffffffffff/{hash}.mp4',
					audioUrl: '/renders/previews/ffffffffffffffff/{hash}.wav',
					container: 'mp4',
					size: 'full',
					audioFiles: 0,
				});
			case '/api/previews/render':
				return ok({ ...job, state: 'queued' }, 202);
			case `/api/jobs/${job.id}`:
				return ok(job);
			case '/api/previews/delete':
				return ok({ deleted: body.all ? 9 : (body.hashes as string[]).length, bytes: 1 });
			case '/api/perf':
				return ok({ process: { cpuPercent: 12 }, jobs: { running: 0, queued: 0 } });
			case '/api/agent/ui':
				return ok({
					result: { playback: { framesShown: 100, framesDropped: 2 } },
					window: { projectId: doc.projectId, sessionId: 's' },
				});
			default:
				return ok({ code: 'NOT_FOUND', message: u.pathname }, 404);
		}
	}) as typeof fetch;
	const { server } = createJasperMcpServer({
		link: new EngineLink({ url: 'http://127.0.0.1:9', fetch: fetchImpl, log: () => {} }),
		agentName: 'previews-test',
	});
	const [a, b] = InMemoryTransport.createLinkedPair();
	await server.connect(a);
	const client = new Client({ name: 'previews-test', version: '1' });
	await client.connect(b);
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
		const text = (r.content[0] as { text: string }).text;
		return { r, json: r.isError ? null : JSON.parse(text), text };
	};
	return { client, call, calls };
}

describe('render previews MCP tools', () => {
	it('get_render_bar_state reports the segments with their state, cost and reasons', async () => {
		const doc = makeDoc();
		const seqId = Object.keys(doc.sequences)[0]!;
		const segs = previewSegments(doc, seqId);
		const { client, call } = await connect(doc, [segs[1]!.hash]);
		const { json, text } = await call('get_render_bar_state', { projectId: doc.projectId });
		expect(json, text).not.toBeNull();
		expect(json.summary.segments).toBe(segs.length);
		expect(json.segments[1].state).toBe('green');
		expect(json.segments.map((s: { startFrame: number }) => s.startFrame)).toEqual(
			segs.map((s) => s.startFrame),
		);
		for (const s of json.segments) expect(['green', 'yellow', 'red', 'none']).toContain(s.state);
		// a range limits the rows
		const r = await call('get_render_bar_state', { projectId: doc.projectId, range: { from: 0, to: 10 } });
		expect(r.json.segments).toHaveLength(1);
		const tools = (await client.listTools()).tools;
		expect(tools.find((t) => t.name === 'get_render_bar_state')?.annotations?.readOnlyHint).toBe(true);
		expect(tools.find((t) => t.name === 'delete_render_files')?.annotations?.destructiveHint).toBe(true);
		await client.close();
	});

	it('render_previews sends the document and waits for the job; delete_render_files computes the range hashes', async () => {
		const doc = makeDoc();
		const seqId = Object.keys(doc.sequences)[0]!;
		const { client, call, calls } = await connect(doc, []);
		const { json, text } = await call('render_previews', { projectId: doc.projectId, mode: 'effects' });
		expect(json, text).not.toBeNull();
		expect(json.state).toBe('succeeded');
		const req = calls.find((c) => c.path === '/api/previews/render')!.body as {
			mode: string;
			range: unknown;
		};
		expect(req.mode).toBe('effects');
		expect(req.range).toEqual({ start: 0, end: 60 });
		const bad = await call('render_previews', { projectId: doc.projectId, mode: 'selection' });
		expect(bad.r.isError).toBe(true);
		const del = await call('delete_render_files', {
			projectId: doc.projectId,
			scope: 'range',
			range: { from: 0, to: 15 },
		});
		const hashes = (
			calls.filter((c) => c.path === '/api/previews/delete').pop()!.body as { hashes: string[] }
		).hashes;
		const expected = previewSegments(doc, seqId)
			.filter((s) => s.startFrame < 15)
			.map((s) => s.hash);
		expect(hashes.slice(0, expected.length)).toEqual(expected);
		expect(del.json.deleted).toBe(hashes.length);
		await client.close();
	});

	it('perf_stats joins the engine counters and the editor window', async () => {
		const doc = makeDoc();
		const { client, call } = await connect(doc, []);
		const { json } = await call('perf_stats', {});
		expect(json.engine.process.cpuPercent).toBe(12);
		expect(json.editor.playback.framesShown).toBe(100);
		await client.close();
	});
});
