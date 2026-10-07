// three-d UI commands (docs/wp-notes/three-d.md): New ▸ Camera… / Light… (File ▸ New, Graphics ▸ New Layer, Project
// panel ▸ New Item), Clip ▸ 3D Layer, Camera Settings…, Light Settings…, View ▸ Switch 3D View ▸ … (After Effects'
// F10 Front, F11 Custom View 1, F12 Active Camera), Switch to Last 3D View, Reset 3D View, Create Camera from 3D View,
// Sequence ▸ 3D Renderer ▸ Classic 3D / Advanced 3D / Draft 3D. This module also registers the Program monitor's 3D
// overlay (view chip, wireframes, axis gizmo, Camera tool).
import { type Clip, canBe3d, type Sequence, VIEW_3D_LABELS, VIEWS_3D, type View3D } from '@jasper/project';
import { programOverlays } from '../extensions/index.ts';
import { CAMERA_DIALOG, LIGHT_DIALOG, registerThreeDDialogs } from '../three-d/dialogs.tsx';
import { Scene3DOverlay } from '../three-d/Scene3DOverlay.tsx';
import { resetView, switchView, viewCamOf, viewsOf } from '../three-d/view-store.ts';
import type { CommandCtx, UiCommand } from './types.ts';

registerThreeDDialogs();
programOverlays.register({ id: 'three-d', active: () => true, component: Scene3DOverlay, order: 95 });

function seqOf(ctx: CommandCtx): Sequence | null {
	const s = ctx.session?.getState();
	const id = s?.activeSequenceId;
	return id ? ((s?.document.sequences[id] as Sequence | undefined) ?? null) : null;
}
const editable = (ctx: CommandCtx) => !!seqOf(ctx) && !ctx.session!.getState().readOnly;
const selectedClips = (ctx: CommandCtx): Clip[] => {
	const seq = seqOf(ctx);
	if (!seq) return [];
	return ctx
		.session!.getState()
		.selection.timeline.clips.map((id) => seq.clips[id])
		.filter((c): c is Clip => !!c);
};
const can3d = (c: Clip) => canBe3d(c.kind);
const is3d = (c: Clip) => (c as { threeD?: { enabled?: boolean } }).threeD?.enabled === true;
const playhead = (ctx: CommandCtx) => ctx.session!.transport.getState().frame;

function apply(ctx: CommandCtx, label: string, commands: unknown[]): void {
	const seq = seqOf(ctx);
	if (!seq) return;
	const r = ctx.session!.apply({ label, origin: 'user', sequenceId: seq.id, commands: commands as never[] });
	if (!r.ok)
		ctx.ui.toast({ kind: 'warning', message: `${label}: not possible`, detail: r.errors[0]?.message });
	else if (r.warnings.length) ctx.ui.toast({ kind: 'info', message: r.warnings[0]!.message });
}

const viewCommand = (v: View3D): UiCommand => ({
	id: `threeD.view.${v}`,
	label: VIEW_3D_LABELS[v],
	description: `Show the 3D layers in the Program monitor through the ${VIEW_3D_LABELS[v]} view.`,
	scope: 'global',
	agentExposed: true,
	when: (ctx) => !!seqOf(ctx),
	checked: (ctx) => {
		const seq = seqOf(ctx);
		return !!seq && viewsOf(seq.id).view === v;
	},
	run: (ctx) => {
		const seq = seqOf(ctx);
		if (seq) switchView(seq.id, v);
	},
});

const rendererCommand = (renderer: 'classic' | 'advanced', label: string): UiCommand => ({
	id: `threeD.renderer.${renderer}`,
	label,
	description:
		renderer === 'classic'
			? 'Classic 3D: layers as planes, per-pixel depth sorting and intersections, Blinn-Phong lights, ray-cast shadows, depth of field.'
			: 'Advanced 3D: physically based lights and environment reflections, shadow maps, extruded text and shapes.',
	scope: 'global',
	agentExposed: true,
	when: editable,
	checked: (ctx) => (seqOf(ctx)?.threeD?.renderer ?? 'classic') === renderer,
	run: (ctx) => apply(ctx, '3D Renderer', [{ type: 'sequence.set3dRenderer', renderer }]),
});

