// 3D model files for Advanced 3D model layers (three-d, docs/wp-notes/three-d.md): glTF 2.0 (binary .glb, or .gltf
// with its buffers and images embedded as data: URIs) and Wavefront .obj. Pure: the engine's prober validates imports
// with it and the renderer loads models with it.
//
// glTF: the default scene's node tree (matrix or translation / rotation / scale) is flattened into world-space
// triangle lists; per primitive POSITION, NORMAL (computed when absent), TEXCOORD_0 and indices (triangles, strips
// and fans); materials are pbrMetallicRoughness (base colour factor and texture, metallic, roughness), emissive,
// alpha mode and cutoff. Not read: animations, skins, morph targets, other UV sets, sparse accessors, compressed
// meshes (Draco / meshopt are refused with a message), external files (refused: export a .glb).
// OBJ: v / vt / vn / f (polygons fanned, negative indices); one neutral material (materials of .mtl files are not
// read: the file is served alone).
import type { Vec3 } from '../schema/common.ts';

export type ModelFormat = 'glb' | 'gltf' | 'obj';

export type ModelMaterial = {
	/** Linear-light base colour factor (r, g, b, a). */
	baseColor: [number, number, number, number];
	/** Base colour image (PNG / JPEG / WebP bytes), or null. */
	texture: { mime: string; bytes: Uint8Array } | null;
	metallic: number;
	roughness: number;
	emissive: [number, number, number];
	alphaMode: 'OPAQUE' | 'MASK' | 'BLEND';
	alphaCutoff: number;
	doubleSided: boolean;
};

export type ModelPrimitive = {
	/** World-space (model units) positions, normals, UVs (or null), triangle indices. */
	positions: Float32Array;
	normals: Float32Array;
	uvs: Float32Array | null;
	indices: Uint32Array;
	material: ModelMaterial;
};

export type ParsedModel = {
	format: ModelFormat;
	primitives: ModelPrimitive[];
	bounds: { min: Vec3; max: Vec3 };
	triangles: number;
};

export class ModelParseError extends Error {}

export function modelFormatOf(name: string): ModelFormat | null {
	const m = /\.(glb|gltf|obj)$/i.exec(name);
	return m ? (m[1]!.toLowerCase() as ModelFormat) : null;
}

const DEFAULT_MATERIAL = (): ModelMaterial => ({
	baseColor: [1, 1, 1, 1],
	texture: null,
	metallic: 1,
	roughness: 1,
	emissive: [0, 0, 0],
	alphaMode: 'OPAQUE',
	alphaCutoff: 0.5,
	doubleSided: false,
});

/** Parses a model file. Throws `ModelParseError` with the reason. */
export function parseModel(bytes: Uint8Array, format: ModelFormat): ParsedModel {
	let primitives: ModelPrimitive[];
	try {
		primitives = format === 'obj' ? parseObj(utf8Decode(bytes)) : parseGltf(bytes, format);
	} catch (e) {
		// glTF JSON is walked without a schema: a structurally wrong document (a number where an array belongs, an
		// index past an array, an out-of-range typed-array view) surfaces as TypeError / RangeError — it is a
		// malformed file, reported as such (golden-fuzz).
		if (e instanceof TypeError || e instanceof RangeError)
			throw new ModelParseError(`The model file is malformed (${e.message})`);
		throw e;
	}
	if (primitives.length === 0) throw new ModelParseError('The model has no triangles');
	const min: Vec3 = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
	const max: Vec3 = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
	let triangles = 0;
	for (const p of primitives) {
		triangles += p.indices.length / 3;
		for (let i = 0; i < p.positions.length; i += 3)
			for (let k = 0; k < 3; k++) {
				const v = p.positions[i + k]!;
				if (v < min[k]!) min[k] = v;
				if (v > max[k]!) max[k] = v;
			}
	}
	if (!min.every(Number.isFinite) || !max.every(Number.isFinite))
		throw new ModelParseError('The model has no vertices');
	return { format, primitives, bounds: { min, max }, triangles };
}

// ---------------------------------------------------------------- glTF

