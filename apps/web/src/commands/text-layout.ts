// Graphics ▸ Vertical Text and Warp Text (spec 19 TL-110, TL-111): the menu and palette side of the Properties rows.
import type { Clip, Command } from '@jasper/project';
import {
	textClipsOf,
	verticalDisabledReason,
	warpEffectOf,
	warpStyleCommands,
	writingModeCommands,
} from '../text-edit/writing.ts';
import type { CommandCtx, UiCommand } from './types.ts';

const selectedText = (ctx: CommandCtx): Clip[] => {
	const s = ctx.session?.getState();
	if (!s?.activeSequenceId || s.readOnly) return [];
	const clips = (s.transient ?? s.document).sequences[s.activeSequenceId]?.clips ?? {};
	return textClipsOf(s.selection.timeline.clips.flatMap((id) => (clips[id] ? [clips[id]] : [])));
};

const isVertical = (c: Clip) =>
	c.kind === 'text' && (c.content as { writingMode?: string }).writingMode === 'vertical';

function apply(ctx: CommandCtx, label: string, commands: Command[]): void {
	const r = ctx.session?.apply({ label, origin: 'user', commands });
	if (r && !r.ok) ctx.ui.toast({ kind: 'error', message: r.errors[0]?.message ?? label });
}

export const textLayoutCommands: UiCommand[] = [
	{
		id: 'graphics.verticalText',
		label: 'Vertical Text',
		description: 'Set the selected text in right-to-left columns, or back to horizontal lines.',
		scope: 'global',
		agentExposed: true,
		when: (ctx) => {
			const c = selectedText(ctx);
			return c.length > 0 && (c.every(isVertical) || !verticalDisabledReason(c));
		},
		disabledReason: (ctx) => {
			const c = selectedText(ctx);
			return c.length ? (verticalDisabledReason(c) ?? undefined) : 'Select a text clip';
		},
		checked: (ctx) => {
			const c = selectedText(ctx);
			return c.length > 0 && c.every(isVertical);
		},
		run: (ctx) => {
			const c = selectedText(ctx);
			const vertical = !c.every(isVertical);
			if (c.length)
				apply(ctx, vertical ? 'Vertical Text' : 'Horizontal Text', writingModeCommands(c, vertical));
		},
	},
	{
		id: 'graphics.warpText',
		label: 'Warp Text',
		description:
			'Bend the selected text with a Photoshop-style warp after its look, or remove the warp. Style, bend and distortion are in Properties and Effect Controls.',
		scope: 'global',
		agentExposed: true,
		when: (ctx) => selectedText(ctx).length > 0,
		disabledReason: (ctx) => (selectedText(ctx).length ? undefined : 'Select a text clip'),
		checked: (ctx) => {
			const c = selectedText(ctx);
			return c.length > 0 && c.every((x) => !!warpEffectOf(x));
		},
		run: (ctx) => {
			const c = selectedText(ctx);
			const off = c.every((x) => !!warpEffectOf(x));
			if (c.length) apply(ctx, off ? 'Remove Warp' : 'Warp Text', warpStyleCommands(c, off ? null : 'arc'));
		},
	},
];
