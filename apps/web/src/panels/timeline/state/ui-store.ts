// Per-instance transient UI state of one Timeline panel (never in the document, never undoable,
// TL-006: no module-level singletons for timeline state). zustand vanilla, read with selectors.
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { MarqueeRect } from '../model/gestures.ts';

export type EditPointSel = {
	trackId: string;
	frame: number;
	/** Which side of the cut is selected (TL-547). */
	side: 'in' | 'out';
	clipId: string;
	type: 'regular' | 'ripple' | 'roll';
};

export type Tooltip = { x: number; y: number; lines: string[] };

type FrameSpan = { start: number; end: number };

/**
 * Transition ghost during drops and edge drags (S10:TUI-021/022): the resulting span, the requested one,
 * the available media handles (light bands) and the part without media (hatched red).
 */
export type TransitionGhost = {
	trackId: string;
	wanted: FrameSpan;
	fitted: FrameSpan | null;
	bands: FrameSpan[];
	missing: FrameSpan[];
	/** Nothing fits: the drop is refused. */
	refused: boolean;
	/** Drawn on an existing transition that the drop replaces (TUI-023). */
	replace?: boolean;
};

export type ContextMenuItem =
	| { kind: 'item'; label: string; shortcut?: string; disabled?: boolean; checked?: boolean; run(): void }
	| { kind: 'separator' }
	| { kind: 'submenu'; label: string; items: ContextMenuItem[] };

export type TimelineUiState = {
	/** Measured sizes. */
	width: number;
	trackAreaHeight: number;
	/** Cursor forced/hover cursor for the clip area. */
	cursor: string;
	marquee: MarqueeRect | null;
	/** Frame of the active snap indicator (TL-454). */
	snapFrame: number | null;
	/** Razor hover line (TL-620): frame and whether it spans all tracks. */
	razor: { frame: number; trackId: string | null } | null;
	/** Insert arrows at a frame (TL-484). */
	insertAt: number | null;
	/** Limit indicator (TL-534). */
	limit: { trackId: string; frame: number } | null;
	tooltip: Tooltip | null;
	editPoints: EditPointSel[];
	/** TL-108 `\` toggle memory. */
	zoomPrev: { pxPerFrame: number; scrollFrame: number } | null;
	contextMenu: { x: number; y: number; items: ContextMenuItem[] } | null;
	/** Frozen layout extent during a gesture (TL-057). */
	frozenEnd: number | null;
	/** Drop preview (TL-492): frame + track label + mode. */
	drop: { frame: number; trackLabel: string; insert: boolean } | null;
	/** Clip ids that flash after agent edits (TL-954). */
	flash: string[];
	/** Hovered track header for Alt+eye restore memory (TL-257). */
	soloEyeMemory: { trackId: string; previous: Record<string, boolean> } | null;
	/** Timecode readout display mode (TL-205 Ctrl+click toggles). */
	readoutFrames: boolean;
	/** S10: transition drop / edge-drag ghost with handle availability. */
	transitionGhost: TransitionGhost | null;
};

export type TimelineUiStore = StoreApi<TimelineUiState>;

export function createTimelineUiStore(): TimelineUiStore {
	return createStore<TimelineUiState>(() => ({
		width: 800,
		trackAreaHeight: 300,
		cursor: 'default',
		marquee: null,
		snapFrame: null,
		razor: null,
		insertAt: null,
		limit: null,
		tooltip: null,
		editPoints: [],
		zoomPrev: null,
		contextMenu: null,
		frozenEnd: null,
		drop: null,
		flash: [],
		soloEyeMemory: null,
		readoutFrames: false,
		transitionGhost: null,
	}));
}

/** Clears every gesture overlay (on commit/cancel). */
export function clearOverlays(ui: TimelineUiStore): void {
	ui.setState({
		marquee: null,
		snapFrame: null,
		insertAt: null,
		limit: null,
		tooltip: null,
		frozenEnd: null,
		drop: null,
		transitionGhost: null,
	});
}
