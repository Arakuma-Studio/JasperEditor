// Audio fades of audio transitions (S01:TRN-004, S10:TUI-052). A light module (no imports) so the AudioWorklet
// chain of audio-fx can evaluate fades with the exact function the Player and the native export use.

export type RenderAudioFade = {
	type: 'in' | 'out';
	/** Sequence frame where the ramp begins. */
	start: number;
	frames: number;
	/** `exponential` (Exponential Fade): dB-linear over 60 dB, (1000^x − 1) / 999, exactly 0 and 1 at the ends. */
	curve: 'linear' | 'equal-power' | 'exponential';
};

/** Gain factor (0…1) of audio fades at a (fractional) sequence frame. */
export function audioFadeGain(fades: readonly RenderAudioFade[] | undefined, frame: number): number {
	if (!fades || fades.length === 0) return 1;
	let k = 1;
	for (const f of fades) {
		const p = Math.min(1, Math.max(0, (frame - f.start) / f.frames));
		const x = f.type === 'in' ? p : 1 - p;
		k *= fadeCurve(f.curve, x);
	}
	return k;
}

/** Gain (0…1) of a fade curve at progress `x` (0 = silent end, 1 = full level). */
export function fadeCurve(curve: RenderAudioFade['curve'], x: number): number {
	if (curve === 'equal-power') return Math.sin((x * Math.PI) / 2);
	if (curve === 'exponential') return (1000 ** x - 1) / 999;
	return x;
}
