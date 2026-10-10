// Simulation core of the simulation-warp family (sim-warp workstream): deterministic hashing and noise, the fixed
// step clock and a checkpointed stepper. Every stepped simulation (Particle World, Particle Systems, Mercury, Particle
// Playground, Foam, Wave World) is a pure function of (params over time, seed, step count): it is stepped from clip
// time 0 at SIM_SPS steps per second, and `fxSimRun` keeps checkpoints per instance key, so seeking to frame N gives
// exactly the state that playing to frame N gives (resuming from a checkpoint replays the same steps).
// Ported in part from EffectCraft (crates/effects/src/util.rs SimCache, sim.rs steps_at; MIT OR Apache-2.0), see
// licenses/ported/sim-warp.md.
import type { EffectParams } from '../../effects.ts';
import type { FxFrameContext } from '../shader.ts';

/** Steps per second of the stepped simulations. */
export const SIM_SPS = 60;
/** Most steps one simulation runs (10 minutes of clip time): later frames hold the last state. */
export const SIM_MAX_STEPS = SIM_SPS * 600;

/** Whole steps reached at `t` seconds of clip time (0 before the clip starts). */
export function stepsAt(t: number): number {
	if (!(t > 0)) return 0;
	return Math.min(SIM_MAX_STEPS, Math.floor(t * SIM_SPS + 1e-6));
}

/** Deterministic hash of (i, k, seed) → [0, 1) (32-bit integer mixing; identical in every JS engine). */
export function h01(i: number, k: number, seed: number): number {
	let x = Math.imul(i | 0, 0x9e3779b1) ^ Math.imul((k | 0) + 0x7f4a7c15, 0x85ebca6b) ^ (seed | 0);
	x ^= x >>> 16;
	x = Math.imul(x, 0x7feb352d);
	x ^= x >>> 15;
	x = Math.imul(x, 0x846ca68b);
	x ^= x >>> 16;
	return (x >>> 0) / 4294967296;
}

/** Signed hash → [−1, 1). */
export const hs = (i: number, k: number, seed: number) => h01(i, k, seed) * 2 - 1;

