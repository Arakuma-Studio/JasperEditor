// Easing panel ▸ curve geometry shared by the editor, the library tiles and the menu thumbnails: the view's
// vertical range (the 0…1 square plus room for overshoot, in quarter steps) and curve ↔ pixel mapping.
import { type EaseCurve, easeCurveSegments } from '@jasper/project';
import { t } from '../../i18n/runtime.ts';
import { curveYRange, formatCubicBezier, type Vec } from './curve-edit.ts';

export const PAD = 14;

export function viewRange(curve: EaseCurve): { lo: number; hi: number } {
	const r = curveYRange(curve);
	return {
		lo: Math.min(-0.25, Math.floor((r.min - 0.05) * 4) / 4),
		hi: Math.max(1.25, Math.ceil((r.max + 0.05) * 4) / 4),
	};
}

/** `w` × `h` plot (padding included), `ox` px from the left of the drawing, y from `lo` to `hi`. */
export type CurveView = { w: number; h: number; lo: number; hi: number; ox?: number };

/** The widest plot for a height: time stays within 1.6× the value span, so curves keep their shape. */
export function plotWidth(w: number, h: number): number {
	return Math.min(w, Math.max(160, (h - 2 * PAD) * 1.6 + 2 * PAD));
}

export const toPx = (v: CurveView, p: Vec): [number, number] => [
	(v.ox ?? 0) + PAD + p[0] * (v.w - 2 * PAD),
	PAD + ((v.hi - p[1]) / (v.hi - v.lo || 1)) * (v.h - 2 * PAD),
];
export const fromPx = (v: CurveView, px: number, py: number): [number, number] => [
	(px - (v.ox ?? 0) - PAD) / Math.max(1, v.w - 2 * PAD),
	v.hi - ((py - PAD) / Math.max(1, v.h - 2 * PAD)) * (v.hi - v.lo),
];

/** SVG path of a curve in a view. */
export function curvePath(v: CurveView, curve: EaseCurve): string {
	const segs = easeCurveSegments(curve);
	const f = (p: Vec) =>
		toPx(v, p)
			.map((n) => n.toFixed(2))
			.join(' ');
	return `M${f(segs[0]![0])}${segs.map((s) => ` C${f(s[1])} ${f(s[2])} ${f(s[3])}`).join('')}`;
}

/** `cubic-bezier(…)` for a cubic, the point count for a multi curve. */
export function curveSummary(curve: EaseCurve): string {
	return curve.kind === 'cubic' ? formatCubicBezier(curve) : t('{0} points', curve.points.length);
}
