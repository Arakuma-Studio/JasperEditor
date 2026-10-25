// spec 13 AS-032: Edit ▸ Select ▸ … helpers. A helper maps the current selection to the clips to select (Same Style
// here; Subtitle Group / Same Template are registered by the subtitles feature). Registered helpers appear in the
// Select submenu (menu provider `selectionHelpers`) and run through the `select.byHelper` UI command.
import type { Clip, ProjectDocument, Sequence } from '@jasper/project';
import { createRegistry } from '../extensions/registry.ts';
import { sameStyleClipIds } from '../text-styles/model.ts';

export type SelectionHelperInput = {
	doc: ProjectDocument;
	seq: Sequence;
	/** Selected clips of the active sequence, in selection order. */
	selected: Clip[];
	primary: Clip | null;
};

export type SelectionHelper = {
	id: string;
	/** Menu label (called when the menu opens, so it is translated in the current language). */
	label(): string;
	/** Why the helper cannot run for this selection (shown as the disabled reason), or null. */
	unavailable?(input: SelectionHelperInput): string | null;
	/** Clip ids to select (replacing the selection). */
	select(input: SelectionHelperInput): string[];
	order?: number;
};

export const selectionHelpers = createRegistry<SelectionHelper>();

/** Same Style: the clips linked to the primary text clip's project text style, or with its exact style. */
export const SAME_STYLE_HELPER: SelectionHelper = {
	id: 'same-style',
	label: () => 'Same Style',
	unavailable: ({ primary }) => (primary?.kind === 'text' ? null : 'Select a text clip first.'),
	select: ({ doc, seq, primary }) => sameStyleClipIds(doc, seq, primary),
	order: 10,
};

selectionHelpers.register(SAME_STYLE_HELPER);
