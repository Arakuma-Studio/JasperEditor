// start_export's sound credits (spec 12 §2.11; wp-note sound-design "Phase 6 → WP6.4"): the `credits` argument
// reaches the engine's ExportSettings (format, scope, null = none), the default follows the sequence's sound design
// setting or a used CC BY sound, the plan's sound warnings come back with their codes (W_SOUND_CREDITS,
// W_SOUND_CHECK_STALE as info) and wait_for_job returns the result's credits file and warnings. The engine is faked
// (the real sidecar is written in apps/engine/test/sound-export-credits.test.ts).
import type { ExportSettings, ExportStartRequest, RenderPlan } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type ProjectDocument,
} from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineConnection } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';
import { readToolResponse } from './tool-response.ts';

function fakeEngine(license = 'CC-BY-4.0') {
	const ids = createCounterIdSource(5);
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'Credits', preset: 'hd-1080p-30' });
	let revision = 0;
	const seqId = Object.keys(doc.sequences)[0]!;
	const apply = (commands: unknown[]) => {
		const r = applyTransaction(
			doc,
			{ protocol: 'jasper.tx/1', sequenceId: seqId, label: 'x', commands, origin: 'user' } as never,
			{ ids, now: () => '2026-10-17T00:00:00.000Z', revision, registries: defaultRegistries() },
		);
		if (!r.result.ok) throw new Error(JSON.stringify(r.result.errors));
		doc = r.document;
		revision++;
	};
	apply([
		{
			type: 'media.register',
			ref: '$a',
			asset: {
				kind: 'audio',
				fingerprint: 'q1:credits',
				originalName: 'whoosh.wav',
				sizeBytes: 1,
				container: 'wav',
				probe: {
					durationFlicks: 705_600_000,
					startTimecode: null,
					streams: [
						{ index: 0, type: 'audio', codec: 'pcm_s16le', sampleRate: 48_000, channels: 2, channelLayout: 'stereo' },
					],
					rotationDegrees: 0,
					hasAlpha: false,
					variableFrameRate: false,
				},
				locators: [{ type: 'engine-store', engineId: 'local', key: 'mk_credits' }],
				library: {
					soundId: 'snd_00000000000000a1',
					title: 'Whoosh',
					types: ['whoosh'],
					source: { type: 'folder', rootId: 'root_1', relPath: 'whoosh.wav' },
					license,
					author: 'Ana',
					attribution: '"Whoosh" by Ana (CC BY 4.0)',
				},
			},
		},
		{ type: 'clip.place', source: { mediaId: '$a' }, at: 0, tracks: { audio: 'A1' } },
	]);
	const starts: ExportStartRequest[] = [];
	const plans: ExportSettings[] = [];
	const warnings = (s: ExportSettings): RenderPlan['warnings'] => [
		...(s.credits?.sidecar
			? []
			: [{ code: 'W_SOUND_CREDITS', message: '1 sound heard in this export needs a credit (CC-BY-4.0: "Whoosh")' }]),
		{ code: 'W_SOUND_CHECK_STALE', level: 'info' as const, message: 'The last Sound Check of this sequence is out of date' },
		{ code: 'FIELDS_PROGRESSIVE', message: 'unrelated' },
	];
	const job = (state: string) => ({
		id: 'job_export',
		kind: 'export',
		title: 'Export',
		origin: { type: 'agent', agentRunId: 'x' },
		state,
		progress: state === 'succeeded' ? 1 : 0,
		createdAt: '2026-10-17T10:00:00.000Z',
		priority: 'user',
		cpuSlots: 2,
		...(state === 'succeeded'
			? {
					result: {
						downloadUrl: '/renders/job_export/output',
						byteSize: 10,
						durationSec: 1,
						frames: 30,
						credits: {
							format: 'md',
							scope: 'all',
							count: 1,
							name: 'output.credits.md',
							url: '/renders/job_export/credits/output.credits.md',
						},
						warnings: [{ code: 'W_SOUND_CHECK_STALE', level: 'info', message: 'stale' }],
					},
				}
			: {}),
	});
	const client = {
		agentQuery: async () => ({ result: doc, revision, via: 'headless' }),
		planExport: async (req: { settings: ExportSettings }) => {
			plans.push(req.settings);
			const plan: RenderPlan = {
				planId: 'pln_1',
				documentRevision: revision,
				path: 'native',
				segments: [],
				audio: { mode: 'native-mix' },
				blockers: [],
				warnings: warnings(req.settings),
				estimate: { seconds: 1, bytes: 1 },
			};
			return plan;
		},
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
	return { link, starts, plans, apply, seqId };
}

