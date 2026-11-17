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
	return { engine, call };
}

describe('edit-structure MCP tools', () => {
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
	it('apply_commands runs range.insertTime under a History label longer than 80 characters', async () => {
		const { engine, call } = await connect();
		const label = `Insert a 24-frame gap at 00:00:00:05 on every track for the sponsor read ${'·'.repeat(100)}`;
		const r = await call('apply_commands', {
			label,
			commands: [{ type: 'range.insertTime', at: 5, duration: 24 }],
		});
		expect(r.isError, JSON.stringify(r.body)).toBe(false);
		expect(Object.values(engine.doc().sequences[engine.seqId]!.clips).map((c) => c.start)).toEqual([34, 34]);
		const tooLong = await call('apply_commands', {
			label: 'x'.repeat(201),
			commands: [{ type: 'range.insertTime', at: 5, duration: 24 }],
		});
		expect(tooLong.isError).toBe(true);
	});
	it('list_cuts lists picture cuts with timecodes, pages and refuses bad tracks', async () => {
		const { engine, call } = await connect();
		const mediaId = Object.keys(engine.doc().media)[0]!;
		const placed = await call('apply_commands', {
			label: 'jump',
			commands: [
				{
					type: 'clip.place',
					source: { mediaId },
					at: 130,
					sourceRange: { in: { seconds: 6 }, out: { seconds: 8 } },
				},
			],
		});
		expect(placed.isError, JSON.stringify(placed.body)).toBe(false);
		const all = await call('list_cuts', {});
		expect(all.isError, JSON.stringify(all.body)).toBe(false);
		expect(all.body).toMatchObject({
			frameRate: '30/1',
			duration: { frames: 190 },
			tracks: ['V3', 'V2', 'V1'],
			total: 2,
			counts: { cut: 1, jump: 1, overlay: 0 },
		});
		expect(
			all.body.cuts.map((c: { frame: number; timecode: string; kind: string; track: string }) => [
				c.frame,
				c.timecode,
				c.kind,
				c.track,
			]),
		).toEqual([
			[10, '00:00:00:10', 'cut', 'V1'],
			[130, '00:00:04:10', 'jump', 'V1'],
		]);
		const page = await call('list_cuts', { limit: 1 });
		expect(page.body.cuts).toHaveLength(1);
		expect(page.body.nextOffset).toBe(1);
		const rest = await call('list_cuts', { offset: 1 });
		expect(rest.body.cuts[0].frame).toBe(130);
		expect(rest.body.nextOffset).toBeUndefined();
		const noJumps = await call('list_cuts', {
			includeJumpCuts: false,
			range: { start: 0, end: '00:00:05:00' },
		});
		expect(noJumps.body.total).toBe(1);
		const below = await call('list_cuts', { outputTrackId: 'V1' });
		expect(below.body.total).toBe(0);
		expect(below.body.tracks).toEqual([]);
		const audio = await call('list_cuts', { outputTrackId: 'A1' });
		expect(audio.isError).toBe(true);
		expect(JSON.stringify(audio.body)).toContain('E_INVALID_PARAM');
		const missing = await call('list_cuts', { trackIds: ['V9'] });
		expect(missing.isError).toBe(true);
		expect(JSON.stringify(missing.body)).toContain('E_NOT_FOUND');
		const unknown = await call('list_cuts', { bogus: 1 });
		expect(unknown.isError).toBe(true);
	});
});
