// Click tracks for the beat tests (`beats.test.ts`, `beats-tempo.test.ts`).

/** A click track: 2 ms decaying 2 kHz clicks at `bpm` from `offsetSec`, every 4th at `accent` × the others. */
export function clickTrack(
	sr: number,
	bpm: number,
	seconds: number,
	opts: { offsetSec?: number; accent?: number } = {},
): { audio: Float32Array[]; clicks: number[] } {
	const n = Math.round(seconds * sr);
	const x = new Float32Array(n);
	const period = (60 * sr) / bpm;
	const clicks: number[] = [];
	for (let k = 0; ; k++) {
		const at = Math.round((opts.offsetSec ?? 0.25) * sr + k * period);
		if (at >= n) break;
		clicks.push(at);
		const amp = k % 4 === 0 ? 0.4 * (opts.accent ?? 1) : 0.4;
		for (let i = 0; i < Math.round(0.03 * sr) && at + i < n; i++)
			x[at + i] = amp * Math.exp(-i / (0.004 * sr)) * Math.sin((2 * Math.PI * 2000 * i) / sr);
	}
	return { audio: [x], clicks };
}
