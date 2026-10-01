// Program monitor right-click menu (S03:XF-050, wp-clipboard + wp-clipboard-2): on the layer under the pointer
// (selected first) Cut, Copy, Paste, Paste Attributes…, Duplicate, Delete, Enable, Reset Motion, Reset Crop, Fit
// to Frame, Fill Frame, Set to Native (100%), Anchor ▸ (XF-038), Arrange ▸, Reveal in Timeline, Reveal in Project;
// Paste alone on empty frame. Entries run the same UI commands as the menubar (Edit, Clip ▸ Transform, Graphics ▸
// Arrange) and the timeline clip menu, so their enabled state and disabled reasons are shared. XF-050's Agent ▸
// (AGT-040) is superseded by ARCHITECTURE D-18 (no in-app agent; agents connect over MCP).
import type { Clip } from '@jasper/project';
import { getCommand, isCommandEnabled } from '../../commands/registry.ts';
import type { CommandCtx } from '../../commands/types.ts';
import type { ContextMenuItem } from '../timeline/state/ui-store.ts';
import { ANCHOR_POINTS, ARRANGE_COMMANDS, ARRANGE_LABELS } from './layer-ops.ts';

const ARRANGE_SHORTCUTS: Record<string, string> = {
	'arrange.bringToFront': 'Ctrl+Shift+]',
	'arrange.bringForward': 'Ctrl+]',
	'arrange.sendBackward': 'Ctrl+[',
	'arrange.sendToBack': 'Ctrl+Shift+[',
};

export function programLayerMenu(
	ctx: CommandCtx,
	clip: Clip | null,
	run: (commandId: string, args?: unknown) => void,
): ContextMenuItem[] {
	const item = (
		commandId: string,
		label: string,
		opts: { shortcut?: string; checked?: boolean; args?: unknown } = {},
	): ContextMenuItem => {
		const cmd = getCommand(commandId);
		return {
			kind: 'item',
			label,
			...(opts.shortcut ? { shortcut: opts.shortcut } : {}),
			...(opts.checked !== undefined ? { checked: opts.checked } : {}),
			disabled: !cmd || !isCommandEnabled(cmd, ctx),
			run: () => (opts.args === undefined ? run(commandId) : run(commandId, opts.args)),
		};
	};
	if (!clip) return [item('edit.paste', 'Paste', { shortcut: 'Ctrl+V' })];
	return [
		item('edit.cut', 'Cut', { shortcut: 'Ctrl+X' }),
		item('edit.copy', 'Copy', { shortcut: 'Ctrl+C' }),
		item('edit.paste', 'Paste', { shortcut: 'Ctrl+V' }),
		item('edit.pasteAttributes', 'Paste Attributes…', { shortcut: 'Ctrl+Alt+V' }),
		{ kind: 'separator' },
		item('timeline.duplicate', 'Duplicate'),
		item('timeline.clear', 'Delete', { shortcut: 'Delete' }),
		item('timeline.toggleEnable', 'Enable', { checked: clip.enabled }),
		{ kind: 'separator' },
		item('motion.reset', 'Reset Motion'),
		item('motion.resetCrop', 'Reset Crop'),
		item('motion.fit', 'Fit to Frame'),
		item('motion.fill', 'Fill Frame'),
		item('motion.native', 'Set to Native (100%)'),
		{
			kind: 'submenu',
			label: 'Anchor',
			items: ANCHOR_POINTS.map((p) =>
				item('motion.anchor', p.id === 'center' ? 'Anchor to Center' : p.label, { args: { point: p.id } }),
			),
		},
		{
			kind: 'submenu',
			label: 'Arrange',
			items: ARRANGE_COMMANDS.map(([id, op]) =>
				item(id, ARRANGE_LABELS[op], { shortcut: ARRANGE_SHORTCUTS[id] }),
			),
		},
		{ kind: 'separator' },
		item('clip.revealInTimeline', 'Reveal in Timeline'),
		item('clip.revealInProject', 'Reveal in Project'),
	];
}
