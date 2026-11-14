// fix_transcript (spec 17 SC-091): strict arguments, engine requests, dry-run/proposal results, progress,
// cancellation of the engine job, and refused jobs as tool errors with their E_* code.
import type { EngineJob, TranscriptFixResult } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import { createCounterIdSource, createEmptyProject, type ProjectDocument } from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineConnection } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';

const P = 'prj_fix';
const doc: ProjectDocument = createEmptyProject({
	ids: createCounterIdSource(3),
	name: 'F',
	preset: 'hd-1080p-30',
});
const SEQ = Object.keys(doc.sequences)[0]!;

const result = (mode: 'propose' | 'dryRun' | 'rebuild'): TranscriptFixResult => ({
	mode,
	projectId: P,
	sequenceId: SEQ,
	proposalId: mode !== 'dryRun' ? 'prp_0000000000000009' : null,
	itemCount: mode !== 'dryRun' ? 2 : 0,
	revision: 3,
	report: {
		settings: {
			sources: ['script', 'glossary'],
			scope: 'recordings',
			strictness: 'standard',
			showRejected: false,
		},
		sourcesUsed: ['script'],
		perMedia: [
			{
				mediaId: 'med_1',
				transcriptId: 'trn_1',
				name: 'voice.wav',
				language: 'en',
				words: 120,
				wordsInScope: 120,
				alignment: {
					transcriptTokens: 120,
					scriptTokens: 118,
					alignedShare: 0.91,
					offScriptShare: 0.03,
					retakeJumps: 1,
					unusedLines: [],
				},
				candidates: 3,
				windows: 2,
				readings: 4,
			},
		],
		candidates: {
			total: 3,
			byGroup: mode === 'propose' ? { fix: 1, spelling: 1, keep: 1 } : { spelling: 1, pending: 2 },
			byCategory: { proper: 1, other: 2 },
			byKind: { join: 1, sub: 2 },
		},
		decisions: [
			{
				candidateId: 'c1',
				fingerprint: 'sf1~med_1~abc',
				mediaId: 'med_1',
				kind: 'join',
				category: 'proper',
				asr: ['glimmer', 'box'],
				script: ['Glimmerbox'],
				decision: 'fix',
				group: 'spelling',
				rule: 'join',
				deltaTok: null,
				start: 0,
				end: 100,
			},
		],
		decisionsTruncated: false,
		skipped: { ins: 1 },
		unusedLines: [],
		patch: { edits: 2, patched: 1, skipped: [], stale: 0 },
		speech: { model: 'whisper-tiny.en' },
		device: mode === 'propose' ? { label: 'CPU' } : null,
		...(mode === 'dryRun'
			? {
					estimate: {
						seconds: 12.5,
						windows: 2,
						readings: 4,
						basis: 'reference' as const,
						note: '≈ reference',
					},
				}
			: {}),
		timings: { readMs: 1, alignMs: 5, scoreMs: 0, decideMs: 1, totalMs: 9, speechSeconds: 50 },
		warnings: [],
	},
});

function fakeEngine(
	opts: {
		fail?: { code: string; message: string; detail?: unknown };
		runningPolls?: number;
		onCancelled?: () => void;
	} = {},
) {
	const calls: { name: string; args: unknown[] }[] = [];
	let polls = 0;
	let mode: 'propose' | 'dryRun' | 'rebuild' = 'propose';
	let cancelled = false;
	const job = (): EngineJob => {
		polls++;
		const running = !cancelled && polls <= (opts.runningPolls ?? 0);
		const state = cancelled ? 'cancelled' : running ? 'running' : opts.fail ? 'failed' : 'succeeded';
		return {
			id: 'job_fix',
			kind: 'transcript-fix',
			title: 'Fix Transcript',
			origin: { type: 'agent', agentRunId: 'fix-test' },
			state,
			progress: running ? Math.min(0.9, polls / 10) : 1,
			stage: running ? 'Scoring' : null,
			createdAt: '2026-10-27T00:00:00.000Z',
			...(state === 'succeeded' ? { result: result(mode) } : {}),
			...(state === 'failed' ? { error: { ...opts.fail!, retryable: false } } : {}),
		} as unknown as EngineJob;
	};
	const client = {
		agentQuery: async () => ({ result: doc, revision: 3, via: 'headless' }),
		transcriptFix: async (
			projectId: string,
			sequenceId: string,
			req: { mode: 'propose' | 'dryRun' | 'rebuild' },
		) => {
			calls.push({ name: 'transcriptFix', args: [projectId, sequenceId, req] });
			mode = req.mode;
			return { ...job(), state: 'queued' };
		},
		getJob: async () => job(),
		cancelJob: async (id: string) => {
			calls.push({ name: 'cancelJob', args: [id] });
			cancelled = true;
			opts.onCancelled?.();
			return job();
		},
	};
	const link: EngineConnection = {
		target: { url: 'http://engine.test', token: null, source: 'explicit' },
		client: async () => client as unknown as EngineClient,
		invalidate: () => {},
		close: async () => {},
	};
	return { link, calls };
}

let open: Client[] = [];
afterEach(async () => {
	for (const c of open) await c.close().catch(() => {});
	open = [];
});

