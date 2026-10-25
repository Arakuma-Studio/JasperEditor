// spec 13 AS-032: Edit ▸ Select ▸ Same Style (and the helpers other features register, `select.byHelper`), and the
// linked text style actions on the selected text clips (New Style from Selection…, Apply, Detach, Reset to Style).
import { z } from 'zod';
import { selectionHelpers } from '../selection/helpers.ts';
import {
	applyStyle,
	currentSelection,
	detachSelection,
	newStyleFromSelection,
	resetSelection,
	runSelectionHelper,
} from '../text-styles/actions.ts';
import { isTextClip, selectionLink } from '../text-styles/model.ts';
import type { CommandCtx, UiCommand } from './types.ts';

const canEdit = (ctx: CommandCtx) => !!ctx.session && !ctx.session.getState().readOnly;
const textSelected = (ctx: CommandCtx) =>
	!!ctx.session && (currentSelection(ctx.session)?.clips.some(isTextClip) ?? false);
const linkedSelected = (ctx: CommandCtx) => {
	const sel = ctx.session ? currentSelection(ctx.session) : null;
	return !!sel && selectionLink(sel.doc, sel.clips).linked.length > 0;
};

function select(ctx: CommandCtx, helper: string): void {
	if (!ctx.session) return;
	const n = runSelectionHelper(ctx.session, helper);
	if (n === 0) ctx.ui.toast({ kind: 'info', message: 'No clips match.' });
}

export const textStyleCommands: UiCommand[] = [
	{
		id: 'select.sameStyle',
		label: 'Select Same Style',
		description:
			'Selects the clips linked to the primary text clip’s text style (or, when it is not linked, with exactly its style).',
		scope: 'editing',
		agentExposed: true,
		when: (ctx) => !!ctx.session && currentSelection(ctx.session)?.primary?.kind === 'text',
		disabledReason: (ctx) => (textSelected(ctx) ? undefined : 'Select a text clip first.'),
		run: (ctx) => select(ctx, 'same-style'),
	},
	{
		id: 'select.byHelper',
		label: 'Select',
		description: 'Runs a Select ▸ helper (Same Style, and helpers other features add) on the current selection.',
		scope: 'editing',
		hidden: true,
		argsSchema: z.object({ helper: z.string().min(1) }),
		when: (ctx) => !!ctx.session,
		labelFor: () => 'Select',
		run: (ctx, args) => {
			const { helper } = z.object({ helper: z.string().min(1) }).parse(args);
			if (!selectionHelpers.get(helper)) {
				ctx.ui.toast({ kind: 'warning', message: `Unknown selection helper: ${helper}` });
				return;
			}
			select(ctx, helper);
		},
	},
	{
		id: 'textStyles.newFromSelection',
		label: 'New Text Style from Selection…',
		description: 'Saves the primary text clip’s style as a project text style and links the selected text clips to it.',
		scope: 'editing',
		when: (ctx) => canEdit(ctx) && textSelected(ctx),
		disabledReason: (ctx) => (textSelected(ctx) ? undefined : 'Select a text clip first.'),
		run: (ctx) => newStyleFromSelection(ctx.session!),
	},
	{
		id: 'textStyles.apply',
		label: 'Apply Text Style',
		description: 'Links the selected text clips to a project text style (their style becomes the style).',
		scope: 'editing',
		agentExposed: true,
		hidden: true,
		argsSchema: z.object({ styleId: z.string().min(1) }),
		when: (ctx) => canEdit(ctx) && textSelected(ctx),
		run: (ctx, args) => applyStyle(ctx.session!, z.object({ styleId: z.string().min(1) }).parse(args).styleId),
	},
	{
		id: 'textStyles.detach',
		label: 'Detach from Text Style',
		description: 'Unlinks the selected clips from their text style; they keep their look.',
		scope: 'editing',
		agentExposed: true,
		when: (ctx) => canEdit(ctx) && linkedSelected(ctx),
		disabledReason: (ctx) => (linkedSelected(ctx) ? undefined : 'No selected clip is linked to a text style.'),
		run: (ctx) => detachSelection(ctx.session!),
	},
	{
		id: 'textStyles.reset',
		label: 'Reset to Text Style',
		description: 'Drops the selected clips’ deviations from their linked text style.',
		scope: 'editing',
		agentExposed: true,
		when: (ctx) => canEdit(ctx) && linkedSelected(ctx),
		disabledReason: (ctx) => (linkedSelected(ctx) ? undefined : 'No selected clip is linked to a text style.'),
		run: (ctx) => resetSelection(ctx.session!),
	},
];
