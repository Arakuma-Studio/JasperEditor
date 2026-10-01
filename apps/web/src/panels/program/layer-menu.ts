// Program monitor right-click menu (S03:XF-050, wp-clipboard): Cut, Copy, Paste, Paste Attributes…, Duplicate,
// Clear, Enable, Scale/Set to Frame Size on the layer under the pointer (selected first); Paste alone on empty
// frame. Entries run the same UI commands as the Edit menu and the timeline clip menu, so their enabled state and
// disabled reasons are shared. Anchor/Arrange/Reveal entries of XF-050 are not implemented yet.
import type { Clip } from '@jasper/project';
import { getCommand, isCommandEnabled } from '../../commands/registry.ts';
import type { CommandCtx } from '../../commands/types.ts';
import type { ContextMenuItem } from '../timeline/state/ui-store.ts';

export function programLayerMenu(
	ctx: CommandCtx,
	clip: Clip | null,
	run: (commandId: string) => void,
): ContextMenuItem[] {
	const item = (commandId: string, label: string, shortcut?: string, checked?: boolean): ContextMenuItem => {
		const cmd = getCommand(commandId);
		return {
			kind: 'item',
			label,
			...(shortcut ? { shortcut } : {}),
			...(checked !== undefined ? { checked } : {}),
			disabled: !cmd || !isCommandEnabled(cmd, ctx),
			run: () => run(commandId),
		};
	};
	if (!clip) return [item('edit.paste', 'Paste', 'Ctrl+V')];
	const session = ctx.session;
	const readOnly = !session || session.getState().readOnly;
	const fit = (mode: 'fit' | 'fill', label: string): ContextMenuItem => ({
		kind: 'item',
		label,
		disabled: readOnly,
		run: () => {
			const ids = session!.getState().selection.timeline.clips;
			const r = session!.apply({
				label,
				origin: 'user',
				commands: [{ type: 'clip.fitToFrame', clipIds: ids.length ? ids : [clip.id], mode }],
			});
			if (!r.ok)
				ctx.ui.toast({ kind: 'warning', message: `${label}: not possible`, detail: r.errors[0]?.message });
		},
	});
	return [
		item('edit.cut', 'Cut', 'Ctrl+X'),
		item('edit.copy', 'Copy', 'Ctrl+C'),
		item('edit.paste', 'Paste', 'Ctrl+V'),
		item('edit.pasteAttributes', 'Paste Attributes…', 'Ctrl+Alt+V'),
		{ kind: 'separator' },
		item('timeline.duplicate', 'Duplicate'),
		item('timeline.clear', 'Delete', 'Delete'),
		item('timeline.toggleEnable', 'Enable', undefined, clip.enabled),
		{ kind: 'separator' },
		fit('fit', 'Scale to Frame Size'),
		fit('fill', 'Set to Frame Size'),
	];
}
