// Frame repaint (S11:ANM-014 render parity, S03:ARC-003): every captured frame is a fresh paint of that frame's DOM,
// whatever the page painted before.
//
// Chrome paints a page incrementally: after a DOM change it re-records only what changed and re-rasters only the
// invalidated rectangles of the tiles it already has ("partial raster"), keeping the rest of each tile from earlier
// frames. The pixels of a frame then depend on the frames the page painted before, although the DOM is identical:
// a dot shrinking inside a ring re-rasters a clip rectangle that cuts through the ring, whose anti-aliased edge then
// differs by up to 60/255 from a fresh paint of the same DOM. A renderer page visiting the frames in another order
// (renderFrames at concurrency 1 or 4, reversed, shuffled; renderStill uses a fresh page) or a Player revisiting a
// frame showed the same frame with different pixels.
//
// `repaintFromScratch` takes the subtree's layout objects down and rebuilds them in the same task (display: none, a
// forced layout, the previous display back), so the next paint invalidates every tile the subtree covers in full, as
// on a fresh page. React's DOM, component state and element-owned resources (canvas pixels, decoded images, media
// and iframe documents) are untouched; it costs one style/layout/paint of the subtree. `FrameRepaint` runs it in a
// layout effect, after the layers' own layout effects of the same commit (text measurement, DOM-leaf builds and
// seeks are synchronous there) and before the frame is painted: on every frame of a render, and in the Player for
// every paused frame (seeks, scrubbing, the frame playback stops on). Playback stays incremental and smooth.
import { type RefObject, useLayoutEffect } from 'react';
import { Internals, useCurrentFrame, useRemotionEnvironment } from 'remotion';

/**
 * Makes Chrome paint `el` and its subtree from scratch at the next paint (see the file comment). The inline
 * `display` of `el` (value and priority, or its absence) is restored exactly.
 */
function repaintFromScratch(el: HTMLElement): void {
	const { style } = el;
	const display = style.getPropertyValue('display');
	const priority = style.getPropertyPriority('display');
	style.setProperty('display', 'none', 'important');
	// Forced layout: the subtree's layout objects are destroyed now and rebuilt by the next lifecycle update.
	void el.offsetHeight;
	if (display) style.setProperty('display', display, priority);
	else style.removeProperty('display');
}

/**
 * Repaints `target` from scratch whenever the frame (or a value of `deps`, e.g. the document edited while paused)
 * changes: every rendered frame, and in the Player only while paused. Render it as the last child of the composition
 * root: React runs layout effects in tree order, so the layers have measured, built and seeked their DOM by then. On mount
 * nothing is needed (a new subtree's first paint is from scratch; the root's ref is attached after this effect).
 */
export function FrameRepaint({
	target,
	deps = [],
}: {
	target: RefObject<HTMLElement | null>;
	deps?: readonly unknown[];
}): null {
	const frame = useCurrentFrame();
	const [playing] = Internals.Timeline.usePlayingState();
	const enabled = useRemotionEnvironment().isRendering || !playing;
	// biome-ignore lint/correctness/useExhaustiveDependencies: the frame and `deps` are the triggers
	useLayoutEffect(() => {
		const el = target.current;
		if (enabled && el) repaintFromScratch(el);
	}, [target, enabled, frame, ...deps]);
	return null;
}
