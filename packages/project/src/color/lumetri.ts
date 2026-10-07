// `jasper.lumetri@1` reference maths (S06 §3, normative). One pure function RGB → RGB on display-referred
// (Rec.709/sRGB-encoded) values; the renderers never evaluate it per pixel: it is baked into the colour run's
// 3D LUT (ARCHITECTURE D-21) that the WebGL preview and the native `lut3d` both sample.
// Any change to the maths bumps the effect version and adds a `migrate` (S01:FX-021).
import type { ColorFn, ColorOpContext, EffectParams } from '../registry/effects.ts';
import { curveFn } from './curves.ts';
import { applyLut, applyLutMix, type Lut, type Rgb } from './lut.ts';

/** Rec.709 luma weights (S06 §3 `Y(v)`). */
const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;
/** BT.1886 simplification used for the linear-light steps: `L = v^2.4`. */
const DISPLAY_GAMMA = 2.4;

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

function num(p: EffectParams, k: string, def: number, lo: number, hi: number): number {
	const v = p[k];
	return typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : def;
}
function mediaRef(p: EffectParams, k: string): string | null {
	const v = p[k] as { mediaId?: unknown } | null | undefined;
	return v && typeof v === 'object' && typeof v.mediaId === 'string' && v.mediaId ? v.mediaId : null;
}
function curve(p: EffectParams, k: string): number[][] | null {
	const v = p[k] as { curve?: unknown } | null | undefined;
	return v && typeof v === 'object' && Array.isArray(v.curve) ? (v.curve as number[][]) : null;
}
function vec(p: EffectParams, k: string): [number, number] {
	const v = p[k];
	if (!Array.isArray(v) || v.length < 2) return [0, 0];
	const x = Number(v[0]);
	const y = Number(v[1]);
	return [Number.isFinite(x) ? x : 0, Number.isFinite(y) ? y : 0];
}

/** Reads (and clamps to the S06:CG-002 ranges) the Lumetri params; missing values take their defaults. */
function readLumetriParams(p: EffectParams) {
	return {
		inputLut: mediaRef(p, 'inputLut'),
		temperature: num(p, 'temperature', 0, -100, 100),
		tint: num(p, 'tint', 0, -100, 100),
		exposure: num(p, 'exposure', 0, -5, 5),
		contrast: num(p, 'contrast', 0, -100, 100),
		highlights: num(p, 'highlights', 0, -100, 100),
		shadows: num(p, 'shadows', 0, -100, 100),
		whites: num(p, 'whites', 0, -100, 100),
		blacks: num(p, 'blacks', 0, -100, 100),
		saturation: num(p, 'saturation', 100, 0, 200),
		look: mediaRef(p, 'look'),
		lookIntensity: num(p, 'lookIntensity', 100, 0, 100),
		vibrance: num(p, 'vibrance', 0, -100, 100),
		curveMaster: curve(p, 'curveMaster'),
		curveRed: curve(p, 'curveRed'),
		curveGreen: curve(p, 'curveGreen'),
		curveBlue: curve(p, 'curveBlue'),
		shadowsWheel: vec(p, 'shadowsWheel'),
		midtonesWheel: vec(p, 'midtonesWheel'),
		highlightsWheel: vec(p, 'highlightsWheel'),
		shadowsLevel: num(p, 'shadowsLevel', 0, -100, 100),
		midtonesLevel: num(p, 'midtonesLevel', 0, -100, 100),
		highlightsLevel: num(p, 'highlightsLevel', 0, -100, 100),
	};
}

/**
 * White-balance gains in linear light (S06 §3.1 step 2): `(1 + 0.30T + 0.15N, 1 − 0.30N, 1 − 0.30T + 0.15N)`
 * normalised so that their luma is 1 (a neutral grey keeps its brightness).
 */
function whiteBalanceGains(temperature: number, tint: number): Rgb {
	const T = temperature / 100;
	const N = tint / 100;
	const r = 1 + 0.3 * T + 0.15 * N;
	const g = 1 - 0.3 * N;
	const b = 1 - 0.3 * T + 0.15 * N;
	const y = LUMA_R * r + LUMA_G * g + LUMA_B * b;
	return [r / y, g / y, b / y];
}

/**
 * RGB direction of a colour wheel (S06 §3.1 step 11): hue `θ = atan2(y, x)`, amount `m = min(1, |(x, y)|)`,
 * `d_k = m·cos(θ − φ_k)` with `φ = (0°, 120°, 240°)`.
 */
