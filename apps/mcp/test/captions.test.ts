import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineClient } from '@jasper/engine-client';
import {
	applyTransaction,
	CaptionStyleSchema,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type MediaAsset,
	type ProjectDocument,
} from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { EngineConnection } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';
import { readToolResponse } from './tool-response.ts';

const CaptionListSchema = z.object({
	tracks: z.array(
		z.object({
			label: z.string(),
			name: z.string(),
			language: z.string().nullable(),
			active: z.boolean(),
			visible: z.boolean(),
			style: CaptionStyleSchema,
			captions: z.array(
				z.object({
					clipId: z.string(),
					text: z.string(),
					in: z.object({ timecode: z.string() }),
					speaker: z.string().nullable(),
					styleOverrides: CaptionStyleSchema.partial().optional(),
				}),
			),
		}),
	),
});
const TranscriptInspectSchema = z.object({
	wordCount: z.number(),
	words: z.array(z.object({ text: z.string() })),
	paragraphs: z.array(z.object({ fromWord: z.number() })),
});
const FillerHitsSchema = z.object({ hits: z.array(z.object({ text: z.string() })) });

const S = 705_600_000;
const WORDS: Array<[string, number, number, string]> = [
	['Welcome', 0.5, 0.9, 's1'],
	['to', 0.9, 1.05, 's1'],
	['the', 1.05, 1.2, 's1'],
	['show.', 1.2, 1.7, 's1'],
	['Um,', 3.7, 4.0, 's1'],
	['today', 4.1, 4.5, 's1'],
	['we', 4.5, 4.65, 's1'],
	['talk', 4.65, 4.95, 's1'],
	['about', 4.95, 5.3, 's1'],
	['rivers.', 5.3, 5.9, 's1'],
	['Thanks', 6.4, 6.8, 's2'],
	['for', 6.8, 6.95, 's2'],
	['having', 6.95, 7.3, 's2'],
	['me.', 7.3, 7.6, 's2'],
	['I', 8.0, 8.1, 's2'],
	['uh', 8.2, 8.5, 's2'],
	['love', 8.6, 8.9, 's2'],
	['rivers,', 8.9, 9.4, 's2'],
	['you', 9.5, 9.65, 's2'],
	['know.', 9.65, 10.0, 's2'],
];

function videoAsset(): Omit<MediaAsset, 'id'> {
	return {
		kind: 'video',
		fingerprint: `q1:${'b'.padStart(64, '0')}`,
		originalName: 'interview.mp4',
		sizeBytes: 1000,
		container: 'mov,mp4',
		probe: {
			durationFlicks: 10 * S,
			startTimecode: null,
			streams: [
				{
					index: 0,
					type: 'video',
					codec: 'h264',
					width: 1920,
					height: 1080,
					pixelAspect: { num: 1, den: 1 },
					frameRate: { num: 25, den: 1 },
					pixelFormat: 'yuv420p',
					bitDepth: 8,
					color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' },
					browserDecodable: true,
				},
				{ index: 1, type: 'audio', codec: 'aac', sampleRate: 48000, channels: 2, channelLayout: 'stereo' },
			],
			rotationDegrees: 0,
			hasAlpha: false,
			variableFrameRate: false,
		},
		locators: [{ type: 'engine-store', engineId: 'local', key: 'mk_1' }],
		derivation: null,
		importedAt: '2026-09-30T10:00:00.000Z',
	} as Omit<MediaAsset, 'id'>;
}

function fakeEngine() {
	const ids = createCounterIdSource(7);
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'Captions', preset: 'hd-1080p-25' });
	let revision = 0;
	const seqId = Object.keys(doc.sequences)[0]!;
	const apply = (tx: Record<string, unknown>) => {
		const r = applyTransaction(
			doc,
			{ protocol: 'jasper.tx/1', sequenceId: seqId, ...tx, origin: 'user' } as never,
			{ ids, now: () => '2026-09-30T00:00:00.000Z', revision, registries: defaultRegistries() },
		);
		if (r.result.ok && !tx.dryRun) {
			doc = r.document;
			revision++;
		}
		return r.result;
	};
	const r = apply({ label: 'setup', commands: [{ type: 'media.register', asset: videoAsset(), ref: '$m' }] });
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	const mediaId = r.refs.$m!;
	const placed = apply({
		label: 'setup',
		commands: [{ type: 'clip.place', source: { mediaId }, at: 0, tracks: { video: 'V1', audio: ['A1'] } }],
	});
	if (!placed.ok) throw new Error(JSON.stringify(placed.errors));
	const client = {
		agentQuery: async () => ({ result: doc, revision, via: 'headless' }),
		agentTx: async (req: { transaction: Record<string, unknown> }) => ({
			result: apply(req.transaction),
			appliedBy: 'headless',
		}),
	};
	const link: EngineConnection = {
		target: { url: 'http://engine.test', token: null, source: 'explicit' },
		client: async () => client as unknown as EngineClient,
		invalidate: () => {},
		close: async () => {},
	};
	return { link, doc: () => doc, seqId, mediaId };
}

