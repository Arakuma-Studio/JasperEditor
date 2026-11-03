// Spec 19 TL-097: every Title Looks action as a UI command, in the Graphics menu and the palette. None has a default
// shortcut: a person binds what they use, and nothing collides with the editing keys.
import type { Command } from '@jasper/project';
import { titleLayerType } from '@jasper/project';
import { openDialog } from '@jasper/ui';
import { z } from 'zod';
import { t } from '../i18n/runtime.ts';
import { newLayerIndex } from '../title-looks/AppearanceList.tsx';
import { APPLY_LOOK_DIALOG } from '../title-looks/ApplyLookDialog.tsx';
import { lookTargets, selectedClips, setColorway, stepColorway } from '../title-looks/actions.ts';
import {
	colorwaysFor,
	detachLook,
	lookedTargets,
	removeLook,
	resetLook,
	saveLook,
	updateProjectLook,
} from '../title-looks/look-actions.ts';
import { lookSelection } from '../title-looks/selection.ts';
import { ensureUserLooks, userLookLibrary, userLooksUnavailable } from '../title-looks/user-library.ts';
import {
	exportMyLooks,
	importMyLooks,
	saveToMyLooks,
	saveToMyLooksDisabled,
} from '../title-looks/user-look-actions.ts';
import type { CommandCtx, UiCommand } from './types.ts';

const canEdit = (ctx: CommandCtx) => !!ctx.session && !ctx.session.getState().readOnly;
const hasSequence = (ctx: CommandCtx) => !!ctx.session?.getState().activeSequenceId;
const looked = (ctx: CommandCtx) => (ctx.session ? lookedTargets(ctx.session) : []);
const linked = (ctx: CommandCtx) => looked(ctx).filter((l) => l.appearance.lookId !== undefined);

const withLook = (ctx: CommandCtx) => (looked(ctx).length ? undefined : 'Select a clip with a look first.');
const withLink = (ctx: CommandCtx) =>
	linked(ctx).length ? undefined : 'Select a clip linked to a look first.';

function stepColorways(ctx: CommandCtx, dir: 1 | -1): void {
	const session = ctx.session;
	if (!session) return;
	const list = looked(ctx);
	const doc = session.getCommitted();
	const sel = lookSelection(doc, selectedClips(session));
	const next = stepColorway(colorwaysFor(sel.look), list[0]?.appearance.colorwayId, dir);
	if (!next) {
		ctx.ui.toast({ kind: 'info', message: 'This look has no colourways yet.' });
		return;
	}
	setColorway(
		session,
		list.map((l) => l.clip.id),
		next,
	);
	ctx.ui.toast({ kind: 'info', message: t('Colourway: {0}', next.name) });
}

const AddLayerArgs = z.object({ layerType: z.string().min(1).max(64) });
const AddGeneratorArgs = z.object({ generatorId: z.string().min(1).max(64) });