function wheelDirection(wheel: readonly [number, number]): Rgb {
	const [x, y] = wheel;
	const m = Math.min(1, Math.hypot(x, y));
	if (m === 0) return [0, 0, 0];
	const th = Math.atan2(y, x);
	return [m * Math.cos(th), m * Math.cos(th - (2 * Math.PI) / 3), m * Math.cos(th - (4 * Math.PI) / 3)];
}

/** Hermite smoothstep with the usual clamp of `t` (S06 §3 `smooth(a, b, x)`). */
function smoothstep(a: number, b: number, x: number): number {
	const t = clamp((x - a) / (b - a), 0, 1);
	return t * t * (3 - 2 * t);
}

const isZeroVec = (v: readonly [number, number]) => v[0] === 0 && v[1] === 0;

/**
 * The Lumetri pixel function for a set of params, or null when every step is the identity (S06:CG-021).
 * `ctx.lut` resolves the `inputLut` / `look` assets; a missing or offline LUT is skipped (S06:CG-004).
 * Steps whose params are at their defaults are skipped entirely, so defaults are bit-exact. The returned
 * function is one monomorphic closure with per-step flags (a bake evaluates it 35 937 times, CG-043).
 */
export function lumetriFn(params: EffectParams, ctx: ColorOpContext): ColorFn | null {
	const p = readLumetriParams(params);

	// 1. Input LUT at full strength.
	const inputLut: Lut | null = p.inputLut ? ctx.lut(p.inputLut) : null;

	// 2–3. White balance and exposure in linear light (L = v^2.4, L ← L·g·2^e), then re-encode. The round trip
	// of a pure gain is exactly a gain on encoded values: (v^2.4·k)^(1/2.4) = v·k^(1/2.4) (no per-pixel pow).
	const wbOn = p.temperature !== 0 || p.tint !== 0;
	const gainOn = wbOn || p.exposure !== 0;
	const g = wbOn ? whiteBalanceGains(p.temperature, p.tint) : ([1, 1, 1] as Rgb);
	const ex = 2 ** p.exposure;
	const inv = 1 / DISPLAY_GAMMA;
	const k0 = (g[0] * ex) ** inv;
	const k1 = (g[1] * ex) ** inv;
	const k2 = (g[2] * ex) ** inv;

	// 4. Contrast around mid-grey on encoded values.
	const contrastOn = p.contrast !== 0;
	const kc = 1 + p.contrast / 100;

	// 5. Highlights / shadows with luma masks (weights computed once from the step's input).
	const hs = (0.25 * p.highlights) / 100;
	const ss = (0.25 * p.shadows) / 100;
	const toneOn = hs !== 0 || ss !== 0;

	// 6. Whites / blacks (end points).
	const endsOn = p.whites !== 0 || p.blacks !== 0;
	const bb = (0.2 * p.blacks) / 100;
	const range = 1 + (0.2 * p.whites) / 100 - bb;

	// 7. Saturation around luma.
	const satOn = p.saturation !== 100;
	const ks = p.saturation / 100;

	// 8. Creative look mixed with its intensity.
	const look: Lut | null = p.look && p.lookIntensity > 0 ? ctx.lut(p.look) : null;
	const lookAmount = p.lookIntensity / 100;

	// 9. Vibrance: saturation weighted towards the less saturated colours.
	const vibOn = p.vibrance !== 0;
	const kv = p.vibrance / 100;

	// 10. Curves: master on every channel, then per channel.
	const cm = curveFn(p.curveMaster);
	const cr = curveFn(p.curveRed);
	const cg = curveFn(p.curveGreen);
	const cb = curveFn(p.curveBlue);

	// 11. Colour wheels: lift / gamma / gain on encoded values.
	const liftOn = !isZeroVec(p.shadowsWheel) || p.shadowsLevel !== 0;
	const dl = wheelDirection(p.shadowsWheel);
	const lb = (0.1 * p.shadowsLevel) / 100;
	const a0 = lb + 0.1 * dl[0];
	const a1 = lb + 0.1 * dl[1];
	const a2 = lb + 0.1 * dl[2];
	const gammaOn = !isZeroVec(p.midtonesWheel) || p.midtonesLevel !== 0;
	const dm = wheelDirection(p.midtonesWheel);
	const mb = 1 + (0.5 * p.midtonesLevel) / 100;
	const e0 = 1 / Math.max(0.05, mb + 0.25 * dm[0]);
	const e1 = 1 / Math.max(0.05, mb + 0.25 * dm[1]);
	const e2 = 1 / Math.max(0.05, mb + 0.25 * dm[2]);
	const gainWheelOn = !isZeroVec(p.highlightsWheel) || p.highlightsLevel !== 0;
	const dh = wheelDirection(p.highlightsWheel);
	const hb = 1 + (0.5 * p.highlightsLevel) / 100;
	const g0 = hb + 0.25 * dh[0];
	const g1 = hb + 0.25 * dh[1];
	const g2 = hb + 0.25 * dh[2];

	const any =
		inputLut !== null ||
		gainOn ||
		contrastOn ||
		toneOn ||
		endsOn ||
		satOn ||
		look !== null ||
		vibOn ||
		cm !== null ||
		cr !== null ||
		cg !== null ||
		cb !== null ||
		liftOn ||
		gammaOn ||
		gainWheelOn;
	if (!any) return null;

	return (c) => {
		if (inputLut) applyLut(inputLut, c);
		if (gainOn) {
			c[0] = c[0] > 0 ? c[0] * k0 : 0;
			c[1] = c[1] > 0 ? c[1] * k1 : 0;
			c[2] = c[2] > 0 ? c[2] * k2 : 0;
		}
		if (contrastOn) {
			c[0] = 0.5 + (c[0] - 0.5) * kc;
			c[1] = 0.5 + (c[1] - 0.5) * kc;
			c[2] = 0.5 + (c[2] - 0.5) * kc;
		}
		if (toneOn) {
			const y = LUMA_R * c[0] + LUMA_G * c[1] + LUMA_B * c[2];
			if (hs !== 0) {
				const w = hs * smoothstep(0.45, 1, y);
				if (hs > 0) {
					c[0] += w * (1 - c[0]);
					c[1] += w * (1 - c[1]);
					c[2] += w * (1 - c[2]);
				} else {
					c[0] += w * c[0];
					c[1] += w * c[1];
					c[2] += w * c[2];
				}
			}
			if (ss !== 0) {
				const w = ss * (1 - smoothstep(0, 0.55, y));
				if (ss > 0) {
					c[0] += w * (1 - c[0]);
					c[1] += w * (1 - c[1]);
					c[2] += w * (1 - c[2]);
				} else {
					c[0] += w * c[0];
					c[1] += w * c[1];
					c[2] += w * c[2];
				}
			}
		}
		if (endsOn) {
			c[0] = bb + c[0] * range;
			c[1] = bb + c[1] * range;
			c[2] = bb + c[2] * range;
		}
		if (satOn) {
			const y = LUMA_R * c[0] + LUMA_G * c[1] + LUMA_B * c[2];
			c[0] = y + (c[0] - y) * ks;
			c[1] = y + (c[1] - y) * ks;
			c[2] = y + (c[2] - y) * ks;
		}
		if (look) applyLutMix(look, c, lookAmount);
		if (vibOn) {
			const mx = c[0] > c[1] ? (c[0] > c[2] ? c[0] : c[2]) : c[1] > c[2] ? c[1] : c[2];
			const mn = c[0] < c[1] ? (c[0] < c[2] ? c[0] : c[2]) : c[1] < c[2] ? c[1] : c[2];
			const k = 1 + kv * (1 - (mx - mn));
			const y = LUMA_R * c[0] + LUMA_G * c[1] + LUMA_B * c[2];
			c[0] = y + (c[0] - y) * k;
			c[1] = y + (c[1] - y) * k;
			c[2] = y + (c[2] - y) * k;
		}
		if (cm) {
			c[0] = cm(c[0]);
			c[1] = cm(c[1]);
			c[2] = cm(c[2]);
		}
		if (cr) c[0] = cr(c[0]);
		if (cg) c[1] = cg(c[1]);
		if (cb) c[2] = cb(c[2]);
		if (liftOn) {
			c[0] += a0 * (1 - c[0]);
			c[1] += a1 * (1 - c[1]);
			c[2] += a2 * (1 - c[2]);
		}
		if (gammaOn) {
			// v^e as exp(e·ln v): same value to ~1e-15, about twice as fast as Math.pow in V8 (bake budget CG-043).
			if (c[0] > 0) c[0] = Math.exp(e0 * Math.log(c[0]));
			if (c[1] > 0) c[1] = Math.exp(e1 * Math.log(c[1]));
			if (c[2] > 0) c[2] = Math.exp(e2 * Math.log(c[2]));
		}
		if (gainWheelOn) {
			c[0] *= g0;
			c[1] *= g1;
			c[2] *= g2;
		}
		// 12. Clamp to 0..1.
		c[0] = c[0] < 0 ? 0 : c[0] > 1 ? 1 : c[0];
		c[1] = c[1] < 0 ? 0 : c[1] > 1 ? 1 : c[1];
		c[2] = c[2] < 0 ? 0 : c[2] > 1 ? 1 : c[2];
	};
}
