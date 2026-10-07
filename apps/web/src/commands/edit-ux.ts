// edit-ux UI commands: keyboard trim mode (Trim Edit, Select Nearest Edit Point, Toggle Trim Type, Trim
// Forward/Backward, Extend Edit, numeric trim entry, dynamic J/K/L trimming, Play Around the Edit), Match Frame,
// Reverse Match Frame, Linked Selection, Speed/Duration, Make Subclip, source patching and track targeting.
// Keys follow Premiere Pro's defaults (keymap-defaults.ts).

import type { FitClip } from '@jasper/project';
import { editPointFrame, type NearestKind, type Sequence } from '@jasper/project';
import { z } from 'zod';
import {
	FIT_CLIP_DIALOG,
	registerEditUxDialogs,
	rememberedFitChoice,
	rememberFitChoice,
	SPEED_DURATION_DIALOG,
	SUBCLIP_DIALOG,
} from '../edit-ux/dialogs.tsx';
import { defaultTransitionFields } from '../panels/effects/transition-prefs.ts';
import { driverFor, getSourceTransport } from '../panels/program/transport-registry.ts';
import { assetFps, performSourceEdit, sourceMonitorState } from '../panels/source/source-state.ts';
import {
	activeDynamicTrim,
	commitDynamicTrim,
	cycleTrimTypes,
	dynamicShuttle,
	editPointsOf,
	enterTrimMode,
	LARGE_TRIM_OFFSET,
	playAroundEdit,
	selectNearest,
	stopPlayAround,
	trimMode,
	trimSelected,
} from '../panels/timeline/state/trim-mode.ts';
import { detectPlatform, detectRuntime } from '../runtime/platform.ts';
import {
	KEYBOARD_SHORTCUTS_DIALOG,
	registerKeyboardShortcutsDialog,
} from '../shell/keymap/KeyboardShortcutsDialog.tsx';
import { onBeforeCommand } from './registry.ts';
import { type Env, envOf, isLocked, seekReveal, selectedClips, targetedTracks } from './timeline.ts';
import type { CommandCtx, UiCommand } from './types.ts';

const T = 'timeline' as const;
const E = 'editing' as const;

const fpsOf = (seq: Sequence) => seq.settings.frameRate.num / seq.settings.frameRate.den;

function hasEditPoints(ctx: CommandCtx): boolean {
	const e = envOf(ctx);
	return !!e && editPointsOf(e.handle?.ui).length > 0;
}

/** Trim mode is on for the active sequence and edit points are selected (Trim Monitor showing). */
export function inTrimMode(ctx: CommandCtx): boolean {
	if (ctx.focus.panel === 'source') return false;
	const s = trimMode.getState();
	const e = envOf(ctx);
	return !!e && s.active && s.sequenceId === e.seq.id && editPointsOf(e.handle?.ui).length > 0;
}

function toastResult(ctx: CommandCtx, r: { error: string } | { applied: number }): void {
	if ('error' in r) ctx.ui.toast({ kind: 'warning', message: 'Trim: not possible', detail: r.error });
}

function trimBy(ctx: CommandCtx, e: Env, delta: number): void {
	if (!e.handle) return;
	toastResult(ctx, trimSelected(e.session, e.handle, e.seq.id, delta, { coalesce: true }));
}

function nearest(ctx: CommandCtx, e: Env, kind: NearestKind): void {
	if (!e.handle) return;
	commitDynamicTrim();
	const pts = selectNearest(e.handle, e.seq, e.playhead, kind, targetedTracks(e));
	if (!pts.length) {
		ctx.ui.toast({ kind: 'info', message: 'No edit point on the targeted tracks' });
		return;
	}
	e.session.select('timeline', [], 'replace');
	const f = editPointFrame(e.seq, pts[0]!);
	if (f !== null) seekReveal(e, f);
}

const cmd = (
	id: string,
	label: string,
	scope: UiCommand['scope'],
	run: (ctx: CommandCtx, e: Env) => void,
	extra: Partial<UiCommand> = {},
): UiCommand => ({
	id,
	label,
	scope,
	agentExposed: true,
	when: (ctx) => envOf(ctx) !== null,
	run: (ctx) => {
		const e = envOf(ctx);
		if (e) run(ctx, e);
	},
	...extra,
});

