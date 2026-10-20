// Stroke Animation (docs/wp-notes/shapes.md § "Stroke Animation panel"): the pure part of the one-click Trim Paths
// tools — the buttons and their commands, which selected clips they apply to (and why not), the start time, the
// modifier rules and the `shape.*` payloads. The panel, the menus and the palette all go through the UI commands in
// commands.ts, which use these functions.
import { type Clip, type CubicEase, CubicEaseSchema, type Sequence, type ShapeItem } from '@jasper/project';
import type { SessionState } from '@jasper/session';
import type { IconId } from '@jasper/ui';
import { z } from 'zod';
import type { AddTrimTracerCommand, AnimateTrimCommand, AnimateTrimStyle } from './adapter.ts';
import type { StrokeButtonId, StrokePrefs } from './prefs.ts';

export type StrokeGroupId = 'draw' | 'middle' | 'divide' | 'utilities' | 'trace';

export type StrokeAction = {
	id: StrokeButtonId;
	/** UI command id (menus, palette, keymap and the panel run it). */
	command: string;
	group: StrokeGroupId;
	icon: IconId;
	/** Trim Paths animation style; absent for the utilities and trace buttons. */
	style?: AnimateTrimStyle;
};

export const STROKE_ACTIONS: readonly StrokeAction[] = [
	{ id: 'drawIn', command: 'strokeAnimation.drawIn', group: 'draw', icon: 'stroke.drawIn', style: 'in' },
	{ id: 'drawOut', command: 'strokeAnimation.drawOut', group: 'draw', icon: 'stroke.drawOut', style: 'out' },
	{
		id: 'drawInOut',
		command: 'strokeAnimation.drawInOut',
		group: 'draw',
		icon: 'stroke.drawInOut',
		style: 'inOut',
	},
	{
		id: 'growFromMiddle',
		command: 'strokeAnimation.growFromMiddle',
		group: 'middle',
		icon: 'stroke.middleIn',
		style: 'middleIn',
	},
	{
		id: 'shrinkToMiddle',
		command: 'strokeAnimation.shrinkToMiddle',
		group: 'middle',
		icon: 'stroke.middleOut',
		style: 'middleOut',
	},
	{
		id: 'divideIn',
		command: 'strokeAnimation.divideIn',
		group: 'divide',
		icon: 'stroke.divideIn',
		style: 'divideIn',
	},
	{
		id: 'divideOut',
		command: 'strokeAnimation.divideOut',
		group: 'divide',
		icon: 'stroke.divideOut',
		style: 'divideOut',
	},
	{ id: 'reversePath', command: 'strokeAnimation.reversePath', group: 'utilities', icon: 'stroke.reverse' },
	{
		id: 'addHorizontalLine',
		command: 'strokeAnimation.addHorizontalLine',
		group: 'utilities',
		icon: 'stroke.lineH',
	},
	{
		id: 'addVerticalLine',
		command: 'strokeAnimation.addVerticalLine',
		group: 'utilities',
		icon: 'stroke.lineV',
	},
	{ id: 'tracerNext', command: 'strokeAnimation.toggleTracer', group: 'trace', icon: 'stroke.tracerNext' },
	{ id: 'addTracer', command: 'strokeAnimation.addTracer', group: 'trace', icon: 'stroke.tracer' },
];

export const STROKE_GROUPS: readonly StrokeGroupId[] = ['draw', 'middle', 'divide', 'utilities', 'trace'];

export const STROKE_GROUP_TITLES: Record<StrokeGroupId, string> = {
	draw: 'Draw',
	middle: 'Middle',
	divide: 'Divide',
	utilities: 'Utilities',
	trace: 'Trace',
};