/** UTF-8 → string (the model is DOM- and Node-free: no TextDecoder). */
function utf8Decode(b: Uint8Array): string {
	let out = '';
	let i = 0;
	while (i < b.length) {
		const c = b[i++]!;
		let cp: number;
		if (c < 0x80) cp = c;
		else if (c < 0xe0) cp = ((c & 0x1f) << 6) | (b[i++]! & 0x3f);
		else if (c < 0xf0) cp = ((c & 0x0f) << 12) | ((b[i++]! & 0x3f) << 6) | (b[i++]! & 0x3f);
		else cp = ((c & 0x07) << 18) | ((b[i++]! & 0x3f) << 12) | ((b[i++]! & 0x3f) << 6) | (b[i++]! & 0x3f);
		// Malformed sequences (overlong tails, surrogates, > U+10FFFF) become U+FFFD instead of throwing.
		out += cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? '\ufffd' : String.fromCodePoint(cp);
	}
	return out;
}

function utf8Encode(s: string): Uint8Array {
	const out: number[] = [];
	for (const ch of s) {
		const cp = ch.codePointAt(0)!;
		if (cp < 0x80) out.push(cp);
		else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
		else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
		else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
	}
	return Uint8Array.from(out);
}

type Json = Record<string, any>;

function base64(s: string): Uint8Array {
	const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
	const clean = s.replace(/[^A-Za-z0-9+/]/g, '');
	const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
	let o = 0;
	for (let i = 0; i < clean.length; i += 4) {
		const n =
			(A.indexOf(clean[i]!) << 18) |
			(A.indexOf(clean[i + 1] ?? 'A') << 12) |
			((A.indexOf(clean[i + 2] ?? 'A') & 63) << 6) |
			(A.indexOf(clean[i + 3] ?? 'A') & 63);
		if (o < out.length) out[o++] = (n >> 16) & 255;
		if (o < out.length) out[o++] = (n >> 8) & 255;
		if (o < out.length) out[o++] = n & 255;
	}
	return out;
}

function dataUri(uri: string): { mime: string; bytes: Uint8Array } {
	const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(uri);
	if (!m)
		throw new ModelParseError(
			`The glTF file references an external file (${uri.slice(0, 60)}): export the model as .glb (everything in one file)`,
		);
	const bytes = m[2] ? base64(m[3]!) : utf8Encode(decodeURIComponent(m[3]!));
	return { mime: m[1] || 'application/octet-stream', bytes };
}

