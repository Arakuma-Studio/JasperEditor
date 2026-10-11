// Engine import calls are stubbed; document edits use the real command system.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LayeredLayer, RegisteredMedia } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type MediaAsset,
	MediaInterpretationSchema,
	type ProjectDocument,
	type Sequence,
} from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { EngineConnection } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';
import type { describeInterpretation } from '../src/tools/imports.ts';

const InterpretationSchema = z.object({
	file: z.object({ fieldOrder: MediaInterpretationSchema.shape.fieldOrder.unwrap(), fps: z.number() }),
	effective: z.object({
		pixelAspect: z.number(),
		fps: z.number(),
		loop: z.number(),
		durationSeconds: z.number(),
	}),
}) satisfies z.ZodType<Pick<ReturnType<typeof describeInterpretation>, 'file' | 'effective'>>;

const dir = mkdtempSync(join(tmpdir(), 'jasper-mcp-imports-'));
const file = (name: string) => {
	const p = join(dir, name);
	writeFileSync(p, 'x');
	return p;
};

function picture(
	name: string,
	key: string,
	w: number,
	h: number,
	extra: Partial<RegisteredMedia> = {},
): RegisteredMedia {
	return {
		mediaKey: key,
		fingerprint: `q1:${key.padStart(64, '0')}`,
		originalName: name,
		sizeBytes: 100,
		container: 'png_pipe',
		kind: 'image',
		probe: {
			durationFlicks: null,
			startTimecode: null,
			streams: [
				{
					index: 0,
					type: 'video',
					codec: 'png',
					width: w,
					height: h,
					pixelAspect: { num: 1, den: 1 },
					frameRate: { num: 25, den: 1 },
					pixelFormat: 'rgba',
					bitDepth: 8,
					color: { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'bt709', range: 'pc' },
					browserDecodable: true,
				},
			],
			rotationDegrees: 0,
			hasAlpha: true,
			variableFrameRate: false,
		},
		locators: [],
		browserPlayable: 'yes',
		...extra,
	} as RegisteredMedia;
}

function videoAsset(): Omit<MediaAsset, 'id'> {
	return {
		kind: 'video',
		fingerprint: `q1:${'a'.padStart(64, '0')}`,
		originalName: 'interlaced.mov',
		sizeBytes: 1000,
		container: 'mov,mp4',
		probe: {
			durationFlicks: 10 * 705_600_000,
			startTimecode: null,
			streams: [
				{
					index: 0,
					type: 'video',
					codec: 'prores',
					width: 720,
					height: 480,
					pixelAspect: { num: 10, den: 11 },
					frameRate: { num: 30000, den: 1001 },
					pixelFormat: 'yuv422p10le',
					bitDepth: 10,
					fieldOrder: 'tt',
					color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' },
					browserDecodable: false,
				},
			],
			rotationDegrees: 0,
			hasAlpha: false,
			variableFrameRate: false,
		},
		locators: [{ type: 'engine-store', engineId: 'local', key: 'mk_video0001' }],
		derivation: null,
		importedAt: '2026-09-30T10:00:00.000Z',
	} as Omit<MediaAsset, 'id'>;
}

const layer = (index: number, name: string, over: Partial<LayeredLayer> = {}): LayeredLayer => ({
	index,
	name,
	kind: 'pixel',
	visible: true,
	opacity: 1,
	blendMode: 'normal',
	clipping: false,
	left: 10 * index,
	top: 20,
	width: 100,
	height: 50,
	media: picture(`${name}.png`, `mk_layer000${index}`, 100, 50, {
		container: 'png_pipe',
		originalName: `doc.psd ▸ ${name}`,
	}),
	...over,
});

