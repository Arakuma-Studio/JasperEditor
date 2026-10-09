// Sequence ▸ Auto Reframe Sequence (workstream gaps, docs/wp-notes/gaps.md §AI-2), as Premiere: a copy of the sequence
// at a new aspect ratio (Square 1:1, Vertical 4:5, Vertical 9:16, Horizontal 16:9 or custom) whose video clips fill the
// new frame and follow their subject with Position keyframes. The subject of each clip comes from the engine's
// `reframe` job (faces when the face model is installed, else a motion / contrast / skin saliency centroid, per media
// frame); here it is smoothed by Motion Tracking (Slower Motion / Default / Faster Motion: a Gaussian of 1.2 / 0.6 /
// 0.25 s with a dead zone), turned into Position values that keep the frame covered, and thinned to the keyframes
// that a linear interpolation needs (≤ 1.5 px error, at least one key every 2 s).
import type { Rational } from '../time.ts';

export const REFRAME_ASPECTS = [
	{ id: 'square', label: 'Square 1:1', num: 1, den: 1 },
	{ id: 'vertical-4-5', label: 'Vertical 4:5', num: 4, den: 5 },
	{ id: 'vertical-9-16', label: 'Vertical 9:16', num: 9, den: 16 },
	{ id: 'horizontal-16-9', label: 'Horizontal 16:9', num: 16, den: 9 },
] as const;

export const REFRAME_TRACKING = {
	slower: { label: 'Slower Motion', sigmaSeconds: 1.2, deadZone: 0.06 },
	default: { label: 'Default', sigmaSeconds: 0.6, deadZone: 0.03 },
	faster: { label: 'Faster Motion', sigmaSeconds: 0.25, deadZone: 0.01 },
} as const;
export type ReframeTracking = keyof typeof REFRAME_TRACKING;

/** The reframed frame size: the source's smaller side kept, the other from the aspect ratio (even numbers). */
export function reframeSize(width: number, height: number, aspect: { num: number; den: number }): { width: number; height: number } {
	const a = aspect.num / aspect.den;
	const even = (v: number) => Math.max(2, 2 * Math.round(v / 2));
	if (a <= width / height) return { width: even(height * a), height: even(height) };
	return { width: even(width), height: even(width / a) };
}

/** A clip's subject per analysed media frame: normalised centre (0..1 of the media's display) and confidence. */
export type ReframeSubjectPath = {
	clipId: string;
	/** Media seconds of the first sample and the sample spacing. */
	start: number;
	frameDuration: number;
	/** x, y, confidence per sample. */
	points: number[];
};

/** The smoothed subject centre per sample (Gaussian over time, confidence-weighted, then a dead zone). */
export function smoothSubjectPath(
	points: readonly number[],
	frameDuration: number,
	tracking: ReframeTracking,
): [number, number][] {
	const n = Math.floor(points.length / 3);
	const t = REFRAME_TRACKING[tracking];
	const sigma = Math.max(0.5, t.sigmaSeconds / Math.max(1e-6, frameDuration));
	const r = Math.ceil(3 * sigma);
	const raw: [number, number][] = [];
	for (let i = 0; i < n; i++) {
		let sx = 0;
		let sy = 0;
		let sw = 0;
		for (let j = Math.max(0, i - r); j <= Math.min(n - 1, i + r); j++) {
			const w = Math.exp(-((j - i) ** 2) / (2 * sigma * sigma)) * Math.max(1e-3, points[3 * j + 2]!);
			sx += w * points[3 * j]!;
			sy += w * points[3 * j + 1]!;
			sw += w;
		}
		raw.push(sw > 0 ? [sx / sw, sy / sw] : [0.5, 0.5]);
	}
	// Dead zone: the framing moves only when the subject leaves a small window around it (no drift on a still subject).
	const out: [number, number][] = [];
	let cur = raw[0] ?? [0.5, 0.5];
	for (const p of raw) {
		const dx = p[0] - cur[0];
		const dy = p[1] - cur[1];
		const nx = Math.abs(dx) > t.deadZone ? p[0] - Math.sign(dx) * t.deadZone : cur[0];
		const ny = Math.abs(dy) > t.deadZone ? p[1] - Math.sign(dy) * t.deadZone : cur[1];
		cur = [nx, ny];
		out.push(cur);
	}
	// A second, light pass removes the dead zone's corners.
	const s2 = Math.max(0.5, sigma / 3);
	const r2 = Math.ceil(3 * s2);
	return out.map((_, i) => {
		let sx = 0;
		let sy = 0;
		let sw = 0;
		for (let j = Math.max(0, i - r2); j <= Math.min(out.length - 1, i + r2); j++) {
			const w = Math.exp(-((j - i) ** 2) / (2 * s2 * s2));
			sx += w * out[j]![0];
			sy += w * out[j]![1];
			sw += w;
		}
		return [sx / sw, sy / sw];
	});
}

