// Spec 19 TL-086: the window of a virtualised card grid. Pure: which cards are mounted for a scroll position.

export type GridInput = {
	/** Inner width of the scroller, px. */
	width: number;
	scrollTop: number;
	/** Visible height of the scroller, px. */
	viewport: number;
	count: number;
	/** Smallest tile width, px. */
	tile: number;
	gap: number;
	/** Height of everything in a card under the poster, px. */
	footer: number;
	/** Rows mounted beyond the visible ones, each way. */
	overscan?: number;
};

export type GridWindow = {
	columns: number;
	cellWidth: number;
	cellHeight: number;
	/** Height of all rows. */
	totalHeight: number;
	/** First and one past the last mounted card. */
	start: number;
	end: number;
	/** Top of the first mounted row. */
	top: number;
};

export function gridWindow(g: GridInput): GridWindow {
	const width = Math.max(1, g.width);
	const columns = Math.max(1, Math.floor((width + g.gap) / (g.tile + g.gap)));
	const cellWidth = Math.max(1, (width - (columns - 1) * g.gap) / columns);
	const cellHeight = Math.round((cellWidth * 9) / 16) + g.footer;
	const rows = Math.ceil(Math.max(0, g.count) / columns);
	const step = cellHeight + g.gap;
	const overscan = g.overscan ?? 1;
	const scroll = Math.max(0, Number.isFinite(g.scrollTop) ? g.scrollTop : 0);
	const firstRow = Math.max(0, Math.floor(scroll / step) - overscan);
	const lastRow = Math.min(rows - 1, Math.floor((scroll + Math.max(0, g.viewport)) / step) + overscan);
	return {
		columns,
		cellWidth,
		cellHeight,
		totalHeight: rows > 0 ? rows * step - g.gap : 0,
		start: Math.min(g.count, firstRow * columns),
		end: Math.min(g.count, (lastRow + 1) * columns),
		top: firstRow * step,
	};
}

/** The card a key moves to: left, right, up or down inside the grid. */
export function gridStep(index: number, key: string, columns: number, count: number): number {
	const last = count - 1;
	switch (key) {
		case 'ArrowLeft':
			return Math.max(0, index - 1);
		case 'ArrowRight':
			return Math.min(last, index + 1);
		case 'ArrowUp':
			return index - columns >= 0 ? index - columns : index;
		case 'ArrowDown':
			return Math.min(last, index + columns);
		case 'Home':
			return 0;
		case 'End':
			return last;
		default:
			return index;
	}
}

/** Scroll position that brings a card's row into view. */
export function scrollToCard(
	index: number,
	w: Pick<GridWindow, 'columns' | 'cellHeight'>,
	gap: number,
	scrollTop: number,
	viewport: number,
): number {
	const step = w.cellHeight + gap;
	const y = Math.floor(index / w.columns) * step;
	if (y < scrollTop) return y;
	if (y + w.cellHeight > scrollTop + viewport) return y + w.cellHeight - viewport;
	return scrollTop;
}
