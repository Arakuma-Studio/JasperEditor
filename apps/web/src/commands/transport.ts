// transport UI commands — owned by WP-2C. Ids match keymap-defaults.ts (S02:TL-903, S05:PGM-008).
//
// Transport commands act on the Source monitor's local transport when the Source panel is focused,
// else on the session's TransportStore (Program/Timeline). Rates beyond the Player's native range
// are realized by the Program monitor's PlaybackDriver with seek-stepping (TL-873).
// Also registered here: monitor-scoped commands (fit, loop, nudge, snap) and the Source hand-off
// (source.open, Insert `,` / Overwrite `.`), because the monitors own those behaviors.
import { nextEditPoint, prevEditPoint, sequenceDuration } from '@jasper/project';
import type { TransportStore } from '@jasper/session';
import { z } from 'zod';
import { activeSequence, NUDGE_LARGE, NUDGE_SMALL, nudgeSelection } from '../panels/program/edits.ts';
import { monitorStores } from '../panels/program/monitor-store.ts';
import { driverFor, getSourceTransport, shuttleFor } from '../panels/program/transport-registry.ts';
import { openInSource, performSourceEdit, sourceMonitorState } from '../panels/source/source-state.ts';
import type { CommandCtx, UiCommand } from './types.ts';

/** Large step for Shift+←/→ (S02:TL-876 preference default). */
const LARGE_STEP_FRAMES = 5;
/** Play Around pre/post-roll (S02:TL-877 preference default). */
const PLAY_AROUND_SECONDS = 2;

function isSource(ctx: CommandCtx): boolean {
	return ctx.focus.panel === 'source' && getSourceTransport() !== null;
}

/** The transport the command acts on. */
function activeTransport(ctx: CommandCtx): TransportStore {
	return (isSource(ctx) ? getSourceTransport() : null) ?? ctx.transport;
}

/** Last frame the playhead may reach: the sequence end (TL-834) or the source duration. */
function endFrame(ctx: CommandCtx): number {
	if (isSource(ctx)) return Math.max(0, sourceMonitorState.getState().durationFrames - 1);
	const seq = ctx.session ? activeSequence(ctx.session) : null;
	return seq ? sequenceDuration(seq) : 0;
}

function inOut(ctx: CommandCtx): { in: number | null; out: number | null } {
	if (isSource(ctx)) {
		const s = sourceMonitorState.getState();
		return { in: s.markIn, out: s.markOut };
	}
	const seq = ctx.session ? activeSequence(ctx.session) : null;
	return { in: seq?.inPoint ?? null, out: seq?.outPoint ?? null };
}

function fps(ctx: CommandCtx): number {
	if (isSource(ctx)) return sourceMonitorState.getState().fps;
	const seq = ctx.session ? activeSequence(ctx.session) : null;
	return seq ? seq.settings.frameRate.num / seq.settings.frameRate.den : 30;
}

function seek(ctx: CommandCtx, frame: number) {
	const t = activeTransport(ctx);
	if (t.getState().playing) t.pause();
	const target = Math.max(0, Math.min(endFrame(ctx), frame));
	t.seek(target);
	// S02:TL-120: keyboard seeks on the sequence (steps, Home/End, edit points) bring the playhead into view
	// in the timeline with minimum scrolling.
	if (!isSource(ctx)) ctx.services.get('timelineViewport')?.scrollToFrame(target);
}

function editTargets(ctx: CommandCtx, any: boolean): string[] | undefined {
	if (any || !ctx.session) return undefined;
	const s = ctx.session.getState();
	const view = s.activeSequenceId ? s.views[s.activeSequenceId] : undefined;
	const ids = [...(view?.targeting.video ?? []), ...(view?.targeting.audio ?? [])];
	return ids.length ? ids : undefined;
}

function goToEdit(ctx: CommandCtx, dir: 1 | -1, any: boolean) {
	const seq = ctx.session ? activeSequence(ctx.session) : null;
	if (!seq) return;
	const t = activeTransport(ctx);
	const f = t.getState().frame;
	const next =
		dir > 0 ? nextEditPoint(seq, f, editTargets(ctx, any)) : prevEditPoint(seq, f, editTargets(ctx, any));
	if (next !== null) seek(ctx, next);
}

const shuttleKey =
	(key: 'J' | 'K' | 'L') =>
	(ctx: CommandCtx): void =>
		shuttleFor(activeTransport(ctx)).keyDown(key);
const shuttleKeyUp =
	(key: 'J' | 'K' | 'L') =>
	(ctx: CommandCtx): void =>
		shuttleFor(activeTransport(ctx)).keyUp(key);

