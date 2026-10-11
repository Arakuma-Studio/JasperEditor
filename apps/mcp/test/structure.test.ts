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
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'Structure', preset: 'hd-1080p-30' });
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
	return { link, doc: () => doc, seqId, clipIds: (placed.results[0] as { clipIds: string[] }).clipIds };
}

let open: Client[] = [];
afterEach(async () => {
	for (const c of open) await c.close().catch(() => {});
	open = [];
});

async function connect() {
	const engine = fakeEngine();
	const { server } = createJasperMcpServer({ link: engine.link, agentName: 'structure-test' });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await server.connect(a);
	const client = new Client({ name: 'structure-test', version: '1' });
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

describe('edit-structure MCP tools', () => {
	it('lists the tools', async () => {
		const { client } = await connect();
		const names = (await client.listTools()).tools.map((t) => t.name);
		for (const n of [
			'nest_clips',
			'unnest_clips',
			'place_sequence',
			'list_nests',
			'add_adjustment_layer',
			'group_clips',
			'ungroup_clips',
			'duplicate_sequence',
			'delete_sequence',
			'remove_unused_media',
			'create_synthetic',
			'update_synthetic',
			'list_through_edits',
			'join_through_edits',
			'find_gaps',
			'make_subsequence',
			'add_frame_hold',
			'insert_frame_hold_segment',
			'frame_hold_options',
		])
			expect(names).toContain(n);
	});

	it('nests, lists, places and unnests', async () => {
		const { engine, call } = await connect();
		const nest = await call('nest_clips', { clipIds: engine.clipIds, name: 'Inner' });
		expect(nest.isError, JSON.stringify(nest.body)).toBe(false);
		const { sequenceId, clipIds } = nest.body.results[0];
		const list = await call('list_nests', {});
		expect(list.body.nests).toHaveLength(2);
		expect(list.body.nests[0].nestedName).toBe('Inner');
		expect(typeof list.body.nests[0].contentKey).toBe('string');
		const placed = await call('place_sequence', { sourceSequenceId: sequenceId, at: 200, nest: false });
		expect(placed.isError, JSON.stringify(placed.body)).toBe(false);
		const un = await call('unnest_clips', { clipIds });
		expect(un.isError, JSON.stringify(un.body)).toBe(false);
		const kinds = Object.values(engine.doc().sequences[engine.seqId]!.clips).map((c) => c.kind);
		expect(kinds).not.toContain('nest-video');
	});

	it('adjustment layers, groups, synthetics, through edits, gaps, subsequences and frame holds', async () => {
		const { engine, call } = await connect();
		const adj = await call('add_adjustment_layer', {
			at: 0,
			duration: 60,
			track: 'V2',
			effects: [{ effectId: 'jasper.black-white' }],
		});
		expect(adj.isError, JSON.stringify(adj.body)).toBe(false);
		const adjClip = Object.values(engine.doc().sequences[engine.seqId]!.clips).find(
			(c) => c.kind === 'adjustment',
		);
		expect((adjClip as { effects: unknown[] }).effects).toHaveLength(1);
		expect((await call('group_clips', { clipIds: [engine.clipIds[0], adjClip!.id] })).isError).toBe(false);
		expect((await call('ungroup_clips', { clipIds: [adjClip!.id] })).isError).toBe(false);
		const bars = await call('create_synthetic', { kind: 'bars-and-tone', params: { toneDb: -18 } });
		expect(bars.isError, JSON.stringify(bars.body)).toBe(false);
		const synId = bars.body.results[0].syntheticId;
		expect((await call('update_synthetic', { syntheticId: synId, params: { toneDb: -20 } })).isError).toBe(
			false,
		);
		expect((await call('update_synthetic', { syntheticId: synId, params: { nope: 1 } })).isError).toBe(true);
		await call('add_frame_hold', { at: 40, clipIds: [engine.clipIds[0]] });
		const held = Object.values(engine.doc().sequences[engine.seqId]!.clips).filter((c) => c.frameHold);
		expect(held).toHaveLength(1);
		expect((await call('frame_hold_options', { clipIds: [held[0]!.id], enabled: false })).isError).toBe(
			false,
		);
		const te = await call('list_through_edits', {});
		expect(te.body.throughEdits.length).toBeGreaterThan(0);
		expect((await call('join_through_edits', {})).isError).toBe(false);
		const gaps = await call('find_gaps', { tracks: ['V1'] });
		expect(gaps.body.tracks[0].gaps[0]).toMatchObject({ start: 0, end: 10 });
		expect((await call('find_gaps', {})).body.gaps).toEqual([]);
		const seg = await call('insert_frame_hold_segment', { clipId: engine.clipIds[0], at: 20, duration: 15 });
		expect(seg.isError, JSON.stringify(seg.body)).toBe(false);
		const sub = await call('make_subsequence', { from: 10, to: 50 });
		expect(sub.isError, JSON.stringify(sub.body)).toBe(false);
		const dup = await call('duplicate_sequence', { sequenceId: engine.seqId, name: 'Copy' });
		expect(dup.isError, JSON.stringify(dup.body)).toBe(false);
	});
});