async function connect(opts: Parameters<typeof fakeEngine>[0] = {}) {
	const engine = fakeEngine(opts);
	const { server } = createJasperMcpServer({ link: engine.link, agentName: 'fix-test' });
	const [x, y] = InMemoryTransport.createLinkedPair();
	await server.connect(x);
	const client = new Client({ name: 'fix-test', version: '1' });
	await client.connect(y);
	open.push(client);
	const call = async (args: Record<string, unknown>) => {
		const r = (await client.callTool({ name: 'fix_transcript', arguments: args })) as CallToolResult;
		// biome-ignore lint/suspicious/noExplicitAny: tool results are JSON read loosely by the assertions
		return { r, json: JSON.parse((r.content[0] as { text: string }).text) as Record<string, any> };
	};
	return { engine, client, call };
}

describe('fix_transcript', () => {
	it('refuses unknown settings, unsupported scopes and missing mode before starting a job', async () => {
		const t = await connect();
		const { r, json } = await t.call({ projectId: P, mode: 'dryRun', strictnes: 'careful' });
		expect(r.isError).toBe(true);
		expect(json.error.code).toBe('E_UNKNOWN_ARGUMENT');
		const bad = await t.call({ projectId: P, mode: 'dryRun', scope: 'all' });
		expect(bad.r.isError).toBe(true);
		expect(bad.json.error.code).toBe('E_INVALID_ARGUMENT');
		const missing = await t.call({ projectId: P });
		expect(missing.r.isError).toBe(true);
		expect(missing.json.error.code).toBe('E_INVALID_ARGUMENT');
		expect(t.engine.calls).toEqual([]);
	});

	it('dry run: passes the settings to the engine and returns the pre-run report', async () => {
		const t = await connect();
		const { r, json } = await t.call({
			projectId: P,
			mode: 'dryRun',
			sources: ['script'],
			scope: 'used',
			strictness: 'careful',
			showRejected: true,
			device: 'cpu',
		});
		expect(r.isError).toBeFalsy();
		expect(t.engine.calls[0]).toEqual({
			name: 'transcriptFix',
			args: [
				P,
				SEQ,
				{
					mode: 'dryRun',
					sources: ['script'],
					scope: 'used',
					strictness: 'careful',
					showRejected: true,
					device: 'cpu',
				},
			],
		});
		expect(json).toMatchObject({
			mode: 'dryRun',
			proposalId: null,
			estimate: { basis: 'reference' },
			perMedia: [{ alignedShare: 0.91, offScriptShare: 0.03 }],
		});
		expect(json.next).toContain('mode "propose"');
	});

	it('rebuild: asks the engine to rebuild the kept speech (off-script words kept) and names the proposal', async () => {
		const t = await connect();
		const { r, json } = await t.call({ projectId: P, mode: 'rebuild', offScript: 'keep' });
		expect(r.isError).toBeFalsy();
		expect(t.engine.calls[0]!.args[2]).toEqual({ mode: 'rebuild', offScript: 'keep' });
		expect(json).toMatchObject({ mode: 'rebuild', proposalId: 'prp_0000000000000009' });
		expect(json.next).toContain('rewrites 2 kept spans');
	});

	it('propose: waits for the job with progress notifications and names the proposal', async () => {
		const t = await connect({ runningPolls: 3 });
		const progress: number[] = [];
		const r = (await t.client.callTool(
			{ name: 'fix_transcript', arguments: { projectId: P, mode: 'propose' } },
			undefined,
			{
				onprogress: (p) => progress.push(p.progress),
			},
		)) as CallToolResult;
		expect(r.isError).toBeFalsy();
		const json = JSON.parse((r.content[0] as { text: string }).text);
		expect(json).toMatchObject({
			proposalId: 'prp_0000000000000009',
			itemCount: 2,
			candidates: { byGroup: { fix: 1 } },
		});
		expect(json.next).toContain('wait_for_proposal');
		expect(json.next).toContain('do not regenerate');
		expect(progress.length).toBeGreaterThan(0);
	});

	it('cancelling the request cancels the engine job', async () => {
		let onCancelled!: () => void;
		const cancelled = new Promise<void>((resolve) => {
			onCancelled = resolve;
		});
		const t = await connect({ runningPolls: 1000, onCancelled });
		let progressed!: () => void;
		const progressReceived = new Promise<void>((resolve) => {
			progressed = resolve;
		});
		const ac = new AbortController();
		const progress: number[] = [];
		const call = t.client.callTool(
			{ name: 'fix_transcript', arguments: { projectId: P, mode: 'propose' } },
			undefined,
			{
				signal: ac.signal,
				onprogress: (p) => {
					progress.push(p.progress);
					progressed();
				},
			},
		);
		await progressReceived;
		expect(progress.length).toBeGreaterThan(0);
		ac.abort('stop');
		await expect(call).rejects.toThrow();
		await cancelled;
		expect(t.engine.calls).toContainEqual({ name: 'cancelJob', args: ['job_fix'] });
	});

	it('a refused job is a tool error with its E_* code and a hint', async () => {
		const t = await connect({
			fail: { code: 'NO_FIX_SOURCE', message: 'Nothing to fix from', detail: { code: 'E_NO_SOURCE' } },
		});
		const { r, json } = await t.call({ projectId: P, mode: 'propose' });
		expect(r.isError).toBe(true);
		expect(json.error.code).toBe('E_NO_SOURCE');
		expect(json.error.hint).toBeTruthy();
	});
});
