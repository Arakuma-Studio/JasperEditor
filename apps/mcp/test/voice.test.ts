// get_voice_analysis (spec 14 TC-001): reads a cached analysis, or runs the engine job and reads it; totals, windows
// and a downsampled page with class runs; strict arguments, refusals and job failures as tool errors; the guide.
import type { EngineJob, VoiceAnalyzeRequest } from '@jasper/api';
import { type EngineClient, EngineError } from '@jasper/engine-client';
import {
	applyTransaction,
	buildVoiceAnalysis,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type MediaAsset,
	type ProjectDocument,
	type VoiceAnalysis,
} from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { EngineConnection } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';
import { readToolResponse } from './tool-response.ts';

const S = 705_600_000;

function asset(
	key: string,
	streams: Array<{ index: number; type: 'audio' | 'subtitle' }>,
): Omit<MediaAsset, 'id'> {
	return {
		kind: 'audio',
		fingerprint: `q1:${key.slice(3).padStart(64, '0')}`,
		originalName: `${key}.mka`,
		sizeBytes: 1000,
		container: 'matroska',
		probe: {
			durationFlicks: 20 * S,
			startTimecode: null,
			streams: streams.map((s) =>
				s.type === 'audio'
					? {
							index: s.index,
							type: 'audio',
							codec: 'aac',
							sampleRate: 48000,
							channels: 2,
							channelLayout: 'stereo',
						}
					: { index: s.index, type: 'subtitle', codec: 'ass', language: null },
			),
			rotationDegrees: 0,
			hasAlpha: false,
			variableFrameRate: false,
		},
		locators: [{ type: 'engine-store', engineId: 'local', key }],
		derivation: null,
		importedAt: '2026-10-25T10:00:00.000Z',
	} as Omit<MediaAsset, 'id'>;
}

/** 20 s of frames: speech (−20 dBFS, voiced) 0–1 s of every 2 s, a −70 dBFS noise floor between. */
function analysis(stream: number): VoiceAnalysis {
	const n = 2000;
	const planes = { level: new Uint8Array(n), voicing: new Uint8Array(n), flatness: new Uint8Array(n) };
	for (let k = 0; k < n; k++) {
		const speech = k % 200 < 100;
		planes.level[k] = speech ? 200 : 100;
		planes.voicing[k] = speech ? 230 : 20;
		planes.flatness[k] = speech ? 10 : 150;
	}
	return buildVoiceAnalysis({ fingerprint: 'q1:x', stream, samples: n * 160, planes });
}

function fakeEngine(opts: { cached: boolean; jobState?: EngineJob['state'] }) {
	const ids = createCounterIdSource(5);
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'Voice', preset: 'hd-1080p-25' });
	const seqId = Object.keys(doc.sequences)[0]!;
	const r = applyTransaction(
		doc,
		{
			protocol: 'jasper.tx/1',
			sequenceId: seqId,
			origin: 'user',
			label: 'setup',
			commands: [
				{
					type: 'media.register',
					asset: asset('mk_aaaaaaaaaaaaaaaaaaaaaaaa', [
						{ index: 0, type: 'subtitle' },
						{ index: 1, type: 'audio' },
						{ index: 2, type: 'audio' },
					]),
					ref: '$a',
				},
				{
					type: 'media.register',
					asset: asset('mk_bbbbbbbbbbbbbbbbbbbbbbbb', [{ index: 0, type: 'subtitle' }]),
					ref: '$b',
				},
			],
		} as never,
		{ ids, now: () => '2026-10-25T00:00:00.000Z', revision: 0, registries: defaultRegistries() },
	);
	if (!r.result.ok) throw new Error(JSON.stringify(r.result.errors));
	doc = r.document;
	const calls: string[] = [];
	const analysed = new Set<number>(opts.cached ? [1, 2] : []);
	const job = (state: EngineJob['state']): EngineJob =>
		({
			id: 'job_1',
			kind: 'voice-analysis',
			title: 'Voice analysis',
			origin: { type: 'agent', agentRunId: 'x' },
			state,
			progress: state === 'succeeded' ? 1 : 0.5,
			createdAt: '2026-10-25T10:00:00.000Z',
			priority: 'user',
			cpuSlots: 4,
			...(state === 'failed'
				? { error: { code: 'TOOL_FAILED', message: 'ffmpeg exited 1', retryable: true } }
				: {}),
		}) as EngineJob;
	let pendingStream = -1;
	const client = {
		agentQuery: async () => ({ result: doc, revision: 1, via: 'headless' }),
		getVoiceAnalysis: async (key: string, stream?: number) => {
			calls.push(`get ${key} ${stream}`);
			if (stream === undefined || !analysed.has(stream))
				throw new EngineError('VOICE_ANALYSIS_NOT_FOUND', 'No voice analysis', { status: 404 });
			return analysis(stream);
		},
		analyzeVoice: async (key: string, req: VoiceAnalyzeRequest) => {
			calls.push(`analyze ${key} ${JSON.stringify(req)}`);
			pendingStream = req.streamIndex ?? -1;
			return job('running');
		},
		getJob: async () => {
			const state = opts.jobState ?? 'succeeded';
			if (state === 'succeeded') analysed.add(pendingStream);
			return job(state);
		},
		cancelJob: async () => job('cancelled'),
	};
	const link: EngineConnection = {
		target: { url: 'http://engine.test', token: null, source: 'explicit' },
		client: async () => client as unknown as EngineClient,
		invalidate: () => {},
		close: async () => {},
	};
	return { link, calls, a: r.result.refs.$a!, b: r.result.refs.$b! };
}

