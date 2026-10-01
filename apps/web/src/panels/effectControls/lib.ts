// Effect Controls pure helpers: mini-timeline range and ruler ticks (S03:EC-020), keyframe glyph
// shapes by interpolation (EC-022), snapping for key drags (EC-023) and the right-click
// interpolation presets (EC-024, S01:KF-004).
import type { Command, Ease, Interpolation, Keyframe } from '@jasper/project';

export type Range = { start: number; end: number };

/** Clip range padded so off-clip keys stay visible past the edges (S01:KF-006). */
export function clipRange(clip: { start: number; duration: number }): Range {
	const pad = Math.max(2, Math.round(clip.duration * 0.06));
	return { start: clip.start - pad, end: clip.start + clip.duration + pad };
}

export const pctOf = (r: Range, frame: number) => ((frame - r.start) / Math.max(1, r.end - r.start)) * 100;

const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 150, 300, 600, 900, 1800, 3600, 9000, 18000];

/** Ruler ticks: about `target` labelled ticks across the range. */
export function rulerTicks(r: Range, target = 6): number[] {
	const span = r.end - r.start;
	const step = TICK_STEPS.find((s) => span / s <= target) ?? TICK_STEPS[TICK_STEPS.length - 1]!;
	const out: number[] = [];
	for (let f = Math.ceil(Math.max(0, r.start) / step) * step; f <= r.end; f += step) out.push(f);
	return out;
}

type GlyphHalf = 'linear' | 'bezier' | 'auto' | 'hold';

const half = (i: Interpolation): GlyphHalf =>
	i === 'linear' ? 'linear' : i === 'hold' ? 'hold' : i === 'auto-bezier' ? 'auto' : 'bezier';

/**
 * Glyph halves of a key (S03:EC-022): the right half shows the outgoing segment (the key's own
 * interpolation); the left half the incoming one (held when the previous key holds).
 */
export function glyphHalves(
	kfs: readonly Pick<Keyframe<unknown>, 'interpolation'>[],
	i: number,
): { left: GlyphHalf; right: GlyphHalf } {
	const k = kfs[i]!;
	const prev = kfs[i - 1];
	return {
		left: prev?.interpolation === 'hold' ? 'hold' : half(k.interpolation),
		right: half(k.interpolation),
	};
}

/** SVG path (9×9 box centred at 4.5,4.5) for one half of a glyph. */
export function halfPath(kind: GlyphHalf, side: 'left' | 'right'): string {
	const s = side === 'left' ? -1 : 1;
	const x = (dx: number) => 4.5 + s * dx;
	switch (kind) {
		case 'linear': // diamond
			return `M4.5 0.5 L${x(4)} 4.5 L4.5 8.5 Z`;
		case 'hold': // square
			return `M4.5 0.5 L${x(4)} 0.5 L${x(4)} 8.5 L4.5 8.5 Z`;
		case 'auto': // circle
			return `M4.5 0.5 A4 4 0 0 ${side === 'left' ? 0 : 1} 4.5 8.5 Z`;
		case 'bezier': // hourglass
			return `M4.5 0.5 L${x(4)} 0.5 L4.5 4.5 L${x(4)} 8.5 L4.5 8.5 Z`;
	}
}

/**
 * Snaps a drag delta so the grabbed key lands on a candidate frame (playhead, other keys, clip edges)
 * when within `thresholdFrames` (S03:EC-023). Returns the adjusted delta.
 */
export function snapDelta(
	grabbedFrame: number,
	delta: number,
	candidates: readonly number[],
	thresholdFrames: number,
): number {
	const target = grabbedFrame + delta;
	let best: number | null = null;
	for (const c of candidates) {
		const d = Math.abs(c - target);
		if (d <= thresholdFrames && (best === null || d < Math.abs(best - target))) best = c;
	}
	return best === null ? delta : Math.round(best - grabbedFrame);
}

export type InterpolationPreset =
	| 'linear'
	| 'bezier'
	| 'auto-bezier'
	| 'continuous-bezier'
	| 'hold'
	| 'ease-in'
	| 'ease-out'
	| 'easy-ease';

export const INTERPOLATION_MENU: { preset: InterpolationPreset; label: string }[] = [
	{ preset: 'linear', label: 'Linear' },
	{ preset: 'bezier', label: 'Bezier' },
	{ preset: 'auto-bezier', label: 'Auto Bezier' },
	{ preset: 'continuous-bezier', label: 'Continuous Bezier' },
	{ preset: 'hold', label: 'Hold' },
	{ preset: 'ease-in', label: 'Ease In' },
	{ preset: 'ease-out', label: 'Ease Out' },
	{ preset: 'easy-ease', label: 'Easy Ease' },
];

const EASY: Ease = { influence: 1 / 3, slope: 0 };

/** Document command for an interpolation preset (S01:KF-004: Ease In/Out set the side's ease to {⅓, 0}). */
export function interpolationCommand(keyframeIds: string[], preset: InterpolationPreset): Command {
	const base = { type: 'keyframe.setInterpolation' as const, keyframeIds };
	switch (preset) {
		case 'ease-in':
			return { ...base, interpolation: 'bezier', easeIn: EASY } as Command;
		case 'ease-out':
			return { ...base, interpolation: 'bezier', easeOut: EASY } as Command;
		case 'easy-ease':
			return { ...base, interpolation: 'bezier', easeIn: EASY, easeOut: EASY } as Command;
		default:
			return { ...base, interpolation: preset } as Command;
	}
}
