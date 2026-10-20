// Stroke Animation preferences (docs/wp-notes/shapes.md § "Stroke Animation panel"): the settings the one-click
// Trim Paths buttons use — duration, offset, copies, in-out lag, start time, curve — the Reverse / Animate offset
// checkboxes, the tracer options and which buttons the panel shows. Per-user UI state in localStorage, never in the
// project. The stored value is validated with zod field by field: a bad or missing field takes its default and the
// others are kept, so a corrupt or older/newer value never stops the panel from opening.
import { type CubicEase, CubicEaseSchema } from '@jasper/project';
import { useSyncExternalStore } from 'react';
import { z } from 'zod';

export const STROKE_PREFS_VERSION = 1;
const STROKE_PREFS_KEY = 'jasper:stroke-animation-prefs';

/** Ids of the panel buttons that can be hidden (Settings ▸ Buttons). */
export const STROKE_BUTTON_IDS = [
	'drawIn',
	'drawOut',
	'drawInOut',
	'growFromMiddle',
	'shrinkToMiddle',
	'divideIn',
	'divideOut',
	'reversePath',
	'addHorizontalLine',
	'addVerticalLine',
	'tracerNext',
	'addTracer',
] as const;
export type StrokeButtonId = (typeof STROKE_BUTTON_IDS)[number];

/** Bounds of the numeric settings (the `shape.animateTrim` contract). */
export const STROKE_LIMITS = {
	durationFrames: { min: 1, max: 3600 },
	offsetDegrees: { min: -3600, max: 3600 },
	copies: { min: 2, max: 64 },
	inOutLag: { min: 0, max: 1 },
} as const;

const L = STROKE_LIMITS;
const FIELDS = {
	version: z.literal(STROKE_PREFS_VERSION),
	/** Length of the animation, frames (contract default 10). */
	durationFrames: z.number().int().min(L.durationFrames.min).max(L.durationFrames.max),
	/** Offset turn when "Animate offset" is on, degrees (360° = one full length; contract default 180). */
	offsetDegrees: z.number().finite().min(L.offsetDegrees.min).max(L.offsetDegrees.max),
	/** Parts of the Divide styles (contract 2…64, default 4). */
	copies: z.number().int().min(L.copies.min).max(L.copies.max),
	/** In & Out: when the tail starts, as a fraction of the duration (contract default 0.5). */
	inOutLag: z.number().finite().min(L.inOutLag.min).max(L.inOutLag.max),
	/** `playhead`: at the playhead when it is inside the clip, else the clip start; `clipStart`: always the start. */
	startAt: z.enum(['playhead', 'clipStart']),
	/** Ease of the animation; null = the command's default. */
	curve: CubicEaseSchema.nullable(),
	/** The preset the curve came from (shown in the picker); null = custom or default. */
	curvePresetId: z.string().min(1).max(200).nullable(),
	/** The checkboxes; Alt / Shift on a click toggle them for that click. */
	reverse: z.boolean(),
	animateOffset: z.boolean(),
	/** "Tracer on next animation": every animation also adds a tracer following its tip. */
	addTracer: z.boolean(),
	tracerTip: z.enum(['auto', 'start', 'end']),
	/** A follower clip turns with the path direction. */
	tracerOrient: z.boolean(),
	/** Buttons the panel hides. */
	hidden: z.array(z.enum(STROKE_BUTTON_IDS)).max(STROKE_BUTTON_IDS.length),
	/** The Settings section is expanded. */
	settingsOpen: z.boolean(),
};

export const StrokePrefsSchema = z.strictObject(FIELDS);
export type StrokePrefs = z.infer<typeof StrokePrefsSchema>;

export const DEFAULT_STROKE_PREFS: StrokePrefs = {
	version: STROKE_PREFS_VERSION,
	durationFrames: 10,
	offsetDegrees: 180,
	copies: 4,
	inOutLag: 0.5,
	startAt: 'playhead',
	curve: null,
	curvePresetId: null,
	reverse: false,
	animateOffset: false,
	addTracer: false,
	tracerTip: 'auto',
	tracerOrient: true,
	hidden: [],
	settingsOpen: true,
};

/**
 * A stored value (any version, any shape) → valid prefs: each field that fails its schema takes its default, unknown
 * hidden-button ids are dropped, unknown keys are ignored.
 */
export function parseStrokePrefs(raw: unknown): StrokePrefs {
	const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
	const out: Record<string, unknown> = { ...DEFAULT_STROKE_PREFS, version: STROKE_PREFS_VERSION };
	for (const key of Object.keys(FIELDS) as (keyof typeof FIELDS)[]) {
		if (key === 'version') continue;
		if (key === 'hidden') {
			const list = Array.isArray(o.hidden) ? o.hidden : [];
			out.hidden = [
				...new Set(list.filter((v): v is StrokeButtonId => STROKE_BUTTON_IDS.includes(v as StrokeButtonId))),
			];
			continue;
		}
		const r = FIELDS[key].safeParse(o[key]);
		if (r.success) out[key] = r.data;
	}
	// A preset id without its curve means nothing.
	if (out.curve === null) out.curvePresetId = null;
	return StrokePrefsSchema.parse(out);
}

function load(): StrokePrefs {
	try {
		const raw = globalThis.localStorage?.getItem(STROKE_PREFS_KEY);
		return parseStrokePrefs(raw ? JSON.parse(raw) : null);
	} catch {
		return { ...DEFAULT_STROKE_PREFS };
	}
}

let state: StrokePrefs = load();
const listeners = new Set<() => void>();

export const strokePrefs = {
	key: STROKE_PREFS_KEY,
	get: (): StrokePrefs => state,
	/** Merges a patch; the result is validated (invalid fields keep their previous value). */
	set(patch: Partial<StrokePrefs>): void {
		const merged: Record<string, unknown> = { ...state };
		for (const [k, v] of Object.entries(patch)) {
			if (k === 'version' || !(k in FIELDS)) continue;
			const r = FIELDS[k as keyof typeof FIELDS].safeParse(v);
			if (r.success) merged[k] = r.data;
		}
		state = parseStrokePrefs(merged);
		try {
			globalThis.localStorage?.setItem(STROKE_PREFS_KEY, JSON.stringify(state));
		} catch {
			/* storage unavailable or full: keep in memory */
		}
		for (const l of [...listeners]) l();
	},
	/** Re-reads storage (tests, another window). */
	reload(): void {
		state = load();
		for (const l of [...listeners]) l();
	},
	subscribe(l: () => void): () => void {
		listeners.add(l);
		return () => listeners.delete(l);
	},
};

export function useStrokePrefs(): StrokePrefs {
	return useSyncExternalStore(strokePrefs.subscribe, strokePrefs.get, strokePrefs.get);
}

export type { CubicEase };