let open: Client[] = [];
afterEach(async () => {
	for (const c of open) await c.close().catch(() => {});
	open = [];
});

async function connect(opts: { cached: boolean; jobState?: EngineJob['state'] }) {
	const engine = fakeEngine(opts);
	const { server } = createJasperMcpServer({ link: engine.link, agentName: 'voice-test' });
	const [x, y] = InMemoryTransport.createLinkedPair();
	await server.connect(x);
	const client = new Client({ name: 'voice-test', version: '1' });
	await client.connect(y);
	open.push(client);
	const call = async (args: Record<string, unknown>) =>
		readToolResponse(
			(await client.callTool({
				name: 'get_voice_analysis',
				arguments: { projectId: 'prj_test', ...args },
			})) as CallToolResult,
		);
	return { engine, call, client };
}

const Summary = z.object({
	mediaId: z.string(),
	frameStepMs: z.literal(10),
	stream: z.number(),
	durationSeconds: z.number(),
	frameCount: z.number(),
	floorDb: z.number(),
	speechDb: z.number(),
	speechThresholdDb: z.number(),
	seconds: z.object({ speech: z.number(), breath: z.number(), silence: z.number() }),
	runs: z.object({ speech: z.number(), breath: z.number(), silence: z.number() }),
	windows: z.array(z.object({ startSeconds: z.number(), seconds: z.number() })),
	jobId: z.string().optional(),
	page: z
		.object({
			fromSeconds: z.number(),
			toSeconds: z.number(),
			stepMs: z.number(),
			times: z.array(z.number()),
			levelDb: z.array(z.number()),
			voicing: z.array(z.number()),
			flatness: z.array(z.number()),
			classes: z.array(z.enum(['speech', 'breath', 'silence'])),
			runs: z.array(z.object({ cls: z.string(), start: z.number(), end: z.number() })),
			nextFromSeconds: z.number().optional(),
		})
		.optional(),
});

