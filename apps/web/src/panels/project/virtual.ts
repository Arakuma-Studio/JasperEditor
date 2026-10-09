// Row windowing for the Project panel (workstream ui-perf, docs/performance.md §5): with thousands of items the list
// (a table row per item, nine columns) and the icon grid (a poster per item) made every render and every scrolled
// frame pay for all of them (opening a 2 000-item project took seconds; scrolling ran at ≈ 30 fps, layerization
// bound). From `VIRTUALIZE_MIN_ROWS` items on, only the rows in view (plus a screen of overscan) are rendered between
// two spacers that keep the scroll height; smaller bins render every row as before.
import { type RefObject, useEffect, useLayoutEffect, useState } from 'react';

/** Bins with fewer items render every row (identical DOM to before windowing). */
export const VIRTUALIZE_MIN_ROWS = 200;
/** Rows rendered before the first measurement. */
const INITIAL_ROWS = 80;

export type RowWindow = {
	/** Whether windowing is on (the views render spacers). */
	on: boolean;
	/** Rendered grid rows `[start, end)`. */
	start: number;
	end: number;
	/** Measured height of one row (gap included). */
	rowH: number;
};

/**
 * The rows of a list or grid (`rows` grid rows, laid out from the top of `list` inside the scroll container `scroll`)
 * that are in view, plus one screen of overscan above and below. `measure(list)` returns the height of one row.
 */
export function useRowWindow(opts: {
	scroll: RefObject<HTMLElement | null>;
	list: RefObject<HTMLElement | null>;
	rows: number;
	enabled: boolean;
	measure(list: HTMLElement): number | null;
	/** Grid row of an item to bring into view (Reveal in Project). */
	reveal?: number | null;
}): RowWindow {
	const { scroll, list, rows, enabled, measure } = opts;
	const [win, setWin] = useState<RowWindow>({ on: false, start: 0, end: rows, rowH: 0 });
	const on = enabled && rows >= 1;
	useLayoutEffect(() => {
		if (!on) {
			setWin((w) => (w.on || w.end !== rows ? { on: false, start: 0, end: rows, rowH: 0 } : w));
			return;
		}
		const el = scroll.current;
		let raf = 0;
		let rowH = 0;
		const update = () => {
			raf = 0;
			const s = scroll.current;
			const l = list.current;
			if (!s || !l) return;
			rowH = measure(l) ?? rowH;
			if (!(rowH > 0)) {
				setWin((w) =>
					w.on && w.start === 0 && w.end === Math.min(rows, INITIAL_ROWS)
						? w
						: { on: true, start: 0, end: Math.min(rows, INITIAL_ROWS), rowH: 0 },
				);
				return;
			}
			const top = l.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop;
			const view = s.clientHeight || 600;
			const first = Math.floor((s.scrollTop - top) / rowH);
			const last = Math.ceil((s.scrollTop + view - top) / rowH);
			const over = Math.ceil(view / rowH);
			const start = Math.max(0, Math.min(rows, first - over));
			const end = Math.max(start, Math.min(rows, last + over));
			setWin((w) =>
				w.on && w.start === start && w.end === end && w.rowH === rowH ? w : { on: true, start, end, rowH },
			);
		};
		const schedule = () => {
			if (!raf) raf = requestAnimationFrame(update);
		};
		update();
		// A second pass once the first rows are laid out (their height is the row height).
		schedule();
		el?.addEventListener('scroll', schedule, { passive: true });
		const ro = typeof ResizeObserver !== 'undefined' && el ? new ResizeObserver(schedule) : null;
		if (ro && el) ro.observe(el);
		return () => {
			if (raf) cancelAnimationFrame(raf);
			el?.removeEventListener('scroll', schedule);
			ro?.disconnect();
		};
	}, [on, rows, scroll, list, measure]);

	// Reveal: scroll a row that is not rendered into view (nearest edge), so the panel can find its element.
	const reveal = opts.reveal ?? null;
	useEffect(() => {
		if (!on || reveal === null || reveal < 0 || !(win.rowH > 0)) return;
		const s = scroll.current;
		const l = list.current;
		if (!s || !l) return;
		const top = l.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop;
		const y0 = top + reveal * win.rowH;
		const y1 = y0 + win.rowH;
		if (y0 < s.scrollTop) s.scrollTop = y0;
		else if (y1 > s.scrollTop + s.clientHeight) s.scrollTop = y1 - s.clientHeight;
	}, [on, reveal, win.rowH, scroll, list]);

	return on ? win : { on: false, start: 0, end: rows, rowH: 0 };
}
