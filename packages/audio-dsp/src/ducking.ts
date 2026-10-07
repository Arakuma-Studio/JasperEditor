/**
 * Offline analysis for Essential Sound auto-ducking: level envelope of the trigger audio (dialogue,
 * SFX…), activity detection with gap bridging and blip removal, and the volume keyframes that duck a
 * music clip under the detected regions.
 *
 * Pure functions on plain arrays; times are seconds, levels dBFS / dB.
 *
 * Ported from FilmCraft `crates/audio-dsp/src/ducking.rs` and the ducking glue of
 * `crates/engine/src/essential_sound.rs` (MIT OR Apache-2.0).
 */

/** Level floor (dBFS) for silence. */
export const FLOOR_DB = -120;

/** Default analysis hop (s) of {@link planDucking}. */
export const DUCK_HOP_S = 0.01;
/** Default RMS window (s, centred on each hop) of {@link planDucking}: 5 hops. */
export const DUCK_WINDOW_S = 0.05;
/** Default minimum region length (s): shorter blips are dropped. */
export const DUCK_MIN_ON_S = 0.1;
/** Default gap (s) below which neighbouring regions are bridged. */
export const DUCK_BRIDGE_S = 0.25;

/**
 * RMS level (dBFS) per hop: value `k` is the RMS of the window of `windowS` seconds centred on `k · hopS`
 * (clipped at the signal edges), with the power averaged over channels (prefix sums, float64). The result
 * has `ceil(len / hop)` entries; silence reads {@link FLOOR_DB}.
 */
export function envelopeDb(
	channels: Float32Array[],
	sampleRate: number,
	hopS: number,
	windowS: number,
): Float32Array {
	if (channels.length === 0) return new Float32Array(0);
	let len = Number.POSITIVE_INFINITY;
	for (const c of channels) len = Math.min(len, c.length);
	if (len === 0) return new Float32Array(0);
	const hop = Math.max(1, Math.round(hopS * sampleRate));
	const half = Math.max(1, Math.round((windowS * sampleRate) / 2));
	const nch = channels.length;
	const pre = new Float64Array(len + 1);
	let acc = 0;
	for (let i = 0; i < len; i++) {
		let p = 0;
		for (let c = 0; c < nch; c++) {
			const v = channels[c][i];
			p += v * v;
		}
		acc += p / nch;
		pre[i + 1] = acc;
	}
	const out = new Float32Array(Math.ceil(len / hop));
	for (let k = 0; k < out.length; k++) {
		const centre = k * hop;
		const a = Math.max(0, centre - half);
		const b = Math.min(len, centre + half);
		const ms = Math.max(0, pre[b] - pre[a]) / Math.max(1, b - a);
		out[k] = ms <= 1e-12 ? FLOOR_DB : Math.max(FLOOR_DB, 10 * Math.log10(ms));
	}
	return out;
}

/**
 * Regions `[startS, endS]` (relative to the envelope start) where the envelope exceeds `thresholdDb`.
 * Gaps shorter than `bridgeS` are merged first, then regions shorter than `minOnS` are dropped. Frame `k`
 * covers `[k·hop, (k+1)·hop)`; the hop is rounded to whole microseconds (so 0.01 means exactly 0.01 s).
 * (FilmCraft `activity(env, hop, threshold, min_on, bridge)` — note the argument order here.)
 */
export function activeRegions(
	env: ArrayLike<number>,
	hopS: number,
	thresholdDb: number,
	bridgeS: number,
	minOnS: number,
): [number, number][] {
	const hop = Math.round(Math.fround(hopS) * 1e6) / 1e6;
	const raw: [number, number][] = [];
	let start = -1;
	for (let k = 0; k < env.length; k++) {
		const on = env[k] > thresholdDb;
		if (on && start < 0) start = k;
		else if (!on && start >= 0) {
			raw.push([start * hop, k * hop]);
			start = -1;
		}
	}
	if (start >= 0) raw.push([start * hop, env.length * hop]);
	const merged: [number, number][] = [];
	for (const r of raw) {
		const last = merged[merged.length - 1];
		if (last && r[0] - last[1] < bridgeS - 1e-9) last[1] = r[1];
		else merged.push(r);
	}
	return merged.filter(([a, b]) => b - a >= minOnS - 1e-9);
}

/**
 * Essential Sound ducking "Sensitivity" (0 … 10, clamped) → detection threshold in dBFS: `−20 − 4·s`
 * (5 → −40 dBFS; higher sensitivity reacts to quieter triggers).
 */
export function sensitivityThresholdDb(sensitivity: number): number {
	return -20 - 4 * Math.min(10, Math.max(0, sensitivity));
}

/** One volume keyframe: time (s) and level (dB). */
export type DuckKeyframe = { t: number; db: number };

/**
 * Volume keyframes that duck by `reduceDb` under each region: ramp from `baseDb` at `a − fade` down to
 * `baseDb − |reduceDb|` at `a`, hold until `b`, ramp back up to `baseDb` at `b + fade`. Regions whose ramps
 * would overlap are merged (the level stays ducked between them). Everything is clamped to
 * `[clipStartS, clipEndS]`; a ramp cut by a clip edge gets a keyframe at the edge with the ramp's value
 * there (fully ducked when the region itself reaches the edge). Times are strictly increasing; no regions
 * → no keyframes. `fadeS` is at least 1 ms so a ramp never collapses into two keyframes at the same time.
 */
