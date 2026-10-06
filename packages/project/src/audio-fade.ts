// Audio fades of audio transitions (S01:TRN-004, S10:TUI-052). A light module (no imports) so the AudioWorklet
// chain of audio-fx can evaluate fades with the exact function the Player and the native export use.

export type RenderAudioFade = {
	type: 'in' | 'out';
	/** Sequence frame where the ramp begins. */
	start: number;
	frames: number;
	curve: 'linear' | 'equal-power';
};

/** Gain factor (0…1) of audio fades at a (fractional) sequence frame. */
export function audioFadeGain(fades: readonly RenderAudioFade[] | undefined, frame: number): number {
	if (!fades || fades.length === 0) return 1;
	let k = 1;
	for (const f of fades) {
		const p = Math.min(1, Math.max(0, (frame - f.start) / f.frames));
		const x = f.type === 'in' ? p : 1 - p;
		k *= f.curve === 'equal-power' ? Math.sin((x * Math.PI) / 2) : x;
	}
	return k;
}