function parseGltf(bytes: Uint8Array, format: ModelFormat): ModelPrimitive[] {
	let json: Json;
	let bin: Uint8Array | null = null;
	if (format === 'glb') {
		const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		if (bytes.byteLength < 20 || dv.getUint32(0, true) !== 0x46546c67)
			throw new ModelParseError('Not a binary glTF (.glb) file');
		if (dv.getUint32(4, true) !== 2) throw new ModelParseError('Only glTF 2.0 is supported');
		let off = 12;
		let jsonText: string | null = null;
		while (off + 8 <= bytes.byteLength) {
			const len = dv.getUint32(off, true);
			const type = dv.getUint32(off + 4, true);
			const chunk = bytes.subarray(off + 8, off + 8 + len);
			if (type === 0x4e4f534a) jsonText = utf8Decode(chunk);
			else if (type === 0x004e4942) bin = chunk;
			off += 8 + len;
		}
		if (!jsonText) throw new ModelParseError('The .glb file has no JSON chunk');
		try {
			json = JSON.parse(jsonText) as Json;
		} catch {
			throw new ModelParseError('The .glb JSON chunk is not valid JSON');
		}
	} else {
		try {
			json = JSON.parse(utf8Decode(bytes)) as Json;
		} catch {
			throw new ModelParseError('The .gltf file is not valid JSON');
		}
	}
	if (!json || typeof json !== 'object' || Array.isArray(json))
		throw new ModelParseError('The glTF JSON is not an object');
	if (!String(json.asset?.version ?? '').startsWith('2'))
		throw new ModelParseError('Only glTF 2.0 is supported');
	const required: string[] = json.extensionsRequired ?? [];
	const unsupported = required.filter((e) => e !== 'KHR_materials_unlit' && e !== 'KHR_texture_transform');
	if (unsupported.length)
		throw new ModelParseError(
			`The model needs glTF extensions that are not supported: ${unsupported.join(', ')}`,
		);
	const buffers: Uint8Array[] = (json.buffers ?? []).map((b: Json, i: number) => {
		if (b.uri === undefined) {
			if (i === 0 && bin) return bin;
			throw new ModelParseError('A glTF buffer has no data');
		}
		return dataUri(String(b.uri)).bytes;
	});
	const view = (i: number) => {
		const v = json.bufferViews?.[i];
		if (!v) throw new ModelParseError(`Missing bufferView ${i}`);
		const b = buffers[v.buffer];
		if (!b) throw new ModelParseError(`Missing buffer ${v.buffer}`);
		return {
			bytes: b.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength),
			stride: v.byteStride as number | undefined,
		};
	};
	const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
	const readAccessor = (i: number): { data: Float64Array; n: number; count: number } => {
		const a = json.accessors?.[i];
		if (!a) throw new ModelParseError(`Missing accessor ${i}`);
		const n = COMPONENTS[a.type as string];
		if (!n) throw new ModelParseError(`Unsupported accessor type ${a.type}`);
		const count = a.count as number;
		const out = new Float64Array(count * n);
		if (a.bufferView === undefined) return { data: out, n, count };
		const { bytes: vb, stride } = view(a.bufferView);
		const dv = new DataView(vb.buffer, vb.byteOffset, vb.byteLength);
		const ct = a.componentType as number;
		const size = ct === 5126 || ct === 5125 ? 4 : ct === 5122 || ct === 5123 ? 2 : 1;
		const step = stride ?? size * n;
		const base = a.byteOffset ?? 0;
		const norm = !!a.normalized;
		for (let k = 0; k < count; k++)
			for (let c = 0; c < n; c++) {
				const o = base + k * step + c * size;
				if (o + size > vb.byteLength) throw new ModelParseError(`Accessor ${i} reads past its buffer`);
				let v: number;
				switch (ct) {
					case 5126:
						v = dv.getFloat32(o, true);
						break;
					case 5125:
						v = dv.getUint32(o, true);
						break;
					case 5123:
						v = dv.getUint16(o, true);
						if (norm) v /= 65535;
						break;
					case 5122:
						v = dv.getInt16(o, true);
						if (norm) v = Math.max(v / 32767, -1);
						break;
					case 5121:
						v = dv.getUint8(o);
						if (norm) v /= 255;
						break;
					case 5120:
						v = dv.getInt8(o);
						if (norm) v = Math.max(v / 127, -1);
						break;
					default:
						throw new ModelParseError(`Unsupported component type ${ct}`);
				}
				out[k * n + c] = v;
			}
		return { data: out, n, count };
	};
	const image = (texIndex: number | undefined): ModelMaterial['texture'] => {
		if (texIndex === undefined) return null;
		const src = json.textures?.[texIndex]?.source;
		const img = src !== undefined ? json.images?.[src] : undefined;
		if (!img) return null;
		if (img.bufferView !== undefined)
			return { mime: img.mimeType ?? 'image/png', bytes: view(img.bufferView).bytes.slice() };
		if (img.uri) return dataUri(String(img.uri));
		return null;
	};
	const materials: ModelMaterial[] = (json.materials ?? []).map((m: Json) => {
		const pbr = m.pbrMetallicRoughness ?? {};
		return {
			baseColor: (pbr.baseColorFactor ?? [1, 1, 1, 1]) as ModelMaterial['baseColor'],
			texture: image(pbr.baseColorTexture?.index),
			metallic: pbr.metallicFactor ?? 1,
			roughness: pbr.roughnessFactor ?? 1,
			emissive: (m.emissiveFactor ?? [0, 0, 0]) as ModelMaterial['emissive'],
			alphaMode: m.alphaMode ?? 'OPAQUE',
			alphaCutoff: m.alphaCutoff ?? 0.5,
			doubleSided: !!m.doubleSided,
		};
	});
	const out: ModelPrimitive[] = [];
	const visit = (nodeIndex: number, parent: number[], depth: number) => {
		if (depth > 64) throw new ModelParseError('The node tree is too deep (cycle?)');
		const node = json.nodes?.[nodeIndex];
		if (!node) return;
		const local = nodeMatrix(node);
		const world = mul4(parent, local);
		if (node.mesh !== undefined) {
			const mesh = json.meshes?.[node.mesh];
			for (const p of mesh?.primitives ?? []) {
				const prim = primitive(p, world);
				if (prim) out.push(prim);
			}
		}
		for (const c of node.children ?? []) visit(c, world, depth + 1);
	};
	const primitive = (p: Json, world: number[]): ModelPrimitive | null => {
		const mode = p.mode ?? 4;
		if (mode !== 4 && mode !== 5 && mode !== 6) return null;
		if (p.attributes?.POSITION === undefined) return null;
		const pos = readAccessor(p.attributes.POSITION);
		const count = pos.count;
		let idx: number[];
		if (p.indices !== undefined) idx = Array.from(readAccessor(p.indices).data);
		else idx = [...Array(count).keys()];
		const tris: number[] = [];
		if (mode === 4) for (let i = 0; i + 2 < idx.length; i += 3) tris.push(idx[i]!, idx[i + 1]!, idx[i + 2]!);
		else if (mode === 5)
			for (let i = 0; i + 2 < idx.length; i++)
				tris.push(...(i % 2 ? [idx[i + 1]!, idx[i]!, idx[i + 2]!] : [idx[i]!, idx[i + 1]!, idx[i + 2]!]));
		else for (let i = 1; i + 1 < idx.length; i++) tris.push(idx[0]!, idx[i]!, idx[i + 1]!);
		if (tris.some((t) => t >= count)) throw new ModelParseError('A primitive index is out of range');
		const positions = new Float32Array(count * 3);
		for (let k = 0; k < count; k++) {
			const v = apply4(world, pos.data[k * 3]!, pos.data[k * 3 + 1]!, pos.data[k * 3 + 2]!);
			positions.set(v, k * 3);
		}
		let normals: Float32Array;
		if (p.attributes.NORMAL !== undefined) {
			const nm = normalMatrixOf(world);
			const n = readAccessor(p.attributes.NORMAL);
			normals = new Float32Array(count * 3);
			for (let k = 0; k < count; k++) {
				const x = n.data[k * 3]!;
				const y = n.data[k * 3 + 1]!;
				const z = n.data[k * 3 + 2]!;
				const v: Vec3 = [
					nm[0]! * x + nm[1]! * y + nm[2]! * z,
					nm[3]! * x + nm[4]! * y + nm[5]! * z,
					nm[6]! * x + nm[7]! * y + nm[8]! * z,
				];
				const l = Math.hypot(...v) || 1;
				normals.set([v[0] / l, v[1] / l, v[2] / l], k * 3);
			}
		} else normals = new Float32Array(0);
		let uvs: Float32Array | null = null;
		if (p.attributes.TEXCOORD_0 !== undefined)
			uvs = Float32Array.from(readAccessor(p.attributes.TEXCOORD_0).data);
		const material =
			p.material !== undefined && materials[p.material] ? materials[p.material]! : DEFAULT_MATERIAL();
		// glTF: without normals, flat shading (each triangle its own vertices with its face normal).
		if (normals.length === 0) return { ...flatShaded(positions, uvs, tris), material };
		return { positions, normals, uvs, indices: Uint32Array.from(tris), material };
	};
	const sceneIndex = json.scene ?? 0;
	const roots: number[] =
		json.scenes?.[sceneIndex]?.nodes ?? (json.nodes ?? []).map((_: unknown, i: number) => i);
	const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
	for (const r of roots) visit(r, I, 0);
	return out;
}

