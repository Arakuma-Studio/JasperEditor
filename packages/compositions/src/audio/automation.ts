// Sample-accurate automation in the preview mix graph (sound-design Phase 4 verification). While playing, an automated
// level (a strip's fader / mute / send-level lane, a clip's Volume keyframes, fades or nested gain) is scheduled on its
// AudioParam as a piecewise-linear curve from "now" over a short horizon, at every graph update: the param follows the
// lane between updates as the export mixer does per sample (`OfflineMixer`), instead of stepping once per picture frame
// and gliding with the 8 ms smoothing (a −24 dB stop-before dip with 30 ms ramps was up to 0.19 off the export, an
// audible click when Remotion stepped a clip's volume by a whole frame). The next update cancels what is left (holding
// the value reached) and schedules again, so edits and seeks take effect at once.
//
// The curve is the lane's own values (the caller's `value(dt)`: linear gain `dt` seconds after now), sampled where it
// bends: seeds every `AUTOMATION_SEED` seconds, each interval halved while its midpoint is further than
// `AUTOMATION_TOLERANCE` (relative) from the chord, down to `AUTOMATION_MIN_STEP` samples. Linear-in-dB segments are
// exponential in gain, so a 24 dB / 30 ms ramp is cut into ≈ 1 ms pieces (≤ 0.02 % off); flat stretches cost nothing.

/** Seconds scheduled ahead at each update (several picture frames: a late update never freezes the curve). */
export const AUTOMATION_HORIZON = 0.12;
/** Spacing (s) of the seed points. */
export const AUTOMATION_SEED = 0.008;
/** Shortest piece (samples). */
export const AUTOMATION_MIN_STEP = 8;
/** Largest relative distance between the curve and its linear pieces at a piece's midpoint. */
export const AUTOMATION_TOLERANCE = 1e-4;

/**
 * The curve each following param was given last (context times and values), to know the value it has reached when
 * the next update replaces it. Chrome's `cancelAndHoldAtTime` held wrong values after a few replaced linear ramps
 * (measured: a flat 1.0 curve read 0.27 a frame later), so the hold is computed here and set explicitly.
 */
const schedules = new WeakMap<AudioParam, { t: number[]; v: number[] }>();

/** Whether `p` is following a scheduled curve (`setParam` must stop it, whatever the param reads now). */
export function isFollowing(p: AudioParam): boolean {
	return schedules.has(p);
}

/** The value of `p`'s scheduled curve at context time `t` (null when it follows none). */
function scheduledValue(p: AudioParam, t: number): number | null {
	const s = schedules.get(p);
	if (!s || s.t.length === 0) return null;
	if (t <= s.t[0]!) return s.v[0]!;
	for (let i = 1; i < s.t.length; i++) {
		if (t <= s.t[i]!) {
			const a = s.t[i - 1]!;
			const b = s.t[i]!;
			const x = b > a ? (t - a) / (b - a) : 1;
			return s.v[i - 1]! + (s.v[i]! - s.v[i - 1]!) * x;
		}
	}
	return s.v[s.v.length - 1]!;
}

/**
 * Cancels the automation from `t` on and holds the value the param has there: the value of the curve it was following
 * (`followCurve`), else its current value. Returns the held value. `stop`: it no longer follows a curve.
 */
export function holdParam(p: AudioParam, t: number, stop = true): number {
	const v = scheduledValue(p, t) ?? p.value;
	const held = Number.isFinite(v) ? v : 0;
	if (stop) schedules.delete(p);
	p.cancelScheduledValues(t);
	p.setValueAtTime(held, t);
	return held;
}

const finite = (v: number) => (Number.isFinite(v) ? v : 0);

/**
 * The points (seconds after now, value) of a piecewise-linear approximation of `value` over `(0, horizon]`
 * (exported for tests). `value(0)` is where the curve starts; it is not among the points.
 */
export function curvePoints(
	value: (dt: number) => number,
	sampleRate: number,
	horizon = AUTOMATION_HORIZON,
	/** Seconds after now where the curve may bend (its keyframes, fade edges): they become points. */
	breaks: readonly number[] = [],
): [number, number][] {
	const minStep = AUTOMATION_MIN_STEP / Math.max(1, sampleRate);
	const n = Math.max(1, Math.ceil(horizon / AUTOMATION_SEED - 1e-9));
	const times: number[] = [];
	for (let i = 1; i <= n; i++) times.push((horizon * i) / n);
	for (const b of breaks) if (Number.isFinite(b) && b > minStep && b < horizon - minStep) times.push(b);
	times.sort((a, b) => a - b);
	const seeds = [0];
	for (const t of times) if (t - seeds[seeds.length - 1]! >= minStep * 0.5) seeds.push(t);
	seeds[seeds.length - 1] = horizon;
	const out: [number, number][] = [];
	const v0 = finite(value(0));
	let flat = true;
	const sv: number[] = [v0];
	for (let i = 1; i < seeds.length; i++) {
		const v = finite(value(seeds[i]!));
		sv.push(v);
		if (Math.abs(v - v0) > AUTOMATION_TOLERANCE * Math.max(Math.abs(v0), 1e-9)) flat = false;
	}
	if (flat) {
		out.push([horizon, v0]);
		return out;
	}
	// Recursion depth is bounded by log2(seed / minStep) (≈ 6 at 48 kHz).
	const split = (a: number, va: number, b: number, vb: number): void => {
		if (b - a > minStep * 1.5) {
			const m = (a + b) / 2;
			const vm = finite(value(m));
			const chord = (va + vb) / 2;
			const scale = Math.max(Math.abs(vm), Math.abs(chord), 1e-9);
			if (Math.abs(vm - chord) > AUTOMATION_TOLERANCE * scale) {
				split(a, va, m, vm);
				split(m, vm, b, vb);
				return;
			}
		}
		out.push([b, vb]);
	};
	for (let i = 1; i < seeds.length; i++) split(seeds[i - 1]!, sv[i - 1]!, seeds[i]!, sv[i]!);
	return out;
}

/**
 * Has `p` follow `value` (linear gain `dt` seconds after the context's current time) from now on, for `horizon`
 * seconds: holds what the param reached, then schedules linear ramps through the curve's points. `cut`: seconds after
 * now at which the param drops to 0 and stays there (a clip's end), set on the sample. `breaks`: seconds after now
 * where the curve bends (keyframes, fade edges), so a corner is never cut by a linear piece.
 */
export function followCurve(
	p: AudioParam,
	ctx: BaseAudioContext,
	value: (dt: number) => number,
	horizon = AUTOMATION_HORIZON,
	cut = Number.POSITIVE_INFINITY,
	breaks: readonly number[] = [],
): void {
	const t0 = ctx.currentTime;
	const held = holdParam(p, t0, false);
	const rec = { t: [t0], v: [held] };
	if (cut <= 0) {
		p.setValueAtTime(0, t0);
		rec.v[0] = 0;
		schedules.set(p, rec);
		return;
	}
	const span = Math.min(horizon, cut);
	for (const [dt, v] of curvePoints(value, ctx.sampleRate, span, breaks)) {
		p.linearRampToValueAtTime(v, t0 + dt);
		rec.t.push(t0 + dt);
		rec.v.push(v);
	}
	if (cut <= horizon) {
		p.setValueAtTime(0, t0 + cut);
		rec.t.push(t0 + cut);
		rec.v.push(0);
	}
	schedules.set(p, rec);
}
