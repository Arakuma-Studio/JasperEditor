// A fake onnxruntime-node binding for the speech worker (spec 16 SG-040): sessions of a tiny "Whisper" whose
// encoder returns zeros and whose decoder prefers timestamps and end-of-text, so recognition finishes quickly
// with no words. Tests make providers fail at session creation or mid-run, time decoders, and inspect which
// session ran what.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const FAKE_CFG = {
	num_mel_bins: 80,
	d_model: 8,
	decoder_layers: 2,
	decoder_attention_heads: 2,
	max_target_positions: 448,
	vocab_size: 1533,
};
/** Text tokens 0–25 ('a'–'z'), specials 26–31, timestamps 32… (1501 of them). */
export const EOT = 26;
export const TS_BEGIN = 32;
export const VOCAB = TS_BEGIN + 1501;

/** Token id of the space in an `encodable` fake model (replaces 'z'). */
export const SPACE = 25;

/**
 * A model directory the worker can load with the fake binding. `encodable` (spec 17 scoring and glossary tests):
 * the tokenizer has a BPE merge (so it can encode) and token 25 is the space ('Ġ') instead of 'z', so
 * `encode(' ab')` = [25, 0, 1] and decoded text splits into words.
 */
export function fakeModelDir(opts: { encodable?: boolean } = {}): string {
	const dir = mkdtempSync(join(tmpdir(), 'jasper-fake-whisper-'));
	const vocab: Record<string, number> = {};
	for (let i = 0; i < 26; i++) vocab[String.fromCharCode(97 + i)] = i;
	if (opts.encodable) {
		delete vocab.z;
		vocab['\u0120'] = SPACE;
	}
	const added = [
		['<|endoftext|>', 26],
		['<|startoftranscript|>', 27],
		['<|transcribe|>', 28],
		['<|startofprev|>', 29],
		['<|nospeech|>', 30],
		['<|notimestamps|>', 31],
	] as Array<[string, number]>;
	for (let i = 0; i <= 1500; i++) added.push([`<|${(i * 0.02).toFixed(2)}|>`, TS_BEGIN + i]);
	writeFileSync(join(dir, 'config.json'), JSON.stringify(FAKE_CFG));
	writeFileSync(join(dir, 'generation_config.json'), JSON.stringify({ alignment_heads: [[1, 0]] }));
	writeFileSync(
		join(dir, 'tokenizer.json'),
		JSON.stringify({
			model: { vocab, merges: opts.encodable ? ['x y'] : [] },
			added_tokens: added.map(([content, id]) => ({ id, content })),
		}),
	);
	writeFileSync(join(dir, 'encoder_model.onnx'), 'fake');
	writeFileSync(join(dir, 'decoder_model_merged.onnx'), 'fake');
	return dir;
}

export class FakeTensor {
	location: 'cpu' | 'gpu-buffer' = 'cpu';
	disposed = false;
	constructor(
		readonly type: string,
		readonly data: ArrayLike<unknown> & { length: number },
		readonly dims: number[],
	) {}
	dispose(): void {
		this.disposed = true;
	}
}

export type SessionRecord = {
	path: string;
	provider: string;
	location: Record<string, string> | undefined;
	runs: Array<{ cached: boolean; fetches: string[] | undefined }>;
	released: boolean;
};

export type FakeOrtOptions = {
	/** Make session creation fail: return an error message. */
	createError?(part: 'encoder' | 'decoder', provider: string): string | null;
	/** Make a run fail: return an error message. */
	runError?(part: 'encoder' | 'decoder', provider: string, run: number): string | null;
	/** Delay per decoder run (ms) by provider (calibration tests). */
	decoderDelayMs?(provider: string): number;
	/** Delay per encoder run (ms; cancellation tests). */
	encoderDelayMs?(): number;
	/**
	 * Decoder logits of one position (spec 17 tests): `history` = the row's tokens up to and including this position
	 * (cached steps included); `row` holds the default logits and may be changed.
	 */
	logits?(history: readonly number[], row: Float32Array): void;
	/** Cross-attention of one position over the 1500 frames (default uniform); `history` as for `logits`. */
	cross?(history: readonly number[], row: Float32Array, layer: number, head: number): void;
};

