// The picture speed of an fframes template, measured on its own rendered frames (sound design, spec 12 §2.2): the SVG
// twin is a pure function of params and frame and is what jasper-mg rasterises (D-12), so every animated number in
// it is the motion the viewer sees. Per content frame the speed is the keyframed-clip sampler's
// (`@jasper/project` cues/motion.ts): screen travel in canvas diagonals per second, plus K_SCALE·|Δ ln scale| and
// K_ROT·|Δ degrees|, plus opacity changes weighted by K_OPACITY — the largest over every animated element. Sound
// design cuts it into movements and finds where the intro settles and the outro starts.
import { K_ROT, K_SCALE, MAX_SAMPLES_PER_CLIP, type MgTemplateMotionTiming } from '@jasper/project';
import { CANVASES } from './core.ts';
import type { AnySvgMgTemplate } from './types.ts';

/**
 * An opacity change of 1 per second counts as a quarter of a diagonal per second: a fade still moves while it changes
 * by more than ≈ 0.12/s (the sampler's MOVE_OFF 0.03 ÷ 0.25), about one 8-bit code value per frame at 30 fps.
 */
export const K_OPACITY = 0.25;
/** Most frames measured per clip (as the keyframed-clip sampler): longer clips fall back to the declared timing. */
export const MAX_MOTION_FRAMES = MAX_SAMPLES_PER_CLIP;

type Feature = { kind: 'px' | 'scale' | 'rot' | 'opacity'; value: number };

const NUM = /-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi;
const ATTR = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)="([^"]*)"/g;
const TRANSFORM_FN = /(translate|scale|rotate|matrix|skewX|skewY)\s*\(([^)]*)\)/g;
/** Attributes that are not geometry (names, colours, fonts, references). */
const SKIP = new Set([
	'id',
	'class',
	'fill',
	'stroke',
	'font-family',
	'font-weight',
	'font-style',
	'text-anchor',
	'dominant-baseline',
	'clip-path',
	'mask',
	'filter',
	'href',
	'xlink:href',
	'xmlns',
	'xmlns:xlink',
	'version',
	'preserveAspectRatio',
	'viewBox',
]);
const OPACITY = new Set(['opacity', 'fill-opacity', 'stroke-opacity', 'stop-opacity']);

/** Every animatable number of one rendered frame, in document order (text content is not geometry). */
export function svgFeatures(svg: string): Feature[] {
	const out: Feature[] = [];
	for (const m of svg.matchAll(ATTR)) {
		const name = m[1]!;
		const value = m[2]!;
		if (SKIP.has(name)) continue;
		if (OPACITY.has(name)) {
			const v = Number.parseFloat(value);
			if (Number.isFinite(v)) out.push({ kind: 'opacity', value: v });
			continue;
		}
		if (name === 'transform' || name === 'gradientTransform' || name === 'patternTransform') {
			for (const f of value.matchAll(TRANSFORM_FN)) {
				// angles (rotate, skew) in degrees; matrix coefficients are counted as pixels (no template uses matrix)
				const kind =
					f[1] === 'scale' ? 'scale' : f[1] === 'rotate' || f[1]!.startsWith('skew') ? 'rot' : 'px';
				const nums = f[2]!.match(NUM) ?? [];
				// rotate(a cx cy): the centre is geometry
				nums.forEach((s, i) => {
					const v = Number.parseFloat(s);
					if (!Number.isFinite(v)) return;
					out.push({ kind: kind === 'rot' && i > 0 ? 'px' : kind, value: v });
				});
			}
			continue;
		}
		for (const s of value.match(NUM) ?? []) {
			const v = Number.parseFloat(s);
			if (Number.isFinite(v)) out.push({ kind: 'px', value: v });
		}
	}
	return out;
}

/**
 * Picture speed of a clip of `def` over its content frames `0 … totalFrames − 1` at `fps` (`speed[i]`: from frame
 * i − 1 to i; `speed[0]` = 0). Null when it cannot be measured (too long, a render that throws, or frames whose
 * structure differs so their numbers cannot be paired).
 */
export function svgTemplateSpeed(
	def: AnySvgMgTemplate,
	params: Record<string, unknown>,
	timing: MgTemplateMotionTiming,
): number[] | null {
	const fps = timing.fps;
	const total = Math.round(timing.totalFrames);
	if (!(fps > 0) || !Number.isFinite(fps) || !(total >= 1) || total > MAX_MOTION_FRAMES) return null;
	const parsed = def.paramsSchema.safeParse(params ?? {});
	if (!parsed.success) return null;
	const canvas = CANVASES[0]!;
	const diag = Math.hypot(canvas.width, canvas.height);
	const speed = new Array<number>(total).fill(0);
	let prev: Feature[] | null = null;
	let prevSvg = '';
	for (let f = 0; f < total; f++) {
		let svg: string;
		try {
			svg = def.renderSvg(parsed.data, f, fps, canvas, {
				durationFrames: total,
				sourceInFrames: 0,
				idPrefix: 'sd',
			});
		} catch {
			return null;
		}
		if (typeof svg !== 'string') return null;
		// A held picture renders the same markup: nothing moved (speed[f] stays 0) and nothing to parse.
		if (prev && svg === prevSvg) continue;
		const cur = svgFeatures(svg);
		if (prev) {
			if (prev.length !== cur.length) return null;
			let px = 0;
			let other = 0;
			for (let i = 0; i < cur.length; i++) {
				const a = prev[i]!;
				const b = cur[i]!;
				if (a.kind !== b.kind) return null;
				const d = Math.abs(b.value - a.value);
				if (d === 0) continue;
				if (a.kind === 'px') px = Math.max(px, d);
				else if (a.kind === 'opacity') other = Math.max(other, K_OPACITY * d);
				else if (a.kind === 'rot') other = Math.max(other, K_ROT * d);
				else if (a.value > 0 && b.value > 0)
					other = Math.max(other, K_SCALE * Math.abs(Math.log(b.value / a.value)));
				else other = Math.max(other, K_SCALE * 5);
			}
			speed[f] = Math.max(px / diag, other) * fps;
		}
		prev = cur;
		prevSvg = svg;
	}
	return speed;
}
