// A tiny stand-in for the CLAP model of Describe-it search (WP-E9 tests; no network, no 780 MB download): the same
// file names, inputs and outputs as the real export, written as raw ONNX protobuf.
//   audio: input_features [b,1,1001,64] → mean over time → centred over the 64 bands → identity into dims 0…63
//          (+ 1e-3 on dim 511, so silence stays finite) → L2 normalised `audio_embeds` [b,512]
//   text:  input_ids [b,t] → embedding rows → mean → L2 normalised `text_embeds` [b,512] (attention_mask unused)
// Word tokens: "high" points along a ramp over the bands (bright sounds), "low" along the opposite ramp; every
// single-character token gets a small deterministic vector in dims 64…509, the specials dim 511. So "this is a sound
// of high" matches a bright tone and "… of low" a dark one, and the 300-phrase vocabulary spreads out.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const D = 512;

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

function valueInfo(name: string, elemType: number, shape: Array<number | string>): number[] {
	const shapeProto = shape.flatMap((d) => bytes(1, typeof d === 'number' ? vint(1, d) : str(2, d)));
	const tensorType = [...vint(1, elemType), ...bytes(2, shapeProto)];
	return [...str(1, name), ...bytes(2, bytes(1, tensorType))];
}

function tensor(name: string, dims: number[], data: Float32Array): number[] {
	return [
		...dims.flatMap((d) => vint(1, d)),
		...vint(2, 1),
		...str(8, name),
		...bytes(9, new Uint8Array(data.buffer, data.byteOffset, data.byteLength)),
	];
}

const attrInts = (name: string, v: number[]) => bytes(5, [...str(1, name), ...v.flatMap((x) => vint(8, x)), ...vint(20, 7)]);
const attrInt = (name: string, v: number) => bytes(5, [...str(1, name), ...vint(3, v), ...vint(20, 2)]);

function node(op: string, inputs: string[], outputs: string[], attrs: number[][] = []): number[] {
	return bytes(1, [
		...inputs.flatMap((i) => str(1, i)),
		...outputs.flatMap((o) => str(2, o)),
		...str(3, `${op}_${outputs[0]}`),
		...str(4, op),
		...attrs.flat(),
	]);
}

function model(graph: number[]): Uint8Array {
	return Uint8Array.from([
		...vint(1, 8),
		...str(2, 'jasper-tests'),
		...bytes(7, graph),
		...bytes(8, [...str(1, ''), ...vint(2, 17)]),
	]);
}

export function tinyAudioGraph(): Uint8Array {
	const W = new Float32Array(64 * D);
	for (let i = 0; i < 64; i++) W[i * D + i] = 1;
	const B = new Float32Array(D);
	B[D - 1] = 1e-3;
	return model([
		...node('ReduceMean', ['input_features'], ['m'], [attrInts('axes', [1, 2]), attrInt('keepdims', 0)]),
		...node('ReduceMean', ['m'], ['mu'], [attrInts('axes', [1]), attrInt('keepdims', 1)]),
		...node('Sub', ['m', 'mu'], ['c']),
		...node('MatMul', ['c', 'W'], ['p']),
		...node('Add', ['p', 'B'], ['pb']),
		...node('LpNormalization', ['pb'], ['audio_embeds'], [attrInt('axis', 1), attrInt('p', 2)]),
		...str(2, 'tiny_clap_audio'),
		...bytes(5, tensor('W', [64, D], W)),
		...bytes(5, tensor('B', [D], B)),
		...bytes(11, valueInfo('input_features', 1, ['batch', 1, 1001, 64])),
		...bytes(12, valueInfo('audio_embeds', 1, ['batch', D])),
	]);
}