/** Panel button labels (short; they collapse to icons when the panel is narrow). */
export const STROKE_BUTTON_LABELS: Record<StrokeButtonId, string> = {
	drawIn: 'In',
	drawOut: 'Out',
	drawInOut: 'In & Out',
	growFromMiddle: 'Grow from Middle',
	shrinkToMiddle: 'Shrink to Middle',
	divideIn: 'Divide In',
	divideOut: 'Divide Out',
	reversePath: 'Reverse Path',
	addHorizontalLine: 'Horizontal Line',
	addVerticalLine: 'Vertical Line',
	tracerNext: 'Tracer on Next',
	addTracer: 'Add Tracer',
};

/**
 * Command labels (Graphics ▸ Stroke Animation ▸ …, the palette, which also matches the `strokeAnimation.*` ids) and
 * the first tooltip line of the panel buttons.
 */
export const STROKE_MENU_LABELS: Record<StrokeButtonId, string> = {
	drawIn: 'Draw In',
	drawOut: 'Draw Out',
	drawInOut: 'Draw In and Out',
	growFromMiddle: 'Grow from Middle',
	shrinkToMiddle: 'Shrink to Middle',
	divideIn: 'Divide In',
	divideOut: 'Divide Out',
	reversePath: 'Reverse Path Direction',
	addHorizontalLine: 'Add Horizontal Line',
	addVerticalLine: 'Add Vertical Line',
	tracerNext: 'Add Tracer to Next Animation',
	addTracer: 'Add Tracer to Trim Paths',
};

export const STROKE_DESCRIPTIONS: Record<StrokeButtonId, string> = {
	drawIn: 'Animates Trim Paths so the stroke draws on from its start to its end.',
	drawOut: 'Animates Trim Paths so the stroke draws off, its start running to its end.',
	drawInOut: 'Draws the stroke on, then off: the tail follows the head after the in-out lag.',
	growFromMiddle: 'The stroke grows from the middle of the path towards both ends.',
	shrinkToMiddle: 'The stroke shrinks from both ends towards the middle of the path.',
	divideIn: 'Splits the stroke into equal parts (Copies) that all draw on together.',
	divideOut: 'Splits the stroke into equal parts (Copies) that all draw off together.',
	reversePath: 'Reverses the direction of the paths of the selected shapes, so animations run the other way.',
	addHorizontalLine: 'Adds a new shape clip with a horizontal stroked line at the playhead.',
	addVerticalLine: 'Adds a new shape clip with a vertical stroked line at the playhead.',
	tracerNext:
		'When on, every Stroke Animation also adds a tracer: a marker that follows the moving tip of the stroke.',
	addTracer:
		'Adds a tracer that follows the tip of the selected shape’s Trim Paths. Select another clip too to make it follow the tip.',
};

/** Why an action is unavailable (shown on the disabled buttons, menus and palette). */
export const STROKE_REASONS = {
	noProject: 'Open a project first',
	readOnly: 'The project is open read-only',
	noSequence: 'Open a sequence first',
	noShape: 'Select one or more shape clips in the timeline',
	noTrim: 'Select a shape clip that has Trim Paths (animate it first)',
	manyTrims: 'Select only one shape clip with Trim Paths',
	manyFollowers: 'Select at most one other clip to follow the tip',
} as const;
type ReasonKey = keyof typeof STROKE_REASONS;

/** The modifier hint of the animation buttons (tooltips and the info line). */
export const STROKE_HINTS = {
	modifiers: 'Alt-click: reverse · Shift-click: animate offset · Alt+Shift-click: both',
	startPlayhead: 'Starts at the playhead',
	startClip: 'Starts at the clip start',
};

const reason = (k: ReasonKey) => STROKE_REASONS[k];

export function activeSequenceOf(s: SessionState): Sequence | null {
	const id = s.activeSequenceId;
	const doc = s.transient ?? s.document;
	return id ? (doc.sequences[id] ?? null) : null;
}

export type ShapeTargets =
	| { ok: true; sequence: Sequence; clips: Clip[] }
	| { ok: false; reason: string; sequence: Sequence | null };