/** The fake binding: `InferenceSession.create` + `Tensor`, recording every session. */
export function fakeOrt(opts: FakeOrtOptions = {}) {
	const sessions: SessionRecord[] = [];
	const disposed: FakeTensor[] = [];
	/** Token history per batch row, keyed by the decoder cache tensor that carries it to the next step. */
	const histories = new WeakMap<object, number[][]>();
	const H = FAKE_CFG.decoder_attention_heads;
	const DH = FAKE_CFG.d_model / H;
	const L = FAKE_CFG.decoder_layers;
	const tensor = (
		type: string,
		data: ArrayLike<unknown> & { length: number },
		dims: number[],
		gpu = false,
	) => {
		const t = new FakeTensor(type, data, dims);
		if (gpu) {
			t.location = 'gpu-buffer';
			const d = t.dispose.bind(t);
			t.dispose = () => {
				d();
				disposed.push(t);
			};
		}
		return t;
	};
	const ort = {
		Tensor: FakeTensor,
		InferenceSession: {
			async create(path: string, so: Record<string, unknown>) {
				const eps = (so.executionProviders as unknown[]) ?? ['cpu'];
				const first = eps[0];
				const provider = typeof first === 'string' ? first : (first as { name: string }).name;
				const part = path.includes('encoder') ? 'encoder' : 'decoder';
				const err = opts.createError?.(part, provider);
				if (err) throw new Error(err);
				const rec: SessionRecord = {
					path,
					provider,
					location: so.preferredOutputLocation as Record<string, string> | undefined,
					runs: [],
					released: false,
				};
				sessions.push(rec);
				const outputNames =
					part === 'encoder'
						? ['last_hidden_state']
						: [
								'logits',
								...Array.from({ length: L }, (_, l) =>
									['decoder', 'encoder'].flatMap((k) =>
										['key', 'value'].map((v) => `present.${l}.${k}.${v}`),
									),
								).flat(),
								...Array.from({ length: L }, (_, l) => `cross_attentions.${l}`),
							];
				const gpuOut = (n: string) => rec.location?.[n] === 'gpu-buffer';
				return {
					outputNames,
					inputMetadata: [],
					async release() {
						rec.released = true;
					},
					async run(feeds: Record<string, FakeTensor>, fetches?: string[]) {
						const flag = feeds.use_cache_branch?.data as ArrayLike<unknown> | undefined;
						const cached = !!flag && Number(flag[0]) === 1;
						rec.runs.push({ cached, fetches });
						const rerr = opts.runError?.(part, provider, rec.runs.length);
						if (rerr) throw new Error(rerr);
						if (part === 'encoder') {
							const ed = opts.encoderDelayMs?.() ?? 0;
							if (ed) await new Promise((r) => setTimeout(r, ed));
							return {
								last_hidden_state: tensor('float32', new Float32Array(1500 * FAKE_CFG.d_model), [
									1,
									1500,
									FAKE_CFG.d_model,
								]),
							};
						}
						const delay = opts.decoderDelayMs?.(provider) ?? 0;
						if (delay) await new Promise((r) => setTimeout(r, delay));
						const ids = feeds.input_ids as FakeTensor;
						const [B, T] = ids.dims as [number, number];
						const past = feeds['past_key_values.0.decoder.key'] as FakeTensor;
						const P = past ? (past.dims[2] ?? 0) : 0;
						const idData = ids.data as BigInt64Array;
						const before = (past && histories.get(past)) || [];
						const hist: number[][] = [];
						for (let b = 0; b < B; b++) {
							const h = cached ? [...(before[b] ?? [])] : [];
							for (let t = 0; t < T; t++) h.push(Number(idData[b * T + t]));
							hist.push(h);
						}
						const logits = new Float32Array(B * T * VOCAB).fill(-5);
						for (let b = 0; b < B; b++)
							for (let t = 0; t < T; t++) {
								const row = (b * T + t) * VOCAB;
								// <|0.00|> first, then end-of-text: an empty window in two steps
								logits[row + EOT] = 2;
								logits[row + TS_BEGIN] = 5;
								if (opts.logits) {
									const h = hist[b]!;
									opts.logits(h.slice(0, h.length - T + t + 1), logits.subarray(row, row + VOCAB));
								}
							}
						const out: Record<string, FakeTensor> = { logits: tensor('float32', logits, [B, T, VOCAB]) };
						for (let l = 0; l < L; l++)
							for (const kv of ['key', 'value']) {
								out[`present.${l}.decoder.${kv}`] = tensor(
									'float32',
									new Float32Array(B * H * (P + T) * DH),
									[B, H, P + T, DH],
									gpuOut(`present.${l}.decoder.${kv}`),
								);
								out[`present.${l}.encoder.${kv}`] = cached
									? (feeds[`past_key_values.${l}.encoder.${kv}`] as FakeTensor)
									: tensor(
											'float32',
											new Float32Array(B * H * 1500 * DH),
											[B, H, 1500, DH],
											gpuOut(`present.${l}.encoder.${kv}`),
										);
								const ca = new Float32Array(B * H * T * 1500).fill(1 / 1500);
								if (opts.cross)
									for (let b = 0; b < B; b++)
										for (let h = 0; h < H; h++)
											for (let t = 0; t < T; t++) {
												const hb = hist[b]!;
												const o = ((b * H + h) * T + t) * 1500;
												opts.cross(hb.slice(0, hb.length - T + t + 1), ca.subarray(o, o + 1500), l, h);
											}
								out[`cross_attentions.${l}`] = tensor('float32', ca, [B, H, T, 1500]);
							}
						histories.set(out['present.0.decoder.key'] as FakeTensor, hist);
						if (!fetches) return out;
						const sel: Record<string, FakeTensor> = {};
						for (const f of fetches) sel[f] = out[f] as FakeTensor;
						return sel;
					},
				};
			},
		},
	};
	return {
		ort: ort as unknown as Pick<typeof import('onnxruntime-node'), 'InferenceSession' | 'Tensor'>,
		sessions,
		disposed,
	};
}

/** Noise bursts (voiced by the energy VAD) between quiet stretches: 16 kHz mono. */
export function noiseAudio(
	seconds: number,
	voiced: (t: number) => boolean = () => true,
	seed = 1,
): Float32Array {
	const n = Math.round(seconds * 16_000);
	const out = new Float32Array(n);
	let s = seed >>> 0;
	for (let i = 0; i < n; i++) {
		s = (s * 1664525 + 1013904223) >>> 0;
		const r = s / 4294967296 - 0.5;
		out[i] = voiced(i / 16_000) ? r * 0.5 : r * 0.0005;
	}
	return out;
}