let open: Client[] = [];
afterEach(async () => {
	for (const c of open) await c.close().catch(() => {});
	open = [];
});

async function connect() {
	const engine = fakeEngine();
	const { server } = createJasperMcpServer({ link: engine.link, agentName: 'captions-test' });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await server.connect(a);
	const client = new Client({ name: 'captions-test', version: '1' });
	await client.connect(b);
	open.push(client);
	const call = async (name: string, args: Record<string, unknown>) => {
		const r = (await client.callTool({
			name,
			arguments: { projectId: 'prj_test', ...args },
		})) as CallToolResult;
		return readToolResponse(r);
	};
	return { engine, call, client };
}

async function withTranscript() {
	const c = await connect();
	const json = JSON.stringify({
		speakers: { s1: { name: 'Host' }, s2: { name: 'Guest' } },
		words: WORDS.map(([text, a, b, speaker]) => ({
			text,
			start: Math.round(a * S),
			end: Math.round(b * S),
			speaker,
		})),
	});
	const r = await c.call('import_transcript', { mediaId: c.engine.mediaId, content: json });
	expect(r.isError, JSON.stringify(r.body)).toBe(false);
	return c;
}

describe('caption MCP tools', () => {
	it('imports, lists, edits and exports captions (files on disk)', async () => {
		const { call } = await connect();
		const dir = mkdtempSync(join(tmpdir(), 'jasper-captions-'));
		const srt = join(dir, 'english.srt');
		writeFileSync(
			srt,
			'1\r\n00:00:01,000 --> 00:00:02,000\r\nHello\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nWorld\r\n',
		);
		const imp = await call('import_captions', { path: srt, language: 'en' });
		expect(imp.isError, JSON.stringify(imp.body)).toBe(false);
		let list = (await call('list_captions', {})).read(CaptionListSchema);
		expect(list.tracks).toHaveLength(1);
		const t = list.tracks[0]!;
		expect([t.label, t.name, t.language, t.active, t.visible]).toEqual(['C1', 'english', 'en', true, true]);
		expect(
			t.captions.map((c: { text: string; in: { timecode: string } }) => [c.in.timecode, c.text]),
		).toEqual([
			['00:00:01:00', 'Hello'],
			['00:00:03:00', 'World'],
		]);
		const [first, second] = t.captions.map((c: { clipId: string }) => c.clipId);
		expect(
			(
				await call('edit_caption', {
					clipId: first,
					text: 'Hello there',
					end: { seconds: 2.5 },
					style: { fill: [1, 1, 0, 1] },
				})
			).isError,
		).toBe(false);
		expect((await call('add_caption', { text: 'Third', at: { seconds: 5 } })).isError).toBe(false);
		expect((await call('split_captions', { at: { seconds: 6 } })).isError).toBe(false);
		list = (await call('list_captions', {})).read(CaptionListSchema);
		expect(list.tracks[0]!.captions).toHaveLength(4);
		const ids = list.tracks[0]!.captions.map((c: { clipId: string }) => c.clipId);
		expect((await call('merge_captions', { clipIds: [ids[2], ids[3]] })).isError).toBe(false);
		expect((await call('delete_captions', { clipIds: [second], ripple: true })).isError).toBe(false);
		expect(
			(await call('style_captions', { track: 'C1', preset: 'builtin:outline', style: { placement: 'top' } }))
				.isError,
		).toBe(false);
		expect(
			(await call('caption_track', { action: 'add', name: 'Français', language: 'fr', active: false }))
				.isError,
		).toBe(false);
		expect(
			(await call('caption_track', { action: 'update', track: 'C2', visible: false, active: true })).isError,
		).toBe(false);
		list = (await call('list_captions', {})).read(CaptionListSchema);
		expect(
			list
				.read(CaptionListSchema)
				.tracks.map((x: { active: boolean; visible: boolean }) => [x.active, x.visible]),
		).toEqual([
			[false, true],
			[true, false],
		]);
		expect(list.tracks[0]!.style.placement).toBe('top');
		expect(list.tracks[0]!.captions[0]!.styleOverrides?.fill).toEqual([1, 1, 0, 1]);
		const vtt = await call('export_captions', { track: 'C1', format: 'vtt' });
		expect(vtt.body.content).toContain('00:00:01.000 --> 00:00:02.520\nHello there');
		const out = join(dir, 'out.scc');
		const f1 = await call('export_captions', { track: 'C1', path: out });
		const f2 = await call('export_captions', { track: 'C1', path: out });
		expect(f1.body.path).toBe(out);
		expect(f2.body.path).toBe(join(dir, 'out (2).scc'));
		expect(readFileSync(out, 'utf8').startsWith('Scenarist_SCC V1.0')).toBe(true);
		const stl = await call('export_captions', { track: 'C1', format: 'stl' });
		expect(typeof stl.body.contentBase64).toBe('string');
		expect((await call('import_captions', { content: 'not captions at all' })).isError).toBe(true);
		expect((await call('import_captions', { path: 'relative.srt' })).isError).toBe(true);
		expect((await call('export_captions', { track: 'C9' })).isError).toBe(true);
	});

	it('transcript tools: inspect, search, select, fillers, pauses, captions', async () => {
		const { call, engine } = await withTranscript();
		const ins = await call('transcript_inspect', {});
		expect(ins.body.wordCount).toBe(20);
		expect(ins.body.speakers).toEqual(['Host', 'Guest']);
		expect(ins.read(TranscriptInspectSchema).paragraphs.map((p: { fromWord: number }) => p.fromWord)).toEqual(
			[0, 4, 10],
		);
		const found = await call('transcript_search', { query: 'you kn' });
		expect(found.body.matches).toEqual([
			expect.objectContaining({ fromWord: 18, toWord: 19, text: 'you know.' }),
		]);
		expect((await call('transcript_select', { query: 'welcome to the show' })).isError).toBe(false);
		const seq = engine.doc().sequences[engine.seqId]!;
		expect([seq.inPoint, seq.outPoint]).toEqual([12, 43]);
		const dry = await call('remove_fillers', { dryRun: true, fillers: ['um', 'uh', 'you know', 'you'] });
		expect(dry.read(FillerHitsSchema).hits.map((h: { text: string }) => h.text)).toEqual([
			'Um,',
			'uh',
			'you know.',
		]);
		expect((await call('remove_fillers', {})).isError).toBe(false);
		expect((await call('transcript_inspect', {})).body.wordCount).toBe(18);
		const pauses = await call('remove_pauses', { dryRun: true, minSeconds: 1 });
		expect(pauses.body.pauses).toHaveLength(1);
		expect((await call('remove_pauses', { minSeconds: 1 })).isError).toBe(false);
		expect((await call('rename_speaker', { speaker: 'Guest', name: 'Ann' })).isError).toBe(false);
		const cap = await call('captions_from_transcript', { preset: 'builtin:broadcast' });
		expect(cap.isError, JSON.stringify(cap.body)).toBe(false);
		const list = (await call('list_captions', {})).read(CaptionListSchema);
		// the 2 s pause is now 0.2 s, so the host's words share a caption; the guest starts a new one
		expect(list.tracks[0]!.captions.map((c: { text: string }) => c.text)).toEqual([
			'Welcome to the show. today we talk about\nrivers.',
			'Thanks for having me. I love rivers, you\nknow.',
		]);
		expect(list.tracks[0]!.captions[1]!.speaker).toBe('Ann');
		expect(list.tracks[0]!.style.background?.color).toEqual([0, 0, 0, 1]);
	});

	it('extract, lift and insert a text selection', async () => {
		const { call, engine } = await withTranscript();
		expect((await call('transcript_lift', { fromWord: 0, toWord: 3 })).isError).toBe(false);
		let w = (await call('transcript_inspect', {})).read(TranscriptInspectSchema);
		expect(w.wordCount).toBe(16);
		expect((await call('transcript_extract', { query: 'Um' })).isError).toBe(false);
		w = (await call('transcript_inspect', {})).read(TranscriptInspectSchema);
		expect(w.words[0]!.text).toBe('today');
		const created = await call('apply_commands', {
			label: 'New sequence',
			commands: [{ type: 'sequence.create', name: 'Selects', preset: 'hd-1080p-25' }],
		});
		expect(created.isError, JSON.stringify(created.body)).toBe(false);
		const target = Object.keys(engine.doc().sequences).find((id) => id !== engine.seqId)!;
		const r = await call('insert_transcript_selection', {
			query: 'thanks for having me',
			targetSequenceId: target,
			at: 0,
		});
		expect(r.isError, JSON.stringify(r.body)).toBe(false);
		const inTarget = await call('transcript_inspect', { sequenceId: target });
		expect(inTarget.read(TranscriptInspectSchema).words.map((x: { text: string }) => x.text)).toEqual([
			'Thanks',
			'for',
			'having',
			'me.',
		]);
	});
});
