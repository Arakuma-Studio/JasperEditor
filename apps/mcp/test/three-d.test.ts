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
		const r = (await client.callTool({
			name,
			arguments: { projectId: 'prj_test', ...args },
		})) as CallToolResult;
		const text = (r.content.find((c) => c.type === 'text') as { text: string } | undefined)?.text ?? '';
		let body: unknown = text;
		try {
			body = JSON.parse(text);
		} catch {}
		return { isError: !!r.isError, body: body as Record<string, unknown> & { [k: string]: unknown } };
	};
	return { engine, call };
}

describe('three-d MCP tools', () => {
	it('builds a 3D scene and reads it back', async () => {
		const { engine, call } = await connect();
		expect((await call('set_3d_layer', { clipIds: [engine.a, engine.b], enabled: true })).isError).toBe(
			false,
		);
		expect(
			(
				await call('set_3d_transform', {
					clipId: engine.b,
					position: [960, 540, -200],
					rotationY: 30,
					orientation: [0, 0, 10],
				})
			).isError,
		).toBe(false);
		expect(
			(await call('set_material', { clipIds: [engine.b], castsShadows: 'on', specularShininess: 40 }))
				.isError,
		).toBe(false);
		const cam = await call('add_camera', { at: 0, preset: '35mm', depthOfField: true, fStop: 2.8 });
		expect(cam.isError).toBe(false);
		const camId = Object.values(engine.doc().sequences[engine.seqId]!.clips).find(
			(c) => c.kind === 'camera',
		)!.id;
		expect((await call('move_camera', { clipId: camId, op: 'orbit', yaw: 20, pitch: -10 })).isError).toBe(
			false,
		);
		expect((await call('camera_settings', { clipId: camId, focalLength: 50 })).isError).toBe(false);
		expect(
			(await call('add_light', { at: 0, lightType: 'spot', castsShadows: true, coneAngle: 60 })).isError,
		).toBe(false);
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

	it('builds a 3D title by tools, and reports what it costs (spec 19 TL-078)', async () => {
		const { engine, call } = await connect();
		expect((await call('set_3d_layer', { clipIds: [engine.b], enabled: true })).isError).toBe(false);
		expect(
			(
				await call('set_3d_renderer', {
					renderer: 'advanced',
					toneMapping: 'aces',
					exposure: 0.5,
					glint: { enabled: true, rays: 4 },
				})
			).isError,
		).toBe(false);
		expect((await call('set_material', { clipIds: [engine.b], preset: 'gold' })).isError).toBe(false);
		// The perturbation: an unknown preset is refused by the schema, nothing is applied.
		expect((await call('set_material', { clipIds: [engine.b], preset: 'mithril' })).isError).toBe(true);
		expect(
			(await call('add_light', { at: 0, lightType: 'environment', environmentPreset: 'chromeBands' }))
				.isError,
		).toBe(false);
		const scene = await call('get_3d_scene', { frame: 10 });
		const layers = (scene.body as { layers: { clipId: string; costClass: string }[] }).layers;
		expect(layers.find((l) => l.clipId === engine.b)?.costClass).toBe('3d-heavy');
		const td = (
			engine.doc().sequences[engine.seqId]!.clips[engine.b] as unknown as {
				threeD: { material: { pbr?: unknown } };
			}
		).threeD;
		expect(td.material.pbr).toBeDefined();
	});

	it('threed_solid_edit: geometry, a band and a plate in one undo step; ids come back; refusals name the fix', async () => {
		const { engine, call } = await connect();
		const added = await call('apply_commands', {
			label: 'Title',
			commands: [
				{ type: 'clip.addText', at: 0, duration: 60, track: 'V3', content: { text: 'GOLD' }, ref: '$t' },
			],
		});
		expect(added.isError, JSON.stringify(added.body)).toBe(false);
		const id = (added.body.refs as Record<string, string>).$t!;
		expect((await call('set_3d_layer', { clipIds: [id], enabled: true })).isError).toBe(false);
		const before = engine.doc();
		const r = await call('threed_solid_edit', {
			clipIds: [id],
			extrusionDepth: 40,
			band: { width: 6, profile: 'round', preset: 'gold' },
			plate: { shape: 'box', grow: 12 },
		});
		expect(r.isError).toBe(false);
		const refs = r.body.refs as Record<string, string>;
		const solid = () =>
			(
				engine.doc().sequences[engine.seqId]!.clips[id] as unknown as {
					threeD: {
						geometry: {
							extrusionDepth: { value: number };
							bands: { id: string }[];
							backplates: { id: string }[];
						};
					};
				}
			).threeD.geometry;
		expect(solid().extrusionDepth.value).toBe(40);
		expect(solid().bands.map((b) => b.id)).toEqual([refs.$band0]);
		expect(solid().backplates.map((p) => p.id)).toEqual([refs.$plate0]);
		// One transaction: the document before it had none of the three.
		expect(
			(
				before.sequences[engine.seqId]!.clips[id] as unknown as {
					threeD: { geometry?: { bands?: unknown[] } };
				}
			).threeD.geometry?.bands ?? [],
		).toEqual([]);
		const second = await call('threed_solid_edit', { clipIds: [id], band: { width: 2 } });
		const band2 = (second.body.refs as Record<string, string>).$band0!;
		expect(
			(
				await call('threed_solid_edit', {
					clipIds: [id],
					band: { action: 'reorder', bandId: band2, index: 0 },
				})
			).isError,
		).toBe(false);
		expect(solid().bands.map((b) => b.id)).toEqual([band2, refs.$band0]);
		expect(
			(await call('threed_solid_edit', { clipIds: [id], plate: { action: 'remove', plateId: refs.$plate0 } }))
				.isError,
		).toBe(false);
		expect(solid().backplates ?? []).toEqual([]);
		const hint = async (args: Record<string, unknown>) => {
			const x = await call('threed_solid_edit', args);
			expect(x.isError).toBe(true);
			return (x.body.error as { hint: string }).hint;
		};
		expect(await hint({ clipIds: [id] })).toBe(
			'Pass mode, extrusionDepth, bevelPosition, inflate, band or plate.',
		);
		expect(await hint({ clipIds: [id], band: { action: 'remove' } })).toBe('Pass band.bandId.');
		expect(await hint({ clipIds: [id, engine.b], band: { action: 'remove', bandId: band2 } })).toContain(
			band2,
		);
	});

	it('set_material: classic options and a physical surface in one edit; a bare surface names the fix', async () => {
		const { engine, call } = await connect();
		await call('set_3d_layer', { clipIds: [engine.b], enabled: true });
		const r = await call('set_material', { clipIds: [engine.b], castsShadows: 'on', preset: 'chrome' });
		expect(r.isError).toBe(false);
		const td = (
			engine.doc().sequences[engine.seqId]!.clips[engine.b] as unknown as {
				threeD: { material: { castsShadows: string; pbr?: unknown } };
			}
		).threeD;
		expect(td.material.castsShadows).toBe('on');
		expect(td.material.pbr).toBeDefined();
		const bare = await call('set_material', { clipIds: [engine.b], surface: 'face' });
		expect(bare.isError).toBe(true);
		expect((bare.body.error as { hint: string }).hint).toBe('Add preset or values.');
	});
});