/**
 * Position (sequence px) that puts media point `subject` (normalised) at the frame centre, clamped so the scaled
 * picture still covers the frame. `box` = the clip's picture (anchor at its centre), `scale` in %.
 */
export function reframePosition(
	subject: readonly [number, number],
	box: { width: number; height: number },
	frame: { width: number; height: number },
	scale: number,
	anchor: readonly [number, number],
): [number, number] {
	const s = scale / 100;
	const pos = (axis: 0 | 1) => {
		const size = axis === 0 ? box.width : box.height;
		const f = axis === 0 ? frame.width : frame.height;
		const want = f / 2 - (subject[axis] * size - anchor[axis]) * s;
		// Covered when the picture's edges are outside the frame.
		const lo = f - (size - anchor[axis]) * s;
		const hi = anchor[axis] * s;
		return lo <= hi ? Math.min(hi, Math.max(lo, want)) : f / 2 - (size / 2 - anchor[axis]) * s;
	};
	return [pos(0), pos(1)];
}

/** Indexes of the samples that linear interpolation needs (error ≤ tol px, gaps ≤ maxGap samples). */
export function keyframeIndexes(values: readonly (readonly [number, number])[], tol = 1.5, maxGap = 60): number[] {
	const n = values.length;
	if (n <= 2) return Array.from({ length: n }, (_, i) => i);
	const keep = new Set<number>([0, n - 1]);
	const stack: [number, number][] = [[0, n - 1]];
	while (stack.length) {
		const [a, b] = stack.pop()!;
		if (b - a < 2) continue;
		let worst = -1;
		let err = 0;
		for (let i = a + 1; i < b; i++) {
			const t = (i - a) / (b - a);
			const ex = values[a]![0] + (values[b]![0] - values[a]![0]) * t;
			const ey = values[a]![1] + (values[b]![1] - values[a]![1]) * t;
			const e = Math.hypot(values[i]![0] - ex, values[i]![1] - ey);
			if (e > err) {
				err = e;
				worst = i;
			}
		}
		if (err > tol || b - a > maxGap) {
			const m = err > tol ? worst : Math.floor((a + b) / 2);
			keep.add(m);
			stack.push([a, m], [m, b]);
		}
	}
	return [...keep].sort((x, y) => x - y);
}

/** Media seconds shown at sequence frame `f` of a clip (in-point, speed; ignores Time Remapping). */
export function clipMediaSecondsAt(
	clip: { start: number; sourceIn?: number; speed?: { rate?: number; reverse?: boolean } },
	f: number,
	rate: Rational,
	flicksPerSecond: number,
): number {
	const sp = clip.speed?.rate ?? 1;
	const d = ((f - clip.start) * rate.den * sp) / rate.num;
	return (clip.sourceIn ?? 0) / flicksPerSecond + (clip.speed?.reverse ? -d : d);
}
