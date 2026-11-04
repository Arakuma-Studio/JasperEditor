// Clean Up tools (spec 14 TC-050 / TC-051): analyze_voice (paged findings, groups, ranges, statistics; sequence,
// clip and media targets), plan_cleanup (decisions re-plan), apply_cleanup (one "Clean Up Voice: N cuts" transaction
// with the rejections remembered; stale analysis refused), set_cleanup_settings, attach_script; strict schemas,
// errors as tool errors. The fake engine runs real pure analysis like the engine's `cleanup-analysis` job.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CleanupAnalysisFile, CleanupAnalyzeRequest, EngineJob } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import {
	analyzeSequenceCleanup,
	applyTransaction,
	builtinCleanupSettings,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	loadProject,
	mergeCleanupSettings,
	type ProjectDocument,
	type Sequence,
	sequenceCleanupSettings,
} from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { GOLDEN_EVENTS, GOLDEN_SCRIPT } from '../../../packages/project/test/cleanup-golden-fixture.ts';
import { synthRecording } from '../../../packages/project/test/cleanup-synth.ts';
import { videoAsset } from '../../../packages/project/test/helpers.ts';
import type { EngineConnection } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';
import { readToolResponse } from './tool-response.ts';

const REC = synthRecording(GOLDEN_EVENTS, 7);

