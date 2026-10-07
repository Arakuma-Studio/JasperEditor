// M2 colour UI commands and extensions (S06 §6, ARCHITECTURE §19.10). Owner: wp-m2-color.
// Imported at start-up (commands/index.ts), so this module also registers the package's UI extensions:
// the Lumetri Effect Controls editor (curves + wheels, `hideParams`), Copy/Paste Grade in the timeline clip
// menu, and "Apply as Look" on LUT items in the Project panel.
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
import { LumetriEffectEditor } from '../color/LumetriEffectEditor.tsx';
import { colorEffectsOf, gradeEligible } from '../color/model.ts';
import { clipMenuExtensions, effectEditors, projectItemMenuExtensions } from '../extensions/index.ts';
import type { CommandCtx, UiCommand } from './types.ts';

// ---------------------------------------------------------------- helpers

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

// ---------------------------------------------------------------- extensions (registered at module load)

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

// ---------------------------------------------------------------- commands

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