const NEAREST: [string, string, NearestKind][] = [
	['timeline.selectNearestEditRippleIn', 'Select Nearest Edit Point as Ripple In', 'rippleIn'],
	['timeline.selectNearestEditRippleOut', 'Select Nearest Edit Point as Ripple Out', 'rippleOut'],
	['timeline.selectNearestEditRoll', 'Select Nearest Edit Point as Roll', 'roll'],
	['timeline.selectNearestEditTrimIn', 'Select Nearest Edit Point as Trim In', 'trimIn'],
	['timeline.selectNearestEditTrimOut', 'Select Nearest Edit Point as Trim Out', 'trimOut'],
];

/** J / K / L in trim mode: dynamic trimming. Returns true when handled. */
export function trimModeShuttle(ctx: CommandCtx, key: 'J' | 'K' | 'L', slow = false): boolean {
	if (!inTrimMode(ctx)) return false;
	const e = envOf(ctx);
	if (!e?.handle) return false;
	if (key === 'K') {
		const playing = trimMode.getState().playAround;
		stopPlayAround();
		if (playing) e.session.transport.pause();
		commitDynamicTrim();
		return true;
	}
	dynamicShuttle(e.session, e.handle, e.seq.id, fpsOf(e.seq), key === 'L' ? 1 : -1, slow);
	return true;
}

/** Space in trim mode: loop playback around the edit (Premiere "Play Around the Edit"). */
export function trimModePlay(ctx: CommandCtx): boolean {
	if (!inTrimMode(ctx)) return false;
	const e = envOf(ctx);
	if (!e?.handle) return false;
	const t = e.session.transport;
	const driver = driverFor(t);
	playAroundEdit(e.session, e.handle, e.seq.id, fpsOf(e.seq), (from, to) => {
		if (driver) driver.playRange(from, to);
		else {
			t.seek(from);
			t.play(1);
		}
	});
	return true;
}

/** Commands that keep a dynamic trim / the play-around loop running (FilmCraft: trim buttons keep the loop). */
const KEEPS_DYNAMIC = new Set([
	'transport.shuttleForward',
	'transport.shuttleReverse',
	'transport.shuttleStop',
	'transport.shuttleSlowForward',
	'transport.shuttleSlowReverse',
	'transport.playStop',
	'timeline.playAroundEdit',
	'timeline.dynamicTrimStop',
	'gesture.cancel',
]);
const KEEPS_LOOP = new Set([
	...KEEPS_DYNAMIC,
	'timeline.trimBack',
	'timeline.trimForward',
	'timeline.trimBackMany',
	'timeline.trimForwardMany',
	'timeline.trimByFrames',
	'timeline.toggleTrimType',
	'timeline.trimEdit',
]);
onBeforeCommand((id) => {
	if (!KEEPS_DYNAMIC.has(id)) commitDynamicTrim();
	if (!KEEPS_LOOP.has(id) && trimMode.getState().playAround) stopPlayAround();
});

// ---------------------------------------------------------------- source edits (3/4-point, Fit Clip)

/** Insert / Overwrite from the Source monitor; a four-point mismatch asks Fit Clip (or uses the remembered choice). */
export function runSourceEdit(ctx: CommandCtx, mode: 'insert' | 'overwrite'): void {
	const session = ctx.session;
	if (!session) return;
	const label = mode === 'insert' ? 'Insert' : 'Overwrite';
	const r = performSourceEdit(session, mode);
	if (r.ok) return;
	if (r.needsFit) {
		const remembered = rememberedFitChoice();
		if (remembered) {
			const r2 = performSourceEdit(session, mode, { fit: remembered });
			if (!r2.ok) ctx.ui.toast({ kind: 'warning', message: `${label}: not possible`, detail: r2.message });
			return;
		}
		registerEditUxDialogs();
		ctx.ui.openDialog(FIT_CLIP_DIALOG, {
			message: r.message,
			apply: (fit: FitClip) => performSourceEdit(session, mode, { fit }),
		});
		return;
	}
	ctx.ui.toast({ kind: 'warning', message: r.message ?? `${label} failed` });
}

// ---------------------------------------------------------------- subclips

type SubclipSource = { itemId: string; range: { in: number; out: number }; fps: number };

