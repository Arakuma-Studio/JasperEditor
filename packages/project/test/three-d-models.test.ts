import { describe, expect, it } from 'vitest';
import {
	buildRenderSnapshot,
	type Clip,
	checkInvariants,
	createCounterIdSource,
	type MediaHandle,
	ModelParseError,
	modelFormatOf,
	parseModel,
	repairDocument,
} from '../src/index.ts';
import { Harness, videoAsset } from './helpers.ts';

/** A glTF document with one triangle mesh used by two nodes (translated; rotated 90° about z and scaled). */
function gltfJson(bufferUri?: string, byteLength = 0) {
	return {
		asset: { version: '2.0' },
		scene: 0,
		scenes: [{ nodes: [0, 1] }],
		nodes: [
			{ mesh: 0, translation: [10, 0, 0] },
			{ mesh: 0, rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2], scale: [2, 2, 2] },
		],
		meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
		materials: [
			{ pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1], metallicFactor: 0, roughnessFactor: 0.5 } },
		],
		accessors: [
			{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
			{ bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
		],
		bufferViews: [
			{ buffer: 0, byteOffset: 0, byteLength: 36 },
			{ buffer: 0, byteOffset: 36, byteLength: 6 },
		],
		buffers: [{ byteLength, ...(bufferUri ? { uri: bufferUri } : {}) }],
	};
}

function binary(): Uint8Array {
	const b = new Uint8Array(44);
	const dv = new DataView(b.buffer);
	for (const [i, v] of [0, 0, 0, 1, 0, 0, 0, 1, 0].entries()) dv.setFloat32(i * 4, v, true);
	for (const [i, v] of [0, 1, 2].entries()) dv.setUint16(36 + i * 2, v, true);
	return b;
}

function glb(): Uint8Array {
	const json = new TextEncoder().encode(JSON.stringify(gltfJson(undefined, 44)));
	const jsonLen = Math.ceil(json.length / 4) * 4;
	const bin = binary();
	const total = 12 + 8 + jsonLen + 8 + bin.length;
	const out = new Uint8Array(total);
	const dv = new DataView(out.buffer);
	dv.setUint32(0, 0x46546c67, true);
	dv.setUint32(4, 2, true);
	dv.setUint32(8, total, true);
	dv.setUint32(12, jsonLen, true);
	dv.setUint32(16, 0x4e4f534a, true);
	out.fill(0x20, 20, 20 + jsonLen);
	out.set(json, 20);
	dv.setUint32(20 + jsonLen, bin.length, true);
	dv.setUint32(24 + jsonLen, 0x004e4942, true);
	out.set(bin, 28 + jsonLen);
	return out;
}

describe('model files', () => {
	it('reads a .glb: node transforms, indices, material, computed normals, bounds', () => {
		const m = parseModel(glb(), 'glb');
		expect(m.primitives.length).toBe(2);
		expect(m.triangles).toBe(2);
		expect(Array.from(m.primitives[0]!.positions)).toEqual([10, 0, 0, 11, 0, 0, 10, 1, 0]);
		// Node 1: 90° about z and ×2: (1,0,0) → (0,2,0), (0,1,0) → (−2,0,0).
		const p = Array.from(m.primitives[1]!.positions).map((v) => Math.round(v * 1e6) / 1e6 + 0);
		expect(p).toEqual([0, 0, 0, 0, 2, 0, -2, 0, 0]);
		// Normals of a triangle in the xy plane (counter-clockwise) point along +z.
		expect(Array.from(m.primitives[0]!.normals.slice(0, 3))).toEqual([0, 0, 1]);
		expect(m.primitives[0]!.material).toMatchObject({ baseColor: [1, 0, 0, 1], metallic: 0, roughness: 0.5 });
		const r = (v: number[]) => v.map((x) => Math.round(x * 1e5) / 1e5 + 0);
		expect({ min: r(m.bounds.min), max: r(m.bounds.max) }).toEqual({ min: [-2, 0, 0], max: [11, 2, 0] });
	});

	it('reads a .gltf with an embedded buffer and refuses external files and compressed meshes', () => {
		const b64 = Buffer.from(binary()).toString('base64');
		const json = JSON.stringify(gltfJson(`data:application/octet-stream;base64,${b64}`, 44));
		const m = parseModel(new TextEncoder().encode(json), 'gltf');
		expect(m.triangles).toBe(2);
		expect(() =>
			parseModel(new TextEncoder().encode(JSON.stringify(gltfJson('scene.bin', 44))), 'gltf'),
		).toThrow(/export the model as \.glb/);
		const draco = {
			...gltfJson(`data:;base64,${b64}`, 44),
			extensionsRequired: ['KHR_draco_mesh_compression'],
		};
		expect(() => parseModel(new TextEncoder().encode(JSON.stringify(draco)), 'gltf')).toThrow(
			ModelParseError,
		);
		expect(() =>
			parseModel(
				new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]),
				'glb',
			),
		).toThrow(/Not a binary glTF/);
	});

	it('reads an OBJ (quads fanned, negative indices, uv / normal references)', () => {
		const obj = [
			'# a unit quad and a triangle',
			'v 0 0 0',
			'v 1 0 0',
			'v 1 1 0',
			'v 0 1 0',
			'vt 0 0',
			'vt 1 0',
			'vt 1 1',
			'vt 0 1',
			'vn 0 0 1',
			'f 1/1/1 2/2/1 3/3/1 4/4/1',
			'f -4 -3 -1',
		].join('\n');
		const m = parseModel(new TextEncoder().encode(obj), 'obj');
		expect(m.triangles).toBe(3);
		expect(m.primitives[0]!.uvs).not.toBeNull();
		expect(m.bounds).toEqual({ min: [0, 0, 0], max: [1, 1, 0] });
		expect(() => parseModel(new TextEncoder().encode('v 0 0 0\nf 1 2 3'), 'obj')).toThrow(/out of range/);
		expect(modelFormatOf('Robot.GLB')).toBe('glb');
		expect(modelFormatOf('a.fbx')).toBeNull();
	});
});