export const threeDCommands: UiCommand[] = [
	{
		id: 'threeD.newCamera',
		label: 'Camera…',
		description: 'Add a camera at the playhead (Camera Settings: type, preset, zoom, depth of field).',
		scope: 'global',
		agentExposed: true,
		when: editable,
		disabledReason: (ctx) => (editable(ctx) ? undefined : 'Open a sequence first'),
		run: (ctx) => {
			const seq = seqOf(ctx);
			if (seq)
				ctx.ui.openDialog(CAMERA_DIALOG, {
					session: ctx.session,
					sequenceId: seq.id,
					playhead: playhead(ctx),
				});
		},
	},
	{
		id: 'threeD.newLight',
		label: 'Light…',
		description:
			'Add a light at the playhead (Light Settings: type, colour, intensity, cone, falloff, shadows).',
		scope: 'global',
		agentExposed: true,
		when: editable,
		disabledReason: (ctx) => (editable(ctx) ? undefined : 'Open a sequence first'),
		run: (ctx) => {
			const seq = seqOf(ctx);
			if (seq)
				ctx.ui.openDialog(LIGHT_DIALOG, {
					session: ctx.session,
					sequenceId: seq.id,
					playhead: playhead(ctx),
				});
		},
	},
	{
		id: 'threeD.toggleLayer',
		label: '3D Layer',
		description:
			"Turn the selected clips' 3D Layer switch on or off (Z position, orientation, materials, cameras, lights).",
		scope: 'global',
		agentExposed: true,
		when: (ctx) => editable(ctx) && selectedClips(ctx).some(can3d),
		disabledReason: (ctx) =>
			selectedClips(ctx).some(can3d) ? undefined : 'Select video, still, text, shape or nest clips',
		checked: (ctx) => {
			const c = selectedClips(ctx).filter(can3d);
			return c.length > 0 && c.every(is3d);
		},
		run: (ctx) => {
			const c = selectedClips(ctx).filter(can3d);
			if (c.length)
				apply(ctx, '3D Layer', [
					{ type: 'clip.set3d', clipIds: c.map((x) => x.id), enabled: !c.every(is3d) },
				]);
		},
	},
	{
		id: 'threeD.cameraSettings',
		label: 'Camera Settings…',
		scope: 'global',
		agentExposed: true,
		when: (ctx) => editable(ctx) && selectedClips(ctx).some((c) => c.kind === 'camera'),
		disabledReason: (ctx) =>
			selectedClips(ctx).some((c) => c.kind === 'camera') ? undefined : 'Select a camera',
		run: (ctx) => {
			const seq = seqOf(ctx);
			const c = selectedClips(ctx).find((x) => x.kind === 'camera');
			if (seq && c)
				ctx.ui.openDialog(CAMERA_DIALOG, {
					session: ctx.session,
					sequenceId: seq.id,
					clipId: c.id,
					playhead: playhead(ctx),
				});
		},
	},
	{
		id: 'threeD.lightSettings',
		label: 'Light Settings…',
		scope: 'global',
		agentExposed: true,
		when: (ctx) => editable(ctx) && selectedClips(ctx).some((c) => c.kind === 'light'),
		disabledReason: (ctx) =>
			selectedClips(ctx).some((c) => c.kind === 'light') ? undefined : 'Select a light',
		run: (ctx) => {
			const seq = seqOf(ctx);
			const c = selectedClips(ctx).find((x) => x.kind === 'light');
			if (seq && c)
				ctx.ui.openDialog(LIGHT_DIALOG, {
					session: ctx.session,
					sequenceId: seq.id,
					clipId: c.id,
					playhead: playhead(ctx),
				});
		},
	},
	...VIEWS_3D.map(viewCommand),
	{
		id: 'threeD.view.last',
		label: 'Switch to Last 3D View',
		scope: 'global',
		agentExposed: true,
		when: (ctx) => !!seqOf(ctx),
		run: (ctx) => {
			const seq = seqOf(ctx);
			if (seq) switchView(seq.id, viewsOf(seq.id).last);
		},
	},
	{
		id: 'threeD.view.reset',
		label: 'Reset 3D View',
		scope: 'global',
		agentExposed: true,
		when: (ctx) => !!seqOf(ctx) && viewsOf(seqOf(ctx)!.id).view !== 'activeCamera',
		run: (ctx) => {
			const seq = seqOf(ctx);
			if (seq) resetView(seq.id);
		},
	},
	{
		id: 'threeD.cameraFromView',
		label: 'Create Camera from 3D View',
		description:
			"Add a camera at the playhead that sees what the current 3D view shows (the view's eye, point of interest and zoom).",
		scope: 'global',
		agentExposed: true,
		when: (ctx) => editable(ctx) && viewsOf(seqOf(ctx)!.id).view !== 'activeCamera',
		run: (ctx) => {
			const seq = seqOf(ctx)!;
			const v = viewCamOf(seq.id, viewsOf(seq.id).view, seq.settings.width, seq.settings.height);
			if (!v || v.ortho) {
				ctx.ui.toast({
					kind: 'info',
					message: 'Orthographic views (Front, Top…) cannot become a perspective camera',
				});
				return;
			}
			apply(ctx, 'Create Camera from 3D View', [
				{ type: 'clip.addCamera', at: playhead(ctx), position: v.eye, pointOfInterest: v.poi, zoom: v.zoom },
			]);
			switchView(seq.id, 'activeCamera');
		},
	},
	rendererCommand('classic', 'Classic 3D'),
	rendererCommand('advanced', 'Advanced 3D'),
	{
		id: 'threeD.draft',
		label: 'Draft 3D',
		description:
			'Previews 3D layers without lights, shadows and depth of field (exports always render in full).',
		scope: 'global',
		agentExposed: true,
		when: editable,
		checked: (ctx) => !!seqOf(ctx)?.threeD?.draft,
		run: (ctx) =>
			apply(ctx, 'Draft 3D', [{ type: 'sequence.set3dRenderer', draft: !seqOf(ctx)?.threeD?.draft }]),
	},
];
