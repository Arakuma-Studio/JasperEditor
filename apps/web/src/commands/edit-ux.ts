// edit-ux UI commands: keyboard trim mode (Trim Edit, Select Nearest Edit Point, Toggle Trim Type, Trim
// Forward/Backward, Extend Edit, numeric trim entry, dynamic J/K/L trimming, Play Around the Edit), Match Frame,
// Reverse Match Frame, Linked Selection, Speed/Duration, Make Subclip, source patching and track targeting.
// Keys follow Premiere Pro's defaults (keymap-defaults.ts).
import { editPointFrame, type NearestKind, type Sequence } from '@jasper/project';
import { z } from 'zod';
import { defaultTransitionFields } from '../panels/effects/transition-prefs.ts';
import { driverFor } from '../panels/program/transport-registry.ts';
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
import { onBeforeCommand } from './registry.ts';
import { type Env, envOf, seekReveal, targetedTracks } from './timeline.ts';
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
];
