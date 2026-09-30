// Spatial snapping in the Program monitor (S03 §10, SNP-001…005). Per axis, independent: candidates
// of the moving geometry against targets from the frame, safe margins and other layers; threshold 6
// screen px; tie-break center-to-center, then frame, guides, safe margins, layers.
import type { Rect } from '@jasper/project';

export type SnapKind = 'frame' | 'guide' | 'safe' | 'layer';
export type SnapTarget = {
	value: number;
	kind: SnapKind;
	/** min / center / max of the target geometry (center-to-center wins ties). */
	role: 'min' | 'center' | 'max';
	/** For layer targets: the target layer's extent on the other axis (indicator span). */
	extent?: [number, number];
	sourceId?: string;
};
export type SnapCandidate = { value: number; role: 'min' | 'center' | 'max' };
export type SnapHit = { delta: number; target: SnapTarget; candidate: SnapCandidate };
export type SnapTargets = { x: SnapTarget[]; y: SnapTarget[] };

export const SNAP_SCREEN_PX = 6;
const KIND_ORDER: Record<SnapKind, number> = { frame: 0, guide: 1, safe: 2, layer: 3 };

export function snapThreshold(viewScale: number): number {
	return SNAP_SCREEN_PX / viewScale;
}

/** Targets for a frame of W×H, optional safe margins (percent insets) and other layers' bounds. */
export function buildSnapTargets(opts: {
	width: number;
	height: number;
	safeMargins?: { action: number; title: number } | null;
	layers?: readonly { clipId: string; bounds: Rect }[];
}): SnapTargets {
	const { width: W, height: H } = opts;
	const x: SnapTarget[] = [
		{ value: 0, kind: 'frame', role: 'min' },
		{ value: W / 2, kind: 'frame', role: 'center' },
		{ value: W, kind: 'frame', role: 'max' },
	];
	const y: SnapTarget[] = [
		{ value: 0, kind: 'frame', role: 'min' },
		{ value: H / 2, kind: 'frame', role: 'center' },
		{ value: H, kind: 'frame', role: 'max' },
	];
	if (opts.safeMargins) {
		for (const pct of [opts.safeMargins.action, opts.safeMargins.title]) {
			x.push(
				{ value: (W * pct) / 100, kind: 'safe', role: 'min' },
				{ value: W - (W * pct) / 100, kind: 'safe', role: 'max' },
			);
			y.push(
				{ value: (H * pct) / 100, kind: 'safe', role: 'min' },
				{ value: H - (H * pct) / 100, kind: 'safe', role: 'max' },
			);
		}
	}
	for (const l of opts.layers ?? []) {
		const b = l.bounds;
		const ex: [number, number] = [b.y, b.y + b.height];
		const ey: [number, number] = [b.x, b.x + b.width];
		x.push(
			{ value: b.x, kind: 'layer', role: 'min', extent: ex, sourceId: l.clipId },
			{ value: b.x + b.width / 2, kind: 'layer', role: 'center', extent: ex, sourceId: l.clipId },
			{ value: b.x + b.width, kind: 'layer', role: 'max', extent: ex, sourceId: l.clipId },
		);
		y.push(
			{ value: b.y, kind: 'layer', role: 'min', extent: ey, sourceId: l.clipId },
			{ value: b.y + b.height / 2, kind: 'layer', role: 'center', extent: ey, sourceId: l.clipId },
			{ value: b.y + b.height, kind: 'layer', role: 'max', extent: ey, sourceId: l.clipId },
		);
	}
	return { x, y };
}

/** Candidates of a moving rect on one axis: min, center, max (SNP-003). */
export function rectCandidates(r: Rect, axis: 'x' | 'y'): SnapCandidate[] {
	const a = axis === 'x' ? r.x : r.y;
	const s = axis === 'x' ? r.width : r.height;
	return [
		{ value: a, role: 'min' },
		{ value: a + s / 2, role: 'center' },
		{ value: a + s, role: 'max' },
	];
}

/** Best snap on one axis (SNP-004), or null when nothing is within `tau`. */
export function snapAxis(
	candidates: readonly SnapCandidate[],
	targets: readonly SnapTarget[],
	tau: number,
): SnapHit | null {
	let best: SnapHit | null = null;
	const rank = (h: SnapHit) => [
		Math.abs(h.delta),
		h.candidate.role === 'center' && h.target.role === 'center' ? 0 : 1,
		KIND_ORDER[h.target.kind],
	];
	for (const c of candidates) {
		for (const t of targets) {
			const delta = t.value - c.value;
			if (Math.abs(delta) > tau) continue;
			const hit = { delta, target: t, candidate: c };
			if (!best) {
				best = hit;
				continue;
			}
			const a = rank(hit);
			const b = rank(best);
			const EPS = 1e-9;
			if (a[0]! < b[0]! - EPS) best = hit;
			else if (Math.abs(a[0]! - b[0]!) <= EPS && (a[1]! < b[1]! || (a[1] === b[1] && a[2]! < b[2]!)))
				best = hit;
		}
	}
	return best;
}

/** Snaps a moving rect (SNP-003 move): returns the corrected delta per axis and the hits. */
export function snapMove(
	moving: Rect,
	targets: SnapTargets,
	tau: number,
): { dx: number; dy: number; hits: { x: SnapHit | null; y: SnapHit | null } } {
	const hx = snapAxis(rectCandidates(moving, 'x'), targets.x, tau);
	const hy = snapAxis(rectCandidates(moving, 'y'), targets.y, tau);
	return { dx: hx?.delta ?? 0, dy: hy?.delta ?? 0, hits: { x: hx, y: hy } };
}
