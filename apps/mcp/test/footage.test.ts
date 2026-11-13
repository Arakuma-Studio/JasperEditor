// Spec 18 AF-DIG-002, AF-DIG-003, AF-TAK-002: get_footage_digest, the footage resource, find_takes and import_media's
// `transcribe` option, against an in-memory engine.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscribeMediaRequestSchema } from '@jasper/api';
import { type EngineClient, EngineError } from '@jasper/engine-client';
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type MediaAsset,
	type ProjectDocument,
	type Transcript,
} from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { EngineConnection } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';

const S = 705_600_000;

const probe = (audio: boolean, video: boolean): MediaAsset['probe'] => ({
	durationFlicks: 30 * S,
	startTimecode: null,
	streams: [
		...(video
			? [
					{
						index: 0,
						type: 'video' as const,
						codec: 'h264',
						width: 1920,
						height: 1080,
						pixelAspect: { num: 1, den: 1 },
						frameRate: { num: 25, den: 1 },
						pixelFormat: 'yuv420p',
						bitDepth: 8,
						color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' as const },
						browserDecodable: true,
					},
				]
			: []),
		...(audio
			? [
					{
						index: video ? 1 : 0,
						type: 'audio' as const,
						codec: 'aac',
						sampleRate: 48000,
						channels: 2,
						channelLayout: 'stereo',
					},
				]
			: []),
	],
	rotationDegrees: 0,
	hasAlpha: false,
	variableFrameRate: false,
});

const say = (line: string, at: number) =>
	line.split(' ').map((text, k) => ({
		text,
		start: Math.round((at + k * 0.4) * S),
		end: Math.round((at + k * 0.4 + 0.3) * S),
		confidence: 0.9,
		speaker: null,
		breakBefore: 'none' as const,
	}));

