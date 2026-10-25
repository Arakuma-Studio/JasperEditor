import type { GltfDocument } from '../src/three-d/gltf-schema.ts';

const enc = (doc: unknown) => new TextEncoder().encode(JSON.stringify(doc));

/** A triangle: 3 × VEC3 float positions (36 bytes) and 3 × u16 indices. */
function triangleBuffer(): string {
	const bin = new Uint8Array(44);
	const dv = new DataView(bin.buffer);
	for (const [i, v] of [0, 0, 0, 1, 0, 0, 0, 1, 0].entries()) dv.setFloat32(i * 4, v, true);
	for (const [i, v] of [0, 1, 2].entries()) dv.setUint16(36 + i * 2, v, true);
	return `data:application/octet-stream;base64,${Buffer.from(bin).toString('base64')}`;
}

type TestModelDocument = GltfDocument & {
	scenes: { nodes: number[] }[];
	nodes: NonNullable<GltfDocument['nodes']>;
	meshes: NonNullable<GltfDocument['meshes']>;
	accessors: NonNullable<GltfDocument['accessors']>;
	bufferViews: NonNullable<GltfDocument['bufferViews']>;
	buffers: { byteLength: number; uri?: string }[];
};

export function triangleDocument(): TestModelDocument {
	return {
		asset: { version: '2.0' },
		scene: 0,
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
		buffers: [{ byteLength: 44, uri: triangleBuffer() }],
	};
}

/** An accessor without a buffer view is all zeros (glTF §3.6.2.3): its count is all there is. */
export function accessorOfZeros(count = 100_000_000): Uint8Array {
	const d = triangleDocument();
	d.accessors[0] = { componentType: 5126, count, type: 'VEC3' };
	delete d.meshes[0].primitives[0].indices;
	return enc(d);
}

/** A stride of 0 reads the same element `count` times: the buffer check never fails. */
export function strideZero(count = 100_000_000): Uint8Array {
	const d = triangleDocument();
	d.bufferViews[0].byteStride = 0;
	d.accessors[0].count = count;
	delete d.meshes[0].primitives[0].indices;
	return enc(d);
}

/** Nodes that share their children: `levels` nodes, each naming the next one `fanout` times. */
export function sharedChildren(fanout = 8, levels = 14): Uint8Array {
	const d = triangleDocument();
	d.nodes = Array.from({ length: levels }, (_, i) =>
		i === levels - 1 ? { mesh: 0 } : { children: Array.from({ length: fanout }, () => i + 1) },
	);
	return enc(d);
}

/** One mesh of `vertices` vertices shown by `instances` nodes: legal, and as large as the product. */
export function manyInstances(instances = 20_000, vertices = 30_000): Uint8Array {
	const d = triangleDocument();
	const bin = new Uint8Array(vertices * 12);
	d.buffers[0] = {
		byteLength: bin.length,
		uri: `data:application/octet-stream;base64,${Buffer.from(bin).toString('base64')}`,
	};
	d.bufferViews = [{ buffer: 0, byteOffset: 0, byteLength: bin.length }];
	d.accessors = [{ bufferView: 0, componentType: 5126, count: vertices, type: 'VEC3' }];
	d.meshes[0].primitives[0] = { attributes: { POSITION: 0 } };
	d.nodes = Array.from({ length: instances }, () => ({ mesh: 0 }));
	d.scenes[0].nodes = d.nodes.map((_, i) => i);
	return enc(d);
}

export function sharedImage(materials = 4000, imageBytes = 1 << 20): Uint8Array {
	const d = triangleDocument();
	const bin = new Uint8Array(44 + imageBytes);
	bin.set(Buffer.from(triangleBuffer().split(',')[1]!, 'base64'));
	d.buffers[0] = {
		byteLength: bin.length,
		uri: `data:application/octet-stream;base64,${Buffer.from(bin).toString('base64')}`,
	};
	d.bufferViews.push({ buffer: 0, byteOffset: 44, byteLength: imageBytes });
	d.images = [{ bufferView: 2, mimeType: 'image/png' }];
	d.textures = [{ source: 0 }];
	d.materials = Array.from({ length: materials }, () => ({
		pbrMetallicRoughness: { baseColorTexture: { index: 0 } },
	}));
	d.meshes[0].primitives[0].material = 0;
	return enc(d);
}

export function brokenDataUri(): Uint8Array {
	const d = triangleDocument();
	d.buffers[0] = { byteLength: 3, uri: 'data:application/octet-stream,%E0%A4%A' };
	return enc(d);
}

export function badIndices(values: number[] = [0, -1, 1.5]): Uint8Array {
	const d = triangleDocument();
	const bin = new Uint8Array(36 + 12);
	bin.set(Buffer.from(triangleBuffer().split(',')[1]!, 'base64').subarray(0, 36));
	const dv = new DataView(bin.buffer);
	for (const [i, v] of values.entries()) dv.setFloat32(36 + i * 4, v, true);
	d.buffers[0] = {
		byteLength: bin.length,
		uri: `data:application/octet-stream;base64,${Buffer.from(bin).toString('base64')}`,
	};
	d.bufferViews[1] = { buffer: 0, byteOffset: 36, byteLength: 12 };
	d.accessors[1] = { bufferView: 1, componentType: 5126, count: 3, type: 'SCALAR' };
	return enc(d);
}

export function hostileModelSeeds(): Uint8Array[] {
	return [
		accessorOfZeros(1000),
		strideZero(1000),
		sharedChildren(2, 4),
		manyInstances(8, 12),
		brokenDataUri(),
		badIndices(),
	];
}
