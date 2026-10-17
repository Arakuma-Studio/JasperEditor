// Text units for animators (S11:TXA-010/011, R-ANM §2): segmentation with Intl.Segmenter (anime.js `splitText`
// is banned: it rewrites React-owned DOM and measures with getBoundingClientRect; the pure segmentation lives in
// `@jasper/mg-templates`, shared with the anime templates' motion model) and line grouping by layout boxes
// (`offsetTop`/`offsetHeight`, unaffected by ancestor transforms).

export type TextUnit = 'char' | 'word' | 'line';

export { needsShaping, segmentText, type TextSegment } from '@jasper/mg-templates';

/** Top of an element's layout box in page space: the offsetTop chain (ignores CSS transforms, R-ANM §2). */
function layoutTop(el: HTMLElement): number {
	let y = 0;
	for (let n: HTMLElement | null = el; n && 'offsetTop' in n; n = n.offsetParent as HTMLElement | null)
		y += n.offsetTop;
	return y;
}

/**
 * Line index of every element matching `selector` inside `container`, in document order, from layout boxes
 * (`offsetTop`/`offsetHeight` summed along the offset-parent chain, so units nested in positioned wrappers, e.g.
 * per-line masks, compare in one space; ancestor transforms — rotation, flip, corner pin, monitor zoom — are
 * ignored). An element starts a new line when its vertical centre lies below the bottom of the current line
 * (robust to mixed font sizes on one line and to line-height < 1). Call it after layout, on a displayed
 * container (`display: none` has no layout boxes: everything lands on line 0).
 */
export function groupLines(container: HTMLElement, selector: string): number[] {
	const out: number[] = [];
	const origin = layoutTop(container);
	let line = -1;
	let bottom = Number.NEGATIVE_INFINITY;
	for (const el of container.querySelectorAll<HTMLElement>(selector)) {
		const top = layoutTop(el) - origin;
		const height = el.offsetHeight;
		if (line < 0 || top + height / 2 > bottom) {
			line++;
			bottom = top + height;
		} else bottom = Math.max(bottom, top + height);
		out.push(line);
	}
	return out;
}