export const titleLookCommands: UiCommand[] = [
	{
		id: 'graphics.applyLook',
		label: 'Apply Look…',
		description:
			'Opens the looks grid: applies to the selected clips, or adds a title when nothing is selected.',
		icon: 'tool.type',
		scope: 'global',
		agentExposed: true,
		when: (ctx) => hasSequence(ctx) && canEdit(ctx),
		disabledReason: (ctx) => (hasSequence(ctx) ? undefined : 'Open a sequence first'),
		run: (ctx) => {
			if (ctx.session) void openDialog(APPLY_LOOK_DIALOG, { session: ctx.session });
		},
	},
	{
		id: 'graphics.removeLook',
		label: 'Remove Look',
		description: 'Takes the look off the selected clips.',
		scope: 'editing',
		agentExposed: true,
		when: (ctx) => canEdit(ctx) && looked(ctx).length > 0,
		disabledReason: withLook,
		run: (ctx) => {
			if (ctx.session) removeLook(ctx.session);
		},
	},
	{
		id: 'graphics.resetLook',
		label: 'Reset Look',
		description: 'Takes the selected clips back to their look, dropping their changes to it.',
		scope: 'editing',
		agentExposed: true,
		when: (ctx) => canEdit(ctx) && linked(ctx).length > 0,
		disabledReason: withLink,
		run: (ctx) => {
			if (ctx.session) resetLook(ctx.session);
		},
	},
	{
		id: 'graphics.detachLook',
		label: 'Detach from Look',
		description:
			'Keeps how the selected clips look and drops the link, so later edits of the look do not reach them.',
		scope: 'editing',
		agentExposed: true,
		when: (ctx) => canEdit(ctx) && linked(ctx).length > 0,
		disabledReason: withLink,
		run: (ctx) => {
			if (ctx.session) detachLook(ctx.session);
		},
	},
	{
		id: 'graphics.saveLook',
		label: 'Save Look…',
		description: 'Saves the look of the selected clip in this project, and links the clip to it.',
		scope: 'editing',
		when: (ctx) => canEdit(ctx) && looked(ctx).length > 0,
		disabledReason: withLook,
		run: (ctx) => {
			if (ctx.session) void saveLook(ctx.session);
		},
	},
	{
		id: 'graphics.saveLookToMyLooks',
		label: 'Save Look to My Looks…',
		description: 'Keeps the look of the selected clip in My Looks, where every project can use it.',
		scope: 'editing',
		capability: 'engine',
		when: (ctx) => !!ctx.session && looked(ctx).length > 0,
		disabledReason: (ctx) => (looked(ctx).length ? undefined : withLook(ctx)),
		run: async (ctx) => {
			if (!ctx.session) return;
			await ensureUserLooks(ctx.engine);
			const why = saveToMyLooksDisabled(ctx.session);
			if (why) ctx.ui.toast({ kind: 'warning', message: why });
			else await saveToMyLooks(ctx.session);
		},
	},
	{
		id: 'graphics.importMyLooks',
		label: 'Import Looks…',
		description: 'Adds the looks of a .json looks file to My Looks.',
		scope: 'global',
		capability: 'engine',
		run: async (ctx) => {
			await ensureUserLooks(ctx.engine);
			const r = await importMyLooks();
			if (r) ctx.ui.toast({ kind: r.ok ? 'success' : 'error', message: r.message });
		},
	},
	{
		id: 'graphics.exportMyLooks',
		label: 'Export My Looks…',
		description: 'Saves every look of My Looks as one .json file to share or keep.',
		scope: 'global',
		capability: 'engine',
		run: async (ctx) => {
			await ensureUserLooks(ctx.engine);
			const s = userLookLibrary().getState();
			const why =
				s.status !== 'ready'
					? userLooksUnavailable(s)
					: s.looks.length === 0
						? t('There are no looks in My Looks to export yet.')
						: null;
			if (why) {
				ctx.ui.toast({ kind: 'warning', message: why });
				return;
			}
			const r = await exportMyLooks(undefined, t('My Looks'));
			ctx.ui.toast({ kind: r.ok ? 'success' : 'error', message: r.message });
		},
	},
	{
		id: 'graphics.updateLook',
		label: 'Update Look from Clip',
		description:
			'Redefines the look from the selected clip. Every linked clip follows and keeps its own changes.',
		scope: 'editing',
		agentExposed: true,
		when: (ctx) => canEdit(ctx) && linked(ctx).length === 1,
		disabledReason: (ctx) =>
			linked(ctx).length === 1 ? undefined : 'Select one clip linked to a look first.',
		run: (ctx) => {
			const l = linked(ctx)[0];
			if (ctx.session && l) updateProjectLook(ctx.session, l.appearance.lookId!, l.clip.id);
		},
	},
	{
		id: 'graphics.nextColorway',
		label: 'Next Colourway',
		description: 'Swaps the selected clips to the next colourway. Repeats are one History entry.',
		scope: 'editing',
		agentExposed: true,
		when: (ctx) => canEdit(ctx) && looked(ctx).length > 0,
		disabledReason: withLook,
		run: (ctx) => stepColorways(ctx, 1),
	},
	{
		id: 'graphics.previousColorway',
		label: 'Previous Colourway',
		description: 'Swaps the selected clips to the previous colourway. Repeats are one History entry.',
		scope: 'editing',
		agentExposed: true,
		when: (ctx) => canEdit(ctx) && looked(ctx).length > 0,
		disabledReason: withLook,
		run: (ctx) => stepColorways(ctx, -1),
	},
	{
		id: 'graphics.addLookLayer',
		label: 'Add Look Layer',
		description: 'Adds a layer to the look of the selected clips, where it does not cover the title.',
		scope: 'editing',
		hidden: true,
		argsSchema: AddLayerArgs,
		when: (ctx) => canEdit(ctx) && looked(ctx).length > 0,
		disabledReason: withLook,
		run: (ctx, args) => {
			const { layerType } = AddLayerArgs.parse(args);
			if (!titleLayerType(layerType)) {
				ctx.ui.toast({ kind: 'warning', message: `Unknown layer type: ${layerType}` });
				return;
			}
			ctx.session?.apply({
				label: 'Add Layer',
				origin: 'user',
				commands: looked(ctx).map(
					(l) =>
						({
							type: 'appearance.addLayer',
							effectInstanceId: l.fx.id,
							layerType,
							index: newLayerIndex(layerType, l.appearance),
						}) as Command,
				),
			});
		},
	},
	{
		id: 'graphics.addGenerator',
		label: 'Add Generator',
		description: 'Adds a generator on a free track below the selected title, at the playhead.',
		scope: 'editing',
		hidden: true,
		argsSchema: AddGeneratorArgs,
		when: (ctx) => hasSequence(ctx) && canEdit(ctx),
		disabledReason: (ctx) => (hasSequence(ctx) ? undefined : 'Open a sequence first'),
		run: (ctx, args) => {
			const { generatorId } = AddGeneratorArgs.parse(args);
			const session = ctx.session;
			if (!session) return;
			const title = lookTargets(session).find((c) => c.kind === 'text');
			const seqId = session.getState().activeSequenceId;
			const seq = seqId ? session.getCommitted().sequences[seqId] : undefined;
			if (!seq) return;
			const fps = seq.settings.frameRate.num / seq.settings.frameRate.den;
			const at = title ? title.start : session.transport.getState().frame;
			const duration = title ? title.duration : Math.max(1, Math.round(5 * fps));
			const r = session.apply({
				label: 'Add Generator',
				origin: 'user',
				sequenceId: seq.id,
				commands: [
					{
						type: 'clip.addGenerator',
						effectId: `generator:${generatorId}`,
						at,
						duration,
						...(title ? { belowClipId: title.id } : {}),
					} as Command,
				],
			});
			if (!r.ok)
				ctx.ui.toast({ kind: 'error', message: r.errors[0]?.message ?? 'Could not add the generator' });
		},
	},
];
