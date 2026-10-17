// Shared pieces of the anime template implementations (S11 §5): the design stage (design pixels fitted into the
// render canvas with `fitCanvas`, ATP-003), intro/outro scheduling on one paused timeline (ATP-004: the intro
// starts at content 0, the outro ends at the content end and plays the intro backwards) and small helpers.
// Value engine only (S11:ANM-004): builds animate plain objects; React renders inline styles from their values.
import { type Fit, fitCanvas, type Phase, phaseTimes, type TemplateTiming } from '@jasper/mg-templates';
import type { CSSProperties, ReactNode } from 'react';
import { resolveEase, seededRandom, type Timeline } from '../runtime/index.ts';

// The phases and their placement are shared with the templates' sound-design motion model (@jasper/mg-templates
// `anime/motion.ts`): one source for when every tween runs.
export { type Phase, phaseTimes, type TemplateTiming };

/** Text stack of the templates (the fframes templates use the same family list). */
export const TEMPLATE_FONT = "Inter, 'Inter 24pt', 'Source Sans 3', 'Source Sans Pro', Arial, sans-serif";

/**
 * Adds one animated property group of a target: the intro tween at `at·introMs` for `dur·introMs` from
 * `from` → `to`, and its mirror in the outro window (`to` → `from`), so the outro plays the intro backwards.
 * Values are explicit `[from, to]` (S11:ANM-005; build-time captures are unsafe, R-ANM §1).
 */
export function addInOut(
	tl: Timeline,
	t: TemplateTiming,
	target: Record<string, number>,
	values: Record<string, [number, number]>,
	phase: Phase,
	opts: { outro?: boolean } = {},
): void {
	const introProps: Record<string, [number, number]> = {};
	const outroProps: Record<string, [number, number]> = {};
	for (const [k, [from, to]] of Object.entries(values)) {
		introProps[k] = [from, to];
		outroProps[k] = [to, from];
	}
	const pt = phaseTimes(t, phase);
	tl.add(target, { ...introProps, duration: pt.introDur, ease: phase.ease ?? 'out' }, pt.introStart);
	if (opts.outro === false || pt.outroStart === null) return;
	tl.add(target, { ...outroProps, duration: pt.outroDur, ease: phase.outEase ?? 'in' }, pt.outroStart);
}

/** The ease string of a template `ease` param (unknown names fall back to `out`). */
export function easeOf(name: string): string {
	const e = resolveEase(name);
	return typeof e === 'string' ? e : 'out';
}

/**
 * Rank of each of `n` units in the stagger order: forward (0…n−1), from the centre out, or a permutation drawn
 * from the clip seed (S11:ANM-007).
 */
export function staggerRanks(n: number, order: 'forward' | 'center' | 'random', seed: number): number[] {
	const perm = Array.from({ length: n }, (_, i) => i);
	if (order !== 'center' && order !== 'random') return perm;
	if (order === 'center') {
		const mid = (n - 1) / 2;
		perm.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid) || a - b);
	} else {
		const rnd = seededRandom(seed);
		for (let i = perm.length - 1; i > 0; i--) {
			const j = Math.floor(rnd() * (i + 1));
			[perm[i], perm[j]] = [perm[j]!, perm[i]!];
		}
	}
	const ranks = new Array<number>(n);
	perm.forEach((unit, rank) => {
		ranks[unit] = rank;
	});
	return ranks;
}

/** Design canvas for a render canvas (closest aspect of 16:9 / 9:16 / 1:1, uniform contain). */
export function templateFit(canvas: { width: number; height: number }): Fit {
	return fitCanvas(Math.max(1, canvas.width), Math.max(1, canvas.height));
}

/**
 * The render canvas with a design-space stage inside (position, size and scale of `fit`). Children are laid out in
 * design pixels. The canvas clips its content (`overflow: hidden`, like the fframes SVG twin): what a template draws
 * outside its canvas is never shown, so the Player, `renderStill` and the hybrid export (whose crop rect is the
 * layer box plus a bleed, `contentBleed` 0 for motion graphics) agree. Parts may still leave the design stage when
 * the canvas is wider than the design aspect (the stage is fitted with `contain`).
 */
export function DesignStage({ fit, children, label }: { fit: Fit; children: ReactNode; label: string }) {
	const outer: CSSProperties = { position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' };
	const stage: CSSProperties = {
		position: 'absolute',
		left: 0,
		top: 0,
		width: fit.designW,
		height: fit.designH,
		transformOrigin: '0 0',
		transform: `translate(${fit.offsetX}px, ${fit.offsetY}px) scale(${fit.scale})`,
	};
	return (
		<div data-anime-template={label} style={outer}>
			<div data-design-stage="" style={stage}>
				{children}
			</div>
		</div>
	);
}

/** Text segments with a stable React key: their offset in the text. */
export function keyedSegments<S extends { text: string }>(segments: readonly S[]): { seg: S; key: string }[] {
	let offset = 0;
	return segments.map((seg) => {
		const key = `o${offset}`;
		offset += seg.text.length;
		return { seg, key };
	});
}

/** Rounds a style number for stable markup (sub-pixel precision kept, float noise dropped). */
export function px(n: number): number {
	return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0;
}