function fakeEngine(opts: { script?: boolean } = {}) {
	const ids = createCounterIdSource(5);
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'Clean Up', preset: 'hd-1080p-30' });
	let revision = 1;
	const seqId = Object.keys(doc.sequences)[0]!;
	const apply = (tx: Record<string, unknown>) => {
		const r = applyTransaction(
			doc,
			{ protocol: 'jasper.tx/1', origin: 'user', sequenceId: seqId, ...tx } as never,
			{
				ids,
				now: () => '2026-10-26T00:00:00.000Z',
				revision,
				registries: defaultRegistries(),
			},
		);
		if (r.result.ok && !tx.dryRun) {
			doc = r.document;
			revision++;
		}
		return r.result;
	};
	const setup = apply({
		label: 'setup',
		commands: [
			{ type: 'media.register', asset: videoAsset({ seconds: REC.durationS, kind: 'audio' }), ref: '$m' },
			{
				type: 'clip.place',
				source: { mediaId: '$m' },
				at: 0,
				tracks: { audio: ['A1'] },
				mode: 'overwrite',
				ref: '$c',
			},
		],
	});
	if (!setup.ok) throw new Error(JSON.stringify(setup.errors));
	const mediaId = setup.refs.$m!;
	const clipId = setup.refs.$c!;
	const t = apply({
		label: 'transcript',
		commands: [
			{
				type: 'transcript.create',
				mediaId,
				language: 'es',
				origin: 'manual',
				words: REC.words.map((w) => ({ text: w.text, start: w.start, end: w.end, confidence: w.confidence })),
			},
			...(opts.script === false
				? []
				: [{ type: 'cleanup.configure', script: { name: 'Guion', text: GOLDEN_SCRIPT } }]),
		],
	});
	if (!t.ok) throw new Error(JSON.stringify(t.errors));
	const files = new Map<string, CleanupAnalysisFile>();
	const requests: CleanupAnalyzeRequest[] = [];
	const txs: Array<Record<string, unknown>> = [];
	let n = 0;
	const client = {
		agentQuery: async () => ({ result: doc, revision, via: 'headless' }),
		agentTx: async (req: { transaction: Record<string, unknown> }) => {
			txs.push(req.transaction);
			const exp = req.transaction.expectedRevision;
			if (typeof exp === 'number' && exp !== revision)
				return {
					appliedBy: 'headless',
					result: {
						ok: false,
						revision,
						errors: [{ commandIndex: -1, code: 'E_REVISION', message: 'stale' }],
					},
				};
			return { result: apply(req.transaction), appliedBy: 'headless' };
		},
		analyzeCleanup: async (req: CleanupAnalyzeRequest) => {
			requests.push(req);
			const id = `job_${++n}`;
			const d = req.document ? loadProject(req.document as never).document : doc;
			const seq = d.sequences[req.sequenceId!] as Sequence;
			let settings = req.presetId ? builtinCleanupSettings(req.presetId) : sequenceCleanupSettings(seq);
			if (!settings)
				return {
					id,
					kind: 'cleanup-analysis',
					state: 'failed',
					error: { code: 'PRESET_NOT_FOUND', message: 'no preset', retryable: false },
				} as unknown as EngineJob;
			if (req.overrides) settings = mergeCleanupSettings(settings, req.overrides);
			const a = analyzeSequenceCleanup({
				doc: d,
				seq,
				voice: () => REC.voice,
				settings,
				...(req.script !== undefined ? { script: req.script } : {}),
				...(req.decisions ? { decisions: req.decisions } : {}),
				scope: {
					...(req.clipIds ? { clipIds: req.clipIds } : {}),
					...(req.range ? { range: req.range } : {}),
				},
			});
			if (!a.ok)
				return {
					id,
					kind: 'cleanup-analysis',
					state: 'failed',
					error: { code: a.code, message: a.message, retryable: false },
				} as unknown as EngineJob;
			const analysisId = `cla_${n}`;
			files.set(analysisId, {
				format: 'jasper-cleanup-analysis',
				version: 1,
				analysisId,
				projectId: req.projectId,
				sequenceId: seq.id,
				revision: req.document ? -1 : revision,
				createdAt: '2026-10-26T00:00:00.000Z',
				analysis: a,
			});
			return {
				id,
				kind: 'cleanup-analysis',
				title: 'Clean Up Voice – analysis',
				state: 'succeeded',
				progress: 1,
				result: {
					analysisId,
					url: `/api/cleanup/analyses/${analysisId}`,
					projectId: req.projectId,
					sequenceId: seq.id,
					findings: a.findings.length,
					byKind: {},
					groups: a.groups.length,
					ranges: a.plan.ranges.length,
					stats: a.plan.stats,
					voice: { cached: [mediaId], analysed: [], missing: [] },
					elapsedMs: 5,
				},
			} as unknown as EngineJob;
		},
		getJob: async (id: string) => ({ id, state: 'succeeded' }) as EngineJob,
		getCleanupAnalysis: async (id: string) => {
			const f = files.get(id);
			if (!f) throw Object.assign(new Error('gone'), { code: 'CLEANUP_ANALYSIS_NOT_FOUND' });
			return f;
		},
	};
	const link: EngineConnection = {
		target: { url: 'http://engine.test', token: null, source: 'explicit' },
		client: async () => client as unknown as EngineClient,
		invalidate: () => {},
		close: async () => {},
	};
	return {
		link,
		requests,
		txs,
		mediaId,
		clipId,
		seqId,
		doc: () => doc,
		bump: () => apply({ label: 'marker', commands: [{ type: 'marker.add', frame: 1 }] }),
		setAgentProposals: (v: Record<string, boolean>) =>
			apply({
				label: 'settings',
				commands: [{ type: 'project.updateSettings', settings: { agentProposals: v } }],
			}),
	};
}

let open: Client[] = [];
afterEach(async () => {
	for (const c of open) await c.close().catch(() => {});
	open = [];
});

async function connect(opts: { script?: boolean } = {}) {
	const engine = fakeEngine(opts);
	const { server } = createJasperMcpServer({ link: engine.link, agentName: 'cleanup-test' });
	const [x, y] = InMemoryTransport.createLinkedPair();
	await server.connect(x);
	const client = new Client({ name: 'cleanup-test', version: '1' });
	await client.connect(y);
	open.push(client);
	const call = async (name: string, args: Record<string, unknown>) =>
		readToolResponse(
			(await client.callTool({ name, arguments: { projectId: 'prj_test', ...args } })) as CallToolResult,
		);
	return { engine, call, client };
}

