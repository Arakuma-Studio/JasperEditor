// Waveform level reduction from the engine peaks contract (S04:WF-001/003/004, S02:TL-331/333,
// ARCHITECTURE D-10). Peaks are float32 max-abs values at `peaksPerSecond` of source time per channel.
// This module is pure; `peaks.worker.ts` runs it off the main thread (TL-157).

export type ColumnRequest = {
	/** Source time at the left edge of column 0 (seconds). */
	startSec: number;
	/** Source seconds per column (negative for reversed clips). */
	secPerColumn: number;
	columns: number;
	peaksPerSecond: number;
};

/**
 * Max over the peaks covered by each column (WF-003); when a column covers less than one peak the
 * value is linearly interpolated (upsampling beyond 100 px per second, no decode).
 */
export function reduceColumns(peaks: Float32Array, req: ColumnRequest): Float32Array {
	const out = new Float32Array(Math.max(0, req.columns));
	const pps = req.peaksPerSecond;
	const n = peaks.length;
	if (n === 0) return out;
	const span = Math.abs(req.secPerColumn) * pps; // peaks per column
	for (let c = 0; c < out.length; c++) {
		const t0 = req.startSec + c * req.secPerColumn;
		const t1 = t0 + req.secPerColumn;
		const a = Math.min(t0, t1) * pps;
		const b = Math.max(t0, t1) * pps;
		if (span >= 1) {
			let m = 0;
			const i0 = Math.max(0, Math.floor(a));
			const i1 = Math.min(n, Math.ceil(b));
			for (let i = i0; i < i1; i++) {
				const v = peaks[i]!;
				if (v > m) m = v;
			}
			out[c] = m;
		} else {
			const p = (a + b) / 2 - 0.5;
			const i = Math.floor(p);
			const f = p - i;
			const v0 = peaks[Math.min(n - 1, Math.max(0, i))]!;
			const v1 = peaks[Math.min(n - 1, Math.max(0, i + 1))]!;
			out[c] = v0 + (v1 - v0) * f;
		}
	}
	return out;
}

/** Linear gain for drawing (WP-4 / TL-333): clip gain + static volume, in dB. */
export function drawGain(gainDb: number, volumeDb: number): number {
	return 10 ** ((gainDb + volumeDb) / 20);
}

export type WaveBar = { x: number; top: number; height: number; clipped: boolean };

/**
 * Bars for one lane (TL-331): rectified draws bottom-up, centered draws symmetric around the lane center.
 * Values above full scale are clamped and flagged (clipping hint, TL-333).
 */
export function waveBars(
	columns: Float32Array,
	lane: { x: number; top: number; height: number },
	gain: number,
	style: 'rectified' | 'centered',
): WaveBar[] {
	const out: WaveBar[] = [];
	for (let c = 0; c < columns.length; c++) {
		const v = columns[c]! * gain;
		const clipped = v > 1;
		const a = Math.min(1, v);
		if (style === 'rectified') {
			const h = a * lane.height;
			out.push({ x: lane.x + c, top: lane.top + lane.height - h, height: h, clipped });
		} else {
			const h = a * lane.height;
			out.push({ x: lane.x + c, top: lane.top + (lane.height - h) / 2, height: h, clipped });
		}
	}
	return out;
}
