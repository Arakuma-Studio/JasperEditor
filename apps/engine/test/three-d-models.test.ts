// three-d: 3D model files register as media of kind `model` through the engine's model prober (.glb / .gltf / .obj);
// unreadable files fail the import with the parser's reason.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApps, JSON_H, makeApp, register, type TestApp } from './helpers.ts';

let app: TestApp;
let dir: string;

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'jasper-models-'));
	app = await makeApp();
});
afterAll(async () => {
	await closeApps();
	rmSync(dir, { recursive: true, force: true });
});

describe('model media', () => {
	it('registers an OBJ and a glTF as kind model', async () => {
		const obj = join(dir, 'tri.obj');
		writeFileSync(obj, 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
		const m = await register(app, obj);
		expect(m.kind).toBe('model');
		expect(m.container).toBe('obj');
		const gltf = join(dir, 'tri.gltf');
		const bin = Buffer.alloc(44);
		for (const [i, v] of [0, 0, 0, 1, 0, 0, 0, 1, 0].entries()) bin.writeFloatLE(v, i * 4);
		for (const [i, v] of [0, 1, 2].entries()) bin.writeUInt16LE(v, 36 + i * 2);
		writeFileSync(
			gltf,
			JSON.stringify({
				asset: { version: '2.0' },
				scenes: [{ nodes: [0] }],
				nodes: [{ mesh: 0 }],
				meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
				accessors: [
					{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
					{ bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
				],
				bufferViews: [
					{ buffer: 0, byteOffset: 0, byteLength: 36 },
					{ buffer: 0, byteOffset: 36, byteLength: 6 },
				],
				buffers: [{ byteLength: 44, uri: `data:application/octet-stream;base64,${bin.toString('base64')}` }],
			}),
		);
		const g = await register(app, gltf);
		expect(g.kind).toBe('model');
		expect(g.container).toBe('gltf');
	});

	it('refuses a model it cannot read, with the reason', async () => {
		const bad = join(dir, 'bad.glb');
		writeFileSync(bad, 'not a model at all');
		const r = await app.inject({
			method: 'POST',
			url: '/api/media/register',
			headers: JSON_H,
			payload: { projectId: 'prj_0000000000000001', paths: [bad] },
		});
		const body = r.json() as { items: unknown[]; errors: { message: string }[] };
		expect(body.items.length).toBe(0);
		expect(JSON.stringify(body.errors)).toMatch(/binary glTF/);
	});
});