const hasSequence = (ctx: CommandCtx) => isSource(ctx) || !!(ctx.session && activeSequence(ctx.session));

function nudge(dx: number, dy: number) {
	return (ctx: CommandCtx) => {
		if (!ctx.session) return;
		nudgeSelection(ctx.session, ctx.transport.getState().frame, dx, dy);
	};
}

export const transportCommands: UiCommand[] = [
	// ---------------------------------------------------------------- play / JKL (S02:TL-871/872, A.8)
	{
		id: 'transport.playStop',
		label: 'Play/Stop',
		icon: 'transport.play',
		scope: 'editing',
		agentExposed: true,
		checked: (ctx) => activeTransport(ctx).getState().playing,
		run: (ctx) => shuttleFor(activeTransport(ctx)).playStop(),
	},
	{
		id: 'transport.shuttleForward',
		label: 'Shuttle Right',
		scope: 'editing',
		run: shuttleKey('L'),
		onKeyUp: shuttleKeyUp('L'),
	},
	{
		id: 'transport.shuttleReverse',
		label: 'Shuttle Left',
		scope: 'editing',
		run: shuttleKey('J'),
		onKeyUp: shuttleKeyUp('J'),
	},
	{
		id: 'transport.shuttleStop',
		label: 'Shuttle Stop',
		scope: 'editing',
		run: shuttleKey('K'),
		onKeyUp: shuttleKeyUp('K'),
	},
	{
		id: 'transport.shuttleSlowForward',
		label: 'Shuttle Slow Right',
		scope: 'editing',
		run: (ctx) => shuttleFor(activeTransport(ctx)).slow(1),
	},
	{
		id: 'transport.shuttleSlowReverse',
		label: 'Shuttle Slow Left',
		scope: 'editing',
		run: (ctx) => shuttleFor(activeTransport(ctx)).slow(-1),
	},
	// ---------------------------------------------------------------- stepping and jumps (TL-876/879/880)
	{
		id: 'transport.stepBack',
		label: 'Step Back 1 Frame',
		icon: 'transport.stepBack',
		scope: 'editing',
		repeat: true,
		agentExposed: true,
		run: (ctx) => seek(ctx, activeTransport(ctx).getState().frame - 1),
	},
	{
		id: 'transport.stepForward',
		label: 'Step Forward 1 Frame',
		icon: 'transport.stepForward',
		scope: 'editing',
		repeat: true,
		agentExposed: true,
		run: (ctx) => seek(ctx, activeTransport(ctx).getState().frame + 1),
	},
	{
		id: 'transport.stepBackMany',
		label: 'Step Back 5 Frames',
		scope: 'editing',
		repeat: true,
		run: (ctx) => seek(ctx, activeTransport(ctx).getState().frame - LARGE_STEP_FRAMES),
	},
	{
		id: 'transport.stepForwardMany',
		label: 'Step Forward 5 Frames',
		scope: 'editing',
		repeat: true,
		run: (ctx) => seek(ctx, activeTransport(ctx).getState().frame + LARGE_STEP_FRAMES),
	},
	{
		id: 'transport.goToStart',
		label: 'Go to Start',
		icon: 'transport.goToStart',
		scope: 'editing',
		agentExposed: true,
		run: (ctx) => seek(ctx, 0),
	},
	{
		id: 'transport.goToEnd',
		label: 'Go to End',
		icon: 'transport.goToEnd',
		scope: 'editing',
		agentExposed: true,
		run: (ctx) => seek(ctx, endFrame(ctx)),
	},
	{
		id: 'transport.prevEdit',
		label: 'Go to Previous Edit Point',
		scope: 'editing',
		repeat: true,
		when: (ctx) => !!ctx.session,
		run: (ctx) => goToEdit(ctx, -1, false),
	},
	{
		id: 'transport.nextEdit',
		label: 'Go to Next Edit Point',
		scope: 'editing',
		repeat: true,
		when: (ctx) => !!ctx.session,
		run: (ctx) => goToEdit(ctx, 1, false),
	},
	{
		id: 'transport.prevEditAny',
		label: 'Go to Previous Edit Point on Any Track',
		scope: 'editing',
		repeat: true,
		when: (ctx) => !!ctx.session,
		run: (ctx) => goToEdit(ctx, -1, true),
	},
	{
		id: 'transport.nextEditAny',
		label: 'Go to Next Edit Point on Any Track',
		scope: 'editing',
		repeat: true,
		when: (ctx) => !!ctx.session,
		run: (ctx) => goToEdit(ctx, 1, true),
	},
	{
		id: 'transport.playInToOut',
		label: 'Play In to Out',
		scope: 'editing',
		when: hasSequence,
		run: (ctx) => {
			const t = activeTransport(ctx);
			const m = inOut(ctx);
			const from = m.in ?? 0;
			const to = m.out ?? endFrame(ctx);
			const driver = driverFor(t);
			if (driver) driver.playRange(from, to);
			else {
				t.seek(from);
				t.play(1);
			}
		},
	},
	{
		id: 'transport.playAround',
		label: 'Play Around',
		scope: 'editing',
		when: hasSequence,
		run: (ctx) => {
			const t = activeTransport(ctx);
			const at = t.getState().frame;
			const n = Math.round(PLAY_AROUND_SECONDS * fps(ctx));
			const driver = driverFor(t);
			const from = Math.max(0, at - n);
			const to = Math.min(endFrame(ctx) + 1, at + n);
			if (driver) driver.playRange(from, to, { returnTo: at });
		},
	},
	// ---------------------------------------------------------------- monitor scope (S05:PGM-008, R-PUI §16.7)
	{
		id: 'monitor.fit',
		label: 'Fit',
		scope: 'program',
		run: (ctx) =>
			monitorStores[ctx.focus.panel === 'source' ? 'source' : 'program'].setState({
				zoom: 'fit',
				pan: [0, 0],
			}),
	},
	{
		id: 'monitor.toggleLoop',
		label: 'Loop',
		scope: 'program',
		checked: (ctx) => activeTransport(ctx).getState().loop,
		run: (ctx) => {
			const t = activeTransport(ctx);
			t.setLoop(!t.getState().loop);
		},
	},
	{
		id: 'program.snapInMonitor',
		label: 'Snap in Program Monitor',
		scope: 'program',
		checked: () => monitorStores.program.getState().snapInMonitor,
		run: () => monitorStores.program.setState((s) => ({ snapInMonitor: !s.snapInMonitor })),
	},
	{
		id: 'program.nudgeLeft',
		label: 'Nudge Left',
		scope: 'program',
		repeat: true,
		run: nudge(-NUDGE_SMALL, 0),
	},
	{
		id: 'program.nudgeRight',
		label: 'Nudge Right',
		scope: 'program',
		repeat: true,
		run: nudge(NUDGE_SMALL, 0),
	},
	{ id: 'program.nudgeUp', label: 'Nudge Up', scope: 'program', repeat: true, run: nudge(0, -NUDGE_SMALL) },
	{
		id: 'program.nudgeDown',
		label: 'Nudge Down',
		scope: 'program',
		repeat: true,
		run: nudge(0, NUDGE_SMALL),
	},
	{
		id: 'program.nudgeLeftMany',
		label: 'Nudge Left 5',
		scope: 'program',
		repeat: true,
		run: nudge(-NUDGE_LARGE, 0),
	},
	{
		id: 'program.nudgeRightMany',
		label: 'Nudge Right 5',
		scope: 'program',
		repeat: true,
		run: nudge(NUDGE_LARGE, 0),
	},
	{
		id: 'program.nudgeUpMany',
		label: 'Nudge Up 5',
		scope: 'program',
		repeat: true,
		run: nudge(0, -NUDGE_LARGE),
	},
	{
		id: 'program.nudgeDownMany',
		label: 'Nudge Down 5',
		scope: 'program',
		repeat: true,
		run: nudge(0, NUDGE_LARGE),
	},
	// ---------------------------------------------------------------- Source monitor hand-off (S03:SRC-001/004)
	{
		id: 'source.open',
		label: 'Open in Source Monitor',
		scope: 'global',
		argsSchema: z.object({ itemId: z.string().min(1) }),
		when: (ctx) => !!ctx.session,
		run: (ctx, args) => {
			if (ctx.session) openInSource(ctx.session, (args as { itemId: string }).itemId);
		},
	},
	{
		id: 'timeline.insertFromSource',
		label: 'Insert',
		scope: 'editing',
		when: (ctx) => !!ctx.session && sourceMonitorState.getState().itemId !== null,
		run: (ctx) => runSourceEdit(ctx, 'insert'),
	},
	{
		id: 'timeline.overwriteFromSource',
		label: 'Overwrite',
		scope: 'editing',
		when: (ctx) => !!ctx.session && sourceMonitorState.getState().itemId !== null,
		run: (ctx) => runSourceEdit(ctx, 'overwrite'),
	},
];

function runSourceEdit(ctx: CommandCtx, mode: 'insert' | 'overwrite') {
	if (!ctx.session) return;
	const r = performSourceEdit(ctx.session, mode);
	if (!r.ok)
		ctx.ui.toast({
			kind: 'warning',
			message: r.message ?? `${mode === 'insert' ? 'Insert' : 'Overwrite'} failed`,
		});
}