/** The clips an animation or path utility applies to: the selected shape clips of the active sequence. */
export function shapeTargets(s: SessionState | null | undefined): ShapeTargets {
	if (!s) return { ok: false, reason: reason('noProject'), sequence: null };
	const seq = activeSequenceOf(s);
	if (!seq) return { ok: false, reason: reason('noSequence'), sequence: null };
	if (s.readOnly) return { ok: false, reason: reason('readOnly'), sequence: seq };
	const clips = s.selection.timeline.clips
		.map((id) => seq.clips[id])
		.filter((c): c is Clip => !!c && c.kind === 'shape');
	if (!clips.length) return { ok: false, reason: reason('noShape'), sequence: seq };
	return { ok: true, sequence: seq, clips };
}

/** Adding a line needs an editable sequence only. */
export function lineTarget(s: SessionState | null | undefined): string | null {
	if (!s) return reason('noProject');
	if (!activeSequenceOf(s)) return reason('noSequence');
	if (s.readOnly) return reason('readOnly');
	return null;
}

/** Trim Paths items of a vector shape, depth first in list order. */
export function trimItemIds(contents: readonly ShapeItem[] | undefined, depth = 0): string[] {
	if (!contents || depth > 64) return [];
	const out: string[] = [];
	for (const it of contents) {
		if (it.type === 'trim') out.push(it.id);
		else if (it.type === 'group') out.push(...trimItemIds(it.contents, depth + 1));
	}
	return out;
}

const vectorContents = (c: Clip | undefined): readonly ShapeItem[] | undefined =>
	c?.kind === 'shape' && c.shape.type === 'vector' ? c.shape.contents : undefined;

export type TracerTarget =
	| { ok: true; sequence: Sequence; clipId: string; trimItemId: string; followerId: string | null }
	| { ok: false; reason: string };

/**
 * "Add Tracer": one selected vector shape with Trim Paths (the trim item selected in Shape Contents, else its first
 * trim) and at most one other selected clip with a Motion transform, which becomes the follower.
 */
export function tracerTarget(
	s: SessionState | null | undefined,
	selectedItem: { clipId: string; itemId: string } | null,
): TracerTarget {
	const base = shapeTargets(s);
	if (!s || !base.sequence) return { ok: false, reason: base.ok ? reason('noSequence') : base.reason };
	if (s.readOnly) return { ok: false, reason: reason('readOnly') };
	const seq = base.sequence;
	const selected = s.selection.timeline.clips.map((id) => seq.clips[id]).filter((c): c is Clip => !!c);
	const withTrim = selected.filter((c) => trimItemIds(vectorContents(c)).length > 0);
	if (!withTrim.length) return { ok: false, reason: reason('noTrim') };
	if (withTrim.length > 1) return { ok: false, reason: reason('manyTrims') };
	const shape = withTrim[0] as Clip;
	const others = selected.filter((c) => c.id !== shape.id && 'transform' in c);
	if (others.length > 1) return { ok: false, reason: reason('manyFollowers') };
	const trims = trimItemIds(vectorContents(shape));
	const trimItemId =
		selectedItem?.clipId === shape.id && trims.includes(selectedItem.itemId)
			? selectedItem.itemId
			: (trims[0] as string);
	return { ok: true, sequence: seq, clipId: shape.id, trimItemId, followerId: others[0]?.id ?? null };
}

export type Modifiers = { alt: boolean; shift: boolean };

/** Alt toggles Reverse and Shift toggles Animate offset for one click (the checkboxes keep their state). */
export function effectiveFlags(
	prefs: Pick<StrokePrefs, 'reverse' | 'animateOffset'>,
	mods: Modifiers,
): { reverse: boolean; animateOffset: boolean } {
	return { reverse: prefs.reverse !== mods.alt, animateOffset: prefs.animateOffset !== mods.shift };
}

/** Sequence frame of the animation's first key, or undefined for the clip start (the command's default). */
export function animationStart(
	clip: Pick<Clip, 'start' | 'duration'>,
	playhead: number,
	startAt: StrokePrefs['startAt'],
): number | undefined {
	if (startAt !== 'playhead' || !Number.isFinite(playhead)) return undefined;
	const f = Math.round(playhead);
	return f > clip.start && f < clip.start + clip.duration ? f : undefined;
}

