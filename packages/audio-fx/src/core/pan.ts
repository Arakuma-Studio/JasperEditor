// Pan laws (ported from filmcraft `render/src/audio.rs::pan_gains` and `render/src/mixer.rs`). The clip Panner and
// the track pan of the whole app use `panGains` (the preview AudioWorklet chain and the native export both run this
// code, so they cannot disagree).

/**
 * Balance of a stereo signal for a position `p` in −1 (left) … +1 (right): centre = unity on both sides; turning one
 * way attenuates the other side along the −3 dB constant-power curve normalised so the centre is 0 dB; hard left or
 * right silences the opposite side. Returns `[left, right]` gains.
 */
export function panGains(p: number): [number, number] {
	const q = p < -1 ? -1 : p > 1 ? 1 : Number.isFinite(p) ? p : 0;
	const a = (q + 1) * (Math.PI / 4);
	return [Math.min(1, Math.cos(a) * Math.SQRT2), Math.min(1, Math.sin(a) * Math.SQRT2)];
}

/** −3 dB constant-power pan of a mono signal: `[left, right]`, centre = 0.7071 each. */
export function constantPowerPan(p: number): [number, number] {
	const q = p < -1 ? -1 : p > 1 ? 1 : Number.isFinite(p) ? p : 0;
	const a = (q + 1) * (Math.PI / 4);
	return [Math.cos(a), Math.sin(a)];
}

/** Balance with cosine attenuation of the opposite side (centre unity both sides). */
export function balanceGains(p: number): [number, number] {
	const q = p < -1 ? -1 : p > 1 ? 1 : Number.isFinite(p) ? p : 0;
	return [Math.cos(Math.max(q, 0) * (Math.PI / 2)), Math.cos(Math.max(-q, 0) * (Math.PI / 2))];
}