export function duckKeyframes(
	regions: ReadonlyArray<readonly [number, number]>,
	clipStartS: number,
	clipEndS: number,
	baseDb: number,
	reduceDb: number,
	fadeS: number,
): DuckKeyframe[] {
	const fade = Math.max(fadeS, 1e-3);
	const ducked = baseDb - Math.abs(reduceDb);
	const sorted = regions
		.filter(([a, b]) => b > a && b > clipStartS && a < clipEndS)
		.map(([a, b]) => [a, b] as [number, number])
		.sort((x, y) => x[0] - y[0]);
	// merge regions whose ramps touch or overlap
	const groups: [number, number][] = [];
	for (const r of sorted) {
		const g = groups[groups.length - 1];
		if (g && r[0] - fade <= g[1] + fade) g[1] = Math.max(g[1], r[1]);
		else groups.push(r);
	}
	const out: DuckKeyframe[] = [];
	const push = (t: number, v: number): void => {
		if (t < clipStartS || t > clipEndS) return;
		const last = out[out.length - 1];
		if (last && t <= last.t + 1e-9) last.db = v;
		else out.push({ t, db: v });
	};
	const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
	// value of the down-ramp ending at `a` / up-ramp starting at `b`, at time t
	const down = (a: number, t: number): number =>
		baseDb + (ducked - baseDb) * clamp01((t - (a - fade)) / fade);
	const up = (b: number, t: number): number => ducked + (baseDb - ducked) * clamp01((t - b) / fade);
	for (const [a, b] of groups) {
		const rampStart = a - fade;
		if (rampStart >= clipStartS) push(rampStart, baseDb);
		else push(clipStartS, down(a, clipStartS));
		push(Math.max(a, clipStartS), ducked);
		if (b < clipEndS) {
			push(b, ducked);
			if (b + fade <= clipEndS) push(b + fade, baseDb);
			else push(clipEndS, up(b, clipEndS));
		} else push(clipEndS, ducked);
	}
	return out;
}

/** Input of {@link planDucking}. */
export type DuckingPlanInput = {
	/**
	 * Trigger audio (e.g. the sum of the dialogue clips overlapping the target), planar, covering exactly the
	 * target clip window: sample 0 is at `target.start` in sequence time.
	 */
	trigger: Float32Array[];
	/** Sample rate of `trigger` (Hz). */
	sampleRate: number;
	/** Clip window in seconds (sequence time) of the target (music / ambience) clip. */
	target: { start: number; end: number };
	/** Premiere "Sensitivity", 0 … 10 → threshold `−20 − 4·s` dBFS ({@link sensitivityThresholdDb}). */
	sensitivity: number;
	/** "Reduce by" (dB, positive; the sign is ignored). */
	amountDb: number;
	/** "Fades" duration (s) of each ramp (at least 1 ms). */
	fadeS: number;
	/** Volume level (dB) of the target outside the ducked regions (default 0). */
	baseDb?: number;
	/** Analysis hop (s, default {@link DUCK_HOP_S}). */
	hopS?: number;
	/** RMS window (s, default {@link DUCK_WINDOW_S}). */
	windowS?: number;
	/** Regions shorter than this (s) are ignored (default {@link DUCK_MIN_ON_S}). */
	minOnS?: number;
	/** Gaps shorter than this (s) are bridged (default {@link DUCK_BRIDGE_S}). */
	bridgeS?: number;
};

/** Result of {@link planDucking}. */
export type DuckingPlan = {
	/** Detected trigger activity `[start, end]` in sequence seconds (not clamped). */
	regions: [number, number][];
	/** Volume keyframes in sequence seconds, strictly increasing, inside the target window. */
	keyframes: DuckKeyframe[];
	/** Detection threshold used (dBFS). */
	thresholdDb: number;
};

/**
 * Plan auto-ducking of a target clip: envelope of the trigger ({@link envelopeDb}), activity regions above
 * the sensitivity threshold ({@link activeRegions}), shifted to sequence time, then duck keyframes
 * ({@link duckKeyframes}) clamped to the target window.
 */
export function planDucking(input: DuckingPlanInput): DuckingPlan {
	const hopS = input.hopS ?? DUCK_HOP_S;
	const env = envelopeDb(input.trigger, input.sampleRate, hopS, input.windowS ?? DUCK_WINDOW_S);
	const thresholdDb = sensitivityThresholdDb(input.sensitivity);
	const rel = activeRegions(
		env,
		hopS,
		thresholdDb,
		input.bridgeS ?? DUCK_BRIDGE_S,
		input.minOnS ?? DUCK_MIN_ON_S,
	);
	const s = input.target.start;
	const regions = rel.map(([a, b]) => [s + a, s + b] as [number, number]);
	const keyframes = duckKeyframes(
		regions,
		input.target.start,
		input.target.end,
		input.baseDb ?? 0,
		input.amountDb,
		input.fadeS,
	);
	return { regions, keyframes, thresholdDb };
}
