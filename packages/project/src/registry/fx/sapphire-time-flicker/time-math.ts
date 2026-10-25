// Pure time maths of the Sapphire Time + Flicker family: source-frame remaps (freeze, reverse,
// jitter, random edits, retime…), time-sample planning (span clamping, ≤ 8 offsets spread over a window) and the
// per-frame flicker gains. Every function is a deterministic function of its arguments (no state, no clocks), so the
// Player, stills and parallel render pages agree on every frame (S11 §2).
import type { ParamValue } from '../../../schema/common.ts';
import type { EffectParams } from '../../effects.ts';
import { booleanParam as bool, numberParam as num, stringParam as str } from '../../param-values.ts';
import { FX_MAX_TIME_SAMPLES, type FxTimeContext, fxRandom } from '../shader.ts';

/** A rounded integer param, at least `min`. */
export const int = (v: ParamValue | undefined, d: number, min = Number.NEGATIVE_INFINITY): number =>
	Math.max(min, Math.round(num(v, d)));

type Span = Pick<FxTimeContext, 'duration' | 'headHandle' | 'tailHandle'>;

/** The frame clamped to the clip's drawn span `[−head, duration + tail − 1]` (what the framework does to remaps). */
export function clampToSpan(f: number, s: Span): number {
	return Math.max(-s.headHandle, Math.min(s.duration + s.tailHandle - 1, Math.floor(f)));
}

/** The frame clamped to the clip's own frames `[0, duration − 1]`. */
export function clampToClip(f: number, duration: number): number {
	return Math.max(0, Math.min(Math.max(0, duration - 1), Math.floor(f)));
}

/**
 * Sample offsets (relative to `base`) whose frame lies inside the drawn span, unique and ascending, at most
 * FX_MAX_TIME_SAMPLES. Out-of-span samples would be transparent: dropping them reads as "the effect starts fresh at
 * the first frame", like Sapphire's re-initialisation on a non-consecutive frame.
 */
export function inSpan(offsets: readonly number[], base: number, s: Span): number[] {
	const out = new Set<number>();
	for (const o of offsets) {
		if (!Number.isFinite(o)) continue;
		const r = Math.round(o);
		const at = base + r;
		if (at < -s.headHandle || at > s.duration + s.tailHandle - 1) continue;
		out.add(r);
	}
	return [...out].sort((a, b) => a - b).slice(0, FX_MAX_TIME_SAMPLES);
}

/** At most `max` integers covering [lo, hi] evenly (every integer when they fit), ascending and unique. */
export function spreadOffsets(lo: number, hi: number, max = FX_MAX_TIME_SAMPLES): number[] {
	let a = Math.round(Math.min(lo, hi));
	let b = Math.round(Math.max(lo, hi));
	if (!Number.isFinite(a) || !Number.isFinite(b)) return [];
	a = Math.max(-100000, a);
	b = Math.min(100000, b);
	const n = b - a + 1;
	if (n <= max) return Array.from({ length: n }, (_, i) => a + i);
	const out = new Set<number>();
	for (let i = 0; i < max; i++) out.add(Math.round(a + ((b - a) * i) / (max - 1)));
	return [...out].sort((x, y) => x - y);
}

/**
 * The `count` most recent previous frames of a recursive effect reaching back `steps` frames (oldest first), e.g.
 * steps 15, count 8 → [−15, −13, −11, −9, −8, −6, −4, −2]. The shaders raise the per-step fade/transform to the
 * frame gap between consecutive samples, so a sparse window still decays like `steps` single steps.
 */
export function historyOffsets(steps: number, max = FX_MAX_TIME_SAMPLES): number[] {
	const s = Math.max(1, Math.round(steps));
	const count = Math.min(max, s);
	const out = new Set<number>();
	for (let k = count; k >= 1; k--) out.add(-Math.max(1, Math.round((k * s) / count)));
	return [...out].sort((a, b) => a - b);
}

/** S_FreezeFrame: holds every `freezeFrames`-th frame, phase `frameStart` (0 1 2 3 4 5… → 0 0 0 0 0 5 5…). */
export function freezeFrameSource(f: number, freezeFrames: number, frameStart: number): number {
	const n = Math.max(1, Math.round(freezeFrames));
	const s = Math.max(0, Math.round(frameStart));
	const seg = Math.floor((f - s) / n);
	return Math.max(0, s + seg * n);
}

/** S_ReverseClip: the clip plays backwards. */
export function reverseClipSource(f: number, duration: number): number {
	return duration - 1 - f;
}

/** S_ReverseEdits: each segment of `len` frames (phase `start`) is reversed; `reverseAll` reverses the result. */
export function reverseEditsSource(
	f: number,
	len: number,
	start: number,
	reverseAll: boolean,
	duration: number,
): number {
	const n = Math.max(1, Math.round(len));
	const s = Math.max(0, Math.round(start));
	const g = reverseAll ? duration - 1 - f : f;
	const seg = Math.floor((g - s) / n);
	const segStart = s + seg * n;
	return clampToClip(segStart + (n - 1 - (g - segStart)), duration);
}