/** Row-major 4×4 of a glTF node. */
function nodeMatrix(node: Json): number[] {
	if (Array.isArray(node.matrix) && node.matrix.length === 16) {
		const m = node.matrix as number[];
		// glTF stores column-major.
		return [
			m[0]!,
			m[4]!,
			m[8]!,
			m[12]!,
			m[1]!,
			m[5]!,
			m[9]!,
			m[13]!,
			m[2]!,
			m[6]!,
			m[10]!,
			m[14]!,
			m[3]!,
			m[7]!,
			m[11]!,
			m[15]!,
		];
	}
	const [tx, ty, tz] = (node.translation ?? [0, 0, 0]) as number[];
	const [x, y, z, w] = (node.rotation ?? [0, 0, 0, 1]) as number[];
	const [sx, sy, sz] = (node.scale ?? [1, 1, 1]) as number[];
	const r = [
		1 - 2 * (y! * y! + z! * z!),
		2 * (x! * y! - z! * w!),
		2 * (x! * z! + y! * w!),
		2 * (x! * y! + z! * w!),
		1 - 2 * (x! * x! + z! * z!),
		2 * (y! * z! - x! * w!),
		2 * (x! * z! - y! * w!),
		2 * (y! * z! + x! * w!),
		1 - 2 * (x! * x! + y! * y!),
	];
	return [
		r[0]! * sx!,
		r[1]! * sy!,
		r[2]! * sz!,
		tx!,
		r[3]! * sx!,
		r[4]! * sy!,
		r[5]! * sz!,
		ty!,
		r[6]! * sx!,
		r[7]! * sy!,
		r[8]! * sz!,
		tz!,
		0,
		0,
		0,
		1,
	];
}

