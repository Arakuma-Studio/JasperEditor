import { TranscribeMediaRequestSchema, TranscribeSequenceRequestSchema } from '@jasper/api';
import { type EngineClient, EngineError } from '@jasper/engine-client';
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type MediaAsset,
	mixFingerprint,
	type ProjectDocument,
	ProjectDocumentSchema,
} from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { EngineConnection } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';
import { readToolResponse } from './tool-response.ts';

const SpeechJobsSchema = z.object({
	jobs: z.array(
		z.object({
			jobId: z.string(),
			mediaId: z.string().optional(),
			language: z.string().optional(),
			task: z.enum(['transcribe', 'translate']).optional(),
			media: z.array(z.object({ mediaId: z.string(), words: z.number() })).optional(),
			droppedWords: z.number().optional(),
		}),
	),
});
const TranscriptWordsSchema = z.object({
	words: z.array(
		z.object({
			index: z.number(),
			text: z.string(),
			start: z.number(),
			end: z.number(),
			frame: z.number().optional(),
		}),
	),
});
type EngineCallOptions = NonNullable<Parameters<EngineClient['call']>[1]>;
type EngineRoute = Parameters<EngineClient['call']>[0];

const S = 705_600_000;

function audioAsset(key: string, name: string): Omit<MediaAsset, 'id'> {
	return {
		kind: 'audio',
		fingerprint: `q1:${key.padStart(64, '0')}`,
		originalName: name,
		sizeBytes: 1000,
		container: 'wav',
		probe: {
			durationFlicks: 30 * S,
			startTimecode: null,
			streams: [
				{
					index: 0,
					type: 'audio',
					codec: 'pcm_s16le',
					sampleRate: 48000,
					channels: 1,
					channelLayout: 'mono',
				},
			],
			rotationDegrees: 0,
			hasAlpha: false,
			variableFrameRate: false,
		},
		locators: [{ type: 'engine-store', engineId: 'local', key }],
		derivation: null,
		importedAt: '2026-10-07T10:00:00.000Z',
	} as Omit<MediaAsset, 'id'>;
}

const words = (list: Array<[string, number, number]>) =>
	list.map(([text, a, b]) => ({
		text,
		start: Math.round(a * S),
		end: Math.round(b * S),
		confidence: 0.9,
		speaker: null,
	}));

