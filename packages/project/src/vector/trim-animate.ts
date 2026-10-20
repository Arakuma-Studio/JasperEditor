// One-click Trim Paths animations (docs/wp-notes/shapes.md § Trim Paths animations): the keys, expressions and part
// layout `shape.animateTrim` writes, as pure data. Path parameter u ∈ [0, 1] runs along the path in its direction;
// p ∈ [0, 1] is the eased progress of a segment. The visible parts per style:
//   in        [0, p]                       reverse [1 − p, 1]
//   out       [p, 1]                       reverse [0, 1 − p]
//   inOut     [tail, head], head = p over [0, D], tail = p over [lag·D, lag·D + D]; reverse [1 − head, 1 − tail]
//   middleIn  [½ − p/2, ½ + p/2]           reverse [0, p/2] ∪ [1 − p/2, 1]
//   middleOut [p/2, 1 − p/2]               reverse [0, (1 − p)/2] ∪ [1 − (1 − p)/2, 1]
//   divideIn  ∪ᵢ [(i−1)/N, (i−1)/N + p/N]  reverse ∪ᵢ [i/N − p/N, i/N]
//   divideOut ∪ᵢ [(i−1)/N + p/N, i/N]      reverse ∪ᵢ [(i−1)/N, i/N − p/N]
// The two-sided reverse middle styles trim [0, end] and shift it back by half its length with an offset expression
// linked to the trim's own End (offset = value − 1.8 · End degrees, 360° = one length). Divide styles duplicate the
// contents into N parts; part i's trim follows part 1's (the master's) Start / End and adds (i − 1) · 360 / N to its
// Offset, all by item id so renames never break them.
import type { CubicEase } from '../ease/curve.ts';
import type { ShapeItem, ShapeItemOf } from '../schema/shapes.ts';

export const TRIM_ANIMATION_STYLES = [
	'in',
	'out',
	'inOut',
	'middleIn',
	'middleOut',
	'divideIn',
	'divideOut',
] as const;
export type TrimAnimationStyle = (typeof TRIM_ANIMATION_STYLES)[number];

export const TRIM_ANIMATION_DEFAULTS = {
	durationFrames: 10,
	offsetDegrees: 180,
	copies: 4,
	inOutLag: 0.5,
} as const;
export const TRIM_ANIMATION_LIMITS = {
	durationFrames: 100_000,
	offsetDegrees: 36_000,
	minCopies: 2,
	maxCopies: 64,
	/** Most shape items a divided clip may hold (N parts × the items of one part). */
	maxDividedItems: 20_000,
} as const;

/** Entering motion (draw on): fast start, gentle stop — cubic-bezier(⅓, ⅓, ⅔, 1). */
export const TRIM_ENTER_EASE: CubicEase = { kind: 'cubic', x1: 1 / 3, y1: 1 / 3, x2: 2 / 3, y2: 1 };
/** Exiting motion (wipe off): gentle start, fast stop — cubic-bezier(⅓, 0, ⅔, ⅔). */
export const TRIM_EXIT_EASE: CubicEase = { kind: 'cubic', x1: 1 / 3, y1: 0, x2: 2 / 3, y2: 2 / 3 };
/** cubic-bezier(⅓, ⅓, ⅔, ⅔): constant speed (inOut's offset spin across both phases). */
export const TRIM_LINEAR_EASE: CubicEase = { kind: 'cubic', x1: 1 / 3, y1: 1 / 3, x2: 2 / 3, y2: 2 / 3 };

/** The curve of the same motion run backwards in time: cubic(1 − x2, 1 − y2, 1 − x1, 1 − y1). */
export function mirrorCubicEase(c: CubicEase): CubicEase {
	return { kind: 'cubic', x1: 1 - c.x2, y1: 1 - c.y2, x2: 1 - c.x1, y2: 1 - c.y1 };
}

export type TrimAnimationOptions = {
	style: TrimAnimationStyle;
	reverse?: boolean;
	animateOffset?: boolean;
	durationFrames?: number;
	offsetDegrees?: number;
	copies?: number;
	inOutLag?: number;
	curve?: CubicEase;
};

/** One animated segment, `from` at `startFrame` to `to` at `endFrame` (sequence frames after the animation start). */
export type TrimSegment = {
	startFrame: number;
	endFrame: number;
	from: number;
	to: number;
	curve: CubicEase;
};
/** A trim property: a static value or one segment. */
export type TrimChannel = { value: number; segment: TrimSegment | null };

export type TrimAnimationPlan = {
	start: TrimChannel;
	end: TrimChannel;
	/** The master trim's Offset (degrees). With `linkedOffset` the expression adds −1.8 · End to it. */
	offset: TrimChannel;
	linkedOffset: boolean;
	/** Number of parts for the divide styles, else null. */
	parts: number | null;
	/** Frames from the first key to the last. */
	totalFrames: number;
};

const finiteOr = (v: number | undefined, d: number) => (v !== undefined && Number.isFinite(v) ? v : d);

