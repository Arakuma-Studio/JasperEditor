// start_export `overwrite` and the written path (reported: an export to an existing outputPath wrote
// "…_v7_720p (2).mp4" and the agent reported the requested name). `overwrite: true` reaches the engine's destination
// (the atomic replace is tested in apps/engine/test/export.test.ts); every job view puts the file written up front as
// `path`, with a `pathNote` when it is not the one asked for. The engine is faked.
import type { ExportStartRequest, RenderPlan } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import { createCounterIdSource, createEmptyProject } from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineConnection } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';
import { readToolResponse } from './tool-response.ts';

const OUT = '/home/user/exports/cut_v7_720p.mp4';

function fakeEngine() {
	const doc = createEmptyProject({ ids: createCounterIdSource(5), name: 'Overwrite', preset: 'hd-1080p-30' });
	const starts: ExportStartRequest[] = [];
	const job = (state: string) => {
		const dest = starts.at(-1)?.settings.destination;
		const asked = dest?.type === 'path' ? dest.path : undefined;
		// the file exists: kept unless overwrite
		const kept = asked && !(dest as { overwrite?: boolean }).overwrite;
		return {
			id: 'job_export',
			kind: 'export',
			title: 'Export',
			origin: { type: 'agent', agentRunId: 'x' },
			state,
			progress: state === 'succeeded' ? 1 : 0,
			createdAt: '2026-11-14T10:00:00.000Z',
			priority: 'user',
			cpuSlots: 2,
			...(state === 'succeeded'
				? {
						result: {
							downloadUrl: '/renders/job_export/output',
							byteSize: 10,
							durationSec: 1,
							frames: 30,
							path: kept ? asked.replace('.mp4', ' (2).mp4') : asked,
							...(kept ? { requestedPath: asked } : { replaced: true }),
						},
					}
				: {}),
		};
	};
	const plan: RenderPlan = {
		planId: 'pln_1',
		documentRevision: 0,
		path: 'native',
		segments: [],
		audio: { mode: 'native-mix' },
		blockers: [],
		warnings: [],
		estimate: { seconds: 1, bytes: 1 },
	};
	const client = {
		agentQuery: async () => ({ result: doc, revision: 0, via: 'headless' }),
		planExport: async () => plan,
		startExport: async (req: ExportStartRequest) => {
			starts.push(req);
			return job('queued');
		},
		getJob: async () => job('succeeded'),
		call: async (name: string) => {
			throw new Error(`unexpected call ${name}`);
		},
	};
	const link: EngineConnection = {
		target: { url: 'http://engine.test', token: null, source: 'explicit' },
		client: async () => client as unknown as EngineClient,
		invalidate: () => {},
		close: async () => {},
	};
	return { link, starts };
}

let open: Client[] = [];
afterEach(async () => {
	for (const c of open) await c.close().catch(() => {});
	open = [];
});

async function connect() {
	const engine = fakeEngine();
	const { server } = createJasperMcpServer({ link: engine.link, agentName: 'overwrite-test' });
	const [x, y] = InMemoryTransport.createLinkedPair();
	await server.connect(x);
	const client = new Client({ name: 'overwrite-test', version: '1' });
	await client.connect(y);
	open.push(client);
	const call = async (name: string, args: Record<string, unknown>) =>
		readToolResponse((await client.callTool({ name, arguments: args })) as CallToolResult);
	return { engine, call };
}

describe('start_export overwrite', () => {
	it('passes overwrite to the destination and reports the replaced file as `path`', async () => {
		const { engine, call } = await connect();
		const r = await call('start_export', {
			projectId: 'prj_test',
			outputPath: OUT,
			overwrite: true,
			wait: true,
		});
		expect(engine.starts[0]!.settings.destination).toEqual({ type: 'path', path: OUT, overwrite: true });
		expect(r.body).toMatchObject({ path: OUT });
		expect((r.body as { pathNote?: string }).pathNote).toBeUndefined();
	});

	it('without overwrite an existing file is kept, and the result says where the export went', async () => {
		const { engine, call } = await connect();
		const r = await call('start_export', { projectId: 'prj_test', outputPath: OUT, wait: true });
		expect(engine.starts[0]!.settings.destination).toEqual({ type: 'path', path: OUT });
		const moved = OUT.replace('.mp4', ' (2).mp4');
		expect(r.body).toMatchObject({ path: moved });
		expect((r.body as { pathNote: string }).pathNote).toMatch(/already existed.*overwrite: true/);
		const w = await call('wait_for_job', { jobId: 'job_export' });
		expect(w.body).toMatchObject({ path: moved, pathNote: expect.stringContaining(OUT) });
	});

	it('refuses overwrite without outputPath', async () => {
		const { call } = await connect();
		const r = await call('start_export', { projectId: 'prj_test', overwrite: true });
		expect(r.isError).toBe(true);
		expect(r.body).toMatchObject({ error: { code: 'E_INVALID_PARAM' } });
	});
});