/** The test vocabulary: specials, the word tokens and every printable byte character as a token of its own. */
export function tinyVocab(): { vocab: Record<string, number>; merges: string[] } {
	const vocab: Record<string, number> = { '<s>': 0, '<pad>': 1, '</s>': 2, '<unk>': 3 };
	const words = ['this', 'Ġis', 'Ġa', 'Ġsound', 'Ġof', 'Ġhigh', 'Ġlow', 'high', 'low'];
	const merges: string[] = [];
	const seen = new Set<string>();
	for (const w of words) {
		vocab[w] = Object.keys(vocab).length;
		const chars = [...w];
		let acc = chars[0]!;
		for (let i = 1; i < chars.length; i++) {
			const m = `${acc} ${chars[i]}`;
			if (!seen.has(m)) {
				seen.add(m);
				merges.push(m);
			}
			acc += chars[i];
		}
	}
	for (let c = 0x21; c <= 0x7e; c++) {
		const ch = String.fromCharCode(c);
		if (!(ch in vocab)) vocab[ch] = Object.keys(vocab).length;
	}
	if (!('Ġ' in vocab)) vocab['Ġ'] = Object.keys(vocab).length;
	return { vocab, merges };
}

export function tinyTextGraph(): Uint8Array {
	const { vocab } = tinyVocab();
	const V = Object.keys(vocab).length;
	const E = new Float32Array(V * D);
	const ramp = (sign: number, row: number) => {
		for (let k = 0; k < 64; k++) E[row * D + k] = (sign * (k - 31.5)) / 32;
	};
	for (const [tok, id] of Object.entries(vocab)) {
		if (id <= 3) E[id * D + D - 1] = 0.01;
		else if (tok === 'Ġhigh' || tok === 'high') ramp(1, id);
		else if (tok === 'Ġlow' || tok === 'low') ramp(-1, id);
		else if ([...tok].length === 1) {
			const h = createHash('sha256').update(tok).digest();
			for (let k = 0; k < 8; k++) E[id * D + 64 + (h[k]! % 440)] += 0.1;
		}
	}
	return model([
		...node('Gather', ['E', 'input_ids'], ['g'], [attrInt('axis', 0)]),
		...node('ReduceMean', ['g'], ['t'], [attrInts('axes', [1]), attrInt('keepdims', 0)]),
		...node('LpNormalization', ['t'], ['text_embeds'], [attrInt('axis', 1), attrInt('p', 2)]),
		...str(2, 'tiny_clap_text'),
		...bytes(5, tensor('E', [V, D], E)),
		...bytes(11, valueInfo('input_ids', 7, ['batch', 'tokens'])),
		...bytes(11, valueInfo('attention_mask', 7, ['batch', 'tokens'])),
		...bytes(12, valueInfo('text_embeds', 1, ['batch', D])),
	]);
}

type CatalogFile = { path: string; url: string | null; sha256: string; sizeBytes: number };

/**
 * Writes the tiny model's files into `dir/src` and a processing catalogue `dir/catalog.json` with one `sound` model
 * (`clap-test`, files by path) and, when `pending`, a second one whose graph has no download location.
 */
export function writeTinyClapCatalog(dir: string, opts: { pending?: boolean } = {}): string {
	const src = join(dir, 'src');
	mkdirSync(src, { recursive: true });
	const { vocab, merges } = tinyVocab();
	const files: Record<string, Uint8Array | string> = {
		'clap-audio.graph.onnx': tinyAudioGraph(),
		'clap-text.graph.onnx': tinyTextGraph(),
		'vocab.json': JSON.stringify(vocab),
		'merges.txt': `#version: 0.2\n${merges.join('\n')}\n`,
	};
	const list: CatalogFile[] = Object.entries(files).map(([name, data]) => {
		const p = join(src, name);
		writeFileSync(p, data);
		const buf = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data);
		return { path: name, url: p, sha256: createHash('sha256').update(buf).digest('hex'), sizeBytes: buf.byteLength };
	});
	const entry = (id: string, fileList: CatalogFile[]) => ({
		id,
		name: `Test CLAP ${id}`,
		task: 'audio-text',
		description: 'tiny test model',
		license: 'Apache-2.0',
		licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
		attribution: 'Test authors',
		sourceUrl: 'https://example.invalid/clap',
		upstreamUrl: 'https://example.invalid/clap-upstream',
		revision: '0123456789abcdef0123456789abcdef01234567',
		files: fileList,
	});
	const sound = [entry('clap-test', list)];
	if (opts.pending)
		sound.push(entry('clap-pending', list.map((f, i) => (i === 0 ? { ...f, path: 'pending.onnx', url: null } : f))));
	const catalog = join(dir, 'catalog.json');
	writeFileSync(catalog, JSON.stringify({ models: [], sound }));
	return catalog;
}
