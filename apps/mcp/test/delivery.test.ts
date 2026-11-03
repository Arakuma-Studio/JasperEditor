// Spec 19 §12 for agents. Engine jobs are stubbed; document changes run through the real command system.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineClient } from '@jasper/engine-client';
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type MediaAsset,
	type ProjectDocument,
	titleLooksOf,
} from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineConnection } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';

const probe = (width: number, height: number) => ({
	durationFlicks: null,
	startTimecode: null,
	streams: [
		{
			index: 0,
			type: 'video',
			codec: 'png',
			width,
			height,
			pixelAspect: { num: 1, den: 1 },
			frameRate: { num: 25, den: 1 },
			pixelFormat: 'rgba',
			bitDepth: 8,
			color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'pc' },
			browserDecodable: true,
		},
	],
	rotationDegrees: 0,
	hasAlpha: true,
	variableFrameRate: false,
});

const image = (name: string, key: string, width: number, height: number) =>
	({
		kind: 'image',
		fingerprint: `q1:${name.padStart(64, '0')}`,
		originalName: `${name}.png`,
		sizeBytes: 10,
		container: 'png_pipe',
		probe: probe(width, height),
		locators: [{ type: 'engine-store', engineId: 'local', key }],
		derivation: null,
		importedAt: '2026-09-30T10:00:00.000Z',
	}) as Omit<MediaAsset, 'id'>;

const registered = (name: string, key: string, width: number, height: number) => ({
	...image(name, key, width, height),
	mediaKey: key,
	locators: [],
	browserPlayable: 'yes',
});

type Calls = { name: string; opts: { body?: unknown; query?: unknown; params?: unknown } }[];