let open: Client[] = [];
afterEach(async () => {
	for (const c of open) await c.close().catch(() => {});
	open = [];
});

async function connect(license?: string) {
	const engine = fakeEngine(license);
	const { server } = createJasperMcpServer({ link: engine.link, agentName: 'credits-test' });
	const [x, y] = InMemoryTransport.createLinkedPair();
	await server.connect(x);
	const client = new Client({ name: 'credits-test', version: '1' });
	await client.connect(y);
	open.push(client);
	const call = async (name: string, args: Record<string, unknown>) =>
		readToolResponse((await client.callTool({ name, arguments: args })) as CallToolResult);
	return { engine, call };
}

describe('start_export credits (spec 12 §2.11)', () => {
	it('defaults to Markdown when a used sound needs a credit; returns the sound warnings with their codes', async () => {
		const { call, engine } = await connect();
		const r = await call('start_export', { projectId: 'prj_test' });
		expect(r.isError).toBe(false);
		expect(engine.starts[0]!.settings.credits).toEqual({ sidecar: 'md' });
		expect(r.body.credits).toEqual({ sidecar: 'md', defaulted: true });
		expect(r.body.soundWarnings).toEqual([
			{ code: 'W_SOUND_CHECK_STALE', level: 'info', message: 'The last Sound Check of this sequence is out of date' },
		]);
	});

	it('format, scope and null reach the engine; null leaves W_SOUND_CREDITS for the agent to tell', async () => {
		const { call, engine } = await connect();
		await call('start_export', { projectId: 'prj_test', credits: 'csv' });
		await call('start_export', { projectId: 'prj_test', credits: { sidecar: 'txt', scope: 'attribution' } });
		const off = await call('start_export', { projectId: 'prj_test', credits: null });
		expect(engine.starts.map((s) => s.settings.credits)).toEqual([
			{ sidecar: 'csv' },
			{ sidecar: 'txt', scope: 'attribution' },
			undefined,
		]);
		expect(off.body.credits).toEqual({ sidecar: null, defaulted: false });
		expect((off.body.soundWarnings as { code: string }[]).map((w) => w.code)).toEqual([
			'W_SOUND_CREDITS',
			'W_SOUND_CHECK_STALE',
		]);
		const bad = await call('start_export', { projectId: 'prj_test', credits: 'pdf' });
		expect(bad.isError).toBe(true);
		const extra = await call('start_export', { projectId: 'prj_test', credits: { sidecar: 'md', where: 'x' } });
		expect(extra.isError).toBe(true);
	});

	it('the sequence setting wins over the default (none when set to null); CC0 alone gives none', async () => {
		const a = await connect();
		a.engine.apply([{ type: 'soundDesign.setSettings', credits: 'txt' }]);
		await a.call('start_export', { projectId: 'prj_test' });
		a.engine.apply([{ type: 'soundDesign.setSettings', credits: null }]);
		await a.call('start_export', { projectId: 'prj_test' });
		expect(a.engine.starts.map((s) => s.settings.credits)).toEqual([{ sidecar: 'txt' }, undefined]);
		const b = await connect('CC0-1.0');
		await b.call('start_export', { projectId: 'prj_test' });
		expect(b.engine.starts[0]!.settings.credits).toBeUndefined();
	});

	it('wait: true and wait_for_job return the credits file and the warnings of the result', async () => {
		const { call } = await connect();
		const r = await call('start_export', { projectId: 'prj_test', wait: true });
		expect(r.body.result).toMatchObject({
			credits: { format: 'md', count: 1, url: 'http://engine.test/renders/job_export/credits/output.credits.md' },
			warnings: [{ code: 'W_SOUND_CHECK_STALE', level: 'info' }],
		});
		const w = await call('wait_for_job', { jobId: 'job_export' });
		expect((w.body.result as { credits: { name: string } }).credits.name).toBe('output.credits.md');
	});
});