/** What Make Subclip uses: the focused Source item with its marks, the selected project item, or a timeline clip. */
function subclipSource(ctx: CommandCtx): SubclipSource | null {
	const session = ctx.session;
	if (!session) return null;
	const doc = session.getCommitted();
	const fromItem = (id: string | null | undefined): SubclipSource | null => {
		const it = id ? doc.items[id] : undefined;
		if (!it || (it.kind !== 'media' && it.kind !== 'subclip')) return null;
		const asset = doc.media[it.mediaId];
		if (!asset || (asset.kind !== 'video' && asset.kind !== 'audio' && asset.kind !== 'animated-image'))
			return null;
		const lo = it.kind === 'subclip' ? it.range.in : 0;
		const hi = it.kind === 'subclip' ? it.range.out : (asset.probe.durationFlicks ?? 0);
		const fps = assetFps(asset, 30);
		return { itemId: it.id, range: { in: it.marks.in?.flicks ?? lo, out: it.marks.out?.flicks ?? hi }, fps };
	};
	const source = sourceMonitorState.getState().itemId;
	if (ctx.focus.panel === 'source') return fromItem(source);
	if (ctx.focus.panel === 'project') return fromItem(session.getState().selection.project.primary);
	if (ctx.focus.panel === 'timeline') {
		const e = envOf(ctx);
		const sel = e ? selectedClips(e) : [];
		const c = sel.find((x) => (x as { mediaId?: string }).mediaId);
		if (e && c) {
			const m = (c as { mediaId: string }).mediaId;
			const item =
				(c.subclipId && doc.items[c.subclipId] ? c.subclipId : null) ??
				Object.values(doc.items).find((i) => i.kind === 'media' && i.mediaId === m)?.id;
			const base = item ? fromItem(item) : null;
			if (base) {
				const span = c.duration * (705_600_000 / fpsOf(e.seq)) * c.speed.rate;
				return { ...base, range: { in: c.sourceIn, out: Math.round(c.sourceIn + span) } };
			}
		}
	}
	return fromItem(source) ?? fromItem(session.getState().selection.project.primary);
}

