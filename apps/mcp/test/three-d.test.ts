// three-d MCP tools through the protocol against an in-memory engine: 3D layer switch, transform, material, cameras
// (settings, tools), lights, renderer and the get_3d_scene read-out; refusals come back as tool errors.
import type { EngineClient } from '@jasper/engine-client';
import {
	applyTransaction,
	type CameraClip,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
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
	let doc: ProjectDocument = createEmptyProject({ ids, name: '3D', preset: 'hd-1080p-30' });
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
			{ type: 'clip.addSolid', at: 0, duration: 60, track: 'V1', color: [1, 0, 0, 1], ref: '$a' },
			{ type: 'clip.addSolid', at: 0, duration: 60, track: 'V2', color: [0, 0, 1, 1], ref: '$b' },
		],
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
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
	return { link, doc: () => doc, seqId, a: r.refs.$a!, b: r.refs.$b! };
}

let open: Client[] = [];
afterEach(async () => {
	for (const c of open) await c.close().catch(() => {});
	open = [];
});

async function connect() {
	const engine = fakeEngine();
	const { server } = createJasperMcpServer({ link: engine.link, agentName: '3d-test' });
	const [x, y] = InMemoryTransport.createLinkedPair();
	await server.connect(x);
	const client = new Client({ name: '3d-test', version: '1' });
	await client.connect(y);
	open.push(client);
	const call = async (name: string, args: Record<string, unknown>) => {
		const r = (await client.callTool({ name, arguments: { projectId: 'prj_test', ...args } })) as CallToolResult;
		const text = (r.content.find((c) => c.type === 'text') as { text: string } | undefined)?.text ?? '';
		let body: unknown = text;
		try {
			body = JSON.parse(text);
		} catch {}
		return { isError: !!r.isError, body: body as Record<string, unknown> & { [k: string]: unknown } };
	};
	return { engine, call, client };
}

describe('three-d MCP tools', () => {
	it('builds a 3D scene and reads it back', async () => {
		const { engine, call, client } = await connect();
		const names = (await client.listTools()).tools.map((t) => t.name);
		for (const n of [
			'set_3d_layer',
			'set_3d_transform',
			'set_material',
			'add_camera',
			'camera_settings',
			'move_camera',
			'add_light',
			'light_settings',
			'set_3d_renderer',
			'get_3d_scene',
		])
			expect(names).toContain(n);
		expect((await call('set_3d_layer', { clipIds: [engine.a, engine.b], enabled: true })).isError).toBe(false);
		expect(
			(await call('set_3d_transform', { clipId: engine.b, position: [960, 540, -200], rotationY: 30, orientation: [0, 0, 10] }))
				.isError,
		).toBe(false);
		expect((await call('set_material', { clipIds: [engine.b], castsShadows: 'on', specularShininess: 40 })).isError).toBe(
			false,
		);
		const cam = await call('add_camera', { at: 0, preset: '35mm', depthOfField: true, fStop: 2.8 });
		expect(cam.isError).toBe(false);
		const camId = Object.values(engine.doc().sequences[engine.seqId]!.clips).find((c) => c.kind === 'camera')!.id;
		expect((await call('move_camera', { clipId: camId, op: 'orbit', yaw: 20, pitch: -10 })).isError).toBe(false);
		expect((await call('camera_settings', { clipId: camId, focalLength: 50 })).isError).toBe(false);
		expect((await call('add_light', { at: 0, lightType: 'spot', castsShadows: true, coneAngle: 60 })).isError).toBe(
			false,
		);
		expect((await call('set_3d_renderer', { draft: true })).isError).toBe(false);
		const scene = await call('get_3d_scene', { frame: 10 });
		expect(scene.isError).toBe(false);
		const s = scene.body as {
			camera: { clipId: string; focalLength: number; depthOfField: unknown };
			lights: { type: string }[];
			layers: { clipId: string; corners: unknown }[];
			runs: { members: string[] }[];
		};
		expect(s.camera.clipId).toBe(camId);
		expect(s.camera.focalLength).toBeCloseTo(50, 3);
		expect(s.camera.depthOfField).not.toBeNull();
		expect(s.lights.map((l) => l.type)).toEqual(['spot']);
		expect(s.layers.map((l) => l.clipId).sort()).toEqual([engine.a, engine.b].sort());
		expect(s.runs).toEqual([{ members: [engine.a, engine.b], bottomTrack: 'V1', topTrack: 'V2' }]);
		const c = engine.doc().sequences[engine.seqId]!.clips[camId] as CameraClip;
		expect(c.camera.depthOfField).toBe(true);
	});

	it('refusals are tool errors', async () => {
		const { call } = await connect();
		const r = await call('set_3d_layer', { clipIds: ['clp_missing0000000000'], enabled: true });
		expect(r.isError).toBe(true);
		expect((await call('set_3d_transform', { clipId: 'clp_x' })).isError).toBe(true);
		expect((await call('add_camera', { at: 0, preset: '13mm' })).isError).toBe(true);
	});
});
