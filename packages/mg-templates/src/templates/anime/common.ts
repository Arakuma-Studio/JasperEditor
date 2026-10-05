// Shared metadata helpers of the anime templates (S11 §5, ATP-001/003/004). Pure data: the React
// implementations live in `@jasper/motion/templates` (this package never imports animejs).
import { z } from 'zod';
import type { Rgba } from '../../core.ts';

/**
 * Frame rate the `introFrames` / `outroFrames` of anime templates are written at. The layer converts them to
 * whole frames of the sequence rate (`animeFramesAt`), so intro and outro keep their length in seconds and stay
 * frame-exact at any rate (S11:ATP-004).
 */
export const ANIME_REFERENCE_FPS = 30;

/**
 * Eases a template param may name (supported by `@jasper/motion` `EASES`).
 * `steps` is left out: it needs a step count.
 */
export const ANIME_TEMPLATE_EASES = [
	'linear',
	'out',
	'inOut',
	'outBack',
	'outExpo',
	'inOutExpo',
	'outElastic',
	'outBounce',
] as const;
export type AnimeTemplateEase = (typeof ANIME_TEMPLATE_EASES)[number];

const channel = z.number().min(0).max(1);
/** Straight sRGB RGBA 0..1 (the template param convention; keyframable on anime templates). */
export const rgbaParam = (d: Rgba) =>
	z
		.array(channel)
		.length(4)
		.default(d as number[]);

export const easeParam = (d: AnimeTemplateEase) => z.enum(ANIME_TEMPLATE_EASES).default(d);

/** `rgba(r, g, b, a)` CSS for a straight RGBA 0..1 tuple (channels rounded to 8 bits, alpha to 4 decimals). */
export function rgbaCss(c: readonly number[]): string {
	const ch = (x: number | undefined) => Math.round(Math.min(1, Math.max(0, x ?? 0)) * 255);
	const a = Math.round(Math.min(1, Math.max(0, c[3] ?? 1)) * 10_000) / 10_000;
	return `rgba(${ch(c[0])}, ${ch(c[1])}, ${ch(c[2])}, ${a})`;
}
