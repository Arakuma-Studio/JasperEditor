// M2 UI commands for text animators (S11:TXA-024). Owner: wp-m2-text-anim (ARCHITECTURE §20.6).
//   text.applyAnimation   {clipIds?, side, preset?, version?, durationFrames?, params?} — agent-exposed; without
//                         a preset (Graphics ▸ Text Animation ▸ Apply In… / Apply Out…) it opens the picker
//   text.removeAnimation  {clipIds?, side}
// Default targets: the selected text clips. No default key bindings. This module is imported at start-up
// (commands/index.ts), so it also registers the package's UI extensions: the Properties ▸ Text Animation
// section, the clip context submenu and the picker dialog.
import { latestTextAnimationSpec, type TextAnimationSide } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { openDialog, registerDialog } from '@jasper/ui';
import { createElement } from 'react';
import { z } from 'zod';
import { clipMenuExtensions, clipSections, type MenuItemSpec } from '../extensions/index.ts';
import {
	type AnimationSide,
	activeSequence,
	applyMessage,
	applyTextAnimation,
	removeTextAnimation,
	selectedTextClips,
	textClipIds,
} from '../text-animation/actions.ts';
import { TEXT_ANIMATION_PICKER_DIALOG, TextAnimationPickerDialog } from '../text-animation/PickerDialog.tsx';
import { LATEST_TEXT_ANIMATIONS } from '../text-animation/PresetPreview.tsx';
import { TextAnimationSection } from '../text-animation/TextAnimationSection.tsx';
import type { CommandCtx, UiCommand } from './types.ts';

const Side = z.enum(['in', 'out', 'both']);
const ApplyArgs = z.object({
	clipIds: z.array(z.string().min(1)).optional().describe('Text clips (default: the selected text clips)'),
	side: Side.default('in'),
	preset: z.string().min(1).optional().describe('Preset id; omitted = pick it in a dialog'),
	version: z.number().int().optional(),
	durationFrames: z.number().int().min(1).optional(),
	params: z.record(z.string(), z.unknown()).optional(),
});
const RemoveArgs = z.object({
	clipIds: z.array(z.string().min(1)).optional(),
	side: Side.default('both'),
});

const targets = (ctx: CommandCtx, ids?: readonly string[]) =>
	ctx.session ? (ids ? textClipIds(ctx.session, ids) : selectedTextClips(ctx.session)) : [];
const hasTextSelection = (ctx: CommandCtx) =>
	!!ctx.session && !ctx.session.getState().readOnly && selectedTextClips(ctx.session).length > 0;

function report(ctx: CommandCtx, r: Parameters<typeof applyMessage>[0]): void {
	const m = applyMessage(r);
	if (m) ctx.ui.toast({ kind: m.kind, message: m.text });
}

/** Opens the picker for one side and applies the choice (None removes the side). */
async function pickAndApply(session: EditorSession, ids: string[], side: TextAnimationSide): Promise<void> {
	const seq = activeSequence(session);
	const presets = new Set(
		ids
			.map((id) => seq?.clips[id])
			.map((c) => (c?.kind === 'text' ? (c.textAnimation?.[side]?.preset ?? null) : null)),
	);
	const picked = await openDialog<string | null>(TEXT_ANIMATION_PICKER_DIALOG, {
		side,
		count: ids.length,
		current: presets.size === 1 ? [...presets][0] : '',
	});
	if (picked === undefined) return;
	if (picked === null) removeTextAnimation(session, ids, side);
	else applyTextAnimation(session, ids, { side, preset: picked });
}

