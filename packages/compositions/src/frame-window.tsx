// A `<Sequence>` renders nothing outside `[from − premountFor, from +
// durationInFrames)`, yet every one of them re-renders whenever the frame or the document changes (it reads the
// timeline position). On a 1 000-clip sequence that is 1 000 Sequences per played frame and per gesture frame.
// `FrameWindow` mounts only the items whose span lies within a page-aligned window around the current frame: the
// pages are `PAGE` frames long and the window reaches one page before and two after the current page, so every item
// that draws (or premounts) at the current frame is mounted, and the list changes once per page while playing. The
// rendered DOM is identical: an item outside its span renders nothing either way.
import { type ReactNode, useMemo } from 'react';
import { useCurrentFrame } from 'remotion';

/** Window granularity (frames). */
const FRAME_WINDOW_PAGE = 60;

/** The item's `[first, end)` frame span in the parent Sequence's frame space, premount included. */
export type FrameSpan = readonly [number, number];

/** Whether `span` intersects the window of `page` (pages of `FRAME_WINDOW_PAGE` frames). */
function inFrameWindow(span: FrameSpan, page: number): boolean {
	const lo = (page - 1) * FRAME_WINDOW_PAGE;
	const hi = (page + 2) * FRAME_WINDOW_PAGE;
	// One frame of slack on both sides for Remotion's rounding of fractional sequence ends.
	return span[0] - 1 < hi && span[1] + 1 > lo;
}

function framePage(frame: number): number {
	return Math.floor(frame / FRAME_WINDOW_PAGE);
}

/**
 * Renders `render(item)` for the items of `items` whose `span(item)` intersects the window around the current frame.
 * Re-renders every frame (it reads the frame) but returns the same elements within a page, so React skips them.
 */
export function FrameWindow<T>(props: {
	items: readonly T[];
	span(item: T): FrameSpan;
	render(item: T): ReactNode;
}): ReactNode {
	const page = framePage(useCurrentFrame());
	const { items, span, render } = props;
	return useMemo(() => {
		const out: ReactNode[] = [];
		for (const item of items) if (inFrameWindow(span(item), page)) out.push(render(item));
		return out;
	}, [items, span, render, page]);
}