function fakeEngine() {
	const ids = createCounterIdSource(5);
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'Speech', preset: 'hd-1080p-25' });
	let revision = 0;
	const seqId = Object.keys(doc.sequences)[0]!;
	const apply = (tx: Record<string, unknown>) => {
		const r = applyTransaction(
			doc,
			{ protocol: 'jasper.tx/1', sequenceId: seqId, ...tx, origin: 'user' } as never,
			{ ids, now: () => '2026-10-07T00:00:00.000Z', revision, registries: defaultRegistries() },
		);
		if (r.result.ok && !tx.dryRun) {
			doc = r.document;
			revision++;
		}
		return r.result;
	};
	const r = apply({
		label: 'setup',
		commands: [
			{ type: 'media.register', asset: audioAsset('mk_a', 'a.wav'), ref: '$a' },
			{ type: 'media.register', asset: audioAsset('mk_b', 'b.wav'), ref: '$b' },
		],
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	const a = r.refs.$a!;
	const b = r.refs.$b!;
	// a: media 0–10 s at 0 s; b: media 10–20 s at 10 s (250 frames)
	const placed = apply({
		label: 'setup',
		commands: [
			{
				type: 'clip.place',
				source: { mediaId: a },
				sourceRange: { in: { seconds: 0 }, out: { seconds: 10 } },
				at: 0,
				tracks: { audio: ['A1'] },
			},
			{
				type: 'clip.place',
				source: { mediaId: b },
				sourceRange: { in: { seconds: 10 }, out: { seconds: 20 } },
				at: 250,
				tracks: { audio: ['A1'] },
			},
		],
	});
	if (!placed.ok) throw new Error(JSON.stringify(placed.errors));
	const jobs = new Map<string, Record<string, unknown>>();
	const posts: Array<{ name: EngineRoute; opts: EngineCallOptions }> = [];
	let n = 0;
	const newJob = (result: unknown, state = 'succeeded') => {
		const id = `job_${++n}`;
		jobs.set(id, {
			id,
			kind: 'transcription',
			title: 'Transcribe',
			origin: { type: 'agent', agentRunId: 'x' },
			state,
			progress: 1,
			createdAt: '2026-10-07T10:00:00.000Z',
			priority: 'user',
			cpuSlots: 4,
			result,
		});
		return jobs.get(id);
	};
	const mediaResult = (key: string) => ({
		target: { type: 'media', mediaKey: key, streamIndex: 0 },
		model: 'whisper-base',
		language: 'de',
		languageProbability: 0.97,
		task: 'translate',
		duration: 30 * S,
		words:
			key === 'mk_a'
				? words([
						['Hello', 1, 1.5],
						['world.', 1.6, 2],
					])
				: words([['Second', 12, 12.5]]),
		speakers: {},
		segments: [{ start: 1, end: 2, text: 'Hello world.', avgLogprob: -0.3, noSpeechProb: 0.02, compressionRatio: 1.3 }],
		timings: { decodeMs: 1, loadMs: 1, transcribeMs: 1200 },
		device: {
			encoder: 'cpu',
			decoder: 'cpu',
			label: 'CPU',
			threads: 8,
			fallbacks: [{ stage: 'job', part: 'both', from: 'webgpu', to: 'cpu', reason: 'device lost' }],
		},
		guard: { skippedWindows: 0, droppedWords: 1, removed: [], frames: 'voice-analysis' },
		accuracy: 'best',
		beamSize: 5,
	});
	const client = {
		agentQuery: async () => ({ result: doc, revision, via: 'headless' }),
		agentTx: async (req: { transaction: Record<string, unknown> }) => ({
			result: apply(req.transaction),
			appliedBy: 'headless',
		}),
		getJob: async (id: string) => jobs.get(id),
		call: async (name: EngineRoute, opts: EngineCallOptions = {}) => {
			posts.push({ name, opts });
			if (name === 'speechModels')
				return {
					models: [
						{
							id: 'whisper-base',
							name: 'Whisper base',
							installed: true,
							sizeBytes: 293_625_004,
							license: 'MIT',
							attribution: 'OpenAI',
						},
						{
							id: 'whisper-small',
							name: 'Whisper small',
							installed: false,
							sizeBytes: 970_934_583,
							license: 'MIT',
							attribution: 'OpenAI',
						},
					],
				};
			if (name === 'mediaTranscribe') {
				const body = TranscribeMediaRequestSchema.parse(opts.body);
				const { key } = z.object({ key: z.string() }).parse(opts.params);
				if (body.model === 'whisper-small') {
					throw new EngineError(
						'SPEECH_MODEL_NOT_INSTALLED',
						'The speech model Whisper small is not downloaded',
						{ status: 409 },
					);
				}
				return newJob(mediaResult(key));
			}
			if (name === 'speechTranscribeSequence') {
				const body = TranscribeSequenceRequestSchema.parse(opts.body);
				const sent = ProjectDocumentSchema.parse(body.envelope.document);
				return newJob({
					target: {
						type: 'sequence',
						sequenceId: body.sequenceId,
						range: { startFrame: 0, endFrame: 500 },
						mixHash: mixFingerprint(sent, body.sequenceId),
					},
					model: 'whisper-base',
					language: 'en',
					languageProbability: 0.99,
					task: 'transcribe',
					duration: 20 * S,
					words: words([
						['mixA', 2, 2.5],
						['mixB', 13, 13.5],
						['nowhere', 25, 25.5],
					]),
					speakers: {},
					segments: [],
					timings: { decodeMs: 1, loadMs: 1, transcribeMs: 1 },
				});
			}
			throw new Error(`unexpected call ${name}`);
		},
	};
	const link: EngineConnection = {
		target: { url: 'http://engine.test', token: null, source: 'explicit' },
		client: async () => client as unknown as EngineClient,
		invalidate: () => {},
		close: async () => {},
	};
	return { link, doc: () => doc, seqId, a, b, posts };
}

let open: Client[] = [];
afterEach(async () => {
	for (const c of open) await c.close().catch(() => {});
	open = [];
});

async function connect() {
	const engine = fakeEngine();
	const { server } = createJasperMcpServer({ link: engine.link, agentName: 'speech-test' });
	const [x, y] = InMemoryTransport.createLinkedPair();
	await server.connect(x);
	const client = new Client({ name: 'speech-test', version: '1' });
	await client.connect(y);
	open.push(client);
	const call = async (name: string, args: Record<string, unknown>) => {
		const r = (await client.callTool({
			name,
			arguments:
				name.endsWith('_speech_model') || name === 'list_speech_models'
					? args
					: { projectId: 'prj_test', ...args },
		})) as CallToolResult;
		return readToolResponse(r);
	};
	return { engine, call };
}

describe('speech MCP tools', () => {
	it('transcribes a media, commits one step, and reads it back', async () => {
		const { call, engine } = await connect();
		const r = await call('transcribe', {
			mediaId: engine.a,
			language: 'de',
			translate: true,
			speakerLabels: true,
			speakerCount: 2,
		});
		expect(r.isError, JSON.stringify(r.body)).toBe(false);
		expect(r.read(SpeechJobsSchema).jobs[0]!).toMatchObject({
			language: 'de',
			task: 'translate',
			media: [{ mediaId: engine.a, words: 2 }],
		});
		const post = engine.posts.find((p) => p.name === 'mediaTranscribe')!;
		expect(post.opts.body).toEqual({
			language: 'de',
			task: 'translate',
			speakerLabels: true,
			speakerCount: 2,
			projectId: 'prj_test',
		});
		const t = Object.values(engine.doc().transcripts)[0]!;
		expect(t).toMatchObject({
			mediaId: engine.a,
			language: 'en',
			task: 'translate',
			sourceLanguage: 'de',
			model: 'whisper-base',
		});
		const got = await call('get_transcript', { mediaId: engine.a });
		expect(got.body.text).toBe('Hello world.');
		expect(got.read(TranscriptWordsSchema).words[0]).toMatchObject({
			index: 0,
			text: 'Hello',
			start: 1,
			end: 1.5,
		});
		const seq = await call('get_transcript', { sequenceId: engine.seqId });
		expect(seq.read(TranscriptWordsSchema).words.map((w) => [w.text, w.frame])).toEqual([
			['Hello', 25],
			['world.', 40],
		]);
	});

	it('passes device, accuracy, verbatim and prompt options; reports where it ran and keeps segment scores (spec 16 SG-031)', async () => {
		const { call, engine } = await connect();
		const r = await call('transcribe', {
			mediaId: engine.a,
			device: 'gpu',
			accuracy: 'best',
			verbatim: true,
			initialPrompt: ' JasperEditor ',
			conditionOnPreviousText: false,
		});
		expect(r.isError, JSON.stringify(r.body)).toBe(false);
		const post = engine.posts.find((p) => p.name === 'mediaTranscribe')!;
		expect(post.opts.body).toEqual({
			device: 'gpu',
			accuracy: 'best',
			verbatim: true,
			initialPrompt: 'JasperEditor',
			conditionOnPreviousText: false,
			projectId: 'prj_test',
		});
		const job = (r.body as { jobs: Array<Record<string, unknown>> }).jobs[0]!;
		expect(job.device).toMatchObject({ label: 'CPU', fallbacks: [expect.objectContaining({ from: 'webgpu' })] });
		expect(job.accuracy).toBe('best');
		expect(job.guard).toMatchObject({ droppedWords: 1, frames: 'voice-analysis' });
		const t = Object.values(engine.doc().transcripts)[0]!;
		expect(t.segments).toEqual([{ start: S, end: 2 * S, avgLogprob: -0.3, noSpeechProb: 0.02, compressionRatio: 1.3 }]);
		// device 'auto' is the default: not sent
		await call('transcribe', { mediaId: engine.b, device: 'auto' });
		expect(engine.posts.filter((p) => p.name === 'mediaTranscribe')[1]!.opts.body).toEqual({ projectId: 'prj_test' });
	});

	it('a sequence in media mode transcribes only untranscribed clip media; wait: false then jobIds commits', async () => {
		const { call, engine } = await connect();
		await call('transcribe', { mediaId: engine.a });
		const r = await call('transcribe', { sequenceId: engine.seqId, wait: false });
		expect(r.isError, JSON.stringify(r.body)).toBe(false);
		const { jobs } = r.read(SpeechJobsSchema);
		expect(jobs).toHaveLength(1);
		expect(jobs[0]!.mediaId).toBe(engine.b);
		const c = await call('transcribe', { jobIds: [jobs[0]!.jobId] });
		expect(c.isError, JSON.stringify(c.body)).toBe(false);
		const seq = await call('get_transcript', { sequenceId: engine.seqId });
		expect(seq.body.text).toBe('Hello world. Second');
		const none = await call('transcribe', { sequenceId: engine.seqId });
		expect(none.isError).toBe(true);
		expect(none.body.code ?? JSON.stringify(none.body)).toContain('E_NOTHING_TO_DO');
	});

	it('a sequence mix gives the words to the clip media (media time, coverage) and drops words outside the clips', async () => {
		const { call, engine } = await connect();
		const r = await call('transcribe', { sequenceId: engine.seqId, mode: 'mix' });
		expect(r.isError, JSON.stringify(r.body)).toBe(false);
		expect(r.read(SpeechJobsSchema).jobs[0]!.droppedWords).toBe(1);
		const ta = Object.values(engine.doc().transcripts).find((t) => t.mediaId === engine.a)!;
		const tb = Object.values(engine.doc().transcripts).find((t) => t.mediaId === engine.b)!;
		expect(ta.words.map((w) => [w.text, w.start / S])).toEqual([['mixA', 2]]);
		expect(tb.words.map((w) => [w.text, w.start / S])).toEqual([['mixB', 13]]);
		expect(tb.coverage).toEqual([[10 * S, 20 * S]]);
	});

	it('refuses bad targets and an uninstalled model with a hint', async () => {
		const { call, engine } = await connect();
		expect((await call('transcribe', {})).isError).toBe(true);
		expect((await call('transcribe', { mediaId: engine.a, sequenceId: engine.seqId })).isError).toBe(true);
		const r = await call('transcribe', { mediaId: engine.a, model: 'whisper-small' });
		expect(r.isError).toBe(true);
		expect(JSON.stringify(r.body)).toContain('install_speech_model');
	});
});
