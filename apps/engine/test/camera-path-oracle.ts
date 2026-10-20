/**
 * Maximum position error after the least-squares best similarity, divided by the
 * full truth path length. Only for straight, constant-speed authored trajectories.
 * Null positions omit unsolved observations without shortening the truth span.
 * Rank-one derivation: docs/test-cleanup/camera-metric-correction.md.
 */
export function collinearPathError(
	centers: readonly (readonly number[] | null)[],
	truthFrameCount: number,
): number {
	if (truthFrameCount < 2 || centers.some((center, frame) => center !== null && frame >= truthFrameCount))
		return Number.POSITIVE_INFINITY;
	const samples = centers.flatMap((center, frame) =>
		center ? [{ center, t: frame / (truthFrameCount - 1) }] : [],
	);
	if (samples.length < 3) return Number.POSITIVE_INFINITY;
	const mean = [0, 1, 2].map((j) => samples.reduce((sum, p) => sum + p.center[j]!, 0) / samples.length);
	const meanT = samples.reduce((sum, p) => sum + p.t, 0) / samples.length;
	const centered = samples.map((p) => ({ x: p.center.map((v, j) => v - mean[j]!), u: p.t - meanT }));
	const covariance = [0, 1, 2].map((j) => centered.reduce((sum, p) => sum + p.u * p.x[j]!, 0));
	const magnitude = Math.hypot(...covariance);
	const variance = centered.reduce((sum, p) => sum + p.x.reduce((s, v) => s + v * v, 0), 0);
	if (!(variance > 0)) return Number.POSITIVE_INFINITY;
	if (magnitude === 0) return Math.max(...centered.map(({ u }) => Math.abs(u)));
	const direction = covariance.map((v) => v / magnitude);
	const scale = magnitude / variance;
	return Math.max(
		...centered.map(({ x, u }) => {
			const axial = x.reduce((sum, v, j) => sum + v * direction[j]!, 0);
			const perpendicular = Math.hypot(...x.map((v, j) => v - axial * direction[j]!));
			return Math.hypot(scale * axial - u, scale * perpendicular);
		}),
	);
}