// biome-ignore lint/suspicious/noExplicitAny: tool bodies are read loosely here; their shape is asserted value by value
type Body = Record<string, any>;

describe('Clean Up MCP tools', () => {
	it('analyze_voice: findings with frames, timecodes and reasons, groups, ranges, stats, pages', async () => {
		const { call, engine } = await connect();
		const r = await call('analyze_voice', { limit: 5 });
		expect(r.isError, JSON.stringify(r.body)).toBe(false);
		const b = r.body as Body;
		expect(b.sequenceId).toBe(engine.seqId);
		expect(b.stats.outputDuration).toBeLessThan(b.stats.inputDuration);
		expect(b.cuts).toBe(b.ranges.total);
		expect(b.findings.items).toHaveLength(5);
		expect(b.findings.nextOffset).toBe(5);
		const f = b.findings.items[0];
		expect(f).toMatchObject({
			id: expect.stringMatching(/^f\d+$/),
			fingerprint: expect.any(String),
			reason: expect.any(String),
		});
		expect(f.start).toMatchObject({
			frame: expect.any(Number),
			timecode: expect.stringMatching(/^\d\d:\d\d:\d\d:\d\d$/),
		});
		expect(b.groups.items[0].takes.some((t: Body) => t.kept)).toBe(true);
		expect(b.script.said).toBe(4);
		const p2 = (await call('analyze_voice', { offset: 5, limit: 5, include: ['findings'], kinds: ['pause'] }))
			.body as Body;
		expect(p2.groups).toBeUndefined();
		expect(p2.findings.items.every((x: Body) => x.kind === 'pause')).toBe(true);
		// clip and media targets, presets and overrides reach the engine
		await call('analyze_voice', {
			clipId: engine.clipId,
			preset: 'natural',
			settings: { gaps: { maxGapS: 0.3 } },
		});
		expect(engine.requests.at(-1)).toMatchObject({
			clipIds: [engine.clipId],
			presetId: 'builtin.natural',
			overrides: { gaps: { maxGapS: 0.3 } },
		});
		const m = (await call('analyze_voice', { mediaId: engine.mediaId, include: ['ranges'] })).body as Body;
		expect(m.mediaOnly).toBe(true);
		expect(engine.requests.at(-1)!.document).toBeDefined();
	});

	it('refuses bad arguments and engine refusals as tool errors', async () => {
		const { call, engine } = await connect();
		expect((await call('analyze_voice', { bogus: 1 })).isError).toBe(true);
		const two = await call('analyze_voice', { sequenceId: engine.seqId, mediaId: engine.mediaId });
		expect(two.isError).toBe(true);
		expect((two.body as Body).error.code).toBe('E_INVALID_PARAM');
		const preset = await call('analyze_voice', { preset: 'cup_missing' });
		expect(preset.isError).toBe(true);
		expect((preset.body as Body).error.code).toBe('PRESET_NOT_FOUND');
		const apply = await call('apply_cleanup', { mediaId: engine.mediaId });
		expect((apply.body as Body).error.code).toBe('E_INVALID_PARAM');
		expect((await call('attach_script', {})).isError).toBe(true);
	});

	it('plan_cleanup re-plans with decisions; apply_cleanup cuts in one transaction and remembers rejections', async () => {
		const { call, engine } = await connect();
		const a = (await call('analyze_voice', { include: ['findings'], limit: 1000 })).body as Body;
		const rm = a.findings.items.find((f: Body) => f.suggested === 'remove' && f.words);
		const p = (
			await call('plan_cleanup', { decisions: { reject: [rm.id] }, include: ['findings'], limit: 1000 })
		).body as Body;
		expect(p.findings.items.find((f: Body) => f.id === rm.id).accepted).toBe(false);
		expect(p.stats.outputDuration).toBeGreaterThan(a.stats.outputDuration);
		const before = engine.doc().sequences[engine.seqId]!;
		const r = await call('apply_cleanup', {
			decisions: { reject: [rm.fingerprint] },
			analysisId: p.analysisId,
		});
		expect(r.isError, JSON.stringify(r.body)).toBe(false);
		const b = r.body as Body;
		expect(b.label).toBe(`Clean Up Voice: ${b.cuts} cuts`);
		expect(engine.txs).toHaveLength(1);
		expect((engine.txs[0]!.commands as Body[]).map((c) => c.type)).toEqual([
			'cleanup.configure',
			'cleanup.apply',
		]);
		const after = engine.doc().sequences[engine.seqId]!;
		expect(after.cleanup).toMatchObject({ rejected: [rm.fingerprint] });
		const len = (s: Sequence) => Math.max(...Object.values(s.clips).map((c) => c.start + c.duration));
		expect(len(after)).toBeLessThan(len(before));
	});

	it('apply_cleanup respects "Allow agents to apply transcript-cleanup proposals"', async () => {
		const { call, engine } = await connect();
		engine.setAgentProposals({ 'transcript-cleanup': false });
		const r = await call('apply_cleanup', {});
		expect(r.isError).toBe(true);
		expect((r.body as Body).error.code).toBe('E_APPROVAL_DENIED');
		expect(engine.txs).toHaveLength(0);
	});

	it('apply_cleanup refuses an analysis of an older document (E_STALE)', async () => {
		const { call, engine } = await connect();
		const a = (await call('analyze_voice', { include: [] })).body as Body;
		engine.bump();
		const r = await call('apply_cleanup', { analysisId: a.analysisId, decisions: { reject: ['f1'] } });
		expect(r.isError).toBe(true);
		expect((r.body as Body).error.code).toBe('E_STALE');
		expect((r.body as Body).error.hint).toBeTruthy();
		expect(engine.txs).toHaveLength(0);
	});

	it('set_cleanup_settings and attach_script store the sequence state (undoable edits)', async () => {
		const { call, engine } = await connect({ script: false });
		let r = await call('set_cleanup_settings', { preset: 'natural', settings: { joins: { fadeMs: 6 } } });
		expect(r.isError, JSON.stringify(r.body)).toBe(false);
		expect(engine.doc().sequences[engine.seqId]!.cleanup).toMatchObject({
			settings: { presetId: 'builtin.natural', overrides: { joins: { fadeMs: 6 } } },
		});
		r = await call('set_cleanup_settings', { lists: { es: { fillers: ['eh', 'pos'] } }, reset: true });
		expect(engine.doc().sequences[engine.seqId]!.cleanup).toMatchObject({
			settings: { presetId: 'builtin.natural' },
			lists: { es: { fillers: ['eh', 'pos'] } },
		});
		expect((engine.doc().sequences[engine.seqId]!.cleanup as Body).settings.overrides).toBeUndefined();
		expect((await call('set_cleanup_settings', {})).isError).toBe(true);
		const dir = mkdtempSync(join(tmpdir(), 'cleanup-script-'));
		const file = join(dir, 'guion.txt');
		writeFileSync(file, GOLDEN_SCRIPT);
		r = await call('attach_script', { path: file });
		expect(r.isError, JSON.stringify(r.body)).toBe(false);
		expect(engine.doc().sequences[engine.seqId]!.cleanup).toMatchObject({
			script: { name: 'guion', text: GOLDEN_SCRIPT },
		});
		const relativePath = await call('attach_script', { path: 'relative.txt' });
		expect(relativePath.isError).toBe(true);
		expect(relativePath.body).toMatchObject({ error: { code: 'E_INVALID_PARAM' } });
		r = await call('attach_script', { detach: true });
		expect((engine.doc().sequences[engine.seqId]!.cleanup as Body).script).toBeUndefined();
	});
});
