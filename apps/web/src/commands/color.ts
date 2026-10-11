import { type Clip, LUMETRI_EDITOR_PARAMS, LUMETRI_EFFECT_ID } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { z } from 'zod';
import {
	applyLookToClips,
	colorBypass,
	copyGradeFrom,
	gradeClipboard,
	pasteGradeTo,
} from '../color/actions.ts';
import { faceDetectionPref, runApplyMatch, runAutoTone } from '../color/grade/actions.ts';
import { EyedropperOverlay } from '../color/grade/EyedropperOverlay.tsx';
import { LumetriEffectEditor } from '../color/LumetriEffectEditor.tsx';
import { colorEffectsOf, firstLumetri, gradeEligible } from '../color/model.ts';
import {
	clipMenuExtensions,
	effectEditors,
	programOverlays,
	projectItemMenuExtensions,
} from '../extensions/index.ts';
import { monitorExtras } from '../panels/program/monitor-view.ts';
import type { CommandCtx, UiCommand } from './types.ts';

function primaryClip(session: EditorSession): Clip | null {
	const s = session.getState();
	const seq = s.activeSequenceId ? s.document.sequences[s.activeSequenceId] : undefined;
	if (!seq) return null;
	const selected = s.selection.timeline.clips.map((id) => seq.clips[id]).filter((c): c is Clip => !!c);
	return (
		(s.selection.timeline.primaryClip ? seq.clips[s.selection.timeline.primaryClip] : undefined) ??
		selected[selected.length - 1] ??
		null
	);
}

const writable = (ctx: CommandCtx) => !!ctx.session && !ctx.session.getState().readOnly;
const hasColor = (session: EditorSession, clip: Clip | null) =>
	!!clip && colorEffectsOf(clip, session.ctx.registries.effects).length > 0;

function pasteTargets(session: EditorSession, clipIds: readonly string[]): string[] {
	const s = session.getState();
	const seq = s.activeSequenceId ? s.document.sequences[s.activeSequenceId] : undefined;
	return clipIds.filter((id) => gradeEligible(seq?.clips[id]));
}

effectEditors.register({
	id: 'color.lumetri',
	effectId: LUMETRI_EFFECT_ID,
	component: LumetriEffectEditor,
	hideParams: LUMETRI_EDITOR_PARAMS,
});

clipMenuExtensions.register({
	id: 'color.grade',
	items({ session, clip, selection }) {
		if (!gradeEligible(clip)) return [];
		const targets = pasteTargets(session, selection.includes(clip.id) ? selection : [clip.id]);
		const readOnly = session.getState().readOnly;
		return [
			{
				kind: 'item',
				label: 'Copy Grade',
				disabled: !hasColor(session, clip),
				run: () => void copyGradeFrom(session, clip),
			},
			{
				kind: 'item',
				label: targets.length > 1 ? `Paste Grade (${targets.length} clips)` : 'Paste Grade',
				disabled: readOnly || !gradeClipboard.get() || targets.length === 0,
				run: () => void pasteGradeTo(session, targets),
			},
		];
	},
});

projectItemMenuExtensions.register({
	id: 'color.lut',
	items({ session, items, readOnly }) {
		const doc = session.getCommitted();
		const lut = items.find((i) => i.kind === 'media' && doc.media[i.mediaId]?.kind === 'lut');
		if (lut?.kind !== 'media') return [];
		const targets = pasteTargets(session, session.getState().selection.timeline.clips);
		return [
			{
				kind: 'item',
				label:
					targets.length > 1
						? `Apply as Look to ${targets.length} Selected Clips`
						: 'Apply as Look to Selected Clip',
				disabled: readOnly || targets.length === 0,
				run: () => void applyLookToClips(session, lut.mediaId, targets),
			},
		];
	},
});

programOverlays.register({
	id: 'color.eyedropper',
	active: (session) => !!session.getState().activeSequenceId,
	component: EyedropperOverlay,
	order: 90,
});