export const textAnimationCommands: UiCommand[] = [
	{
		id: 'text.applyAnimation',
		label: 'Apply Text Animation',
		description:
			'Applies a text animation preset (fade, slide-up, pop, typewriter…) as In, Out or both to text clips (default: the selected text clips).',
		icon: 'panel.motionTemplates',
		scope: 'editing',
		argsSchema: ApplyArgs,
		agentExposed: true,
		// Agents pass clipIds, so the selection is not required to run it.
		when: (ctx) => !!ctx.session && !ctx.session.getState().readOnly,
		run: async (ctx, args) => {
			const a = ApplyArgs.parse(args ?? {});
			const ids = targets(ctx, a.clipIds);
			if (!ctx.session || !ids.length) {
				ctx.ui.toast({ kind: 'info', message: 'Select a text clip first' });
				return;
			}
			if (!a.preset) {
				if (a.side === 'both') throw new Error('Pick a preset for In or Out');
				await pickAndApply(ctx.session, ids, a.side);
				return;
			}
			if (!latestTextAnimationSpec(a.preset)) throw new Error(`Unknown text animation ${a.preset}`);
			report(
				ctx,
				applyTextAnimation(ctx.session, ids, {
					side: a.side,
					preset: a.preset,
					...(a.version !== undefined ? { version: a.version } : {}),
					...(a.durationFrames !== undefined ? { durationFrames: a.durationFrames } : {}),
					...(a.params ? { params: a.params } : {}),
				}),
			);
		},
	},
	{
		id: 'text.removeAnimation',
		label: 'Remove Text Animation',
		description:
			'Removes the In, Out or both text animations of text clips (default: the selected text clips).',
		scope: 'editing',
		argsSchema: RemoveArgs,
		agentExposed: true,
		when: hasTextSelection,
		disabledReason: (ctx) => (ctx.session && !hasTextSelection(ctx) ? 'Select a text clip first' : undefined),
		run: (ctx, args) => {
			const a = RemoveArgs.parse(args ?? {});
			const ids = targets(ctx, a.clipIds);
			if (ctx.session && ids.length) report(ctx, removeTextAnimation(ctx.session, ids, a.side));
		},
	},
];

// ---------------------------------------------------------------- UI extensions (ARCHITECTURE §19.10)

registerDialog(TEXT_ANIMATION_PICKER_DIALOG, TextAnimationPickerDialog);

clipSections.register({
	id: 'text-animation',
	title: 'Text Animation',
	appliesTo: (clips) => clips.length > 0 && clips.every((c) => c.kind === 'text'),
	component: ({ session, clips }) =>
		createElement(TextAnimationSection, { session, clipIds: clips.map((c) => c.id), host: 'properties' }),
	defaultOpen: true,
	order: 5,
});

/** Clip context menu ▸ Text Animation (TXA-024): apply a preset as In / Out, remove. */
clipMenuExtensions.register({
	id: 'text-animation',
	items: ({ session, clip, selection }) => {
		if (clip.kind !== 'text') return [];
		const ids = textClipIds(session, selection.includes(clip.id) ? selection : [clip.id]);
		const presets = (side: AnimationSide): MenuItemSpec[] =>
			LATEST_TEXT_ANIMATIONS.filter((s) => side === 'both' || s.phases.includes(side)).map((s) => ({
				kind: 'item',
				label: s.label,
				run: () => void applyTextAnimation(session, ids, { side, preset: s.id }),
			}));
		const has = (side: TextAnimationSide) =>
			ids.some((id) => {
				const c = activeSequence(session)?.clips[id];
				return c?.kind === 'text' && !!c.textAnimation?.[side];
			});
		return [
			{
				kind: 'submenu',
				label: 'Text Animation',
				items: [
					{ kind: 'submenu', label: 'Apply In', items: presets('in') },
					{ kind: 'submenu', label: 'Apply Out', items: presets('out') },
					{ kind: 'separator' },
					{
						kind: 'item',
						label: 'Remove In',
						disabled: !has('in'),
						run: () => void removeTextAnimation(session, ids, 'in'),
					},
					{
						kind: 'item',
						label: 'Remove Out',
						disabled: !has('out'),
						run: () => void removeTextAnimation(session, ids, 'out'),
					},
					{
						kind: 'item',
						label: 'Remove All',
						disabled: !has('in') && !has('out'),
						run: () => void removeTextAnimation(session, ids, 'both'),
					},
				],
			},
		];
	},
});
