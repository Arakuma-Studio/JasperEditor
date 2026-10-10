// edit-ux MCP tools through the protocol against an in-memory engine: source_edit (three/four-point, backtiming, Fit
// Clip, split edits, patching), find/trim edit points, match / reverse match frame, subclips and split marks.
import type { EngineClient } from '@jasper/engine-client';
import {
	applyTransaction,
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
import type { EngineConnection } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';

function videoAsset(): Omit<MediaAsset, 'id'> {
	return {
		kind: 'video',
		fingerprint: `q1:${'a'.padStart(64, '0')}`,
		originalName: 'clip.mp4',
		sizeBytes: 1000,
		container: 'mov,mp4',
		probe: {
			durationFlicks: 10 * 705_600_000,
			startTimecode: null,
			streams: [
				{
					index: 0,
					type: 'video',
					codec: 'h264',
					width: 1920,
					height: 1080,
					pixelAspect: { num: 1, den: 1 },
					frameRate: { num: 30, den: 1 },
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
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'EditUx', preset: 'hd-1080p-30' });
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
	const r = apply({ label: 'setup', commands: [{ type: 'media.register', asset: videoAsset(), ref: '$m' }] });
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	const mediaId = r.refs.$m!;
	const placed = apply({
		label: 'setup',
		commands: [
			{
				type: 'clip.place',
				source: { mediaId },
				at: 10,
				sourceRange: { in: { seconds: 0 }, out: { seconds: 4 } },
			},
		],
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
	return {
		link,
		doc: () => doc,
		seqId,
		mediaId,
		clipIds: (placed.results[0] as { clipIds: string[] }).clipIds,
	};
}

let open: Client[] = [];
afterEach(async () => {
	for (const c of open) await c.close().catch(() => {});
	open = [];
});

async function connect() {
	const engine = fakeEngine();
	const { server } = createJasperMcpServer({ link: engine.link, agentName: 'edit-ux-test' });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await server.connect(a);
	const client = new Client({ name: 'edit-ux-test', version: '1' });
	await client.connect(b);
	open.push(client);
	const call = async (name: string, args: Record<string, unknown>) => {
		const r = (await client.callTool({
			name,
			arguments: { projectId: 'prj_test', ...args },
		})) as CallToolResult;
		const text = (r.content.find((c) => c.type === 'text') as { text: string } | undefined)?.text ?? '';
		return {
			isError: !!r.isError,
			body: (() => {
				try {
					return JSON.parse(text);
				} catch {
					return text;
				}
			})(),
		};
	};
	return { engine, call, client };
}

describe('edit-ux MCP tools', () => {
	it('source_edit: three-point at `at`, backtiming, four-point needs fit, fit to fill', async () => {
		const { call, engine } = await connect();
		const itemId = Object.values(engine.doc().items).find((i) => i.kind === 'media')!.id;
		let r = await call('source_edit', {
			itemId,
			sourceIn: { seconds: 5 },
			sourceOut: { seconds: 6 },
			at: 200,
			mode: 'insert',
		});
		expect(r.isError, JSON.stringify(r.body)).toBe(false);
		expect(r.body.edit).toMatchObject({ at: 200, frames: 30, rate: 1 });
		r = await call('source_edit', {
			itemId,
			sourceIn: { seconds: 1 },
			sourceOut: { seconds: 2 },
			sequenceIn: null,
			sequenceOut: 400,
		});
		expect(r.body.edit).toMatchObject({ at: 370, frames: 30 });
		r = await call('source_edit', {
			itemId,
			sourceIn: { seconds: 1 },
			sourceOut: { seconds: 3 },
			sequenceIn: 500,
			sequenceOut: 530,
		});
		expect(r.isError).toBe(true);
		expect(JSON.stringify(r.body)).toMatch(/fit/);
		r = await call('source_edit', {
			itemId,
			sourceIn: { seconds: 1 },
			sourceOut: { seconds: 3 },
			sequenceIn: 500,
			sequenceOut: 530,
			fit: 'change-speed',
		});
		expect(r.body.edit).toMatchObject({ at: 500, frames: 30, rate: 2 });
		const unknown = await call('source_edit', { itemId, bogus: 1 });
		expect(unknown.isError).toBe(true);
	});

	it('find_edit_points + trim_edit_points roll a cut; match_frame and reverse_match_frame agree', async () => {
		const { call, engine } = await connect();
		const itemId = Object.values(engine.doc().items).find((i) => i.kind === 'media')!.id;
		await call('source_edit', { itemId, sourceIn: { seconds: 6 }, sourceOut: { seconds: 8 }, at: 130 });
		const f = await call('find_edit_points', { at: 128, kind: 'roll', tracks: ['V1'] });
		expect(f.body.editPoints).toHaveLength(1);
		expect(f.body.editPoints[0]).toMatchObject({ edge: 'out', mode: 'roll', frame: 130, track: 'V1' });
		const ep = f.body.editPoints[0];
		const t = await call('trim_edit_points', {
			edits: [{ clipId: ep.clipId, edge: ep.edge, mode: ep.mode }],
			frames: -10,
		});
		expect(t.body.appliedFrames).toBe(-10);
		const m = await call('match_frame', { at: 125 });
		expect(m.body).toMatchObject({ found: true, itemId, sourceFrame: 175 });
		expect(m.body.sourceSeconds).toBeCloseTo(6 - 5 / 30, 5);
		const back = await call('reverse_match_frame', { itemId, sourceTime: { seconds: m.body.sourceSeconds } });
		expect(back.body).toMatchObject({ found: true, frame: 125 });
	});

	it('make_subclip / edit_subclip / set_split_marks', async () => {
		const { call, engine } = await connect();
		const itemId = Object.values(engine.doc().items).find((i) => i.kind === 'media')!.id;
		const s = await call('make_subclip', {
			itemId,
			in: { seconds: 2 },
			out: { seconds: 4 },
			name: 'Take',
			restrictTrims: true,
		});
		expect(s.isError, JSON.stringify(s.body)).toBe(false);
		const sub = s.body.itemId as string;
		expect(engine.doc().items[sub]).toMatchObject({ kind: 'subclip', name: 'Take', restrictTrims: true });
		const e = await call('edit_subclip', { itemId: sub, out: { seconds: 5 } });
		expect(e.isError).toBe(false);
		const m = await call('set_split_marks', { itemId: sub, audioIn: { seconds: 2.5 } });
		expect(m.isError, JSON.stringify(m.body)).toBe(false);
		expect((engine.doc().items[sub] as { marks: { split?: object } }).marks.split).toMatchObject({
			audioIn: { flicks: 2.5 * 705_600_000 },
		});
		const placed = await call('source_edit', { itemId: sub, at: 300 });
		expect(placed.body.edit.clipIds).toHaveLength(2);
	});
});