/** The keys and expressions of a style (see the module comment for the visible parts). */
export function planTrimAnimation(o: TrimAnimationOptions): TrimAnimationPlan {
	const D = Math.max(1, finiteOr(o.durationFrames, TRIM_ANIMATION_DEFAULTS.durationFrames));
	const lag = Math.min(1, Math.max(0, finiteOr(o.inOutLag, TRIM_ANIMATION_DEFAULTS.inOutLag)));
	const rev = !!o.reverse;
	const enter = o.curve ?? TRIM_ENTER_EASE;
	const exit = o.curve ?? TRIM_EXIT_EASE;
	const still = (value: number): TrimChannel => ({ value, segment: null });
	const anim = (from: number, to: number, curve: CubicEase, at = 0): TrimChannel => ({
		value: from,
		segment: { startFrame: at, endFrame: at + D, from, to, curve },
	});
	let start: TrimChannel;
	let end: TrimChannel;
	let linkedOffset = false;
	let parts: number | null = null;
	let total = D;
	let offsetCurve = enter;
	switch (o.style) {
		case 'in':
			[start, end] = rev ? [anim(100, 0, enter), still(100)] : [still(0), anim(0, 100, enter)];
			break;
		case 'out':
			[start, end] = rev ? [still(0), anim(100, 0, exit)] : [anim(0, 100, exit), still(100)];
			offsetCurve = exit;
			break;
		case 'inOut': {
			const L = lag * D;
			[start, end] = rev
				? [anim(100, 0, enter), anim(100, 0, exit, L)]
				: [anim(0, 100, exit, L), anim(0, 100, enter)];
			total = D + L;
			offsetCurve = o.curve ?? TRIM_LINEAR_EASE;
			break;
		}
		case 'middleIn':
			if (rev) {
				[start, end] = [still(0), anim(0, 100, enter)];
				linkedOffset = true;
			} else [start, end] = [anim(50, 0, enter), anim(50, 100, enter)];
			break;
		case 'middleOut':
			if (rev) {
				[start, end] = [still(0), anim(100, 0, exit)];
				linkedOffset = true;
			} else [start, end] = [anim(0, 50, exit), anim(100, 50, exit)];
			offsetCurve = exit;
			break;
		case 'divideIn':
		case 'divideOut': {
			const N = Math.round(
				Math.min(
					TRIM_ANIMATION_LIMITS.maxCopies,
					Math.max(TRIM_ANIMATION_LIMITS.minCopies, finiteOr(o.copies, TRIM_ANIMATION_DEFAULTS.copies)),
				),
			);
			const s = 100 / N;
			parts = N;
			if (o.style === 'divideIn')
				[start, end] = rev ? [anim(s, 0, enter), still(s)] : [still(0), anim(0, s, enter)];
			else {
				[start, end] = rev ? [still(0), anim(s, 0, exit)] : [anim(0, s, exit), still(s)];
				offsetCurve = exit;
			}
			break;
		}
	}
	const degrees = Math.min(
		TRIM_ANIMATION_LIMITS.offsetDegrees,
		Math.max(
			-TRIM_ANIMATION_LIMITS.offsetDegrees,
			finiteOr(o.offsetDegrees, TRIM_ANIMATION_DEFAULTS.offsetDegrees),
		),
	);
	const offset: TrimChannel = o.animateOffset
		? {
				value: 0,
				segment: {
					startFrame: 0,
					endFrame: total,
					from: 0,
					to: rev ? -degrees : degrees,
					curve: offsetCurve,
				},
			}
		: still(0);
	return { start, end, offset, linkedOffset, parts, totalFrames: total };
}

const q = (id: string) => JSON.stringify(id);

/** Offset of the two-sided reverse middle styles: the keyed value minus half of the visible length. */
export function trimLinkedOffsetExpression(trimId: string): string {
	return `value + -1.8 * content(${q(trimId)}).end`;
}

/** Start / End of part 2…N: the master trim's (inside part 1). */
export function trimPartExpression(partId: string, masterId: string, field: 'start' | 'end'): string {
	return `content(${q(partId)}).content(${q(masterId)}).${field}`;
}

/** Offset of part 2…N: its own value ((i − 1) · 360 / N) plus the master's offset. */
export function trimPartOffsetExpression(partId: string, masterId: string): string {
	return `value + content(${q(partId)}).content(${q(masterId)}).offset`;
}

type Group = ShapeItemOf<'group'>;
type Trim = ShapeItemOf<'trim'>;

const lastTrimOf = (g: ShapeItem): Trim | null => {
	if (g.type !== 'group') return null;
	const last = g.contents[g.contents.length - 1];
	return last?.type === 'trim' ? last : null;
};

const exprText = (a: { expression?: { text: string } }) => a.expression?.text;

/**
 * The parts of an earlier divide animation among a vector shape's top-level items: a group (part 1) ending with the
 * master trim, and the groups whose last trim follows it through the exact part expressions (by id). Null when there
 * are none. Detection needs no marker in the document, so it survives renames and saving.
 */
export function findTrimParts(
	contents: readonly ShapeItem[],
): { master: Group; trim: Trim; linked: Group[] } | null {
	for (const g of contents) {
		const m = lastTrimOf(g);
		if (!m) continue;
		const linked: Group[] = [];
		for (const other of contents) {
			if (other === g) continue;
			const t = lastTrimOf(other);
			if (
				t &&
				exprText(t.start) === trimPartExpression(g.id, m.id, 'start') &&
				exprText(t.end) === trimPartExpression(g.id, m.id, 'end') &&
				exprText(t.offset) === trimPartOffsetExpression(g.id, m.id)
			)
				linked.push(other as Group);
		}
		if (linked.length) return { master: g as Group, trim: m, linked };
	}
	return null;
}