function mul4(a: number[], b: number[]): number[] {
	const o = new Array<number>(16).fill(0);
	for (let i = 0; i < 4; i++)
		for (let j = 0; j < 4; j++) {
			let s = 0;
			for (let k = 0; k < 4; k++) s += a[i * 4 + k]! * b[k * 4 + j]!;
			o[i * 4 + j] = s;
		}
	return o;
}

function apply4(m: number[], x: number, y: number, z: number): Vec3 {
	return [
		m[0]! * x + m[1]! * y + m[2]! * z + m[3]!,
		m[4]! * x + m[5]! * y + m[6]! * z + m[7]!,
		m[8]! * x + m[9]! * y + m[10]! * z + m[11]!,
	];
}

/** Inverse transpose of the upper 3×3 (row-major), or the 3×3 itself when singular. */
function normalMatrixOf(m: number[]): number[] {
	const [a, b, c, , d, e, f, , g, h, i] = m as number[];
	const A = e! * i! - f! * h!;
	const B = -(d! * i! - f! * g!);
	const C = d! * h! - e! * g!;
	const det = a! * A + b! * B + c! * C;
	if (Math.abs(det) < 1e-300) return [a!, b!, c!, d!, e!, f!, g!, h!, i!];
	const k = 1 / det;
	// (M⁻¹)ᵀ = cofactor matrix / det.
	return [
		A * k,
		B * k,
		C * k,
		-(b! * i! - c! * h!) * k,
		(a! * i! - c! * g!) * k,
		-(a! * h! - b! * g!) * k,
		(b! * f! - c! * e!) * k,
		-(a! * f! - c! * d!) * k,
		(a! * e! - b! * d!) * k,
	];
}

/** Unwelded triangles with their face normals (flat shading). */
function flatShaded(
	positions: Float32Array,
	uvs: Float32Array | null,
	tris: readonly number[],
): { positions: Float32Array; normals: Float32Array; uvs: Float32Array | null; indices: Uint32Array } {
	const n = tris.length;
	const pos = new Float32Array(n * 3);
	const nor = new Float32Array(n * 3);
	const uv = uvs ? new Float32Array(n * 2) : null;
	for (let t = 0; t + 2 < n; t += 3) {
		const ids = [tris[t]!, tris[t + 1]!, tris[t + 2]!];
		const P = ids.map((i) => [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!]);
		const ax = P[1]![0]! - P[0]![0]!;
		const ay = P[1]![1]! - P[0]![1]!;
		const az = P[1]![2]! - P[0]![2]!;
		const bx = P[2]![0]! - P[0]![0]!;
		const by = P[2]![1]! - P[0]![1]!;
		const bz = P[2]![2]! - P[0]![2]!;
		let cx = ay * bz - az * by;
		let cy = az * bx - ax * bz;
		let cz = ax * by - ay * bx;
		const l = Math.hypot(cx, cy, cz) || 1;
		cx /= l;
		cy /= l;
		cz /= l;
		ids.forEach((id, k) => {
			pos.set(P[k]!, (t + k) * 3);
			nor.set([cx, cy, cz], (t + k) * 3);
			if (uv && uvs) uv.set([uvs[id * 2]!, uvs[id * 2 + 1]!], (t + k) * 2);
		});
	}
	return { positions: pos, normals: nor, uvs: uv, indices: Uint32Array.from({ length: n }, (_, i) => i) };
}