export const colorCommands: UiCommand[] = [
	{
		id: 'color.copyGrade',
		label: 'Copy Grade',
		description: 'Copies every colour effect (Lumetri Color, Brightness & Contrast…) of the selected clip.',
		scope: 'global',
		when: (ctx) => !!ctx.session && hasColor(ctx.session, primaryClip(ctx.session)),
		disabledReason: () => 'Select a clip with colour effects',
		run(ctx) {
			const session = ctx.session;
			const clip = session ? primaryClip(session) : null;
			if (session && clip && copyGradeFrom(session, clip))
				ctx.ui.toast({ kind: 'info', message: `Grade copied from ${clip.name || 'clip'}`, durationMs: 1500 });
		},
	},
	{
		id: 'color.pasteGrade',
		label: 'Paste Grade',
		description: 'Replaces the colour effects of the selected clips with the copied grade (one undo step).',
		scope: 'global',
		when: (ctx) =>
			writable(ctx) &&
			!!gradeClipboard.get() &&
			pasteTargets(ctx.session!, ctx.session!.getState().selection.timeline.clips).length > 0,
		disabledReason: () => (gradeClipboard.get() ? 'Select the clips to grade' : 'Copy a grade first'),
		run(ctx) {
			const session = ctx.session;
			if (!session) return;
			const r = pasteGradeTo(session, pasteTargets(session, session.getState().selection.timeline.clips));
			if (r && !r.ok) ctx.ui.toast({ kind: 'error', message: r.errors[0]?.message ?? 'Paste Grade failed' });
		},
	},
	{
		id: 'color.applyLook',
		label: 'Apply LUT as Look to Selected Clips',
		description: 'Sets the Look of the first Lumetri Color of each selected clip (adds one when missing).',
		scope: 'global',
		hidden: true,
		argsSchema: z.object({ mediaId: z.string() }),
		when: writable,
		run(ctx, args) {
			const session = ctx.session;
			const mediaId = (args as { mediaId?: string } | undefined)?.mediaId;
			if (!session || !mediaId) return;
			applyLookToClips(session, mediaId, pasteTargets(session, session.getState().selection.timeline.clips));
		},
	},
	{
		id: 'color.autoTone',
		label: 'Lumetri Auto Tone',
		description:
			"Sets the selected clip's Lumetri tone sliders (Exposure, Contrast, Highlights, Shadows, Whites, Blacks) from its picture.",
		scope: 'global',
		capability: 'engine',
		when: (ctx) => writable(ctx) && gradeEligible(primaryClip(ctx.session!)),
		disabledReason: () => 'Select a video, still or graphic clip',
		async run(ctx) {
			const session = ctx.session;
			const clip = session ? primaryClip(session) : null;
			if (!session || !clip) return;
			try {
				const err = await runAutoTone(session, ctx.engine, clip, firstLumetri(clip));
				if (err) ctx.ui.toast({ kind: 'error', message: err });
			} catch (e) {
				ctx.ui.toast({ kind: 'error', message: `Auto Tone failed: ${(e as Error).message}` });
			}
		},
	},
	{
		id: 'color.applyMatch',
		label: 'Lumetri Apply Match',
		description:
			'Grades the selected clip to match the Comparison View reference frame (colour wheels, levels and saturation of its Lumetri Color).',
		scope: 'global',
		capability: 'engine',
		when: (ctx) =>
			writable(ctx) &&
			gradeEligible(primaryClip(ctx.session!)) &&
			!!monitorExtras.getState().comparison.enabled &&
			!!monitorExtras.getState().comparison.reference,
		disabledReason: () => 'Open the Comparison View, choose a reference frame and select the clip to match',
		async run(ctx) {
			const session = ctx.session;
			const clip = session ? primaryClip(session) : null;
			const ref = monitorExtras.getState().comparison.reference;
			if (!session || !clip || !ref) return;
			try {
				const r = await runApplyMatch(
					session,
					ctx.engine,
					clip,
					firstLumetri(clip),
					{ sequenceId: ref.sequenceId, frame: ref.frame },
					faceDetectionPref(),
				);
				if (r.error) ctx.ui.toast({ kind: 'error', message: r.error });
				else if (r.note) ctx.ui.toast({ kind: 'info', message: r.note });
			} catch (e) {
				ctx.ui.toast({ kind: 'error', message: `Apply Match failed: ${(e as Error).message}` });
			}
		},
	},
	{
		id: 'color.toggleBeforeAfter',
		label: 'Toggle Grade Before/After',
		description: 'Shows the selected clip without its colour effects in the Program monitor (preview only).',
		scope: 'global',
		when: (ctx) => !!ctx.session && gradeEligible(primaryClip(ctx.session)),
		checked: (ctx) => {
			const clip = ctx.session ? primaryClip(ctx.session) : null;
			return !!clip && colorBypass.isBypassed(clip.id);
		},
		run(ctx) {
			const clip = ctx.session ? primaryClip(ctx.session) : null;
			if (clip) colorBypass.toggle(clip.id);
		},
	},
];