function fakeEngine() {
	const ids = createCounterIdSource(7);
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'Imports', preset: 'hd-1080p-30' });
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
	const videoId = r.refs.$m!;
	const placed = apply({
		label: 'setup',
		commands: [{ type: 'clip.place', source: { mediaId: videoId }, at: 0 }],
	});
	if (!placed.ok) throw new Error(JSON.stringify(placed.errors));
	const calls: Record<string, unknown[]> = {};
	const log = (k: string, v: unknown) => {
		calls[k] ??= [];
		calls[k]!.push(v);
	};
	const jobs = new Map<string, unknown>();
	const job = (id: string, result: unknown) => {
		jobs.set(id, result);
		return { id, state: 'succeeded', title: id, result, progress: 1 };
	};
	const psd = picture('doc.psd', 'mk_psd000001', 400, 300, {
		container: 'psd_pipe',
		layered: { format: 'psd', width: 400, height: 300, layerCount: 3 },
	});
	const pdf = picture('doc.pdf', 'mk_pdf000001', 612, 792, {
		container: 'pdf',
		vector: { format: 'pdf', width: 612, height: 792, page: 1, pageCount: 3, source: 'pdf' },
	});
	const client = {
		registerMedia: async (req: { paths: string[] }) => {
			log('registerMedia', req);
			const p = req.paths[0]!;
			return {
				items: [
					p.endsWith('.psd') ? psd : p.endsWith('.pdf') ? pdf : picture('x.png', 'mk_x0000001', 10, 10),
				],
				errors: [],
			};
		},
		importImageSequence: async (req: unknown) => {
			log('importImageSequence', req);
			return job(
				'job_seq',
				picture('shot_[0001-0012].png', 'mk_seq000001', 64, 48, {
					kind: 'video',
					container: 'matroska,webm',
					imageSequence: {
						pattern: 'shot_[0001-0012].png',
						directory: dir,
						first: 1,
						last: 12,
						frames: 12,
						missing: [7],
						format: 'png',
						frameRate: { num: 24, den: 1 },
					},
				}),
			);
		},
		detectImageSequence: async (path: string) => {
			log('detectImageSequence', path);
			return { pattern: 'shot_[0001-0012].png', directory: dir, first: 1, last: 12, count: 11, missing: [7] };
		},
		extractLayers: async (mediaKey: string, projectId: string, _wait: boolean, merge?: number[]) => {
			log('extractLayers', { mediaKey, projectId, merge });
			return job('job_layers', {
				mediaKey,
				info: { format: 'psd', width: 400, height: 300, layerCount: 4 },
				layers: [
					layer(0, 'Background'),
					layer(1, 'Glow', { blendMode: 'linear-dodge', opacity: 0.5 }),
					layer(2, 'Clipped', { clipping: true }),
					layer(3, 'Hidden', { visible: false }),
				],
				warnings: ['Layer effects (Drop Shadow) on "Glow" are not carried'],
				...(merge ? { merged: picture('doc.psd (merged)', 'mk_merged0001', 400, 300) } : {}),
			});
		},
		vectorPages: async (mediaKey: string) => ({
			mediaKey,
			vector: pdf.vector,
			pages: [
				{ page: 1, width: 612, height: 792 },
				{ page: 2, width: 792, height: 612 },
				{ page: 3, width: 612, height: 792 },
			],
		}),
		exportLottie: async (req: Record<string, unknown>) => {
			log('exportLottie', req);
			return {
				warnings: ['Clip "interlaced.mov": video is not exported'],
				layers: 0,
				bytes: 512,
				outputPath: req.outputPath,
				fileName: 'x.json',
			};
		},
		getJob: async (id: string) => ({ id, state: 'succeeded', title: id, result: jobs.get(id), progress: 1 }),
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
	return { link, doc: () => doc, seqId, videoId, calls };
}

let open: Client[] = [];
afterEach(async () => {
	for (const c of open) await c.close().catch(() => {});
	open = [];
});

