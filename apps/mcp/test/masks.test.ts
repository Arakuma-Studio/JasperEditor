// The fake engine supplies trace/track results; document changes use the real command system.
import type { EngineClient } from '@jasper/engine-client';
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	ellipsePath,
	type Mask,
	type ProjectDocument,
} from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineConnection } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';

function fakeEngine() {
	const ids = createCounterIdSource(7);
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'Masks', preset: 'hd-1080p-30' });
	let revision = 0;
	const calls: { name: string; body?: Record<string, unknown> }[] = [];
	const apply = (tx: Record<string, unknown>) => {
		const r = applyTransaction(doc, { protocol: 'jasper.tx/1', ...tx, origin: 'user' } as never, {
			ids,
			now: () => '2026-10-07T00:00:00.000Z',
			revision,
			registries: defaultRegistries(),
		});
		if (r.result.ok && !tx.dryRun) {
			doc = r.document;
			revision++;
		}
		return r.result;
	};
	const media = {
		kind: 'video',
		fingerprint: `q1:${'0'.repeat(63)}1`,
		originalName: 'plate.mp4',
		sizeBytes: 1,
		container: 'mov,mp4',
		probe: {
			durationFlicks: 705_600_000,
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
			],
			rotationDegrees: 0,
			hasAlpha: false,
			variableFrameRate: false,
		},
		locators: [{ type: 'engine-store', engineId: 'local', key: 'mk_plate' }],
		derivation: null,
		importedAt: '2026-10-07T00:00:00.000Z',
	};
	const setup = apply({
		label: 'setup',
		commands: [
			{ type: 'media.register', asset: media, ref: '$m' },
			{
				type: 'clip.place',
				source: { mediaId: '$m' },
				at: 0,
				sourceRange: { in: { flicks: 0 }, out: { sourceFrames: 30 } },
				tracks: { video: 'V1' },
				ref: '$v',
			},
			{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V2', color: [1, 0, 0, 1], ref: '$s' },
		],
	});
	if (!setup.ok) throw new Error(JSON.stringify(setup.errors));
	const client = {
		agentQuery: async () => ({ result: doc, revision, via: 'headless' }),
		agentTx: async (req: { transaction: Record<string, unknown> }) => ({
			result: apply(req.transaction),
			appliedBy: 'headless',
		}),
		getJob: async (id: string) => ({
			id,
			kind: 'track',
			state: 'succeeded',
			title: 'Track mask',
			progress: 1,
			stage: null,
			result: (() => {
				const req = calls.find((c) => c.name === 'trackingTrack')!.body! as {
					range: { startFrame: number; endFrame: number };
				};
				const n = req.range.endFrame - req.range.startFrame;
				const data: number[] = [];
				// 10 px right per frame (media px).
				for (let i = 0; i < n; i++) data.push(1, 0, 10 * i, 0, 1, 0, 0, 0, 1);
				return {
					startFrame: req.range.startFrame,
					fps: { num: 30, den: 1 },
					stride: 9,
					data,
					confidence: new Array(n).fill(1),
					method: 'mask-klt@1',
					lost: [],
				};
			})(),
		}),
		call: async (name: string, opts: { body?: Record<string, unknown> } = {}) => {
			calls.push({ name, ...(opts.body ? { body: opts.body } : {}) });
			if (name === 'masksTrace')
				return {
					total: 2,
					paths: [
						{ path: ellipsePath([0.5, 0.5], [0.2, 0.2]), depth: 0, area: 1000 },
						{ path: ellipsePath([0.5, 0.5], [0.05, 0.05]), depth: 1, area: -100 },
					],
				};
			if (name === 'trackingTrack') return { id: 'job_1', state: 'queued' };
			throw new Error(`unexpected call ${name}`);
		},
	};
	const link: EngineConnection = {
		target: { url: 'http://engine.test', token: null, source: 'explicit' },
		client: async () => client as unknown as EngineClient,
		invalidate: () => {},
		close: async () => {},
	};
	return { link, doc: () => doc, calls, video: setup.refs.$v!, solid: setup.refs.$s! };
}

let open: Client[] = [];
afterEach(async () => {
	for (const c of open) await c.close().catch(() => {});
	open = [];
});