describe('model layers', () => {
	function setup() {
		const h = new Harness();
		const asset = {
			...videoAsset({ kind: 'video' }),
			kind: 'model' as const,
			container: 'glb',
			originalName: 'robot.glb',
		};
		asset.probe = { ...asset.probe, streams: [], durationFlicks: null };
		const m = (h.ok([{ type: 'media.register', asset }]).results[0] as { mediaId: string }).mediaId;
		h.ok([{ type: 'clip.place', source: { mediaId: m }, at: 0 }]);
		const clip = () => h.clips('V1')[0] as Clip & { threeD?: { enabled: boolean } };
		return { h, m, clip };
	}
	const media = (): MediaHandle => ({
		url: 'model.glb',
		proxyUrl: null,
		kind: 'model',
		width: null,
		height: null,
		durationFlicks: null,
		hasAudio: false,
		rotation: 0,
	});

	it('places a model media as a 3D model layer that stays 3D', () => {
		const { h, clip } = setup();
		expect(clip().kind).toBe('model');
		expect(clip().threeD?.enabled).toBe(true);
		const r = h.tx([{ type: 'clip.set3d', clipIds: [clip().id], enabled: false }]);
		expect(r.ok).toBe(false);
		expect(!r.ok && r.errors[0]!.message).toMatch(/always 3D/);
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('the snapshot draws it with the 3D renderer and warns when the sequence uses Classic 3D', () => {
		const { h, clip } = setup();
		const snap = () => buildRenderSnapshot(h.doc, h.seqId, { resolveMedia: media, resolveFont: () => null });
		const s = snap();
		const c = s.videoTracks[0]!.clips[0]!;
		expect(c.kind).toBe('model');
		expect(c.engine).toBe('remotion');
		expect(c.threeD?.enabled).toBe(true);
		expect(s.warnings.some((w) => w.code === 'THREE_D_MODEL_CLASSIC' && w.clipId === clip().id)).toBe(true);
		h.ok([{ type: 'sequence.set3dRenderer', renderer: 'advanced' }]);
		expect(snap().warnings.some((w) => w.code === 'THREE_D_MODEL_CLASSIC')).toBe(false);
	});

	it('repair turns a model layer back into a 3D layer', () => {
		const { h, clip } = setup();
		const doc = structuredClone(h.doc);
		(doc.sequences[h.seqId]!.clips[clip().id] as { threeD?: { enabled: boolean } }).threeD!.enabled = false;
		expect(checkInvariants(doc).some((i) => i.message.includes('3D model layer'))).toBe(true);
		const fixed = repairDocument(doc, createCounterIdSource(5));
		expect(
			(fixed.document.sequences[h.seqId]!.clips[clip().id] as { threeD?: { enabled: boolean } }).threeD!
				.enabled,
		).toBe(true);
	});
});
