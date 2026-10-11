import { registerDialog } from '@jasper/ui';
import {
	AttributesDialog,
	PASTE_ATTRIBUTES_DIALOG,
	REMOVE_ATTRIBUTES_DIALOG,
} from '../clipboard/AttributesDialog.tsx';
import {
	attributesBlocked,
	type ClipboardArgs,
	type ClipboardTarget,
	clipboardTarget,
	copyBlocked,
	copySelection,
	cutSelection,
	editBlocked,
	pasteAttributes,
	pasteBlocked,
	pasteInto,
	removeAttributes,
} from '../clipboard/actions.ts';
import type { CommandCtx, CommandScope, UiCommand } from './types.ts';

registerDialog(PASTE_ATTRIBUTES_DIALOG, AttributesDialog);
registerDialog(REMOVE_ATTRIBUTES_DIALOG, AttributesDialog);

type Resolve = (ctx: CommandCtx) => ClipboardTarget | null;
const focused: Resolve = clipboardTarget;
const timeline: Resolve = () => 'timeline';

function family(prefix: 'edit' | 'timeline', scope: CommandScope, target: Resolve): UiCommand[] {
	const cutReason = (ctx: CommandCtx) => editBlocked(ctx) ?? copyBlocked(ctx, target(ctx));
	return [
		{
			id: `${prefix}.cut`,
			label: 'Cut',
			description: 'Copy the selection to the clipboard and remove it (clips leave a gap)',
			scope,
			when: (ctx) => !cutReason(ctx),
			disabledReason: cutReason,
			run: (ctx, args) => cutSelection(ctx, target(ctx)!, (args ?? {}) as ClipboardArgs),
		},
		{
			id: `${prefix}.copy`,
			label: 'Copy',
			description: 'Copy the selected clips, effects, keyframes or project items',
			scope,
			when: (ctx) => !copyBlocked(ctx, target(ctx)),
			disabledReason: (ctx) => copyBlocked(ctx, target(ctx)),
			run: (ctx, args) => void copySelection(ctx, target(ctx)!, (args ?? {}) as ClipboardArgs),
		},
		{
			id: `${prefix}.paste`,
			label: 'Paste',
			description: 'Paste at the playhead on the targeted tracks (overwrite)',
			scope,
			nativeClipboard: 'paste',
			when: (ctx) => !pasteBlocked(ctx, target(ctx)),
			disabledReason: (ctx) => pasteBlocked(ctx, target(ctx)),
			run: (ctx, args) => pasteInto(ctx, target(ctx)!, 'overwrite', (args ?? {}) as ClipboardArgs),
		},
		{
			id: `${prefix}.pasteInsert`,
			label: 'Paste Insert',
			description: 'Paste at the playhead and ripple later clips (insert)',
			scope,
			nativeClipboard: 'paste',
			when: (ctx) => target(ctx) === 'timeline' && !pasteBlocked(ctx, 'timeline'),
			disabledReason: (ctx) =>
				pasteBlocked(ctx, target(ctx)) ??
				(target(ctx) === 'timeline' ? undefined : 'Paste Insert pastes clips into the Timeline'),
			run: (ctx, args) => pasteInto(ctx, 'timeline', 'insert', (args ?? {}) as ClipboardArgs),
		},
		{
			id: `${prefix}.pasteAttributes`,
			label: 'Paste Attributes…',
			description: 'Paste chosen attributes of the copied clip onto the selected clips',
			scope,
			when: (ctx) => !attributesBlocked(ctx),
			disabledReason: attributesBlocked,
			run: (ctx, args) => pasteAttributes(ctx, (args ?? {}) as ClipboardArgs),
		},
		{
			id: `${prefix}.removeAttributes`,
			label: 'Remove Attributes…',
			description: 'Reset Motion, Opacity, Volume or Panner, or remove effects, on the selected clips',
			scope,
			when: (ctx) => !attributesBlocked(ctx),
			disabledReason: attributesBlocked,
			run: (ctx) => removeAttributes(ctx),
		},
	];
}

export const clipboardCommands: UiCommand[] = [
	...family('edit', 'global', focused),
	...family('timeline', 'timeline', timeline),
];
