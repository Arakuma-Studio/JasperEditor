// TypeScript mirror of the `jasper-mg-core` crate (native/mg/crates/jasper-mg-core). Every function
// here has a Rust twin with the same name (snake_case there) and the same arithmetic, so the SVG the
// Player shows and the SVG fframes rasterizes for export agree (ARCHITECTURE D-12, §10.2).
// Change both sides together and keep `pnpm --filter @jasper/mg-templates test` + MG_PARITY green.
import type { MgCanvas } from './types.ts';

/** Font stack of every template; the native binary embeds Inter (OFL). */
export const FONT_FAMILY = "Inter, 'Inter 24pt', 'Source Sans 3', sans-serif";

/** Straight sRGB RGBA, channels 0..1 (S01 `RGBA`). */
export type Rgba = [number, number, number, number];

// ------------------------------------------------------------------ anim.rs

export function clamp01(x: number): number {
	if (Number.isNaN(x)) return 0;
	return Math.min(1, Math.max(0, x));
}

/** Linear progress of `t` through `[start, start + duration]`, clamped to 0..1. */
export function progress(t: number, start: number, duration: number): number {
	if (duration <= 0) return t >= start ? 1 : 0;
	return clamp01((t - start) / duration);
}

export function easeOutCubic(p: number): number {
	const q = 1 - clamp01(p);
	return 1 - q * q * q;
}

export function easeInCubic(p: number): number {
	const c = clamp01(p);
	return c * c * c;
}

export function easeInOutCubic(p: number): number {
	const c = clamp01(p);
	if (c < 0.5) return 4 * c * c * c;
	const q = -2 * c + 2;
	return 1 - (q * q * q) / 2;
}

/** Damped spring released at t = 0 from 0 towards 1 with zero velocity (closed form). */
export function spring(t: number, stiffness: number, damping: number, mass: number): number {
	if (t <= 0) return 0;
	const w0 = Math.sqrt(stiffness / mass);
	const zeta = damping / (2 * Math.sqrt(stiffness * mass));
	if (Math.abs(zeta - 1) < 1e-9) return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
	if (zeta < 1) {
		const wd = w0 * Math.sqrt(1 - zeta * zeta);
		const decay = Math.exp(-zeta * w0 * t);
		return 1 - decay * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
	}
	const s = w0 * Math.sqrt(zeta * zeta - 1);
	const r1 = -zeta * w0 + s;
	const r2 = -zeta * w0 - s;
	return 1 - (r2 * Math.exp(r1 * t) - r1 * Math.exp(r2 * t)) / (r2 - r1);
}

// ------------------------------------------------------------------ canvas.rs

/** Design canvases of every template (16:9, 9:16, 1:1). */
export const CANVASES: readonly MgCanvas[] = [
	{ width: 1920, height: 1080 },
	{ width: 1080, height: 1920 },
	{ width: 1080, height: 1080 },
];

export type Fit = {
	outW: number;
	outH: number;
	designW: number;
	designH: number;
	scale: number;
	offsetX: number;
	offsetY: number;
};

/** Closest-aspect design canvas + uniform "contain" transform into the output size. */
export function fitCanvas(outW: number, outH: number): Fit {
	const ar = Math.log(outW / outH);
	let best = CANVASES[0]!;
	let bestD = Number.POSITIVE_INFINITY;
	for (const c of CANVASES) {
		const d = Math.abs(ar - Math.log(c.width / c.height));
		if (d < bestD - 1e-12) {
			best = c;
			bestD = d;
		}
	}
	const scale = Math.min(outW / best.width, outH / best.height);
	return {
		outW,
		outH,
		designW: best.width,
		designH: best.height,
		scale,
		offsetX: (outW - best.width * scale) / 2,
		offsetY: (outH - best.height * scale) / 2,
	};
}

// ------------------------------------------------------------------ spec.rs (FrameTime)

export type FrameTime = { fps: number; t: number; total: number };

/**
 * Timing of clip-local `frame`: content frame `sourceIn + frame` at `fps`, content length
 * `sourceIn + durationFrames`. Intros are anchored at t = 0, outros at `total` (S01:KND-009).
 */
export function frameTime(frame: number, fps: number, durationFrames: number, sourceInFrames = 0): FrameTime {
	return { fps, t: (sourceInFrames + frame) / fps, total: (sourceInFrames + durationFrames) / fps };
}

export function framesToSeconds(ft: FrameTime, frames: number): number {
	return frames / ft.fps;
}

// ------------------------------------------------------------------ svg.rs

/** At most 3 decimals, no trailing zeros, `0` for ±0 and non-finite values. */
export function num(x: number): string {
	if (!Number.isFinite(x)) return '0';
	const r = Math.floor(x * 1000 + 0.5) / 1000;
	if (r === 0) return '0';
	return r.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function channel(c: number): string {
	return Math.floor(clamp01(c) * 255 + 0.5)
		.toString(16)
		.padStart(2, '0');
}

export function hex(c: Rgba): string {
	return `#${channel(c[0])}${channel(c[1])}${channel(c[2])}`;
}

export function alpha(c: Rgba): string {
	return num(clamp01(c[3]));
}

/** `fill="#rrggbb" fill-opacity="a"`. */
export function fill(c: Rgba): string {
	return `fill="${hex(c)}" fill-opacity="${alpha(c)}"`;
}

export function escapeXml(s: string): string {
	let out = '';
	for (const ch of s) {
		const code = ch.codePointAt(0)!;
		if (ch === '&') out += '&amp;';
		else if (ch === '<') out += '&lt;';
		else if (ch === '>') out += '&gt;';
		else if (ch === '"') out += '&quot;';
		else if (ch === "'") out += '&#39;';
		else if (code < 0x20 && ch !== '\t' && ch !== '\n' && ch !== '\r') continue;
		else out += ch;
	}
	return out;
}

export function svgOpen(fit: Fit): string {
	const w = num(fit.outW);
	const h = num(fit.outH);
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`;
}

export function fitGroupOpen(fit: Fit): string {
	return `<g transform="translate(${num(fit.offsetX)} ${num(fit.offsetY)}) scale(${num(fit.scale)})">`;
}

// ------------------------------------------------------------------ text.rs

/** Approximate advance of one character in em (tuned for Inter). */
function charEm(ch: string): number {
	if (ch === ' ') return 0.28;
	if ("iljI.,:;'!|".includes(ch)) return 0.3;
	if (ch === 'f' || ch === 't' || ch === 'r') return 0.38;
	if (ch === 'm' || ch === 'w') return 0.84;
	if (ch === 'M' || ch === 'W') return 0.92;
	if (ch >= 'A' && ch <= 'Z') return 0.68;
	if (ch >= '0' && ch <= '9') return 0.6;
	if (ch >= 'a' && ch <= 'z') return 0.56;
	return 0.62;
}

/** Estimated width of `s` at `size` px; bold (weight ≥ 600) is 6 % wider. */
export function estimateTextWidth(s: string, size: number, weight: number): number {
	let em = 0;
	for (const ch of s) em += charEm(ch);
	return em * size * (weight >= 600 ? 1.06 : 1);
}