const isDivide = (s: AnimateTrimStyle) => s === 'divideIn' || s === 'divideOut';

/**
 * The `shape.animateTrim` commands of one click: one per distinct start (clips whose playhead-inside start differs
 * get their own command), in selection order. Only the settings the style uses are sent.
 */
export function buildAnimateCommands(
	style: AnimateTrimStyle,
	clips: readonly Pick<Clip, 'id' | 'start' | 'duration'>[],
	prefs: StrokePrefs,
	flags: { reverse: boolean; animateOffset: boolean },
	playhead: number,
): AnimateTrimCommand[] {
	const byStart = new Map<number | undefined, string[]>();
	for (const c of clips) {
		const at = animationStart(c, playhead, prefs.startAt);
		const ids = byStart.get(at) ?? [];
		if (!ids.includes(c.id)) ids.push(c.id);
		byStart.set(at, ids);
	}
	return [...byStart].map(([at, clipIds]) => ({
		type: 'shape.animateTrim',
		clipIds,
		style,
		reverse: flags.reverse,
		animateOffset: flags.animateOffset,
		durationFrames: prefs.durationFrames,
		...(flags.animateOffset ? { offsetDegrees: prefs.offsetDegrees } : {}),
		...(isDivide(style) ? { copies: prefs.copies } : {}),
		...(style === 'inOut' ? { inOutLag: prefs.inOutLag } : {}),
		...(at !== undefined ? { at } : {}),
		...(prefs.curve ? { curve: prefs.curve } : {}),
	}));
}

const AnimateTrimResultSchema = z.object({
	clips: z.array(z.object({ clipId: z.string(), trimItemIds: z.array(z.string()).min(1) })),
});

/** The master trim item of each animated clip, from the transaction's per-command results. */
export function masterTrims(results: readonly unknown[]): { clipId: string; trimItemId: string }[] {
	const out: { clipId: string; trimItemId: string }[] = [];
	for (const r of results) {
		const parsed = AnimateTrimResultSchema.safeParse(r);
		if (!parsed.success) continue;
		for (const c of parsed.data.clips) out.push({ clipId: c.clipId, trimItemId: c.trimItemIds[0] as string });
	}
	return out;
}

export function tracerCommand(
	clipId: string,
	trimItemId: string,
	prefs: Pick<StrokePrefs, 'tracerTip' | 'tracerOrient'>,
	followerId: string | null = null,
): AddTrimTracerCommand {
	return {
		type: 'shape.addTrimTracer',
		clipId,
		trimItemId,
		tip: prefs.tracerTip,
		...(followerId ? { follower: { clipId: followerId }, orient: prefs.tracerOrient } : {}),
	};
}

const round = (v: number) => String(Math.round(v * 1000) / 1000);

/** "0.25, 0.1, 0.25, 1" (CSS cubic-bezier order). */
export function formatCubic(c: CubicEase): string {
	return [c.x1, c.y1, c.x2, c.y2].map(round).join(', ');
}

/** Parses "x1, y1, x2, y2" or "cubic-bezier(x1, y1, x2, y2)"; null when it is not a valid cubic curve. */
export function parseCubic(text: string): CubicEase | null {
	const m = /^\s*(?:cubic-bezier\s*\(([^)]*)\)|([^()]*))\s*$/i.exec(text);
	const body = m?.[1] ?? m?.[2];
	if (body === undefined) return null;
	const parts = body
		.split(/[\s,]+/)
		.map((s) => s.trim())
		.filter(Boolean);
	if (parts.length !== 4) return null;
	const nums = parts.map(Number);
	if (nums.some((n) => !Number.isFinite(n))) return null;
	const r = CubicEaseSchema.safeParse({ kind: 'cubic', x1: nums[0], y1: nums[1], x2: nums[2], y2: nums[3] });
	return r.success ? r.data : null;
}
