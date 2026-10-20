// Geometry of the Review panel's item list (Phase 3 verification: the list is virtualised so a proposal of hundreds
// of items renders only what is in view). Pure: the groups' headers and rows stacked with fixed heights (a row is two
// lines, plus a line for its folded setup items and one per setup item when unfolded), and the range of entries a
// scroll position shows.
import type { ReviewGroup, ReviewModel, ReviewRow } from '../../proposals/review.ts';

/**
 * The heights the rows are drawn at, from the root font size (the UI scale): a row's first line is `h-5` (1.25 rem), its
 * small-text lines `h-[1.375rem]`, with `py-0.5` and a 1 px border; a group header is 1.25 rem. The row component sets
 * the same heights explicitly, so the stacked layout and what is drawn agree at every UI scale.
 */
export type ReviewListMetrics = { header: number; row: number; line: number };

/** The metrics at a root font size in px (the editor's is 12 px; 14 px with the larger UI). */
export function reviewListMetrics(remPx = 12): ReviewListMetrics {
	const rem = Number.isFinite(remPx) && remPx > 0 ? remPx : 12;
	const line = 1.375 * rem; // a small-text line (`h-[1.375rem]`, its own leading)
	return { header: 1.25 * rem, row: 1.25 * rem + line + 0.25 * rem + 1, line };
}

/** Drawn beyond the visible part above and below (px). */
export const REVIEW_OVERSCAN_PX = 480;

export type ReviewListEntry =
	| { kind: 'header'; group: ReviewGroup; top: number; height: number }
	| { kind: 'row'; group: ReviewGroup; row: ReviewRow; top: number; height: number; position: number };

export type ReviewListLayout = {
	entries: ReviewListEntry[];
	/** Height of everything (px). */
	total: number;
	/** Each group's top and height (header included). */
	groups: { group: ReviewGroup; top: number; height: number }[];
	/** Row entry index by item id. */
	rowIndex: Record<string, number>;
	/** Rows in all (an option's `aria-setsize`). */
	rows: number;
	metrics: ReviewListMetrics;
};

/** The height of a row: two lines, plus the setup toggle line, plus one line per setup item when unfolded. */
export function reviewRowHeight(
	row: ReviewRow,
	expanded: boolean,
	m: ReviewListMetrics = reviewListMetrics(),
): number {
	if (!row.setup.length) return m.row;
	return m.row + m.line + (expanded ? row.setup.length * m.line : 0);
}

export function reviewListLayout(
	model: ReviewModel,
	expanded: ReadonlySet<string>,
	m: ReviewListMetrics = reviewListMetrics(),
): ReviewListLayout {
	const entries: ReviewListEntry[] = [];
	const groups: ReviewListLayout['groups'] = [];
	const rowIndex: Record<string, number> = {};
	let top = 0;
	let position = 0;
	for (const group of model.groups) {
		const groupTop = top;
		entries.push({ kind: 'header', group, top, height: m.header });
		top += m.header;
		for (const row of group.rows) {
			const height = reviewRowHeight(row, expanded.has(row.item.id), m);
			rowIndex[row.item.id] = entries.length;
			entries.push({ kind: 'row', group, row, top, height, position: position++ });
			top += height;
		}
		groups.push({ group, top: groupTop, height: top - groupTop });
	}
	return { entries, total: top, groups, rowIndex, rows: position, metrics: m };
}

/** First entry whose bottom is below `y` (binary search over the stacked entries). */
function firstBelow(entries: readonly ReviewListEntry[], y: number): number {
	let lo = 0;
	let hi = entries.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		const e = entries[mid]!;
		if (e.top + e.height <= y) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** The entries [start, end) a scroll position shows, with the overscan. */
export function visibleEntries(
	layout: ReviewListLayout,
	scrollTop: number,
	viewport: number,
	overscan = REVIEW_OVERSCAN_PX,
): { start: number; end: number } {
	const from = Math.max(0, scrollTop - overscan);
	const to = scrollTop + Math.max(0, viewport) + overscan;
	const start = firstBelow(layout.entries, from);
	let end = start;
	while (end < layout.entries.length && layout.entries[end]!.top < to) end++;
	return { start, end };
}

/** The scroll position that shows an entry whole (null: it is in view already). */
export function scrollToShow(
	entry: Pick<ReviewListEntry, 'top' | 'height'>,
	scrollTop: number,
	viewport: number,
	stickyPx = reviewListMetrics().header,
): number | null {
	if (entry.top - stickyPx < scrollTop) return Math.max(0, entry.top - stickyPx);
	if (viewport > 0 && entry.top + entry.height > scrollTop + viewport)
		return entry.top + entry.height - viewport;
	return null;
}

/** The group whose rows are at the top of the view (its label stays pinned there), or null at the very top. */
export function pinnedGroup(layout: ReviewListLayout, scrollTop: number): ReviewGroup | null {
	if (scrollTop <= 0) return null;
	let found: ReviewGroup | null = null;
	for (const g of layout.groups) {
		if (g.top < scrollTop) found = g.group;
		else break;
	}
	return found;
}
