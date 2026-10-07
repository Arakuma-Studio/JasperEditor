// Workstream `time` MCP tools through the protocol against an in-memory engine: time remapping (segments, keyframes,
// ramps, freeze, reverse), time interpolation and Scene Edit Detection (engine job stubbed).
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
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'Time', preset: 'hd-1080p-30' });
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
	const sceneRequests: unknown[] = [];
	const client = {
		detectScenes: async (req: unknown) => {
			sceneRequests.push(req);
			return {
				id: 'job_scene1',
				state: 'succeeded',
				result: { cuts: [1, 2.5], frames: 120, scores: [], times: [], threshold: 0.25 },
			};
		},
		getJob: async () => ({ id: 'job_scene1', state: 'succeeded' }),
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
		sceneRequests,
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
	const { server } = createJasperMcpServer({ link: engine.link, agentName: 'time-test' });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await server.connect(a);
	const client = new Client({ name: 'time-test', version: '1' });
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

describe('time MCP tools', () => {
	it('remaps a clip: half speed, ramp, freeze, reverse, then removes it', async () => {
		const { engine, call } = await connect();
		const v = engine.clipIds.find((id) => engine.doc().sequences[engine.seqId]!.clips[id]!.kind === 'video')!;
		let r = await call('set_segment_speed', { clipId: v, at: 20, speedPercent: 50 });
		expect(r.isError, JSON.stringify(r.body)).toBe(false);
		r = await call('get_time_remap', { clipId: v });
		expect(r.body.timeRemapping).toBe(true);
		expect(r.body.duration).toBe(240);
		expect(r.body.segments.map((s: { speedPercent: number }) => s.speedPercent)).toEqual([50]);
		const k = await call('add_speed_keyframe', { clipId: v, at: 70 });
		const keyId = k.body.results[0].keyframeId;
		await call('set_segment_speed', { clipId: v, at: 100, speedPercent: 200, ripple: true });
		await call('set_speed_transition', { clipId: v, keyframeId: keyId, frames: 10 });
		await call('add_freeze_segment', { clipId: v, at: 30, duration: 15, ripple: true });
		await call('add_reverse_segment', { clipId: v, at: 50, duration: 10, ripple: true });
		r = await call('get_time_remap', { clipId: v });
		const kinds = r.body.segments.map((s: { kind: string }) => s.kind);
		expect(kinds).toContain('hold');
		expect(kinds).toContain('reverse');
		expect(r.body.keyframes.some((x: { transitionFrames: number }) => x.transitionFrames === 10)).toBe(true);
		r = await call('set_time_interpolation', { clipIds: [v], mode: 'optical-flow' });
		expect(r.isError).toBe(false);
		r = await call('set_time_remap', { clipIds: [v], enabled: false });
		expect(r.isError).toBe(false);
		expect((await call('get_time_remap', { clipId: v })).body.timeRemapping).toBe(false);
		// Strict inputs: unknown keys are refused.
		expect((await call('set_segment_speed', { clipId: v, at: 20, speed: 50 })).isError).toBe(true);
	});

	it('Scene Edit Detection runs the engine job and applies cuts, markers and scene items in one step', async () => {
		const { engine, call } = await connect();
		const v = engine.clipIds.find((id) => engine.doc().sequences[engine.seqId]!.clips[id]!.kind === 'video')!;
		const dry = await call('detect_scene_edits', { clipIds: [v], dryRun: true });
		expect(dry.body.clips[v].cutsSeconds).toEqual([1, 2.5]);
		const before = Object.keys(engine.doc().sequences[engine.seqId]!.clips).length;
		const r = await call('detect_scene_edits', { clipIds: [v], createMarkers: true, createSubclips: true });
		expect(r.isError, JSON.stringify(r.body)).toBe(false);
		const seq = engine.doc().sequences[engine.seqId]!;
		// Two cuts on the video and its linked audio: 4 more clips.
		expect(Object.keys(seq.clips).length).toBe(before + 4);
		expect(engine.sceneRequests[0]).toMatchObject({ mediaKey: 'mk_1', startSec: 0, sensitivity: 50 });
		expect(
			Object.values(engine.doc().items).filter((i) => i.name.includes('Scene')).length,
		).toBeGreaterThanOrEqual(3);
	});
});
