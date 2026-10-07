// The blend-composite kernel of the native export (keyframes-blend): composites the layer stack below the top blend
// layer frame by frame — every part a sequence-sized straight-RGBA frame (a run of Normal layers composited by
// ffmpeg, or one blend-mode layer placed by ffmpeg) — onto transparency with each part's mode, exactly as the GL
// compositor of the preview does (`packages/compositions/src/fx/composite-plan.ts`): the formulas are
// `makeBlendKernel` of @jasper/project (`blend-modes.ts`, the same source text runs in the worker threads), the stack
// is stored premultiplied on the 8-bit grid between parts (`storePremul8`) and Dissolve hashes the sequence pixel.
// `compositeBlendFrame` is self-contained (no imports, no closures over module scope): its source text runs inside the
// worker threads (pool.ts), so tests and production share one implementation.
import type { BlendKernel } from '@jasper/project';

/**
 * Composites `parts` (straight RGBA, `W×H`, bottom → top) with `modes` (BLEND_MODES indexes) and Dissolve `seeds`
 * into `out` (straight RGBA): what lies below the top blend layer, over transparency.
 */
export function compositeBlendFrame(
	K: BlendKernel,
	parts: readonly Uint8Array[],
	modes: ArrayLike<number>,
	seeds: ArrayLike<number>,
	W: number,
	H: number,
	out: Uint8Array,
): void {
	const d = new Float64Array(4);
	const s = new Float64Array(4);
	const n = parts.length;
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			const i = (y * W + x) * 4;
			d[0] = 0;
			d[1] = 0;
			d[2] = 0;
			d[3] = 0;
			for (let p = 0; p < n; p++) {
				const src = parts[p]!;
				const a8 = src[i + 3]!;
				const m = modes[p]!;
				if (a8 === 0) {
					// A transparent source leaves the stack as it is, except the stencils, which clear it.
					if (m === 27 || m === 28) {
						d[0] = 0;
						d[1] = 0;
						d[2] = 0;
						d[3] = 0;
					}
					continue;
				}
				const sa = a8 / 255;
				s[0] = (src[i]! / 255) * sa;
				s[1] = (src[i + 1]! / 255) * sa;
				s[2] = (src[i + 2]! / 255) * sa;
				s[3] = sa;
				K.blend(m, d, s, m === 1 ? K.noise(x, y, seeds[p]!) : 0);
				// storePremul8: alpha 0..1, colour 0..alpha, each on the 8-bit grid.
				const a = d[3]! < 0 ? 0 : d[3]! > 1 ? 1 : d[3]!;
				for (let k = 0; k < 3; k++) {
					const c = d[k]! < 0 ? 0 : d[k]! > a ? a : d[k]!;
					d[k] = Math.round(c * 255) / 255;
				}
				d[3] = Math.round(a * 255) / 255;
			}
			const A = d[3]!;
			if (A <= 0) {
				out[i] = 0;
				out[i + 1] = 0;
				out[i + 2] = 0;
				out[i + 3] = 0;
				continue;
			}
			const inv = 255 / A;
			out[i] = Math.min(255, Math.round(d[0]! * inv));
			out[i + 1] = Math.min(255, Math.round(d[1]! * inv));
			out[i + 2] = Math.min(255, Math.round(d[2]! * inv));
			out[i + 3] = Math.round(A * 255);
		}
	}
}