async function connect() {
	const engine = fakeEngine();
	const { server } = createJasperMcpServer({ link: engine.link, agentName: 'imports-test' });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await server.connect(a);
	const client = new Client({ name: 'imports-test', version: '1' });
	await client.connect(b);
	open.push(client);
	const call = async (name: string, args: Record<string, unknown>, withProject = true) => {
		const r = (await client.callTool({
			name,
			arguments: withProject ? { projectId: 'prj_test', ...args } : args,
		})) as CallToolResult;
		const text = (r.content.find((c) => c.type === 'text') as { text: string } | undefined)?.text ?? '';
		let body: unknown = text;
		try {
			body = JSON.parse(text);
		} catch {}
		const err = (body as { error?: { code?: string } }).error;
		return {
			isError: !!r.isError,
			body: (err ? { ...(body as object), code: err.code } : body) as Record<string, unknown> & {
				code?: string;
			},
		};
	};
	return { engine, call };
}

describe('imports MCP tools', () => {
	it('interprets footage and reports file vs effective values', async () => {
		const { engine, call } = await connect();
		const before = await call('get_media_interpretation', { mediaIds: [engine.videoId] });
		const m0 = z.array(InterpretationSchema).parse(before.body.media)[0]!;
		expect(m0.file.fieldOrder).toBe('upper');
		expect(m0.file.fps).toBe(29.97);
		expect(m0.effective.pixelAspect).toBeCloseTo(0.9091, 4);
		const r = await call('interpret_footage', {
			mediaIds: [engine.videoId],
			frameRate: 23.976,
			pixelAspect: 1,
			fieldOrder: 'progressive',
			loop: 2,
		});
		expect(r.isError).toBe(false);
		expect(engine.doc().media[engine.videoId]!.interpretation).toEqual({
			frameRate: { num: 24000, den: 1001 },
			pixelAspect: { num: 10000, den: 10000 },
			fieldOrder: 'progressive',
			loop: 2,
		});
		const eff = z.array(InterpretationSchema).parse(r.body.media)[0]!.effective;
		expect(eff.fps).toBe(23.976);
		expect(eff.loop).toBe(2);
		// 10 s at 29.97 assumed 23.976 → 12.5 s, twice.
		expect(eff.durationSeconds).toBeCloseTo(25, 2);
		await call('interpret_footage', { mediaIds: [engine.videoId], frameRate: null });
		expect(engine.doc().media[engine.videoId]!.interpretation?.frameRate).toBeUndefined();
		expect(engine.doc().media[engine.videoId]!.interpretation?.loop).toBe(2);
	});

	it('refuses empty, unknown and strictly-invalid interpretations', async () => {
		const { engine, call } = await connect();
		expect((await call('interpret_footage', { mediaIds: [engine.videoId] })).body.code).toBe(
			'E_INVALID_PARAM',
		);
		expect((await call('interpret_footage', { mediaIds: ['med_nope'], loop: 2 })).isError).toBe(true);
		const typo = await call('interpret_footage', {
			mediaIds: [engine.videoId],
			alpha: { mode: 'ignore', invrt: true },
		});
		expect(typo.isError).toBe(true);
		expect((await call('get_media_interpretation', { mediaIds: ['med_nope'] })).body.code).toBe(
			'E_NOT_FOUND',
		);
	});

	it('imports an image sequence from one frame', async () => {
		const { engine, call } = await connect();
		const frame = file('shot_0001.png');
		const d = await call('detect_image_sequence', { path: frame }, false);
		expect(d.body.missing).toEqual([7]);
		const r = await call('import_image_sequence', { path: frame, frameRate: 24 });
		expect(r.isError).toBe(false);
		expect(engine.calls.importImageSequence![0]).toMatchObject({
			path: frame,
			frameRate: { num: 24, den: 1 },
		});
		const asset = engine.doc().media[r.body.mediaId as string]!;
		expect(asset.imageSequence?.missing).toEqual([7]);
		expect(
			Object.values(engine.doc().items).some((i) => i.kind === 'media' && i.name === 'shot_[0001-0012].png'),
		).toBe(true);
		expect((await call('import_image_sequence', { frameRate: 24 })).body.code).toBe('E_INVALID_PARAM');
		expect(
			(await call('import_image_sequence', { path: '/no/such/frame_0001.png', frameRate: 24 })).body.code,
		).toBe('FILE_NOT_FOUND');
	});

	it('lists PSD layers and imports them as a sequence', async () => {
		const { engine, call } = await connect();
		const psd = file('doc.psd');
		const list = await call('list_document_layers', { path: psd });
		expect((list.body.layers as unknown[]).length).toBe(4);
		const r = await call('import_layered_document', { path: psd, mode: 'sequence', frameRate: 25 });
		expect(r.isError).toBe(false);
		const seq = engine.doc().sequences[r.body.sequenceId as string] as Sequence;
		expect(seq.settings.width).toBe(400);
		expect(seq.settings.frameRate).toEqual({ num: 25, den: 1 });
		const clips = Object.values(seq.clips);
		expect(clips).toHaveLength(4);
		expect(clips.find((c) => 'blendMode' in c && c.blendMode === 'add')).toBeTruthy();
		expect(clips.filter((c) => c.enabled === false)).toHaveLength(1);
		expect(
			clips.some((c) => 'effects' in c && c.effects.some((e) => JSON.stringify(e).includes('track-matte'))),
		).toBe(true);
		expect((r.body.media as unknown[]).length).toBe(4);
		expect(r.body.notes).toEqual(expect.arrayContaining([expect.stringContaining('Drop Shadow')]));
	});

	it('imports chosen PSD layers individually or merged, and the flattened picture', async () => {
		const { engine, call } = await connect();
		const psd = file('doc2.psd');
		const ind = await call('import_layered_document', { path: psd, mode: 'individual', layers: [0, 2] });
		expect((ind.body.media as unknown[]).length).toBe(2);
		expect(ind.body.sequenceId).toBeUndefined();
		const merged = await call('import_layered_document', { path: psd, mode: 'merged', layers: [1, 2] });
		expect(engine.calls.extractLayers!.at(-1)).toMatchObject({ merge: [1, 2] });
		expect((merged.body.media as { name: string }[])[0]!.name).toBe('doc (merged)');
		const flat = await call('import_layered_document', { path: psd, mode: 'merged-all' });
		expect((flat.body.media as { kind: string }[])[0]!.kind).toBe('image');
		expect((await call('import_layered_document', { path: file('a.png'), mode: 'sequence' })).body.code).toBe(
			'E_NOT_LAYERED',
		);
	});

	it('imports PDF pages, one item per page', async () => {
		const { engine, call } = await connect();
		const pdf = file('doc.pdf');
		const list = await call('import_pdf_pages', { path: pdf });
		expect(list.body.pageCount).toBe(3);
		const r = await call('import_pdf_pages', { path: pdf, pages: [2, 3] });
		const imported = r.body.imported as { page: number; mediaId: string }[];
		expect(imported.map((x) => x.page)).toEqual([2, 3]);
		const p2 = engine.doc().media[imported[0]!.mediaId]!;
		expect(p2.vector).toMatchObject({ page: 2, width: 792, height: 612 });
		expect(p2.probe.streams[0]).toMatchObject({ width: 792, height: 612 });
		// Pages of one file are different media (same fingerprint, different page).
		expect(imported[1]!.mediaId).not.toBe(imported[0]!.mediaId);
		expect(engine.doc().media[imported[1]!.mediaId]!.vector?.page).toBe(3);
		expect((await call('import_pdf_pages', { path: pdf, pages: [9] })).body.code).toBe('E_INVALID_PARAM');
	});

	it('exports a sequence as Lottie with warnings', async () => {
		const { engine, call } = await connect();
		const out = join(dir, 'anim.lottie');
		const r = await call('export_lottie', { outputPath: out, start: 0, end: { seconds: 2 } });
		expect(r.isError).toBe(false);
		expect(r.body.warnings).toHaveLength(1);
		expect(engine.calls.exportLottie![0]).toMatchObject({
			sequenceId: engine.seqId,
			format: 'dotlottie',
			outputPath: out,
			range: { start: 0, end: 60 },
		});
		expect((await call('export_lottie', { outputPath: 'rel.json' })).body.code).toBe('NOT_ABSOLUTE');
	});
});
