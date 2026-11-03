// A virtualised grid of looks (TL-086): only the rows on screen are mounted, so posters are asked for those alone and a
// library of hundreds costs what one screen costs. Arrow keys move a roving focus, Enter uses the look.
import type { Colorway } from '@jasper/project';
import type { ResolvedMenuItem } from '@jasper/ui';
import { type KeyboardEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { gridStep, gridWindow, scrollToCard } from './grid-window.ts';
import { LookCard } from './LookCard.tsx';
import type { LookEntry } from './library.ts';
import { type PosterSample, type PosterStore, posterWidth } from './posters.ts';

const GAP = 4;
/** Name and colourway rows of a card, with its padding. */
const CARD_FOOTER = 44;

export type TileSize = 'small' | 'medium' | 'large';
export const TILE_PX: Record<TileSize, number> = { small: 120, medium: 168, large: 240 };

type Size = { width: number; height: number };

/** The scroller's size; a layout that has not run yet reads as one typical screen. */
function useScrollerSize(el: HTMLElement | null): Size {
	const [size, setSize] = useState<Size>({ width: 0, height: 0 });
	useLayoutEffect(() => {
		if (!el) return;
		const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight });
		measure();
		if (typeof ResizeObserver === 'undefined') return;
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, [el]);
	return size;
}

export function LookGrid(props: {
	entries: readonly LookEntry[];
	tile: TileSize;
	sample: PosterSample | null;
	store: PosterStore | null;
	/** The selection's colourway, per look it already has. */
	colorwayOf(entry: LookEntry): string | undefined;
	onUse(entry: LookEntry, colorway?: Colorway): void;
	onHover(entry: LookEntry | null, colorway?: Colorway): void;
	menu(entry: LookEntry): ResolvedMenuItem[];
}) {
	const { entries } = props;
	const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
	const size = useScrollerSize(scroller);
	const [scrollTop, setScrollTop] = useState(0);
	const [active, setActive] = useState(0);
	const focusAfterScroll = useRef(false);
	const tile = TILE_PX[props.tile];
	const w = gridWindow({
		width: size.width || 320,
		viewport: size.height || 480,
		scrollTop,
		count: entries.length,
		tile,
		gap: GAP,
		footer: CARD_FOOTER,
	});
	const index = Math.min(active, Math.max(0, entries.length - 1));
	const posterPx = posterWidth(w.cellWidth);
	const onFocusCard = useCallback((i: number) => setActive(i), []);

	useEffect(() => {
		if (!focusAfterScroll.current) return;
		const el = scroller?.querySelector<HTMLElement>(`[data-look-index="${index}"]`);
		if (el) {
			focusAfterScroll.current = false;
			el.focus();
		}
	});

	const onKeyDown = (e: KeyboardEvent) => {
		const next = gridStep(index, e.key, w.columns, entries.length);
		if (next === index && !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key))
			return;
		e.preventDefault();
		setActive(next);
		focusAfterScroll.current = true;
		if (scroller) {
			const y = scrollToCard(next, w, GAP, scroller.scrollTop, scroller.clientHeight);
			if (y !== scroller.scrollTop) scroller.scrollTop = y;
		}
	};

	return (
		<div
			ref={setScroller}
			className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
			onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
			data-testid="look-grid"
		>
			{/* biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: a list with keyboard navigation between its cards */}
			<ul
				aria-label="Looks"
				className="relative"
				style={{ height: w.totalHeight }}
				data-count={entries.length}
				data-keymap-local
				onKeyDown={onKeyDown}
			>
				{entries.slice(w.start, w.end).map((e, k) => {
					const i = w.start + k;
					return (
						<LookCard
							key={e.lookId}
							entry={e}
							index={i}
							active={i === index}
							width={w.cellWidth}
							height={w.cellHeight}
							x={(i % w.columns) * (w.cellWidth + GAP)}
							y={Math.floor(i / w.columns) * (w.cellHeight + GAP)}
							posterPx={posterPx}
							sample={props.sample}
							store={props.store}
							currentColorway={props.colorwayOf(e)}
							onUse={props.onUse}
							onHover={props.onHover}
							onFocusCard={onFocusCard}
							menu={props.menu}
						/>
					);
				})}
			</ul>
		</div>
	);
}
