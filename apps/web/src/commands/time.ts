// Workstream `time` UI commands (docs/wp-notes/time.md): Show Clip Keyframes ▸ Time Remapping ▸ Speed, Remove Time
// Remapping, Add / remove a speed keyframe at the playhead, Clip ▸ Video Options ▸ Time Interpolation (Frame
// Sampling / Frame Blending / Optical Flow) and Scene Edit Detection…. Premiere has no default shortcuts for these
// (Adobe's default keyboard shortcut list), so none are bound. Registers the speed band (clip decoration), the
// Effect Controls section host, the clip context-menu entries and the Scene Edit Detection dialog.
import {
	activeRemap,
	type Clip,
	contentTimeAt,
	isRemapped,
	type Rational,
	type Sequence,
	type TimedClip,
	type TimeInterpolation,
	timeInterpolationOf,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { openDialog, registerDialog } from '@jasper/ui';
import { clipDecorations, clipMenuExtensions, type MenuItemSpec } from '../extensions/index.ts';
import { activeTimeline } from '../panels/timeline/env.tsx';
import { SCENE_DETECT_DIALOG, SceneDetectDialog } from '../time/SceneDetectDialog.tsx';
import { bandVisible, SpeedBandOverlay } from '../time/SpeedBand.tsx';
import { isBandShown, setBandShown, subscribeBand } from '../time/store.ts';
import type { CommandCtx, CommandScope, UiCommand } from './types.ts';

type Env = { session: EditorSession; seq: Sequence; playhead: number };

function envOf(ctx: CommandCtx): Env | null {
	const session = ctx.session;
	if (!session) return null;
	const s = session.getState();
	const seqId = activeTimeline(ctx.services)?.sequenceId() ?? s.activeSequenceId;
	const seq = seqId ? (session.getCommitted().sequences[seqId] as Sequence | undefined) : undefined;
	if (!seq) return null;
	return { session, seq, playhead: session.transport.getState().frame };
}

const remappable = (c: Clip) => c.kind === 'video' || c.kind === 'nest-video';
const selectedClips = (e: Env): Clip[] =>
	e.session
		.getState()
		.selection.timeline.clips.map((id) => e.seq.clips[id])
		.filter((c): c is Clip => !!c);
const editable = (ctx: CommandCtx) => {
	const e = envOf(ctx);
	return !!e && !e.session.getState().readOnly;
};

/** The selected remappable clip under the playhead, else the first selected remappable clip. */
function targetClip(e: Env): Clip | null {
	const sel = selectedClips(e).filter(remappable);
	return sel.find((c) => c.start <= e.playhead && e.playhead < c.start + c.duration) ?? sel[0] ?? null;
}

function apply(ctx: CommandCtx, e: Env, label: string, commands: unknown[]): boolean {
	const r = e.session.apply({ label, origin: 'user', sequenceId: e.seq.id, commands: commands as never[] });
	if (!r.ok)
		ctx.ui.toast({ kind: 'warning', message: `${label}: not possible`, detail: r.errors[0]?.message });
	else if (r.warnings.length) ctx.ui.toast({ kind: 'info', message: r.warnings[0]!.message });
	return r.ok;
}

const E: CommandScope = 'editing';

function cmd(
	id: string,
	label: string,
	run: (ctx: CommandCtx, e: Env, args?: unknown) => void,
	extra: Partial<UiCommand> = {},
): UiCommand {
	return {
		id,
		label,
		scope: E,
		when: (ctx) => !!envOf(ctx),
		run: (ctx, args) => {
			const e = envOf(ctx);
			if (e) run(ctx, e, args);
		},
		agentExposed: true,
		...extra,
	};
}

const INTERP: { id: string; mode: TimeInterpolation; label: string }[] = [
	{ id: 'timeline.timeInterpolation.frameSampling', mode: 'frame-sampling', label: 'Frame Sampling' },
	{ id: 'timeline.timeInterpolation.frameBlending', mode: 'frame-blending', label: 'Frame Blending' },
	{ id: 'timeline.timeInterpolation.opticalFlow', mode: 'optical-flow', label: 'Optical Flow' },
];

export function openSceneDetection(ctx: CommandCtx, e: Env): void {
	const clips = selectedClips(e).filter((c) => c.kind === 'video');
	if (!clips.length) {
		ctx.ui.toast({ kind: 'info', message: 'Scene Edit Detection: select one or more video clips' });
		return;
	}
	ctx.ui.openDialog(SCENE_DETECT_DIALOG, {
		session: e.session,
		sequenceId: e.seq.id,
		clipIds: clips.map((c) => c.id),
	});
}

export const timeCommands: UiCommand[] = [
	cmd(
		'timeline.showSpeedKeyframes',
		'Show Clip Keyframes ▸ Time Remapping ▸ Speed',
		(_ctx, e) => {
			const clips = selectedClips(e).filter(remappable);
			const on = !clips.every((c) => isBandShown(c.id) || isRemapped(c as TimedClip));
			setBandShown(
				clips.map((c) => c.id),
				on,
			);
		},
		{
			when: (ctx) => {
				const e = envOf(ctx);
				return !!e && selectedClips(e).some(remappable);
			},
			checked: (ctx) => {
				const e = envOf(ctx);
				const clips = e ? selectedClips(e).filter(remappable) : [];
				return clips.length > 0 && clips.every((c) => isBandShown(c.id) || isRemapped(c as TimedClip));
			},
		},
	),
	cmd(
		'timeline.removeTimeRemapping',
		'Remove Time Remapping',
		(ctx, e) => {
			const clips = selectedClips(e).filter((c) => remappable(c) && (c as { timeRemap?: unknown }).timeRemap);
			if (!clips.length) return;
			apply(ctx, e, 'Remove Time Remapping', [
				{ type: 'timeRemap.enable', clipIds: clips.map((c) => c.id), enabled: false },
			]);
		},
		{
			when: (ctx) => {
				const e = envOf(ctx);
				return (
					editable(ctx) && !!e && selectedClips(e).some((c) => remappable(c) && !!activeRemap(c as TimedClip))
				);
			},
		},
	),
	cmd(
		'timeline.toggleSpeedKeyframe',
		'Add / Remove Speed Keyframe',
		(ctx, e) => {
			const c = targetClip(e);
			if (!c || e.playhead < c.start || e.playhead >= c.start + c.duration) {
				ctx.ui.toast({ kind: 'info', message: 'Place the playhead over a selected video clip' });
				return;
			}
			setBandShown([c.id], true);
			const at = (activeRemap(c as TimedClip)?.keyframes ?? []).find(
				(k) => Math.abs(k.time - contentAt(e, c)) < 1000,
			);
			if (at)
				apply(ctx, e, 'Delete Speed Keyframes', [
					{ type: 'timeRemap.removeKeyframes', clipId: c.id, keyframeIds: [at.id] },
				]);
			else
				apply(ctx, e, 'Add Speed Keyframe', [
					{ type: 'timeRemap.addKeyframe', clipId: c.id, at: e.playhead },
				]);
		},
		{ when: editable },
	),
	...INTERP.map((m) =>
		cmd(
			m.id,
			`Time Interpolation ▸ ${m.label}`,
			(ctx, e) => {
				const clips = selectedClips(e).filter((c) => c.kind === 'video');
				if (!clips.length) return;
				apply(ctx, e, 'Time Interpolation', [
					{ type: 'clip.setTimeInterpolation', clipIds: clips.map((c) => c.id), mode: m.mode },
				]);
			},
			{
				when: (ctx) => {
					const e = envOf(ctx);
					return editable(ctx) && !!e && selectedClips(e).some((c) => c.kind === 'video');
				},
				checked: (ctx) => {
					const e = envOf(ctx);
					const clips = e ? selectedClips(e).filter((c) => c.kind === 'video') : [];
					return clips.length > 0 && clips.every((c) => timeInterpolationOf(c as TimedClip) === m.mode);
				},
			},
		),
	),
	cmd('timeline.sceneEditDetection', 'Scene Edit Detection…', (ctx, e) => openSceneDetection(ctx, e), {
		when: (ctx) => {
			const e = envOf(ctx);
			return editable(ctx) && !!e && selectedClips(e).some((c) => c.kind === 'video');
		},
	}),
];

function contentAt(e: Env, c: Clip): number {
	return contentTimeAt(c, e.playhead, e.seq.settings.frameRate as Rational);
}

// ---------------------------------------------------------------- registration

registerDialog(SCENE_DETECT_DIALOG, SceneDetectDialog);

const speedBand = () => ({
	id: 'time.speedBand',
	order: 20,
	appliesTo: bandVisible,
	overlay: SpeedBandOverlay,
});
clipDecorations.register(speedBand());
// `appliesTo` reads the band store: re-register on every change so the (memoised) clip views re-evaluate it.
subscribeBand(() => clipDecorations.register(speedBand()));

clipMenuExtensions.register({
	id: 'time',
	order: 30,
	items: ({ session, clip, selection }) => {
		if (!remappable(clip)) return [];
		const readOnly = session.getState().readOnly;
		const ids = selection.includes(clip.id) ? selection : [clip.id];
		const remapped = !!activeRemap(clip as TimedClip);
		// Show Clip Keyframes ▸ Time Remapping ▸ Speed lives in edit-ux's Show Clip Keyframes menu (edit-ux/menus.ts).
		const items: MenuItemSpec[] = [];
		if (remapped)
			items.push({
				kind: 'item',
				label: 'Remove Time Remapping',
				disabled: readOnly,
				run: () =>
					void session.apply({
						label: 'Remove Time Remapping',
						origin: 'user',
						commands: [{ type: 'timeRemap.enable', clipIds: ids, enabled: false } as never],
					}),
			});
		if (clip.kind === 'video') {
			items.push({
				kind: 'submenu',
				label: 'Time Interpolation',
				items: INTERP.map((m) => ({
					kind: 'item' as const,
					label: m.label,
					checked: timeInterpolationOf(clip as TimedClip) === m.mode,
					disabled: readOnly,
					run: () =>
						void session.apply({
							label: 'Time Interpolation',
							origin: 'user',
							commands: [{ type: 'clip.setTimeInterpolation', clipIds: ids, mode: m.mode } as never],
						}),
				})),
			});
			items.push({
				kind: 'item',
				label: 'Scene Edit Detection…',
				disabled: readOnly,
				run: () => {
					const seq = Object.values(session.getCommitted().sequences).find((s) => s.clips[clip.id]);
					if (!seq) return;
					const videoIds = ids.filter((id) => seq.clips[id]?.kind === 'video');
					void openDialog(SCENE_DETECT_DIALOG, { session, sequenceId: seq.id, clipIds: videoIds });
				},
			});
		}
		return items;
	},
});
