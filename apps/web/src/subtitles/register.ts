// spec 13: registers the subtitle dialogs, the timeline clip menu entries for text clips (Save as Template…, Apply
// Template…, Select Subtitle Group) and the Edit ▸ Select ▸ Subtitle Group / Same Template helpers. Called at module
// load of `commands/subtitles.ts` (in COMMAND_MODULES).
import {
	type Clip,
	captionGroupOf,
	captionGroupsOf,
	captionOf,
	groupClips,
	type Sequence,
} from '@jasper/project';
import { registerDialog } from '@jasper/ui';
import { clipMenuExtensions, type MenuItemSpec } from '../extensions/index.ts';
import { type SelectionHelper, selectionHelpers } from '../selection/helpers.ts';
import { CreateSubtitlesDialog } from './CreateSubtitlesDialog.tsx';
import {
	APPLY_TEMPLATE_DIALOG,
	CREATE_SUBTITLES_DIALOG,
	openApplyTemplate,
	openSaveTemplate,
	SAVE_TEMPLATE_DIALOG,
} from './open.ts';
import { ApplyTemplateDialog, SaveTemplateDialog } from './TemplateDialogs.tsx';

/** The clips of the primary subtitle's group. */
export function subtitleGroupClipIds(seq: Sequence, primary: Clip | null): string[] {
	const g = captionOf(primary)?.groupId;
	return g ? groupClips(seq, g).map((c) => c.id) : [];
}

/** The subtitles whose group uses the same template as the primary subtitle's group (every group of the sequence). */
export function sameTemplateClipIds(seq: Sequence, primary: Clip | null): string[] {
	const g = captionOf(primary)?.groupId;
	const tpl = g ? captionGroupOf(seq, g)?.templateId : null;
	if (!tpl) return [];
	const groups = new Set(
		Object.values(captionGroupsOf(seq))
			.filter((x) => x.templateId === tpl)
			.map((x) => x.id),
	);
	return Object.values(seq.clips)
		.filter((c) => {
			const cg = captionOf(c)?.groupId;
			return !!cg && groups.has(cg);
		})
		.sort((a, b) => a.start - b.start)
		.map((c) => c.id);
}

export const SUBTITLE_GROUP_HELPER: SelectionHelper = {
	id: 'subtitle-group',
	label: () => 'Subtitle Group',
	unavailable: ({ primary }) => (captionOf(primary) ? null : 'Select a subtitle first.'),
	select: ({ seq, primary }) => subtitleGroupClipIds(seq, primary),
	order: 20,
};

export const SAME_TEMPLATE_HELPER: SelectionHelper = {
	id: 'same-template',
	label: () => 'Same Template',
	unavailable: ({ seq, primary }) => {
		const g = captionOf(primary)?.groupId;
		if (!g) return 'Select a subtitle first.';
		return captionGroupOf(seq, g)?.templateId ? null : 'The subtitle group has no template.';
	},
	select: ({ seq, primary }) => sameTemplateClipIds(seq, primary),
	order: 30,
};

let registered = false;
export function registerSubtitlesUi(): void {
	if (registered) return;
	registered = true;
	registerDialog(CREATE_SUBTITLES_DIALOG, CreateSubtitlesDialog);
	registerDialog(SAVE_TEMPLATE_DIALOG, SaveTemplateDialog);
	registerDialog(APPLY_TEMPLATE_DIALOG, ApplyTemplateDialog);
	selectionHelpers.register(SUBTITLE_GROUP_HELPER);
	selectionHelpers.register(SAME_TEMPLATE_HELPER);
	clipMenuExtensions.register({
		id: 'subtitles',
		order: 60,
		items: ({ session, clip, selection }) => {
			if (clip.kind !== 'text') return [];
			const readOnly = session.getState().readOnly;
			const cap = captionOf(clip);
			const doc = session.getCommitted();
			const seq = Object.values(doc.sequences).find((s) => s.clips[clip.id]);
			const items: MenuItemSpec[] = [
				{
					kind: 'item',
					label: 'Save as Template…',
					disabled: readOnly,
					run: () => openSaveTemplate(session, clip.id),
				},
			];
			if (cap && seq) {
				const g = captionGroupOf(seq, cap.groupId);
				items.push({
					kind: 'item',
					label: 'Select Subtitle Group',
					run: () =>
						session.select('timeline', subtitleGroupClipIds(seq, clip), 'replace', { linked: false }),
				});
				if (g?.templateId)
					items.push({
						kind: 'item',
						label: 'Re-apply Subtitle Template…',
						disabled: readOnly,
						run: () =>
							openApplyTemplate(session, {
								clipIds: selection.includes(clip.id) ? [...selection] : [clip.id],
								templateId: g.templateId!,
							}),
					});
			}
			return items;
		},
	});
}