async function connect() {
	const engine = fakeEngine();
	const { server } = createJasperMcpServer({ link: engine.link, agentName: 'masks-test' });
	const [x, y] = InMemoryTransport.createLinkedPair();
	await server.connect(x);
	const client = new Client({ name: 'masks-test', version: '1' });
	await client.connect(y);
	open.push(client);
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
		const text = (r.content[0] as { text: string }).text;
		let json: Record<string, unknown> = {};
		try {
			json = JSON.parse(text);
		} catch {}
		return { r, text, json };
	};
	return { engine, client, call };
}

const masksOf = (doc: ProjectDocument, id: string) =>
	((Object.values(doc.sequences)[0]!.clips[id] as { masks?: Mask[] }).masks ?? []) as Mask[];

describe('mask MCP tools', () => {
	it('add (px units), list, edit, remove', async () => {
		const { engine, call } = await connect();
		const add = await call('add_mask', {
			projectId: 'prj_t',
			clipId: engine.solid,
			shape: 'bezier',
			points: [
				[192, 108],
				[960, 108],
				[960, 540],
			],
			units: 'px',
			feather: 5,
		});
		expect(add.r.isError, add.text).toBeFalsy();
		const maskId = add.json.maskId as string;
		expect(masksOf(engine.doc(), engine.solid)[0]!.path.value.vertices[1]!.p).toEqual([0.5, 0.1]);
		const list = await call('list_masks', { projectId: 'prj_t', clipId: engine.solid });
		expect((list.json.box as { width: number }).width).toBe(1920);
		expect((list.json.masks as unknown[]).length).toBe(1);
		const edit = await call('edit_mask', {
			projectId: 'prj_t',
			maskId,
			mode: 'subtract',
			inverted: true,
			animate: ['opacity'],
			at: 0,
			opacity: 40,
			translate: [96, 0],
			units: 'px',
		});
		expect(edit.r.isError, edit.text).toBeFalsy();
		const m = masksOf(engine.doc(), engine.solid)[0]!;
		expect([m.mode, m.inverted, m.opacity.keyframes.length]).toEqual(['subtract', true, 1]);
		expect(m.path.value.vertices[0]!.p[0]).toBeCloseTo(0.15, 9);
		const rm = await call('remove_masks', { projectId: 'prj_t', maskIds: [maskId] });
		expect(rm.r.isError, rm.text).toBeFalsy();
		expect(masksOf(engine.doc(), engine.solid)).toHaveLength(0);
	});

	it('auto-trace creates add / subtract masks; track_mask writes path keys', async () => {
		const { engine, call } = await connect();
		const tr = await call('auto_trace_mask', { projectId: 'prj_t', clipId: engine.video, channel: 'luma' });
		expect(tr.r.isError, tr.text).toBeFalsy();
		const ms = masksOf(engine.doc(), engine.video);
		expect(ms.map((m) => m.mode)).toEqual(['add', 'subtract']);
		const body = engine.calls.find((c) => c.name === 'masksTrace')!.body!;
		expect(body).toMatchObject({ mediaKey: 'mk_plate', width: 1920, height: 1080, channel: 'luma' });
		const t = await call('track_mask', {
			projectId: 'prj_t',
			maskId: ms[0]!.id,
			direction: 'forward',
			frames: 5,
		});
		expect(t.r.isError, t.text).toBeFalsy();
		const after = masksOf(engine.doc(), engine.video)[0]!;
		expect(after.path.keyframes).toHaveLength(6);
		const dx =
			after.path.keyframes[5]!.value.vertices[0]!.p[0] - after.path.keyframes[0]!.value.vertices[0]!.p[0];
		expect(dx * 1920).toBeCloseTo(50, 6);
	});

	it('set_track_matte adds a Track Matte Key reading V1 and hides it', async () => {
		const { engine, call } = await connect();
		const r = await call('set_track_matte', {
			projectId: 'prj_t',
			clipId: engine.solid,
			matteTrack: 'V1',
			compositeUsing: 'luma',
			hideMatteTrack: true,
		});
		expect(r.r.isError, r.text).toBeFalsy();
		const seq = Object.values(engine.doc().sequences)[0]!;
		const fx = (
			seq.clips[engine.solid] as {
				effects: { effectId: string; params: Record<string, { value: unknown }> }[];
			}
		).effects[0]!;
		expect(fx.effectId).toBe('jasper.track-matte-key');
		expect(fx.params.matteTrack!.value).toBe(seq.videoTracks[0]!.id);
		expect(fx.params.compositeUsing!.value).toBe('matteLuma');
		expect(seq.videoTracks[0]!.output).toBe(false);
	});
});
