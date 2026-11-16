// Export tools for agents (reported in a real cut, 2026-11-14): `jasper call start_export '{}'`, meant as a look at the
// arguments, exported the project open in the editor; a review cut of several ranges needed one export per range plus
// an outside concat; and an export whose job id was lost could not be verified, with no way to list past exports.
// The engine is faked (the joined render itself is tested in apps/engine/test/export-ranges.test.ts).
import type { EngineJob, ExportStartRequest, RenderPlan } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import { createCounterIdSource, createEmptyProject } from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/jasper-cli.ts';
import type { EngineConnection } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';
import { readToolResponse } from './tool-response.ts';

const PROJECT = 'prj_test';
const EARLIER = '/home/user/exports/review_v6.mp4';

function exportJob(id: string, path: string | null, state = 'succeeded'): EngineJob {
	return {
		id,
		kind: 'export',
		title: 'Export – Sequence 1',
		origin: { type: 'agent', agentRunId: 'x' },
		state,
		progress: state === 'succeeded' ? 1 : 0,
		createdAt: '2026-11-13T10:00:00.000Z',
		finishedAt: '2026-11-13T10:05:00.000Z',
		priority: 'user',
		cpuSlots: 2,
		projectId: PROJECT,
		...(state === 'succeeded'
			? {
					result: {
						downloadUrl: `/renders/${id}/output`,
						byteSize: 10,
						durationSec: 3,
						frames: 90,
						...(path ? { path } : {}),
					},
				}
			: {}),
	} as EngineJob;
}