// ---------------------------------------------------------------- OBJ

function parseObj(text: string): ModelPrimitive[] {
	const v: number[] = [];
	const vt: number[] = [];
	const vn: number[] = [];
	const positions: number[] = [];
	const normals: number[] = [];
	const uvs: number[] = [];
	const tris: number[] = [];
	const seen = new Map<string, number>();
	let hasNormals = true;
	let anyUv = false;
	const ref = (s: string): number => {
		const hit = seen.get(s);
		if (hit !== undefined) return hit;
		const [a, b, c] = s.split('/');
		const idx = (x: string | undefined, len: number) => {
			if (!x) return -1;
			const k = Number.parseInt(x, 10);
			if (!Number.isFinite(k)) throw new ModelParseError(`Bad OBJ index "${s}"`);
			return k < 0 ? len + k : k - 1;
		};
		const pi = idx(a, v.length / 3);
		if (pi < 0 || pi >= v.length / 3) throw new ModelParseError(`OBJ face index out of range ("${s}")`);
		const ti = idx(b, vt.length / 2);
		const ni = idx(c, vn.length / 3);
		positions.push(v[pi * 3]!, v[pi * 3 + 1]!, v[pi * 3 + 2]!);
		if (ti >= 0 && ti < vt.length / 2) {
			uvs.push(vt[ti * 2]!, 1 - vt[ti * 2 + 1]!);
			anyUv = true;
		} else uvs.push(0, 0);
		if (ni >= 0 && ni < vn.length / 3) normals.push(vn[ni * 3]!, vn[ni * 3 + 1]!, vn[ni * 3 + 2]!);
		else {
			normals.push(0, 0, 0);
			hasNormals = false;
		}
		const k = positions.length / 3 - 1;
		seen.set(s, k);
		return k;
	};
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const parts = line.split(/\s+/);
		const head = parts[0];
		if (head === 'v') v.push(Number(parts[1]), Number(parts[2]), Number(parts[3]));
		else if (head === 'vt') vt.push(Number(parts[1]), Number(parts[2] ?? 0));
		else if (head === 'vn') vn.push(Number(parts[1]), Number(parts[2]), Number(parts[3]));
		else if (head === 'f') {
			const ids = parts.slice(1).map(ref);
			for (let i = 1; i + 1 < ids.length; i++) tris.push(ids[0]!, ids[i]!, ids[i + 1]!);
		}
	}
	if (!v.every(Number.isFinite) || !vt.every(Number.isFinite) || !vn.every(Number.isFinite))
		throw new ModelParseError('The OBJ file has non-numeric coordinates');
	if (tris.length === 0) return [];
	const pos = Float32Array.from(positions);
	const material: ModelMaterial = {
		...DEFAULT_MATERIAL(),
		baseColor: [0.8, 0.8, 0.8, 1],
		metallic: 0,
		roughness: 0.6,
	};
	const uv = anyUv ? Float32Array.from(uvs) : null;
	// Faces without normals are shaded flat.
	if (!hasNormals) return [{ ...flatShaded(pos, uv, tris), material }];
	return [
		{
			positions: pos,
			normals: Float32Array.from(normals),
			uvs: uv,
			indices: Uint32Array.from(tris),
			material,
		},
	];
}