function fakeEngine() {
	const ids = createCounterIdSource(7);
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'Delivery', preset: 'hd-1080p-30' });
	let revision = 0;
	const seqId = Object.keys(doc.sequences)[0]!;
	const apply = (tx: Record<string, unknown>) => {
		const r = applyTransaction(
			doc,
			{ protocol: 'jasper.tx/1', sequenceId: seqId, ...tx, origin: 'user' } as never,
			{
				ids,
				now: () => '2026-09-30T00:00:00.000Z',
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
	const r = apply({
		label: 'setup',
		commands: [{ type: 'media.register', asset: image('logo', 'mk_logo', 400, 100), ref: '$m' }],
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	const placed = apply({
		label: 'setup',
		commands: [{ type: 'clip.place', source: { mediaId: r.refs.$m! }, at: 0, ref: '$c' }],
	});
	if (!placed.ok) throw new Error(JSON.stringify(placed.errors));
	const calls: Calls = [];
	const results: Record<string, unknown> = {
		psdExport: {
			url: '/renders/j/output',
			bytes: 100,
			width: 1920,
			height: 1080,
			layers: [],
			baked: [],
			warnings: [],
		},
		alphaDelivery: {
			url: '/renders/j/output',
			format: 'png',
			frames: 1,
			width: 40,
			height: 20,
			origin: { x: -5, y: 3 },
			warnings: [],
		},
		gamutCheck: {
			frame: 0,
			output: 'rec709',
			outputLabel: 'Rec. 709',
			width: 4,
			height: 4,
			gamutPercent: 12,
			legalPercent: 0.5,
			anyPercent: 12.5,
			maskUrl: '/renders/j/output',
		},
		splitImageAnalyze: {
			width: 400,
			height: 100,
			cell: 1,
			cols: 400,
			rows: 100,
			bitDepth: 8,
			islands: [
				{ x0: 0, y0: 0, x1: 64, y1: 64 },
				{ x0: 272, y0: 16, x1: 400, y1: 80 },
			],
			labelMapUrl: '/x',
		},
		splitImage: {
			parts: [
				{ media: registered('a', 'mk_a', 64, 64), box: { x: 0, y: 0, w: 64, h: 64 } },
				{ media: registered('b', 'mk_b', 128, 64), box: { x: 272, y: 16, w: 128, h: 64 } },
			],
		},
	};
	let last = '';
	const plan = {
		width: 1920,
		height: 1080,
		frame: 0,
		layers: [],
		baked: ['Title: text rasterised'],
		blockers: [] as { code: string; message: string }[],
		warnings: [],
		estimate: { renders: 2, bytes: 1 },
	};
	const client = {
		agentQuery: async () => ({ result: doc, revision, via: 'headless' }),
		agentTx: async (req: { transaction: Record<string, unknown> }) => ({
			result: apply(req.transaction),
			appliedBy: 'headless',
		}),
		getJob: async () => ({ id: 'job', title: 'job', state: 'succeeded', progress: 1, result: results[last] }),
		call: async (name: string, opts: Calls[number]['opts'] = {}) => {
			calls.push({ name, opts });
			if (name === 'psdPlan') return plan;
			if (name === 'layerStylesRead')
				return {
					fileName: 'a.asl',
					skipped: ['Plain: no layer effects (blending options only)'],
					styles: [
						{
							name: 'Gold',
							origin: 'style library',
							refPx: 100,
							refKnown: false,
							refNote: 'unknown size',
							style: {
								effects: {
									stroke: [
										{
											enabled: true,
											size: { units: 'Pixels', value: 8 },
											position: 'outside',
											fillType: 'color',
										},
									],
									patternOverlay: { enabled: true, pattern: { name: 'Bricks' } },
								},
								baseColor: null,
								ppi: 72,
								globalAngle: 120,
								globalAltitude: 30,
								fillOpacity: 1,
								knockout: false,
							},
						},
					],
				};
			last = name;
			return { id: 'job', title: name, state: 'queued', progress: null };
		},
	};
	const link: EngineConnection = {
		target: { url: 'http://engine.test', token: null, source: 'explicit' },
		client: async () => client as unknown as EngineClient,
		invalidate: () => {},
		close: async () => {},
	};
	return { link, doc: () => doc, calls, plan, clipId: placed.refs.$c! };
}

let open: Client[] = [];
afterEach(async () => {
	for (const c of open) await c.close().catch(() => {});
	open = [];
});

async function connect(link: EngineConnection): Promise<Client> {
	const { server } = createJasperMcpServer({ link, agentName: 'delivery-test' });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await server.connect(a);
	const client = new Client({ name: 'test', version: '1' });
	await client.connect(b);
	open.push(client);

	return client;
}

const body = (r: unknown) => JSON.parse(((r as CallToolResult).content[0] as { text: string }).text);
const projectId = 'prj_0000000000000001';

describe('delivery tools (spec 19 §12)', () => {
	it('send_to_photoshop: dryRun lists what is baked and writes nothing', async () => {
		const e = fakeEngine();
		const c = await connect(e.link);
		const r = body(
			await c.callTool({
				name: 'send_to_photoshop',
				arguments: { projectId, at: { frames: 0 }, dryRun: true },
			}),
		);
		expect(r.written).toBe(false);
		expect(r.baked).toContain('Title: text rasterised');
		expect(e.calls.map((x) => x.name)).toEqual(['psdPlan']);
	});

	it('send_to_photoshop: blockers stop it before the job', async () => {
		const e = fakeEngine();
		e.plan.blockers.push({ code: 'PSD_EMPTY', message: 'Nothing is visible' });
		const c = await connect(e.link);
		const r = body(
			await c.callTool({ name: 'send_to_photoshop', arguments: { projectId, at: { frames: 0 } } }),
		);
		expect(r.written).toBe(false);
		expect(e.calls.map((x) => x.name)).toEqual(['psdPlan']);
	});

	it('send_to_photoshop writes through the job', async () => {
		const e = fakeEngine();
		const c = await connect(e.link);
		const r = body(
			await c.callTool({
				name: 'send_to_photoshop',
				arguments: { projectId, at: { frames: 0 }, splitTitles: true },
			}),
		);
		expect(r).toMatchObject({ written: true, bytes: 100 });
		expect((e.calls[1]!.opts.body as { splitTitles?: boolean }).splitTitles).toBe(true);
	});

	it('export_alpha trims selected clips and reports where the picture sits', async () => {
		const e = fakeEngine();
		const c = await connect(e.link);
		const r = body(
			await c.callTool({
				name: 'export_alpha',
				arguments: { projectId, start: { frames: 3 }, clipIds: [e.clipId], trimMarginPx: 12 },
			}),
		);
		expect(r.origin).toEqual({ x: -5, y: 3 });
		const sent = e.calls[0]!.opts.body as { range: unknown; clipIds: string[]; trim: { marginPx: number } };
		expect(sent.range).toEqual({ start: 3, end: 4 });
		expect(sent.trim.marginPx).toBe(12);
	});

	it('export_alpha refuses an empty range', async () => {
		const e = fakeEngine();
		const c = await connect(e.link);
		const r = (await c.callTool({
			name: 'export_alpha',
			arguments: { projectId, start: { frames: 5 }, end: { frames: 5 } },
		})) as CallToolResult;
		expect(r.isError).toBe(true);
	});

	it('import_layer_styles: dryRun reports; otherwise the styles become project looks', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'jasper-mcp-styles-'));
		const file = join(dir, 'a.asl');
		writeFileSync(file, 'bytes');
		const e = fakeEngine();
		const c = await connect(e.link);
		const dry = body(
			await c.callTool({ name: 'import_layer_styles', arguments: { projectId, path: file, dryRun: true } }),
		);
		expect(dry.saved).toBe(false);
		expect(dry.styles[0].report.mapped).toContain('Stroke');
		expect(dry.styles[0].report.unsupported.join()).toContain('Bricks');
		expect(dry.skipped[0]).toContain('Plain');
		expect(titleLooksOf(e.doc())).toEqual([]);
		const saved = body(
			await c.callTool({ name: 'import_layer_styles', arguments: { projectId, path: file, refPx: 200 } }),
		);
		expect(saved.saved).toBe(true);
		const looks = titleLooksOf(e.doc());
		expect(looks.map((l) => l.name)).toEqual(['Gold']);
		expect(saved.styles[0].lookId).toBe(looks[0]!.id);
		const rim = looks[0]!.appearance.layers.find((l) => l.type === 'rim')!;
		expect(rim.params.width!.value).toBe(4);
	});

	it('import_layer_styles refuses a relative path', async () => {
		const c = await connect(fakeEngine().link);
		const r = (await c.callTool({
			name: 'import_layer_styles',
			arguments: { projectId, path: 'a.asl' },
		})) as CallToolResult;
		expect(r.isError).toBe(true);
	});

	it('split_image: dryRun lists parts; otherwise one transaction replaces the clip', async () => {
		const e = fakeEngine();
		const c = await connect(e.link);
		const dry = body(
			await c.callTool({
				name: 'split_image',
				arguments: { projectId, clipId: e.clipId, mergePercent: 0, dryRun: true },
			}),
		);
		expect(dry.split).toBe(false);
		expect(dry.parts).toHaveLength(2);
		const seq = () => Object.values(e.doc().sequences)[0]!;
		expect(Object.keys(seq().clips)).toEqual([e.clipId]);
		const r = (await c.callTool({
			name: 'split_image',
			arguments: { projectId, clipId: e.clipId, mergePercent: 0 },
		})) as CallToolResult;
		expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
		expect(Object.values(seq().clips)).toHaveLength(2);
		expect(Object.keys(seq().groups)).toHaveLength(1);
	});

	it('split_image refuses a clip that is not a still', async () => {
		const e = fakeEngine();
		const c = await connect(e.link);
		const r = (await c.callTool({
			name: 'split_image',
			arguments: { projectId, clipId: 'clp_none' },
		})) as CallToolResult;
		expect(r.isError).toBe(true);
	});

	it('check_gamut returns the percentages and the mask', async () => {
		const e = fakeEngine();
		const c = await connect(e.link);
		const r = body(
			await c.callTool({
				name: 'check_gamut',
				arguments: { projectId, at: { frames: 0 }, output: 'rec709' },
			}),
		);
		expect(r).toMatchObject({ gamutPercent: 12, legalPercent: 0.5, outputLabel: 'Rec. 709' });
	});
});
