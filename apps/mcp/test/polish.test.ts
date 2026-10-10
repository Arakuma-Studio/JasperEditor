// polish: browse_media_files (the Media Browser for agents).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { EngineLink } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';

const entry = (name: string, kind: 'folder' | 'file', category: string | null) => ({
	name,
	path: `/m/${name}`,
	kind,
	size: kind === 'file' ? 1000 : null,
	modifiedAt: '2026-10-01T00:00:00.000Z',
	category,
	hidden: false,
});

async function connect(local = true) {
	const requests: string[] = [];
	const fetchImpl = (async (url: string) => {
		const u = new URL(url);
		requests.push(`${u.pathname}${u.search}`);
		const json = (body: unknown, status = 200) =>
			new Response(JSON.stringify(body), { status, headers: { 'x-jasper-api': '1' } });
		if (!local) return json({ code: 'LOCAL_MODE_ONLY', message: 'local only', retryable: false }, 403);
		if (u.pathname === '/api/browse/roots')
			return json({ sep: '/', home: '/home/u', roots: [{ label: 'Home', path: '/home/u', kind: 'home' }] });
		if (u.pathname === '/api/browse/list')
			return json({
				path: u.searchParams.get('path'),
				parent: '/',
				entries: [
					entry('Sub', 'folder', null),
					entry('a.mp4', 'file', 'video'),
					entry('b.wav', 'file', 'audio'),
					entry('c.srt', 'file', 'captions'),
				],
				truncated: false,
			});
		if (u.pathname === '/api/browse/info')
			return json({
				path: u.searchParams.get('path'),
				name: 'a.mp4',
				size: 1000,
				modifiedAt: '2026-10-01T00:00:00.000Z',
				category: 'video',
				media: {
					durationSec: 4,
					width: 1920,
					height: 1080,
					fps: 30,
					videoCodec: 'h264',
					audioCodec: null,
					sampleRate: null,
					channels: null,
					browserPlayable: 'yes',
				},
			});
		return json({ code: 'NOT_FOUND', message: 'nope', retryable: false }, 404);
	}) as typeof fetch;
	const { server } = createJasperMcpServer({
		link: new EngineLink({ url: 'http://127.0.0.1:9', fetch: fetchImpl, log: () => {} }),
		agentName: 'polish-test',
	});
	const [a, b] = InMemoryTransport.createLinkedPair();
	await server.connect(a);
	const client = new Client({ name: 'polish-test', version: '1' });
	await client.connect(b);
	const call = async (args: Record<string, unknown> = {}) => {
		const r = (await client.callTool({ name: 'browse_media_files', arguments: args })) as CallToolResult;
		const text = (r.content[0] as { text: string }).text;
		return { r, json: r.isError ? null : JSON.parse(text), text };
	};
	return { client, call, requests };
}

describe('browse_media_files', () => {
	it('answers the places without a path', async () => {
		const { call } = await connect();
		const { json } = await call();
		expect(json.home).toBe('/home/u');
		expect(json.places).toEqual([{ label: 'Home', path: '/home/u', kind: 'home' }]);
	});

	it('lists a folder, filters by kind, limits and probes', async () => {
		const { call, requests } = await connect();
		const all = (await call({ path: '/m' })).json;
		expect(all.entries.map((e: { name: string; kind: string }) => `${e.name}:${e.kind}`)).toEqual([
			'Sub:folder',
			'a.mp4:video',
			'b.wav:audio',
			'c.srt:captions',
		]);
		expect(all.total).toBe(4);
		expect(all.truncated).toBeUndefined();
		const video = (await call({ path: '/m', kind: 'video', probe: true })).json;
		expect(video.entries.map((e: { name: string }) => e.name)).toEqual(['Sub', 'a.mp4']);
		expect(video.entries[1].media).toMatchObject({ width: 1920, fps: 30 });
		expect(requests.filter((r) => r.startsWith('/api/browse/info')).length).toBe(1);
		const limited = (await call({ path: '/m', limit: 2 })).json;
		expect(limited.entries.length).toBe(2);
		expect(limited.truncated).toBe(true);
		// only importable media: the tool never asks for every file of a folder
		expect(requests.some((r) => r.includes('all=1'))).toBe(false);
		expect((await call({ path: '/m', includeAll: true })).r.isError).toBe(true);
	});

	it('is read-only and reports a remote engine as an error result', async () => {
		const { client } = await connect();
		const tool = (await client.listTools()).tools.find((t) => t.name === 'browse_media_files')!;
		expect(tool.annotations?.readOnlyHint).toBe(true);
		const remote = await connect(false);
		const { r, text } = await remote.call({ path: '/m' });
		expect(r.isError).toBe(true);
		expect(text).toMatch(/LOCAL_MODE_ONLY|local engine/);
		const bad = await remote.call({ path: '/m', nope: 1 });
		expect(bad.r.isError).toBe(true);
	});
});