describe('get_voice_analysis', () => {
	it('is a read-only tool with a documented guide', async () => {
		const { client } = await connect({ cached: true });
		const tool = (await client.listTools()).tools.find((t) => t.name === 'get_voice_analysis')!;
		expect(tool.annotations).toMatchObject({
			readOnlyHint: true,
			destructiveHint: false,
			openWorldHint: false,
		});
		expect(client.getInstructions()).toContain('get_voice_analysis');
	});

	it('reads a cached analysis of the first audio stream: totals and 60 s windows', async () => {
		const { call, engine } = await connect({ cached: true });
		const r = await call({ mediaId: engine.a });
		expect(r.isError, JSON.stringify(r.body)).toBe(false);
		const s = r.read(Summary);
		expect(s).toMatchObject({ mediaId: engine.a, stream: 1, durationSeconds: 20, frameCount: 2000 });
		expect(s.runs.speech).toBe(10);
		expect(s.seconds.speech).toBeGreaterThan(9.5);
		expect(s.windows).toHaveLength(1);
		expect(s.page).toBeUndefined();
		expect(s.jobId).toBeUndefined();
		expect(engine.calls).toEqual(['get mk_aaaaaaaaaaaaaaaaaaaaaaaa 1']);
	});

	it('runs the analysis when none is cached, then reads it', async () => {
		const { call, engine } = await connect({ cached: false });
		const r = await call({ mediaId: engine.a, stream: 2 });
		expect(r.isError, JSON.stringify(r.body)).toBe(false);
		expect(r.read(Summary)).toMatchObject({ stream: 2, jobId: 'job_1' });
		expect(engine.calls).toEqual([
			'get mk_aaaaaaaaaaaaaaaaaaaaaaaa 2',
			'analyze mk_aaaaaaaaaaaaaaaaaaaaaaaa {"projectId":"prj_test","streamIndex":2}',
			'get mk_aaaaaaaaaaaaaaaaaaaaaaaa 2',
		]);
	});

	it('pages frames: points, loudest levels, classes and class runs, and the next page', async () => {
		const { call, engine } = await connect({ cached: true });
		const r = await call({ mediaId: engine.a, summary: false, fromSeconds: 1.5, seconds: 2, stepMs: 100 });
		const p = r.read(Summary).page!;
		expect(p.fromSeconds).toBe(1.5);
		expect(p.toSeconds).toBe(3.5);
		expect(p.stepMs).toBe(100);
		expect(p.times).toHaveLength(20);
		// 1.5–2 s silence, 2–3 s tone, 3–3.5 s silence
		expect(p.classes.slice(0, 4).every((c) => c === 'silence')).toBe(true);
		expect(p.classes.slice(6, 14).every((c) => c === 'speech')).toBe(true);
		expect(p.levelDb[10]!).toBeGreaterThan(p.levelDb[0]! + 20);
		expect(p.runs.map((x) => x.cls)).toEqual(['silence', 'speech', 'silence']);
		expect(p.nextFromSeconds).toBe(3.5);
		// at most 6000 points: a long page with a small step is coarsened
		const big = (await call({ mediaId: engine.a, summary: false, seconds: 600, stepMs: 10 })).read(Summary)
			.page!;
		expect(big.times.length).toBeLessThanOrEqual(6000);
		expect(big.nextFromSeconds).toBeUndefined();
		expect(big.toSeconds).toBe(20);
	});

	it('refuses unknown media, non-audio streams, media without audio and analyze:false misses', async () => {
		const { call, engine } = await connect({ cached: false });
		const cases: Array<[Record<string, unknown>, string]> = [
			[{ mediaId: 'med_nope' }, 'E_NOT_FOUND'],
			[{ mediaId: engine.a, stream: 0 }, 'E_INVALID_PARAM'],
			[{ mediaId: engine.b }, 'E_INVALID_PARAM'],
			[{ mediaId: engine.a, analyze: false }, 'E_NOT_FOUND'],
			[{ mediaId: engine.a, bogus: 1 }, 'E_UNKNOWN_ARGUMENT'],
			[{ mediaId: engine.a, seconds: 601 }, ''],
		];
		for (const [args, code] of cases) {
			const r = await call(args);
			expect(r.isError, JSON.stringify(args)).toBe(true);
			if (code) expect(JSON.stringify(r.body)).toContain(code);
		}
		expect(engine.calls.some((c) => c.startsWith('analyze'))).toBe(false);
	});

	it('reports a failed analysis job as a tool error with its code', async () => {
		const { call, engine } = await connect({ cached: false, jobState: 'failed' });
		const r = await call({ mediaId: engine.a });
		expect(r.isError).toBe(true);
		expect(JSON.stringify(r.body)).toContain('TOOL_FAILED');
	});
});
