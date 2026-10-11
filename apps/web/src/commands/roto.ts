import { type Clip, findRoto } from '@jasper/project';
import { cancelRoto, convertToMasks, freezeRoto, runRoto, trackFaces } from '../roto/actions.ts';
import { registerRotoUi } from '../roto/register.ts';
import { type RotoView, rotoUi } from '../roto/store.ts';
import type { CommandCtx, UiCommand } from './types.ts';

registerRotoUi();

const writable = (ctx: CommandCtx) => !!ctx.session && !ctx.session.getState().readOnly;

function selectedPicture(ctx: CommandCtx): Clip | null {
	const s = ctx.session?.getState();
	if (!s) return null;
	const ids = s.selection.timeline.clips ?? [];
	if (ids.length !== 1) return null;
	for (const seq of Object.values(s.document.sequences)) {
		const c = seq.clips[ids[0]!];
		if (c && (c.kind === 'video' || c.kind === 'still')) return c;
	}
	return null;
}

function activeRoto(ctx: CommandCtx) {
	const id = rotoUi.get().activeRotoId;
	return id && ctx.session ? findRoto(ctx.session.getState().document, id) : null;
}

const VIEWS: RotoView[] = ['overlay', 'boundary', 'alpha', 'off'];

export const rotoCommands: UiCommand[] = [
	{
		id: 'roto.tool',
		label: 'Roto Brush Tool',
		description:
			'Paint over an object in the Program monitor to select it (Alt subtracts, Shift draws a box, Ctrl/Cmd-drag resizes the brush); the clip is cut out by an Object Matte effect.',
		scope: 'global',
		checked: () => rotoUi.get().tool,
		when: writable,
		run: () => rotoUi.set({ tool: !rotoUi.get().tool }),
	},
	{
		id: 'roto.brushBigger',
		label: 'Roto Brush Bigger',
		scope: 'program',
		repeat: true,
		when: () => rotoUi.get().tool,
		run: () => rotoUi.set({ radius: Math.min(400, Math.round(rotoUi.get().radius * 1.15 + 1)) }),
	},
	{
		id: 'roto.brushSmaller',
		label: 'Roto Brush Smaller',
		scope: 'program',
		repeat: true,
		when: () => rotoUi.get().tool,
		run: () => rotoUi.set({ radius: Math.max(2, Math.round((rotoUi.get().radius - 1) / 1.15)) }),
	},
	{
		id: 'roto.propagate',
		label: 'Propagate Roto',
		description: 'Computes the active roto object over its whole span (frames already computed are reused).',
		scope: 'global',
		capability: 'engine',
		when: (ctx) => writable(ctx) && !!activeRoto(ctx) && !rotoUi.get().running[activeRoto(ctx)!.roto.id],
		disabledReason: (ctx) => (activeRoto(ctx) ? undefined : 'Select a roto object first (Properties ▸ Roto)'),
		run: async (ctx) => {
			const loc = activeRoto(ctx);
			if (loc && ctx.session) await runRoto(ctx.session, ctx.engine, loc.roto.id, 'both');
		},
	},
	{
		id: 'roto.cancel',
		label: 'Stop Roto Propagation',
		scope: 'global',
		when: (ctx) => !!activeRoto(ctx) && !!rotoUi.get().running[activeRoto(ctx)!.roto.id],
		run: async (ctx) => {
			const loc = activeRoto(ctx);
			if (loc) await cancelRoto(ctx.engine, loc.roto.id);
		},
	},
	{
		id: 'roto.trackFaces',
		label: 'Track Faces',
		description: 'Finds and tracks every face of the selected clip (face mattes and poses).',
		scope: 'global',
		capability: 'engine',
		when: (ctx) => writable(ctx) && !!selectedPicture(ctx),
		disabledReason: () => 'Select one video or still clip',
		run: async (ctx) => {
			const c = selectedPicture(ctx);
			if (c && ctx.session) await trackFaces(ctx.session, ctx.engine, c.id, false);
		},
	},
	{
		id: 'roto.blurFaces',
		label: 'Blur Faces',
		description: 'Tracks every face of the selected clip and blurs it (Object Blur).',
		scope: 'global',
		capability: 'engine',
		when: (ctx) => writable(ctx) && !!selectedPicture(ctx),
		disabledReason: () => 'Select one video or still clip',
		run: async (ctx) => {
			const c = selectedPicture(ctx);
			if (c && ctx.session) await trackFaces(ctx.session, ctx.engine, c.id, true);
		},
	},
	{
		id: 'roto.convertToMasks',
		label: 'Convert Roto to Masks',
		description: 'The active roto object’s outline at the playhead becomes Opacity masks of its clip.',
		scope: 'global',
		capability: 'engine',
		when: (ctx) => writable(ctx) && !!activeRoto(ctx)?.roto.result,
		run: async (ctx) => {
			const loc = activeRoto(ctx);
			if (loc && ctx.session)
				await convertToMasks(ctx.session, ctx.engine, loc.roto.id, 'still', ctx.transport.getState().frame);
		},
	},
	{
		id: 'roto.freeze',
		label: 'Freeze Roto',
		scope: 'global',
		checked: (ctx) => !!activeRoto(ctx)?.roto.frozen,
		when: (ctx) =>
			writable(ctx) &&
			!!activeRoto(ctx) &&
			(!!activeRoto(ctx)!.roto.frozen || !!activeRoto(ctx)!.roto.result),
		run: (ctx) => {
			const loc = activeRoto(ctx);
			if (loc && ctx.session) freezeRoto(ctx.session, loc.roto.id, !loc.roto.frozen);
		},
	},
	{
		id: 'roto.cycleView',
		label: 'Cycle Roto View',
		description: 'Program monitor view of the roto matte: Alpha Overlay, Alpha Boundary, Alpha, Off.',
		scope: 'global',
		run: () => {
			const i = VIEWS.indexOf(rotoUi.get().view);
			rotoUi.set({ view: VIEWS[(i + 1) % VIEWS.length]! });
		},
	},
];
