// CLAP on ONNX Runtime (spec 12 P6-E14, WP-E9; ARCHITECTURE D-24): the audio and text towers of an installed model
// directory (`clap-audio.graph.onnx`, `clap-text.graph.onnx` with their weights in `pytorch_model.bin`, and the
// tokenizer's `vocab.json` + `merges.txt`). Each tower loads on first use. Runs only in the `jasper-clap` child process
// (worker/cli.ts), never in the engine (D-07).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { CLAP_EMBED_DIM, CLAP_FRAMES, CLAP_MELS, clapLogMel, normalize } from '../frontend.ts';
import { ClapTokenizer, PAD_ID } from '../tokenizer.ts';

type Ort = typeof import('onnxruntime-node');
type Session = import('onnxruntime-node').InferenceSession;

let ortModule: Ort | null = null;
function loadOrt(): Ort {
	if (!ortModule) ortModule = createRequire(import.meta.url)('onnxruntime-node') as Ort;
	return ortModule;
}

export const AUDIO_GRAPH = 'clap-audio.graph.onnx';
export const TEXT_GRAPH = 'clap-text.graph.onnx';
/** Windows embedded per audio run (memory: 256 KB of features each). */
export const AUDIO_BATCH = 4;
/** Texts embedded per text run. */
export const TEXT_BATCH = 16;

export class ClapModel {
	private audio: Promise<Session> | null = null;
	private text: Promise<Session> | null = null;
	private tokenizer: ClapTokenizer | null = null;

	constructor(
		readonly dir: string,
		private readonly threads = 2,
	) {}

	private options(): import('onnxruntime-node').InferenceSession.SessionOptions {
		return {
			executionProviders: ['cpu'],
			graphOptimizationLevel: 'all',
			intraOpNumThreads: Math.max(1, Math.min(16, Math.floor(this.threads))),
			interOpNumThreads: 1,
			logSeverityLevel: 3,
		};
	}

	private session(which: 'audio' | 'text'): Promise<Session> {
		const ort = loadOrt();
		if (which === 'audio')
			return (this.audio ??= ort.InferenceSession.create(join(this.dir, AUDIO_GRAPH), this.options()));
		return (this.text ??= ort.InferenceSession.create(join(this.dir, TEXT_GRAPH), this.options()));
	}

	private tok(): ClapTokenizer {
		this.tokenizer ??= new ClapTokenizer(
			readFileSync(join(this.dir, 'vocab.json'), 'utf8'),
			readFileSync(join(this.dir, 'merges.txt'), 'utf8'),
		);
		return this.tokenizer;
	}

	/** Unit-length text embeddings, one per text (padded batches; the attention mask hides the padding). */
	async embedTexts(texts: readonly string[]): Promise<Float32Array[]> {
		const ort = loadOrt();
		const s = await this.session('text');
		const tok = this.tok();
		const out: Float32Array[] = [];
		for (let i = 0; i < texts.length; i += TEXT_BATCH) {
			const batch = texts.slice(i, i + TEXT_BATCH).map((t) => tok.encode(t));
			const width = Math.max(...batch.map((b) => b.length));
			const ids = new BigInt64Array(batch.length * width).fill(BigInt(PAD_ID));
			const mask = new BigInt64Array(batch.length * width);
			batch.forEach((b, r) => {
				for (let k = 0; k < b.length; k++) {
					ids[r * width + k] = BigInt(b[k]!);
					mask[r * width + k] = 1n;
				}
			});
			const res = await s.run({
				input_ids: new ort.Tensor('int64', ids, [batch.length, width]),
				attention_mask: new ort.Tensor('int64', mask, [batch.length, width]),
			});
			out.push(...rows(res.text_embeds?.data, batch.length));
		}
		return out;
	}

	/** Unit-length audio embeddings of 48 kHz mono windows (each repeat-padded / cut to 10 s). */
	async embedAudio(windows: readonly Float32Array[]): Promise<Float32Array[]> {
		const ort = loadOrt();
		const s = await this.session('audio');
		const out: Float32Array[] = [];
		const per = CLAP_FRAMES * CLAP_MELS;
		for (let i = 0; i < windows.length; i += AUDIO_BATCH) {
			const batch = windows.slice(i, i + AUDIO_BATCH);
			const feats = new Float32Array(batch.length * per);
			batch.forEach((w, b) => {
				clapLogMel(w, feats.subarray(b * per, (b + 1) * per));
			});
			const res = await s.run({
				input_features: new ort.Tensor('float32', feats, [batch.length, 1, CLAP_FRAMES, CLAP_MELS]),
			});
			out.push(...rows(res.audio_embeds?.data, batch.length));
		}
		return out;
	}
}

function rows(data: unknown, n: number): Float32Array[] {
	if (!(data instanceof Float32Array) || data.length !== n * CLAP_EMBED_DIM)
		throw new Error(`the model returned ${data instanceof Float32Array ? data.length : 'no'} values, expected ${n} × ${CLAP_EMBED_DIM}`);
	const out: Float32Array[] = [];
	for (let r = 0; r < n; r++) {
		const v = data.slice(r * CLAP_EMBED_DIM, (r + 1) * CLAP_EMBED_DIM);
		for (let i = 0; i < v.length; i++) if (!Number.isFinite(v[i]!)) throw new Error('the model returned a non-finite value');
		out.push(normalize(v));
	}
	return out;
}