/** S_JitterFrames: each group of `len` frames shows a random frame within ±`dist` (repeatable per seed). */
export function jitterFramesSource(
	f: number,
	len: number,
	dist: number,
	seed: number,
	duration: number,
): number {
	const n = Math.max(1, Math.round(len));
	const g = Math.floor(f / n);
	const d = Math.max(0, dist);
	return clampToClip(f + Math.round((fxRandom(seed, g) * 2 - 1) * d), duration);
}

const permutations = new Map<string, Uint32Array>();

/** A deterministic permutation of 0…n−1 for a seed (Fisher–Yates on `fxRandom`; memoised, pure). */
function seededPermutation(n: number, seed: number): Uint32Array {
	const key = `${seed}:${n}`;
	const hit = permutations.get(key);
	if (hit) return hit;
	const p = new Uint32Array(n);
	for (let i = 0; i < n; i++) p[i] = i;
	for (let i = n - 1; i > 0; i--) {
		const j = Math.floor(fxRandom(seed, i) * (i + 1));
		const t = p[i]!;
		p[i] = p[j]!;
		p[j] = t;
	}
	if (permutations.size > 16) permutations.delete(permutations.keys().next().value!);
	permutations.set(key, p);
	return p;
}

/** S_RandomEdits: segments of `len` frames of the whole clip in a random (repeatable) order. */
export function randomEditsSource(f: number, len: number, seed: number, duration: number): number {
	const n = Math.max(1, Math.round(len));
	const segs = Math.max(1, Math.min(1 << 20, Math.ceil(duration / n)));
	const seg = Math.floor(f / n);
	if (seg < 0 || seg >= segs) return clampToClip(f, duration);
	const to = seededPermutation(segs, seed)[seg]!;
	return clampToClip(to * n + (f - seg * n), duration);
}

export const RETIME_MODES = ['speed', 'longer', 'scale', 'fps', 'length', 'variable'] as const;
export const RETIME_MODE_LABELS = [
	'Retime Speed',
	'Retime Longer',
	'Retime Scale',
	'Retime FPS',
	'Retime Length',
	'Retime Variable Speed',
] as const;

/** S_Retime: the (fractional) source frame shown at clip frame `f`. */
export function retimeSource(p: EffectParams, f: number, duration: number): number {
	const mode = str(p.mode, 'speed');
	if (mode === 'variable') return Math.max(0, num(p.inputFrame, 1));
	let s: number;
	switch (mode) {
		case 'longer':
			s = 1 / (1 + Math.max(0, num(p.percentLonger, 100)) / 100);
			break;
		case 'scale':
			s = 100 / Math.max(1, num(p.percent, 200));
			break;
		case 'fps':
			s = Math.max(1, num(p.inputFps, 30)) / Math.max(1, num(p.outputFps, 60));
			break;
		case 'length':
			s = Math.max(1, duration) / Math.max(2, Math.round(num(p.outputLength, 30)));
			break;
		default:
			s = Math.min(10, Math.max(0.01, num(p.speed, 0.5)));
	}
	const start = Math.max(0, Math.round(num(p.startFrame, 0)));
	return Math.max(0, start + (f - start) * s);
}

/** Integer part and blend weight of a fractional source frame (blend towards the next frame by `t`). */
export function splitFrame(src: number): { frame: number; t: number } {
	const frame = Math.floor(src);
	return { frame, t: src - frame };
}

function smoothRandom(seed: number, x: number, lane: number): number {
	const i = Math.floor(x);
	const fr = x - i;
	const a = fxRandom(seed, i * 4 + lane);
	const b = fxRandom(seed, (i + 1) * 4 + lane);
	const s = fr * fr * (3 - 2 * fr);
	return (a + (b - a) * s) * 2 - 1;
}

/**
 * S_Flicker: the RGB gains at a clip frame — smooth random luma/colour flicker (keys `randFreq` per second, eased
 * between) plus a periodic wave per channel (phases in cycles), scaled by Amplitude, the channel amps and Brightness.
 */
export function flickerGains(
	p: EffectParams,
	frame: number,
	fps: number,
	seed: number,
): [number, number, number] {
	const t = frame / Math.max(1, fps);
	const amp = Math.max(0, num(p.amplitude, 0.2));
	const x = t * Math.max(0, num(p.randFreq, 30));
	const luma = Math.max(0, num(p.randLumaAmp, 1)) * smoothRandom(seed, x, 0);
	const colorAmp = Math.max(0, num(p.randColorAmp, 0));
	const waveAmp = Math.max(0, num(p.waveAmp, 0));
	const waveFreq = Math.max(0, num(p.waveFreq, 5));
	const phases = [num(p.waveRPhase), num(p.waveGPhase), num(p.waveBPhase)];
	const chan = [num(p.redAmp, 1), num(p.greenAmp, 1), num(p.blueAmp, 1)];
	const bright = Math.max(0, num(p.brightness, 1));
	const gain = (c: number) => {
		const color = colorAmp > 0 ? colorAmp * smoothRandom(seed, x, c + 1) : 0;
		const wave = waveAmp > 0 ? waveAmp * Math.sin(2 * Math.PI * (waveFreq * t + phases[c]!)) : 0;
		return bright * Math.max(0, 1 + amp * Math.max(0, chan[c]!) * (luma + color + wave));
	};
	return [gain(0), gain(1), gain(2)];
}

export { bool, num, str };