function fakeEngine(opts: { failTx?: boolean } = {}) {
	const ids = createCounterIdSource(9);
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'Footage', preset: 'hd-1080p-25' });
	let revision = 0;
	const seqId = Object.keys(doc.sequences)[0]!;
	let failing = false;
	const apply = (tx: Record<string, unknown>) => {
		if (failing) return { ok: false, errors: [{ code: 'E_INVALID_PARAM', message: 'refused' }] } as never;
		const r = applyTransaction(
			doc,
			{ protocol: 'jasper.tx/1', sequenceId: seqId, ...tx, origin: { agent: 'test' } } as never,
			{ ids, now: () => '2026-10-31T00:00:00.000Z', revision, registries: defaultRegistries() },
		);
		if (r.result.ok) {
			doc = r.document;
			revision++;
		}
		return r.result;
	};
	const asset = (key: string, name: string, audio = true, video = true) => ({
		type: 'media.register',
		asset: {
			kind: video ? 'video' : 'audio',
			fingerprint: `q1:${key.padStart(64, '0')}`,
			originalName: name,
			sizeBytes: 1,
			container: 'mov,mp4',
			probe: probe(audio, video),
			locators: [{ type: 'engine-store', engineId: 'local', key }],
		},
	});
	const setup = apply({
		label: 'setup',
		commands: [
			{ ...asset('mk_a', 'a-take1.mp4'), ref: '$a' },
			{ ...asset('mk_b', 'b-take2.mp4'), ref: '$b' },
		],
	});
	if (!setup.ok) throw new Error(JSON.stringify(setup));
	failing = !!opts.failTx;
	const a = setup.refs.$a!;
	const b = setup.refs.$b!;
	const transcripts: Record<string, Transcript> = {
		trs_00000000000000A1: {
			id: 'trs_00000000000000A1',
			mediaId: a,
			language: 'en',
			origin: 'whisper-local',
			words: [...say('Welcome to the show everybody.', 1), ...say('Unrelated words about pasta.', 10)],
			speakers: {},
		},
		trs_00000000000000B1: {
			id: 'trs_00000000000000B1',
			mediaId: b,
			language: 'en',
			origin: 'whisper-local',
			words: say('Um welcome to the show everybody.', 2),
			speakers: {},
		},
	};
	doc = { ...doc, transcripts };
	const calls: Array<{ name: string; opts?: unknown }> = [];
	const cancelled: string[] = [];
	let jobN = 0;
	/** Files the fake registers: path → [key, name, hasAudio, hasVideo]. */
	const files = new Map<string, [string, string, boolean, boolean]>();
	const client = {
		listProjects: async () => ({ projects: [{ projectId: 'prj_test', name: 'Footage' }] }),
		agentQuery: async () => ({ result: doc, revision, via: 'headless' }),
		agentTx: async (req: { transaction: Record<string, unknown> }) => {
			calls.push({ name: 'agentTx' });
			return { result: apply(req.transaction), appliedBy: 'headless' };
		},
		cancelJob: async (id: string) => {
			cancelled.push(id);
			return { id, state: 'cancelled' };
		},
		registerMedia: async (req: { paths: string[] }) => ({
			items: req.paths.map((p) => {
				const [key, name, audio, video] = files.get(p)!;
				return {
					mediaKey: key,
					kind: video ? 'video' : 'audio',
					fingerprint: `q1:${key.padStart(64, '0')}`,
					originalName: name,
					sizeBytes: 1,
					container: 'mov,mp4',
					probe: probe(audio, video),
					locators: [{ type: 'path', path: p, relativeToProject: null }],
					browserPlayable: 'yes',
				};
			}),
			errors: [],
		}),
		call: async (name: string, o: { params?: unknown; body?: unknown } = {}) => {
			calls.push({ name, opts: o });
			if (name === 'mediaTranscribe') {
				const body = TranscribeMediaRequestSchema.parse(o.body);
				const { key } = z.object({ key: z.string() }).parse(o.params);
				if (body.model === 'whisper-small')
					throw new EngineError('SPEECH_MODEL_NOT_INSTALLED', 'Whisper small is not downloaded', {
						status: 409,
					});
				return {
					id: `job_${++jobN}`,
					kind: 'transcription',
					title: `Transcribe ${key}`,
					origin: { type: 'user' },
					state: 'queued',
					progress: 0,
					createdAt: '2026-10-31T00:00:00.000Z',
					priority: 'user',
					cpuSlots: 1,
					assetId: key,
				};
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
	return { link, a, b, seqId, calls, cancelled, files, doc: () => doc };
}

let open: Client[] = [];
afterEach(async () => {
	for (const c of open) await c.close().catch(() => {});
	open = [];
});

async function connect(opts: { failTx?: boolean } = {}) {
	const engine = fakeEngine(opts);
	const { server } = createJasperMcpServer({ link: engine.link, agentName: 'footage-test' });
	const [x, y] = InMemoryTransport.createLinkedPair();
	await server.connect(x);
	const client = new Client({ name: 'footage-test', version: '1' });
	await client.connect(y);
	open.push(client);
	const call = async (name: string, args: Record<string, unknown>) =>
		(await client.callTool({ name, arguments: { projectId: 'prj_test', ...args } })) as CallToolResult;
	return { engine, client, call };
}

const textOf = (r: CallToolResult, i = 0) => (r.content[i] as { text: string }).text;
const json = (r: CallToolResult) => JSON.parse(textOf(r)) as Record<string, unknown>;

describe('get_footage_digest', () => {
	it('returns the digest text; mediaIds and sequenceId narrow it; errors are coded', async () => {
		const { engine, call, client } = await connect();
		const r = await call('get_footage_digest', {});
		expect(r.isError).toBeFalsy();
		const text = textOf(r);
		expect(text.split('\n')[0]).toBe('# Footage digest: Footage');
		expect(text).toContain(`## ${engine.a} "a-take1.mp4" (30.0 s, 1920×1080 25 fps, 2 phrases)`);
		expect(text).toContain('  [001.00-002.90] Welcome to the show everybody.');
		const only = textOf(await call('get_footage_digest', { mediaIds: [engine.b] }));
		expect(only).not.toContain(engine.a);
		const seq = await call('get_footage_digest', { sequenceId: engine.seqId });
		expect(textOf(seq)).toContain('(sequence, ');
		const missing = await call('get_footage_digest', { mediaIds: ['med_nope'] });
		expect(missing.isError).toBe(true);
		expect(json(missing)).toMatchObject({ error: { code: 'E_NOT_FOUND' } });
		const range = await call('get_footage_digest', { maxChars: 10 });
		expect(range.isError).toBe(true);
		// the resource returns the same text
		const res = await client.readResource({ uri: 'jasper://projects/prj_test/footage' });
		expect((res.contents[0] as { text: string }).text).toBe(text);
		const listed = await client.listResources();
		expect(listed.resources.map((x) => x.uri)).toContain('jasper://projects/prj_test/footage');
		const tools = (await client.listTools()).tools;
		for (const name of ['get_footage_digest', 'find_takes'])
			expect(tools.find((t) => t.name === name)?.annotations).toMatchObject({
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			});
	});
});

describe('find_takes', () => {
	it('groups the takes across files with seconds, names and the suggestion', async () => {
		const { engine, call } = await connect();
		const r = json(await call('find_takes', {}));
		expect(r).toMatchObject({
			minSimilarity: 0.6,
			phrasesCompared: 3,
			groups: [
				{
					id: 't1',
					suggested: 1,
					members: [
						{
							mediaId: engine.a,
							name: 'a-take1.mp4',
							start: 1,
							text: 'Welcome to the show everybody.',
							complete: true,
						},
						{ mediaId: engine.b, name: 'b-take2.mp4', start: 2, complete: true, meanConfidence: 0.9 },
					],
				},
			],
		});
		const strict = json(await call('find_takes', { minSimilarity: 1, mediaIds: [engine.a] }));
		expect(strict.groups).toEqual([]);
		const bad = await call('find_takes', { minSimilarity: 0.1 });
		expect(bad.isError).toBe(true);
	});
});

describe('import_media transcribe (AF-DIG-003)', () => {
	function file(
		engine: ReturnType<typeof fakeEngine>,
		name: string,
		key: string,
		audio: boolean,
		video = true,
	) {
		const dir = mkdtempSync(join(tmpdir(), 'af-footage-'));
		const p = join(dir, name);
		writeFileSync(p, 'x');
		engine.files.set(p, [key, name, audio, video]);
		return p;
	}

	it('queues one transcription job per imported media with sound, before the import transaction', async () => {
		const { engine, call } = await connect();
		const withSound = file(engine, 'talk.mp4', 'mk_talk', true);
		const silent = file(engine, 'broll.mp4', 'mk_broll', false);
		const voice = file(engine, 'vo.wav', 'mk_vo', true, false);
		const r = await call('import_media', {
			paths: [withSound, silent, voice],
			transcribe: { model: 'whisper-base', language: 'es' },
		});
		expect(r.isError, textOf(r)).toBeFalsy();
		const body = json(r) as {
			imported: Array<{ mediaId: string; path: string; transcription?: Record<string, unknown> }>;
			transcriptionJobs: Array<{ jobId: string; mediaId: string }>;
			next: string;
		};
		const posts = engine.calls.filter((c) => c.name === 'mediaTranscribe');
		expect(posts.map((c) => (c.opts as { params: { key: string } }).params.key)).toEqual([
			'mk_talk',
			'mk_vo',
		]);
		expect((posts[0]!.opts as { body: unknown }).body).toEqual({
			model: 'whisper-base',
			language: 'es',
			projectId: 'prj_test',
		});
		// queued before the import transaction, so an open editor's "Transcribe on import" sees the job
		const order = engine.calls.map((c) => c.name);
		expect(order.indexOf('mediaTranscribe')).toBeLessThan(order.indexOf('agentTx'));
		const byPath = new Map(body.imported.map((i) => [i.path, i]));
		expect(byPath.get(withSound)!.transcription).toEqual({ jobId: 'job_1' });
		expect(byPath.get(silent)!.transcription).toEqual({ skipped: 'no audio stream' });
		expect(byPath.get(voice)!.transcription).toEqual({ jobId: 'job_2' });
		expect(body.transcriptionJobs).toEqual([
			{ jobId: 'job_1', mediaId: byPath.get(withSound)!.mediaId },
			{ jobId: 'job_2', mediaId: byPath.get(voice)!.mediaId },
		]);
		expect(body.next).toContain('transcribe {projectId, jobIds: ["job_1", "job_2"]}');
	});

	it('true uses the defaults; media that already have a transcript are skipped; refusals are reported per file', async () => {
		const { engine, call } = await connect();
		const again = file(engine, 'a-take1.mp4', 'mk_a', true);
		const fresh = file(engine, 'new.mp4', 'mk_new', true);
		const r = json(await call('import_media', { paths: [again, fresh], transcribe: true })) as {
			imported: Array<{ path: string; transcription?: Record<string, unknown> }>;
		};
		const posts = engine.calls.filter((c) => c.name === 'mediaTranscribe');
		expect(posts).toHaveLength(1);
		expect((posts[0]!.opts as { body: unknown }).body).toEqual({ projectId: 'prj_test' });
		const byPath = new Map(r.imported.map((i) => [i.path, i]));
		expect(byPath.get(again)!.transcription).toEqual({ skipped: 'already has a transcript' });
		const missingModel = file(engine, 'other.mp4', 'mk_other', true);
		const m = json(
			await call('import_media', { paths: [missingModel], transcribe: { model: 'whisper-small' } }),
		) as {
			imported: Array<{ transcription?: { error?: { code: string } } }>;
			transcriptionJobs?: unknown;
		};
		expect(m.imported[0]!.transcription!.error!.code).toBe('E_NO_SPEECH_MODEL');
		expect(m.transcriptionJobs).toBeUndefined();
	});

	it('without transcribe nothing is queued; a refused import cancels the queued jobs', async () => {
		const { engine, call } = await connect();
		const p = file(engine, 'talk.mp4', 'mk_talk', true);
		await call('import_media', { paths: [p] });
		expect(engine.calls.some((c) => c.name === 'mediaTranscribe')).toBe(false);

		const refused = await connect({ failTx: true });
		const q = file(refused.engine, 'talk.mp4', 'mk_talk', true);
		const r = await refused.call('import_media', { paths: [q], transcribe: true });
		expect(r.isError).toBe(true);
		expect(refused.engine.cancelled).toEqual(['job_1']);
	});
});