/** A 32-bit seed from `u_seed` (0..1) and a Random Seed param. */
export function seedOf(ctxSeed: number, randomSeed: unknown, salt: number): number {
	const r = typeof randomSeed === 'number' && Number.isFinite(randomSeed) ? Math.floor(randomSeed) : 0;
	return (Math.floor(ctxSeed * 4294967296) ^ Math.imul(r + 1, 0x9e3779b9) ^ Math.imul(salt, 0x85ebca6b)) | 0;
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/** 3D value noise in [0, 1] (smooth lattice noise, quintic fade). */
export function valueNoise3(x: number, y: number, z: number, seed: number): number {
	const x0 = Math.floor(x);
	const y0 = Math.floor(y);
	const z0 = Math.floor(z);
	const fx = fade(x - x0);
	const fy = fade(y - y0);
	const fz = fade(z - z0);
	const c = (dx: number, dy: number, dz: number) =>
		h01(Math.imul(x0 + dx, 73856093) ^ Math.imul(y0 + dy, 19349663), z0 + dz, seed);
	const l = (a: number, b: number, t: number) => a + (b - a) * t;
	const a = l(l(c(0, 0, 0), c(1, 0, 0), fx), l(c(0, 1, 0), c(1, 1, 0), fx), fy);
	const b = l(l(c(0, 0, 1), c(1, 0, 1), fx), l(c(0, 1, 1), c(1, 1, 1), fx), fy);
	return l(a, b, fz);
}

// ---------------------------------------------------------------- checkpointed stepper

type Entry<S> = { checkpoints: Map<number, S>; used: number };

/** Steps between checkpoints. */
const CHECKPOINT = SIM_SPS;
/** Checkpoints kept per key before thinning (every other one is dropped). */
const MAX_CHECKPOINTS = 96;

/**
 * A checkpoint cache of one kind of simulation: `run(key, target, init, step, clone)` returns the state after
 * `target` steps, resuming from the latest checkpoint at or before it. States must be treated as immutable by
 * callers (clone before stepping).
 */
export class SimCache<S> {
	private entries = new Map<string, Entry<S>>();
	private tick = 0;
	constructor(private readonly cap = 6) {}

	run(key: string, target: number, init: () => S, step: (s: S, i: number) => void, clone: (s: S) => S): S {
		let e = this.entries.get(key);
		this.tick++;
		if (!e) {
			if (this.entries.size >= this.cap) {
				let oldest: string | null = null;
				let used = Number.POSITIVE_INFINITY;
				for (const [k, v] of this.entries)
					if (v.used < used) {
						used = v.used;
						oldest = k;
					}
				if (oldest !== null) this.entries.delete(oldest);
			}
			e = { checkpoints: new Map(), used: this.tick };
			this.entries.set(key, e);
		}
		e.used = this.tick;
		let best = -1;
		for (const k of e.checkpoints.keys()) if (k <= target && k > best) best = k;
		if (best === target) return e.checkpoints.get(best)!;
		let i = best >= 0 ? best : 0;
		let st = best >= 0 ? clone(e.checkpoints.get(best)!) : init();
		if (best < 0) e.checkpoints.set(0, clone(st));
		while (i < target) {
			step(st, i);
			i++;
			if (i % CHECKPOINT === 0 && i !== target && !e.checkpoints.has(i)) e.checkpoints.set(i, clone(st));
		}
		if (!e.checkpoints.has(target)) e.checkpoints.set(target, st);
		if (e.checkpoints.size > MAX_CHECKPOINTS) {
			// Thin: keep step 0, the target and every other checkpoint.
			const keys = [...e.checkpoints.keys()].sort((a, b) => a - b);
			keys.forEach((k, n) => {
				if (k !== 0 && k !== target && n % 2 === 1) e!.checkpoints.delete(k);
			});
		}
		st = e.checkpoints.get(target)!;
		return st;
	}

	/** Forget every simulation (tests). */
	clear(): void {
		this.entries.clear();
	}
}

/**
 * The key of a stepped simulation of an effect instance: the host's instance key (animation identity) or, without
 * one (tests), the params; plus the layer size and any extra identity (map pixels).
 */
export function simKey(p: EffectParams, ctx: FxFrameContext, salt: string, extra = ''): string {
	return `${salt}|${ctx.instanceKey ?? JSON.stringify(p)}|${ctx.width}x${ctx.height}|${ctx.fps}|${ctx.seed}|${extra}`;
}

/** The params at simulation step `i` (fractional clip frame), or `p` without `paramsAt`. */
export function paramsAtStep(p: EffectParams, ctx: FxFrameContext, i: number): EffectParams {
	return ctx.paramsAt?.((i / SIM_SPS) * ctx.fps) ?? p;
}

/** Steps reached at the context's frame. */
export const stepsOf = (ctx: FxFrameContext) => stepsAt(ctx.frame / (ctx.fps > 0 ? ctx.fps : 30));

// ---------------------------------------------------------------- params helpers

export const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
export const bool = (v: unknown, d = false) => (typeof v === 'boolean' ? v : d);
export const vec2 = (v: unknown, d: [number, number] = [0, 0]): [number, number] =>
	Array.isArray(v) && v.length >= 2 ? [num(v[0], d[0]), num(v[1], d[1])] : d;
export const rgba = (v: unknown, d: [number, number, number, number] = [1, 1, 1, 1]) =>
	Array.isArray(v) && v.length >= 4
		? ([num(v[0], d[0]), num(v[1], d[1]), num(v[2], d[2]), num(v[3], d[3])] as [
				number,
				number,
				number,
				number,
			])
		: d;
/** Index of an enum value in its options (default 0). */
export const choice = (v: unknown, options: readonly string[], d = 0) => {
	const i = typeof v === 'string' ? options.indexOf(v) : -1;
	return i >= 0 ? i : d;
};
export const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