function fakeEngine() {
	const doc = createEmptyProject({ ids: createCounterIdSource(5), name: 'Surface', preset: 'hd-1080p-30' });
	const starts: ExportStartRequest[] = [];
	const verified: string[] = [];
	const jobs: EngineJob[] = [
		exportJob('job_new', null, 'failed'),
		exportJob('job_v6', EARLIER),
		exportJob('job_v5', '/home/user/exports/review_v5.mp4'),
	];
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
	const verifyJob = {
		id: 'job_verify',
		kind: 'export-verify',
		title: 'Verify',
		origin: { type: 'agent', agentRunId: 'x' },
		state: 'succeeded',
		progress: 1,
		createdAt: '2026-11-14T10:00:00.000Z',
		priority: 'user',
		cpuSlots: 1,
		result: {
			exportId: 'job_v6',
			checks: 'fast',
			deliverable: 'video',
			output: { container: 'mp4', durationSec: 3, sizeBytes: 10, streams: [] },
			rows: [],
			verified: true,
			counts: { pass: 0, warn: 0, fail: 0, unverified: 0 },
		},
	};
	const client = {
		agentQuery: async () => ({ result: doc, revision: 0, via: 'headless' }),
		listProjects: async () => ({ projects: [{ projectId: PROJECT, name: 'Surface' }] }),
		agentUi: async () => ({ result: { projectId: PROJECT } }),
		planExport: async () => plan,
		startExport: async (req: ExportStartRequest) => {
			starts.push(req);
			return exportJob('job_started', null, 'queued');
		},
		listJobs: async (q: { projectId?: string }) => ({
			jobs: jobs.filter((j) => j.projectId === q.projectId),
		}),
		getJob: async (id: string) =>
			id === 'job_verify' ? verifyJob : (jobs.find((j) => j.id === id) ?? exportJob(id, null, 'queued')),
		verifyExport: async (id: string) => {
			verified.push(id);
			return verifyJob;
		},
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
	return { link, starts, verified };
}

let open: Client[] = [];
afterEach(async () => {
	for (const c of open) await c.close().catch(() => {});
	open = [];
});

async function connect() {
	const engine = fakeEngine();
	const { server } = createJasperMcpServer({ link: engine.link, agentName: 'surface-test' });
	const [x, y] = InMemoryTransport.createLinkedPair();
	await server.connect(x);
	const client = new Client({ name: 'surface-test', version: '1' });
	await client.connect(y);
	open.push(client);
	const call = async (name: string, args: Record<string, unknown>) =>
		readToolResponse((await client.callTool({ name, arguments: args })) as CallToolResult);
	return { engine, call };
}

describe('start_export', () => {
	it('joins a list of ranges into one export, in the order given', async () => {
		const { engine, call } = await connect();
		const r = await call('start_export', {
			projectId: PROJECT,
			range: [
				{ from: '00:20', to: '00:25' },
				{ from: 30, to: 60 },
			],
		});
		expect(r.isError, JSON.stringify(r.body)).toBe(false);
		expect(engine.starts[0]!.settings.range).toEqual({
			type: 'ranges',
			ranges: [
				{ startFrame: 600, endFrame: 750 },
				{ startFrame: 30, endFrame: 60 },
			],
		});
		const empty = await call('start_export', {
			projectId: PROJECT,
			range: [
				{ from: 0, to: 30 },
				{ from: 90, to: 90 },
			],
		});
		expect(empty.body).toMatchObject({
			error: { code: 'E_INVALID_PARAM', message: expect.stringMatching(/^range\[1\]/) },
		});
	});

	it('a video carries a sound stream unless videoOnly asks for the picture alone', async () => {
		const { engine, call } = await connect();
		expect((await call('start_export', { projectId: PROJECT })).isError).toBe(false);
		expect(engine.starts[0]!.settings.videoOnly).toBeUndefined();
		const r = await call('start_export', { projectId: PROJECT, videoOnly: true });
		expect(r.isError, JSON.stringify(r.body)).toBe(false);
		expect(engine.starts[1]!.settings.videoOnly).toBe(true);
		const mixed = await call('start_export', { projectId: PROJECT, videoOnly: true, normalizeLufs: -14 });
		expect(mixed.body).toMatchObject({ error: { code: 'E_INVALID_PARAM' } });
		expect(engine.starts).toHaveLength(2);
	});

	it('`jasper call start_export {}` never exports a guessed project: the refusal names projectId', async () => {
		const engine = fakeEngine();
		const err: string[] = [];
		const run = (argv: string[]) =>
			runCli(argv, { stdout: () => {}, stderr: (t) => err.push(t), link: engine.link, env: {} });
		expect(await run(['call', 'start_export', '{}'])).toBe(1);
		expect(err.join('')).toMatch(/projectId/);
		expect(engine.starts).toEqual([]);
		// a named project still exports
		expect(await run(['--project', PROJECT, 'call', 'start_export', '{}'])).toBe(0);
		expect(engine.starts).toHaveLength(1);
	});
});

describe('verify_export', () => {
	it('takes the file an export wrote and verifies the export job that wrote it', async () => {
		const { engine, call } = await connect();
		const r = await call('verify_export', { projectId: PROJECT, outputPath: EARLIER, checks: 'fast' });
		expect(r.isError, JSON.stringify(r.body)).toBe(false);
		expect(engine.verified).toEqual(['job_v6']);
		const unknown = await call('verify_export', {
			projectId: PROJECT,
			outputPath: '/home/user/elsewhere.mp4',
		});
		expect(unknown.body).toMatchObject({
			error: { code: 'E_NOT_FOUND', details: { exports: [{ path: EARLIER }, { jobId: 'job_v5' }] } },
		});
	});

	it("without an export lists the project's recent exports", async () => {
		const { engine, call } = await connect();
		const r = await call('verify_export', { projectId: PROJECT });
		expect((r.body as { exports: { jobId: string; state: string }[] }).exports).toEqual([
			expect.objectContaining({ jobId: 'job_new', state: 'failed' }),
			expect.objectContaining({ jobId: 'job_v6', path: EARLIER }),
			expect.objectContaining({ jobId: 'job_v5' }),
		]);
		expect(engine.verified).toEqual([]);
	});
});