export const editUxCommands: UiCommand[] = [
	// ---------------------------------------------------------------- trim mode
	cmd(
		'timeline.trimEdit',
		'Trim Edit',
		T,
		(ctx, e) => {
			// Premiere Shift+T: selects the nearest edit point on the targeted tracks (as a roll) and opens the Trim
			// Monitor; with edit points already selected it toggles their trim type.
			if (inTrimMode(ctx) && e.handle) {
				cycleTrimTypes(e.handle.ui, e.seq);
				return;
			}
			if (editPointsOf(e.handle?.ui).length) {
				enterTrimMode(e.seq.id);
				return;
			}
			nearest(ctx, e, 'roll');
		},
		{ description: 'Select the nearest edit point and open the Trim Monitor' },
	),
	cmd(
		'timeline.toggleTrimType',
		'Toggle Trim Type',
		T,
		(_ctx, e) => {
			if (e.handle) cycleTrimTypes(e.handle.ui, e.seq);
		},
		{ when: hasEditPoints },
	),
	...NEAREST.map(([id, label, kind]) => cmd(id, label, T, (ctx, e) => nearest(ctx, e, kind))),
	cmd('timeline.trimBack', 'Trim Backward', T, (ctx, e) => trimBy(ctx, e, -1), {
		repeat: true,
		when: hasEditPoints,
	}),
	cmd('timeline.trimForward', 'Trim Forward', T, (ctx, e) => trimBy(ctx, e, 1), {
		repeat: true,
		when: hasEditPoints,
	}),
	cmd('timeline.trimBackMany', 'Trim Backward Many', T, (ctx, e) => trimBy(ctx, e, -LARGE_TRIM_OFFSET), {
		repeat: true,
		when: hasEditPoints,
	}),
	cmd('timeline.trimForwardMany', 'Trim Forward Many', T, (ctx, e) => trimBy(ctx, e, LARGE_TRIM_OFFSET), {
		repeat: true,
		when: hasEditPoints,
	}),
	cmd('timeline.extendEditToPlayhead', 'Extend Selected Edit to Playhead', T, (ctx, e) => {
		const points = editPointsOf(e.handle?.ui);
		if (!points.length || !e.handle) {
			ctx.ui.toast({ kind: 'info', message: 'Select an edit point first' });
			return;
		}
		const f = editPointFrame(e.seq, points[0]!);
		if (f === null) return;
		toastResult(ctx, trimSelected(e.session, e.handle, e.seq.id, e.playhead - f, { label: 'Extend Edit' }));
	}),
	{
		id: 'timeline.trimNumericEntry',
		label: 'Trim by Number',
		description: 'Type a number of frames (with + or −), then Enter, to trim the selected edit points',
		scope: T,
		agentExposed: true,
		argsSchema: z.object({ sign: z.union([z.literal(1), z.literal(-1)]).optional() }).optional(),
		when: hasEditPoints,
		run: (ctx, args) => {
			const e = envOf(ctx);
			if (!e?.handle) return;
			commitDynamicTrim();
			const sign = (args as { sign?: 1 | -1 } | undefined)?.sign ?? 1;
			if (!trimMode.getState().active || trimMode.getState().sequenceId !== e.seq.id) enterTrimMode(e.seq.id);
			trimMode.setState({ numeric: sign < 0 ? '-' : '+' });
		},
	},
	{
		id: 'timeline.trimByFrames',
		label: 'Trim Selected Edit Points by Frames',
		scope: T,
		agentExposed: true,
		argsSchema: z.object({ frames: z.number().int() }),
		when: hasEditPoints,
		run: (ctx, args) => {
			const e = envOf(ctx);
			if (e) trimBy(ctx, e, (args as { frames: number }).frames);
		},
	},
	{
		id: 'timeline.dynamicTrimStop',
		label: 'Stop Dynamic Trimming',
		scope: E,
		hidden: true,
		when: () => activeDynamicTrim() !== null,
		run: () => void commitDynamicTrim(),
	},
	cmd(
		'timeline.applyDefaultTransitionsAtEditPoints',
		'Apply Default Transitions to Selection',
		T,
		(ctx, e) => {
			// Premiere Shift+D with edit points selected (Trim Monitor button): the default video/audio transition at
			// every selected edit point (FilmCraft trim.applyDefaultTransition).
			const commands = editPointsOf(e.handle?.ui).flatMap((p) => {
				const c = e.seq.clips[p.clipId];
				if (!c) return [];
				const video = e.seq.videoTracks.some((t) => t.id === c.trackId);
				const audio = e.seq.audioTracks.some((t) => t.id === c.trackId);
				if (!video && !audio) return [];
				const medium = video ? 'video' : 'audio';
				return [
					{
						type: 'transition.applyDefault',
						clipIds: [c.id],
						edges: p.edge,
						...defaultTransitionFields([medium]),
					},
				];
			});
			if (!commands.length) return;
			const r = e.session.apply({
				label: 'Apply Default Transitions',
				origin: 'user',
				sequenceId: e.seq.id,
				commands: commands as never[],
			});
			if (!r.ok)
				ctx.ui.toast({
					kind: 'warning',
					message: 'Apply Default Transitions: not possible',
					detail: r.errors[0]?.message,
				});
		},
		{ when: hasEditPoints },
	),
	cmd(
		'timeline.playAroundEdit',
		'Play Around the Edit',
		E,
		(ctx) => {
			trimModePlay(ctx);
		},
		{ when: inTrimMode },
	),
	// ---------------------------------------------------------------- source edits (override transport.ts ids)
	{
		id: 'timeline.insertFromSource',
		label: 'Insert',
		scope: E,
		agentExposed: true,
		when: (ctx) => !!ctx.session && sourceMonitorState.getState().itemId !== null,
		run: (ctx) => runSourceEdit(ctx, 'insert'),
	},
	{
		id: 'timeline.overwriteFromSource',
		label: 'Overwrite',
		scope: E,
		agentExposed: true,
		when: (ctx) => !!ctx.session && sourceMonitorState.getState().itemId !== null,
		run: (ctx) => runSourceEdit(ctx, 'overwrite'),
	},
	{
		id: 'source.clearFitChoice',
		label: 'Ask Fit Clip Again',
		description: 'Forget the "Always use this choice" answer of the Fit Clip dialog',
		scope: 'global',
		when: () => rememberedFitChoice() !== null,
		run: () => rememberFitChoiceReset(),
	},
	// ---------------------------------------------------------------- Mark Split (Premiere Markers ▸ Mark Split)
	...(
		[
			['source.markSplitVideoIn', 'Mark Split Video In', 'videoIn'],
			['source.markSplitVideoOut', 'Mark Split Video Out', 'videoOut'],
			['source.markSplitAudioIn', 'Mark Split Audio In', 'audioIn'],
			['source.markSplitAudioOut', 'Mark Split Audio Out', 'audioOut'],
		] as const
	).map(
		([id, label, field]): UiCommand => ({
			id,
			label,
			scope: 'source',
			agentExposed: true,
			when: (ctx) => !!ctx.session && splitMarkable(ctx),
			run: (ctx) => {
				if (ctx.session) setSplitMark(ctx.session, field);
			},
		}),
	),
	{
		id: 'source.clearSplitMarks',
		label: 'Clear Split Marks',
		scope: 'source',
		agentExposed: true,
		when: (ctx) => !!ctx.session && splitMarkable(ctx),
		run: (ctx) => {
			if (ctx.session) setSplitMark(ctx.session, null);
		},
	},
	// ---------------------------------------------------------------- clip commands
	cmd(
		'timeline.speedDuration',
		'Speed/Duration…',
		T,
		(ctx, e) => {
			const clips = selectedClips(e).filter((c) => !isLocked(e.seq, c.trackId));
			if (!clips.length) {
				ctx.ui.toast({ kind: 'info', message: 'Select clips first' });
				return;
			}
			registerEditUxDialogs();
			ctx.ui.openDialog(SPEED_DURATION_DIALOG, {
				session: e.session,
				sequenceId: e.seq.id,
				clipIds: clips.map((c) => c.id),
			});
		},
		{
			when: (ctx) => {
				const e = envOf(ctx);
				return !!e && selectedClips(e).length > 0;
			},
		},
	),
	{
		id: 'timeline.toggleLinkedSelection',
		label: 'Linked Selection',
		scope: E,
		agentExposed: true,
		when: (ctx) => !!ctx.session,
		checked: (ctx) => !!ctx.session?.getState().toggles.linkedSelection,
		run: (ctx) => {
			const s = ctx.session;
			if (s) s.setToggles({ linkedSelection: !s.getState().toggles.linkedSelection });
		},
	},
	{
		id: 'project.makeSubclip',
		label: 'Make Subclip…',
		scope: 'global',
		agentExposed: true,
		when: (ctx) => subclipSource(ctx) !== null,
		run: (ctx) => {
			const src = subclipSource(ctx);
			if (!src || !ctx.session) return;
			registerEditUxDialogs();
			ctx.ui.openDialog(SUBCLIP_DIALOG, { session: ctx.session, mode: 'make', ...src });
		},
	},
	{
		id: 'project.editSubclip',
		label: 'Edit Subclip…',
		scope: 'global',
		agentExposed: true,
		when: (ctx) => editableSubclip(ctx) !== null,
		run: (ctx) => {
			const it = editableSubclip(ctx);
			if (!it || !ctx.session) return;
			const asset = ctx.session.getCommitted().media[it.mediaId];
			registerEditUxDialogs();
			ctx.ui.openDialog(SUBCLIP_DIALOG, {
				session: ctx.session,
				mode: 'edit',
				itemId: it.id,
				range: it.range,
				fps: assetFps(asset ?? null, 30),
				name: it.name,
				restrictTrims: it.restrictTrims,
			});
		},
	},
	{
		id: 'app.keyboardShortcuts',
		label: 'Keyboard Shortcuts…',
		description:
			'Customize keyboard shortcuts and choose a layout (Premiere Pro, Avid, Final Cut Pro 7, Final Cut Pro)',
		scope: 'global',
		run: (ctx) => {
			registerKeyboardShortcutsDialog();
			ctx.ui.openDialog(KEYBOARD_SHORTCUTS_DIALOG, { platform: detectPlatform(), runtime: detectRuntime() });
		},
	},
];

