// The blend kernel of the native export (keyframes-blend): one frame of a blend layer composited onto the composite
// below it, exactly as the preview's GL compositor does (`packages/compositions/src/fx/composite-plan.ts`): the
// formulas are `makeBlendKernel` of @jasper/project (`blend-modes.ts`; the same source text runs in the worker
// threads), the result is stored premultiplied on the 8-bit grid (`storePremul8`) and Dissolve hashes the sequence
// pixel with the layer's seed of the frame. Input: a `2W×H` straight-RGBA frame, the composite below ‖ the layer
// placed on transparency (ffmpeg `hstack`); output: the `W×H` straight-RGBA result.
// `blendStackedFrame` is self-contained (no imports, no closures over module scope): its source text runs inside the
// worker threads (pool.ts), so tests and production share one implementation.
import type { BlendKernel } from '@jasper/project';

export function blendStackedFrame(
	K: BlendKernel,
	src: Uint8Array,
	W: number,
	H: number,
	mode: number,
	seed: number,
	active: boolean,
	out: Uint8Array,
): void {
	const d = new Float64Array(4);
	const s = new Float64Array(4);
	const row = W * 8;
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			const i = y * row + x * 4;
			const j = i + W * 4;
			const o = (y * W + x) * 4;
			const ba = src[i + 3]!;
			const la = src[j + 3]!;
			// Inactive frame, or a transparent layer pixel (it leaves the composite as it is — except the stencils,
			// which keep the composite only where the layer is): copy.
			if (!active || (la === 0 && mode !== 27 && mode !== 28)) {
				out[o] = src[i]!;
				out[o + 1] = src[i + 1]!;
				out[o + 2] = src[i + 2]!;
				out[o + 3] = ba;
				continue;
			}
			const da = ba / 255;
			d[0] = (src[i]! / 255) * da;
			d[1] = (src[i + 1]! / 255) * da;
			d[2] = (src[i + 2]! / 255) * da;
			d[3] = da;
			const sa = la / 255;
			s[0] = (src[j]! / 255) * sa;
			s[1] = (src[j + 1]! / 255) * sa;
			s[2] = (src[j + 2]! / 255) * sa;
			s[3] = sa;
			K.blend(mode, d, s, mode === 1 ? K.noise(x, y, seed) : 0);
			// storePremul8 (alpha 0..1, colour 0..alpha, on the 8-bit grid), then straight 8-bit.
			const a = d[3]! < 0 ? 0 : d[3]! > 1 ? 1 : d[3]!;
			const A = Math.round(a * 255);
			if (A === 0) {
				out[o] = 0;
				out[o + 1] = 0;
				out[o + 2] = 0;
				out[o + 3] = 0;
				continue;
			}
			for (let k = 0; k < 3; k++) {
				const c = d[k]! < 0 ? 0 : d[k]! > a ? a : d[k]!;
				const c8 = Math.round(c * 255);
				out[o + k] = Math.min(255, Math.round((c8 * 255) / A));
			}
			out[o + 3] = A;
		}
	}
}
