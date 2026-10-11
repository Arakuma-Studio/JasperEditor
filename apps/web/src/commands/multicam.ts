// Synchronize, Merge Clips and multi-camera UI commands (wp-multicam; docs/wp-notes/multicam.md). Premiere names
// and default shortcuts: keys 1–9 Select Camera 1–9, Ctrl+1–9 Cut to Camera 1–9, Shift+0 Toggle Multi-Camera View.
// Every edit is one document transaction (or, while playing, one recording pass = one undo step).
import {
	type Clip,
	cameraNumber,
	FLICKS_PER_SECOND,
	isMulticamClip,
	type MulticamClip,
	multicamSourceOf,
	type Sequence,
	shownAngles,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import {
	CREATE_MULTICAM_DIALOG,
	EDIT_CAMERAS_DIALOG,
	MERGE_CLIPS_DIALOG,
	registerMulticamDialogs,
	SYNCHRONIZE_DIALOG,
} from '../multicam/dialogs.tsx';
import { gridLayout, multicamClipAt } from '../multicam/logic.ts';
import { pressCamera } from '../multicam/recorder.ts';
import { multicamViewStore } from '../multicam/state.ts';
import { getSourceTransport } from '../panels/program/transport-registry.ts';
import { sourceMonitorState } from '../panels/source/source-state.ts';
import { activeTimeline } from '../panels/timeline/env.tsx';
import type { CommandCtx, CommandScope, UiCommand } from './types.ts';

registerMulticamDialogs();

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

const writable = (ctx: CommandCtx) => !!ctx.session && !ctx.session.getState().readOnly;
const selectedClips = (e: Env): Clip[] =>
	e.session
		.getState()
		.selection.timeline.clips.map((id) => e.seq.clips[id])
		.filter((c): c is Clip => !!c);
const selectedMulticam = (e: Env): MulticamClip[] => selectedClips(e).filter(isMulticamClip);

function projectItems(ctx: CommandCtx): string[] {
	const s = ctx.session?.getState();
	return s ? s.selection.project.items : [];
}
function mediaItems(ctx: CommandCtx): { id: string; video: boolean; audio: boolean }[] {
	const doc = ctx.session?.getCommitted();
	if (!doc) return [];
	return projectItems(ctx).flatMap((id) => {
		const it = doc.items[id];
		if (it?.kind !== 'media') return [];
		const m = doc.media[it.mediaId];
		if (!m || (m.kind !== 'video' && m.kind !== 'audio')) return [];
		return [
			{
				id,
				video: m.kind === 'video' && m.probe.streams.some((x) => x.type === 'video'),
				audio: m.probe.streams.some((x) => x.type === 'audio'),
			},
		];
	});
}

function apply(ctx: CommandCtx, e: Env, label: string, commands: unknown[]): boolean {
	const r = e.session.apply({ label, origin: 'user', sequenceId: e.seq.id, commands: commands as never[] });
	if (!r.ok)
		ctx.ui.toast({ kind: 'warning', message: `${label}: not possible`, detail: r.errors[0]?.message });
	else if (r.warnings.length) ctx.ui.toast({ kind: 'info', message: r.warnings[0]!.message });
	return r.ok;
}

const toastOf = (ctx: CommandCtx) => (kind: 'info' | 'warning', message: string, detail?: string) =>
	ctx.ui.toast({ kind, message, ...(detail ? { detail } : {}) });

/** The multi-camera clip the commands act on: selected ones, else the one at the playhead. */
function targetClips(e: Env): MulticamClip[] {
	const sel = selectedMulticam(e);
	if (sel.length) return sel;
	const at = multicamClipAt(e.seq, e.playhead, multicamViewStore.getState().topDown);
	return at ? [at.clip] : [];
}

/** The multi-camera source the view and Edit Cameras act on. */
function sourceOf(e: Env): string | null {
	const t = targetClips(e)[0];
	if (t) return t.sequenceId;
	return multicamSourceOf(e.seq) ? e.seq.id : null;
}

const E: CommandScope = 'editing';
const T: CommandScope = 'timeline';
const G: CommandScope = 'global';

function cmd(
	id: string,
	label: string,
	scope: CommandScope,
	run: (ctx: CommandCtx, e: Env, args?: unknown) => void,
	extra: Partial<UiCommand> = {},
): UiCommand {
	return {
		id,
		label,
		scope,
		when: (ctx) => !!envOf(ctx),
		run: (ctx, args) => {
			const e = envOf(ctx);
			if (e) run(ctx, e, args);
		},
		agentExposed: true,
		...extra,
	};
}

const viewToggle = (
	id: string,
	label: string,
	key: 'view' | 'showPreview' | 'topDown' | 'audioFollowsVideo' | 'showNames',
): UiCommand => ({
	id,
	label,
	scope: G,
	run: () => multicamViewStore.setState((s) => ({ [key]: !s[key] }) as never),
	checked: () => multicamViewStore.getState()[key],
	agentExposed: true,
});

const cameraKeys: UiCommand[] = [1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((n) => [
	cmd(
		`multicam.selectCamera${n}`,
		`Select Camera ${n}`,
		E,
		(ctx, e) => {
			pressCamera(e.session, n, 'select', toastOf(ctx));
		},
		{
			when: (ctx) => {
				const e = envOf(ctx);
				return (
					!!e && writable(ctx) && !!multicamClipAt(e.seq, e.playhead, multicamViewStore.getState().topDown)
				);
			},
			hidden: n > 1,
		},
	),
	cmd(
		`multicam.cutToCamera${n}`,
		`Cut to Camera ${n}`,
		E,
		(ctx, e) => {
			pressCamera(e.session, n, 'cutTo', toastOf(ctx));
		},
		{
			when: (ctx) => {
				const e = envOf(ctx);
				return (
					!!e && writable(ctx) && !!multicamClipAt(e.seq, e.playhead, multicamViewStore.getState().topDown)
				);
			},
			hidden: n > 1,
		},
	),
]);

export const multicamCommands: UiCommand[] = [
	cmd(
		'clip.synchronize',
		'Synchronize…',
		T,
		(ctx, e) => {
			const clips = selectedClips(e);
			ctx.ui.openDialog(SYNCHRONIZE_DIALOG, {
				session: e.session,
				engine: ctx.engine,
				sequenceId: e.seq.id,
				clipIds: clips.map((c) => c.id),
			});
		},
		{
			when: (ctx) => {
				const e = envOf(ctx);
				if (!e || !writable(ctx)) return false;
				const clips = selectedClips(e);
				const sources = new Set(clips.map((c) => c.linkId ?? c.id));
				return sources.size >= 2;
			},
			disabledReason: () => 'Select clips from at least two sources in the timeline',
		},
	),
	{
		id: 'clip.mergeClips',
		label: 'Merge Clips…',
		scope: G,
		when: (ctx) => {
			const items = mediaItems(ctx);
			return writable(ctx) && items.length >= 2 && items.filter((i) => i.video).length <= 1;
		},
		disabledReason: () => 'Select one video clip and audio clips in the Project panel',
		run: (ctx) =>
			ctx.ui.openDialog(MERGE_CLIPS_DIALOG, {
				session: ctx.session,
				engine: ctx.engine,
				itemIds: mediaItems(ctx).map((i) => i.id),
			}),
		agentExposed: true,
	},
	{
		id: 'clip.createMulticam',
		label: 'Create Multi-Camera Source Sequence…',
		scope: G,
		when: (ctx) => writable(ctx) && mediaItems(ctx).some((i) => i.video),
		disabledReason: () => 'Select camera clips in the Project panel',
		run: (ctx) =>
			ctx.ui.openDialog(CREATE_MULTICAM_DIALOG, {
				session: ctx.session,
				engine: ctx.engine,
				itemIds: mediaItems(ctx).map((i) => i.id),
			}),
		agentExposed: true,
	},
	cmd(
		'multicam.enable',
		'Enable',
		T,
		(ctx, e) => {
			const nests = selectedClips(e).filter((c) => c.kind === 'nest-video' || c.kind === 'nest-audio');
			if (!nests.length) return;
			const on = !nests.every((c) => isMulticamClip(c) && c.multicam.enabled);
			apply(ctx, e, on ? 'Enable Multi-Camera' : 'Disable Multi-Camera', [
				{ type: 'multicam.setEnabled', clipIds: nests.map((c) => c.id), enabled: on },
			]);
		},
		{
			when: (ctx) => {
				const e = envOf(ctx);
				return (
					!!e &&
					writable(ctx) &&
					selectedClips(e).some((c) => c.kind === 'nest-video' || c.kind === 'nest-audio')
				);
			},
			checked: (ctx) => {
				const e = envOf(ctx);
				const sel = e ? selectedMulticam(e) : [];
				return sel.length > 0 && sel.every((c) => c.multicam.enabled);
			},
		},
	),
	cmd(
		'multicam.flatten',
		'Flatten',
		T,
		(ctx, e) => {
			const clips = selectedMulticam(e);
			if (clips.length)
				apply(ctx, e, 'Flatten Multi-Camera', [
					{ type: 'multicam.flatten', clipIds: clips.map((c) => c.id) },
				]);
		},
		{
			when: (ctx) => {
				const e = envOf(ctx);
				return !!e && writable(ctx) && selectedMulticam(e).some((c) => c.multicam.enabled);
			},
		},
	),
	cmd(
		'multicam.switchCamera',
		'Switch to Camera',
		T,
		(ctx, e, args) => {
			const a = args as { camera?: number; angle?: string } | undefined;
			const clips = targetClips(e);
			if (!clips.length || (!a?.camera && !a?.angle)) return;
			apply(ctx, e, 'Switch Multi-Camera Angle', [
				{
					type: 'multicam.switchAngle',
					clipIds: clips.map((c) => c.id),
					angle: a.angle ?? a.camera,
					audio: multicamViewStore.getState().audioFollowsVideo,
				},
			]);
		},
		{ when: (ctx) => writable(ctx) && !!envOf(ctx) && targetClips(envOf(ctx)!).length > 0, hidden: true },
	),
	cmd(
		'multicam.editCameras',
		'Edit Cameras…',
		G,
		(ctx, e) => {
			const id = sourceOf(e);
			if (id) ctx.ui.openDialog(EDIT_CAMERAS_DIALOG, { session: e.session, sequenceId: id });
		},
		{ when: (ctx) => writable(ctx) && !!envOf(ctx) && !!sourceOf(envOf(ctx)!) },
	),
	viewToggle('program.toggleMulticamView', 'Multi-Camera', 'view'),
	viewToggle('multicam.showPreviewMonitor', 'Show Multi-Camera Preview Monitor', 'showPreview'),
	viewToggle('multicam.selectionTopDown', 'Multi-Camera Selection Top Down', 'topDown'),
	viewToggle('multicam.audioFollowsVideo', 'Multi-Camera Audio Follows Video', 'audioFollowsVideo'),
	viewToggle('multicam.showCameraNames', 'Show Camera Names', 'showNames'),
	...(['auto', 2, 3, 4] as const).map(
		(l): UiCommand => ({
			id: `multicam.layout.${l}`,
			label: l === 'auto' ? 'Automatic' : `${l}×${l}`,
			scope: G,
			run: () => multicamViewStore.setState({ layout: l, page: 0 }),
			checked: () => multicamViewStore.getState().layout === l,
			agentExposed: true,
			hidden: true,
		}),
	),
	...([1, -1] as const).map(
		(d): UiCommand =>
			cmd(
				d > 0 ? 'multicam.nextPage' : 'multicam.prevPage',
				d > 0 ? 'Next Multi-Camera Page' : 'Previous Multi-Camera Page',
				G,
				(_ctx, e) => {
					const id = sourceOf(e);
					const mc = id ? multicamSourceOf(e.session.getCommitted().sequences[id]) : null;
					const v = multicamViewStore.getState();
					const l = gridLayout(mc ? shownAngles(mc).length : 0, v.layout, v.page + d);
					multicamViewStore.setState({ page: l.page });
				},
				{ hidden: true },
			),
	),
	...cameraKeys,
	{
		// Premiere: M in the Source monitor adds a marker to the source clip (here: on the media item, media time).
		id: 'source.addMarker',
		label: 'Add Marker',
		scope: 'source',
		when: (ctx) => {
			const it = sourceMonitorState.getState().itemId;
			return writable(ctx) && !!it && ctx.session!.getCommitted().items[it]?.kind === 'media';
		},
		run: (ctx) => {
			const session = ctx.session!;
			const src = sourceMonitorState.getState();
			const f = getSourceTransport()?.getState().frame ?? 0;
			const r = session.apply({
				label: 'Add Marker',
				origin: 'user',
				commands: [
					{
						type: 'marker.add',
						itemId: src.itemId,
						flicks: { flicks: Math.round((f / src.fps) * FLICKS_PER_SECOND) },
					} as never,
				],
			});
			if (!r.ok)
				ctx.ui.toast({ kind: 'warning', message: 'Add Marker failed', detail: r.errors[0]?.message });
		},
		agentExposed: true,
	},
];

/** For menus: the Multi-Camera ▸ Camera N entries of a clip (context menu). */
export function cameraMenuEntries(
	session: EditorSession,
	clip: Clip,
): { label: string; camera: number; checked: boolean }[] {
	if (!isMulticamClip(clip)) return [];
	const mc = multicamSourceOf(session.getCommitted().sequences[clip.sequenceId]);
	if (!mc) return [];
	const current = cameraNumber(mc, clip.multicam.angle);
	return shownAngles(mc).map((a, i) => ({
		label: `${i + 1}  ${a.name}`,
		camera: i + 1,
		checked: current === i + 1,
	}));
}
