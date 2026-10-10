// Separable resampling of float RGB frames (interleaved, 3 channels) for the upscale step (S07:PST-033):
// bicubic (Catmull-Rom-like, a = -0.5) and Lanczos-3, antialiased when downscaling (kernel support scaled by
// the reduction factor, like ffmpeg's swscale / PIL). Pure and deterministic.

type Kernel = 'bicubic' | 'lanczos';

function bicubic(x: number): number {
	const a = -0.5;
	const t = Math.abs(x);
	if (t < 1) return (a + 2) * t * t * t - (a + 3) * t * t + 1;
	if (t < 2) return a * t * t * t - 5 * a * t * t + 8 * a * t - 4 * a;
	return 0;
}

function sinc(x: number): number {
	if (x === 0) return 1;
	const p = Math.PI * x;
	return Math.sin(p) / p;
}

function lanczos3(x: number): number {
	const t = Math.abs(x);
	return t < 3 ? sinc(t) * sinc(t / 3) : 0;
}

type Taps = { start: Int32Array; count: number; weights: Float32Array };

/** Precomputed contributions for resizing a line of `src` samples to `dst` samples. */
function taps(src: number, dst: number, kernel: Kernel): Taps {
	const fn = kernel === 'bicubic' ? bicubic : lanczos3;
	const support = kernel === 'bicubic' ? 2 : 3;
	const scale = dst / src;
	const stretch = scale < 1 ? 1 / scale : 1;
	const radius = support * stretch;
	const count = Math.ceil(radius) * 2 + 1;
	const start = new Int32Array(dst);
	const weights = new Float32Array(dst * count);
	for (let i = 0; i < dst; i++) {
		const center = (i + 0.5) / scale - 0.5;
		const first = Math.floor(center - radius) + 1;
		start[i] = first;
		let sum = 0;
		for (let k = 0; k < count; k++) {
			const w = fn((first + k - center) / stretch);
			weights[i * count + k] = w;
			sum += w;
		}
		if (sum !== 0) for (let k = 0; k < count; k++) weights[i * count + k] /= sum;
	}
	return { start, count, weights };
}

/** Resizes an interleaved RGB float image (`sw`×`sh`) to `dw`×`dh`. Edges replicate. */
export function resampleRgb(
	src: Float32Array,
	sw: number,
	sh: number,
	dw: number,
	dh: number,
	kernel: Kernel,
): Float32Array {
	if (sw === dw && sh === dh) return src.slice();
	// Horizontal pass: sh rows × dw.
	const tx = taps(sw, dw, kernel);
	const mid = new Float32Array(dw * sh * 3);
	for (let y = 0; y < sh; y++) {
		const row = y * sw * 3;
		const out = y * dw * 3;
		for (let x = 0; x < dw; x++) {
			let r = 0;
			let g = 0;
			let b = 0;
			const s0 = tx.start[x];
			const wo = x * tx.count;
			for (let k = 0; k < tx.count; k++) {
				const w = tx.weights[wo + k];
				if (w === 0) continue;
				let sx = s0 + k;
				sx = sx < 0 ? 0 : sx >= sw ? sw - 1 : sx;
				const p = row + sx * 3;
				r += src[p] * w;
				g += src[p + 1] * w;
				b += src[p + 2] * w;
			}
			const o = out + x * 3;
			mid[o] = r;
			mid[o + 1] = g;
			mid[o + 2] = b;
		}
	}
	// Vertical pass.
	const ty = taps(sh, dh, kernel);
	const dst = new Float32Array(dw * dh * 3);
	const rowLen = dw * 3;
	for (let y = 0; y < dh; y++) {
		const s0 = ty.start[y];
		const wo = y * ty.count;
		const out = y * rowLen;
		for (let k = 0; k < ty.count; k++) {
			const w = ty.weights[wo + k];
			if (w === 0) continue;
			let sy = s0 + k;
			sy = sy < 0 ? 0 : sy >= sh ? sh - 1 : sy;
			const row = sy * rowLen;
			for (let i = 0; i < rowLen; i++) dst[out + i] += mid[row + i] * w;
		}
	}
	return dst;
}
