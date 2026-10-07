// Segment Anything 2.1 (hiera-tiny) through ONNX Runtime, as the Roto Brush's trained mask model. The image encoder
// runs once per frame (1024 × 1024, ImageNet normalisation, the frame stretched to the square as the SAM 2 processor
// does); its three embeddings are kept for the last few frames so repeated prompts on one frame (stroke after stroke)
// cost only the prompt decoder (~0.1 s). Prompts: positive / negative points and a box, in 1024-space; outputs: three
// candidate masks (256² logits) with predicted IoUs and an object-presence logit. The best-scoring mask is upsampled
// bilinearly to the frame and passed through a sigmoid. An absent object (presence logit < 0) yields an empty mask.
//
// Weights: SAM 2.1 hiera-tiny by Meta Platforms (Apache-2.0), ONNX conversion `onnx-community/sam2.1-hiera-tiny-ONNX`
// (pinned revision, processing/models.json).
import { createRequire } from 'node:module';
import { resample } from '../core/image.ts';
import type { MaskModel, ModelPrompt } from '../core/segment.ts';

type Ort = typeof import('onnxruntime-node');
type Session = import('onnxruntime-node').InferenceSession;
type Tensor = import('onnxruntime-node').Tensor;

let ortModule: Ort | null = null;
export function loadOrt(): Ort {
	if (!ortModule) ortModule = createRequire(import.meta.url)('onnxruntime-node') as Ort;
	return ortModule;
}

const SIZE = 1024;
const MASK = 256;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
const KEEP_EMBEDDINGS = 6;

type Embedding = { e0: Tensor; e1: Tensor; e2: Tensor };

export class SamModel implements MaskModel {
	readonly id: string;
	private readonly cache = new Map<string, Embedding>();

	private constructor(
		id: string,
		private readonly ort: Ort,
		private readonly encoder: Session,
		private readonly decoder: Session,
	) {
		this.id = id;
	}

	static async load(
		id: string,
		files: { encoder: string; decoder: string },
		threads: number,
	): Promise<SamModel> {
		const ort = loadOrt();
		const opts = {
			intraOpNumThreads: Math.max(1, threads),
			interOpNumThreads: 1,
			graphOptimizationLevel: 'all' as const,
			logSeverityLevel: 3 as const,
		};
		const encoder = await ort.InferenceSession.create(files.encoder, opts);
		const decoder = await ort.InferenceSession.create(files.decoder, opts);
		return new SamModel(id, ort, encoder, decoder);
	}

	async release(): Promise<void> {
		this.cache.clear();
		await this.encoder.release();
		await this.decoder.release();
	}

	/** The image embeddings of a frame (cached by `key` when given). */
	async embed(rgb: Float32Array, w: number, h: number, key?: string): Promise<Embedding> {
		const hit = key ? this.cache.get(key) : undefined;
		if (hit) {
			this.cache.delete(key!);
			this.cache.set(key!, hit);
			return hit;
		}
		const sq = resample(rgb, w, h, 3, SIZE, SIZE);
		const px = new Float32Array(3 * SIZE * SIZE);
		const plane = SIZE * SIZE;
		for (let i = 0; i < plane; i++)
			for (let c = 0; c < 3; c++) px[c * plane + i] = (sq[i * 3 + c]! - MEAN[c]!) / STD[c]!;
		const out = await this.encoder.run({
			pixel_values: new this.ort.Tensor('float32', px, [1, 3, SIZE, SIZE]),
		});
		const e: Embedding = {
			e0: out['image_embeddings.0']!,
			e1: out['image_embeddings.1']!,
			e2: out['image_embeddings.2']!,
		};
		if (key) {
			this.cache.set(key, e);
			while (this.cache.size > KEEP_EMBEDDINGS) this.cache.delete(this.cache.keys().next().value!);
		}
		return e;
	}

	async segment(
		rgb: Float32Array,
		w: number,
		h: number,
		prompt: ModelPrompt & { imageKey?: string },
	): Promise<Float32Array | null> {
		const pts = prompt.points.slice(0, 64);
		if (pts.length === 0 && !prompt.box) return null;
		const emb = await this.embed(rgb, w, h, prompt.imageKey);
		const sx = SIZE / w;
		const sy = SIZE / h;
		// SAM 2 pads point lists with label −1 at (−10, −10) (`point_pad_value`); with no points one pad point.
		const coords = new Float32Array(Math.max(1, pts.length) * 2).fill(-10);
		const labels = new BigInt64Array(Math.max(1, pts.length)).fill(-1n);
		pts.forEach((p, i) => {
			coords[i * 2] = p.x * sx;
			coords[i * 2 + 1] = p.y * sy;
			labels[i] = p.fg ? 1n : 0n;
		});
		const boxes = prompt.box
			? new Float32Array([prompt.box[0] * sx, prompt.box[1] * sy, prompt.box[2] * sx, prompt.box[3] * sy])
			: new Float32Array(0);
		const out = await this.decoder.run({
			input_points: new this.ort.Tensor('float32', coords, [1, 1, labels.length, 2]),
			input_labels: new this.ort.Tensor('int64', labels, [1, 1, labels.length]),
			input_boxes: new this.ort.Tensor('float32', boxes, [1, prompt.box ? 1 : 0, 4]),
			'image_embeddings.0': emb.e0,
			'image_embeddings.1': emb.e1,
			'image_embeddings.2': emb.e2,
		});
		const presence = (out.object_score_logits!.data as Float32Array)[0]!;
		const scores = out.iou_scores!.data as Float32Array;
		const masks = out.pred_masks!.data as Float32Array;
		const dims = out.pred_masks!.dims;
		const mh = Number(dims[3] ?? MASK);
		const mw = Number(dims[4] ?? MASK);
		const n = Math.min(3, scores.length);
		let best = 0;
		for (let k = 1; k < n; k++) if (scores[k]! > scores[best]!) best = k;
		if (presence < 0) return new Float32Array(w * h);
		const logits = masks.subarray(best * mw * mh, (best + 1) * mw * mh);
		const up = resample(Float32Array.from(logits), mw, mh, 1, w, h);
		for (let i = 0; i < up.length; i++) up[i] = 1 / (1 + Math.exp(-up[i]!));
		return up;
	}
}
