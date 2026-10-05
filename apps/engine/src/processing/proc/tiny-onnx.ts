// A tiny ONNX super-resolution model (S07:PST-034, tests; also the runtime self-test of ortProviders): a 1×1 convolution (3 → 12 channels) followed by
// DepthToSpace(2, CRD) = a 2× nearest-neighbour upscale. Written as raw protobuf so
// tests need no Python and no downloads. A few hundred bytes.

function varint(n: number | bigint): number[] {
	let v = BigInt(n);
	const out: number[] = [];
	do {
		let b = Number(v & 0x7fn);
		v >>= 7n;
		if (v > 0n) b |= 0x80;
		out.push(b);
	} while (v > 0n);
	return out;
}

const key = (field: number, wire: number) => varint((field << 3) | wire);
const vint = (field: number, v: number | bigint) => [...key(field, 0), ...varint(v)];
const bytes = (field: number, b: number[] | Uint8Array) => [...key(field, 2), ...varint(b.length), ...b];
const str = (field: number, s: string) => bytes(field, [...Buffer.from(s, 'utf8')]);

function dim(v: number | string): number[] {
	return typeof v === 'number' ? vint(1, v) : str(2, v);
}

function valueInfo(name: string, shape: Array<number | string>): number[] {
	const shapeProto = shape.flatMap((d) => bytes(1, dim(d)));
	const tensorType = [...vint(1, 1), ...bytes(2, shapeProto)];
	const typeProto = bytes(1, tensorType);
	return [...str(1, name), ...bytes(2, typeProto)];
}

/** Builds the model bytes. The runtime uses it to probe execution providers. */
export function tinySrModel(): Uint8Array {
	const weights = new Float32Array(12 * 3);
	for (let c = 0; c < 3; c++) for (let s = 0; s < 4; s++) weights[(c * 4 + s) * 3 + c] = 1;
	const raw = new Uint8Array(weights.buffer);
	const initializer = [
		...vint(1, 12),
		...vint(1, 3),
		...vint(1, 1),
		...vint(1, 1),
		...vint(2, 1),
		...str(8, 'W'),
		...bytes(9, raw),
	];
	const conv = [...str(1, 'input'), ...str(1, 'W'), ...str(2, 'c'), ...str(3, 'conv'), ...str(4, 'Conv')];
	const attrBlock = [...str(1, 'blocksize'), ...vint(3, 2), ...vint(20, 2)];
	const attrMode = [...str(1, 'mode'), ...bytes(4, [...Buffer.from('CRD')]), ...vint(20, 3)];
	const d2s = [
		...str(1, 'c'),
		...str(2, 'output'),
		...str(3, 'd2s'),
		...str(4, 'DepthToSpace'),
		...bytes(5, attrBlock),
		...bytes(5, attrMode),
	];
	const graph = [
		...bytes(1, conv),
		...bytes(1, d2s),
		...str(2, 'tiny_sr'),
		...bytes(5, initializer),
		...bytes(11, valueInfo('input', ['batch', 3, 'height', 'width'])),
		...bytes(12, valueInfo('output', ['batch', 3, 'height2', 'width2'])),
	];
	const model = [
		...vint(1, 8),
		...str(2, 'jasper-tests'),
		...bytes(7, graph),
		...bytes(8, [...str(1, ''), ...vint(2, 17)]),
	];
	return Uint8Array.from(model);
}