function rememberFitChoiceReset(): void {
	rememberFitChoice(null);
}

function editableSubclip(ctx: CommandCtx) {
	const session = ctx.session;
	if (!session) return null;
	const doc = session.getCommitted();
	for (const id of [session.getState().selection.project.primary, sourceMonitorState.getState().itemId]) {
		const it = id ? doc.items[id] : undefined;
		if (it?.kind === 'subclip') return it;
	}
	return null;
}

function splitMarkable(ctx: CommandCtx): boolean {
	const s = ctx.session;
	const id = sourceMonitorState.getState().itemId;
	const it = s && id ? s.getCommitted().items[id] : undefined;
	return it?.kind === 'media' || it?.kind === 'subclip';
}

/** Sets one Mark Split mark at the Source playhead (Out marks are exclusive: the frame after), or clears them all. */
function setSplitMark(
	session: NonNullable<CommandCtx['session']>,
	field: 'videoIn' | 'videoOut' | 'audioIn' | 'audioOut' | null,
): void {
	const st = sourceMonitorState.getState();
	const id = st.itemId;
	const it = id ? session.getCommitted().items[id] : undefined;
	if (!id || !it || (it.kind !== 'media' && it.kind !== 'subclip')) return;
	const t = getSourceTransport();
	const frame = (t?.getState().frame ?? 0) + (field?.endsWith('Out') ? 1 : 0);
	const flicks = Math.round((frame / st.fps) * 705_600_000);
	const r = session.apply({
		label: field ? 'Mark Split' : 'Clear Split Marks',
		origin: 'user',
		commands: [
			{
				type: 'item.setMarks',
				itemId: id,
				in: it.marks.in,
				out: it.marks.out,
				split: field ? { [field]: { flicks } } : null,
			} as never,
		],
	});
	if (!r.ok) console.info(`[source] ${r.errors[0]?.message}`);
}
