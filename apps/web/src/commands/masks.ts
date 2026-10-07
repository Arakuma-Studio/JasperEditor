// UI commands for masks (wp masks): delete the selected mask / vertices (Delete / Backspace in the Program monitor),
// leave the pen / deselect (Escape), Premiere's mask tracking commands for the selected mask (no default keys in
// Premiere), and the Program monitor overlay registration. Loaded once by commands/index.ts.
import type { Command } from '@jasper/project';
import { programOverlays } from '../extensions/index.ts';
import { deleteMasks, stopPen, trackMask } from '../masks/actions.ts';
import { MaskOverlay } from '../masks/MaskOverlay.tsx';
import { maskUi } from '../masks/store.ts';
import type { CommandCtx, UiCommand } from './types.ts';

programOverlays.register({
	id: 'masks',
	active: (session) => !!session.getState().activeSequenceId,
	component: MaskOverlay,
	order: 75,
});

const selected = () => maskUi.get().selected;

function track(
	id: string,
	label: string,
	mode: 'forward' | 'backward' | 'step-forward' | 'step-back',
): UiCommand {
	return {
		id,
		label,
		description: `${label}: follows the pixels inside the selected mask and keys its Mask Path (Effect Controls ▸ mask tracking).`,
		scope: 'global',
		agentExposed: true,
		when: (ctx: CommandCtx) => !!ctx.session && !!selected() && !maskUi.get().tracking[selected()!.maskId],
		disabledReason: () =>
			selected() ? 'This mask is being tracked' : 'Select a mask in Effect Controls first',
		run: async (ctx) => {
			const s = selected();
			if (ctx.session && s) await trackMask(ctx.session, ctx.engine, s.maskId, mode);
		},
	};
}

export const maskCommands: UiCommand[] = [
	{
		id: 'mask.deleteSelection',
		label: 'Delete Mask Vertices or Mask',
		description:
			'Deletes the selected vertices of the selected mask (a closed mask keeps 3), or the mask itself.',
		scope: 'program',
		when: (ctx) => !!ctx.session && !!selected() && !ctx.session.getState().readOnly,
		run: (ctx) => {
			const session = ctx.session!;
			const s = selected()!;
			const vertices = maskUi.get().vertices;
			if (vertices.length) {
				const r = session.apply({
					label: 'Delete Mask Vertex',
					origin: 'user',
					commands: [
						{ type: 'mask.editPath', maskId: s.maskId, ops: [{ op: 'removeVertices', vertices }] } as Command,
					],
				});
				if (!r.ok) ctx.ui.toast({ kind: 'error', message: r.errors[0]?.message ?? 'Cannot delete vertices' });
				else maskUi.set({ vertices: [] });
				return;
			}
			deleteMasks(session, [s.maskId]);
		},
	},
	{
		id: 'mask.escape',
		label: 'Finish Pen / Deselect Mask',
		description: 'Stops drawing with the mask pen, or deselects the selected mask.',
		scope: 'program',
		when: () => !!maskUi.get().pen || !!selected(),
		run: () => {
			if (maskUi.get().pen) stopPen();
			else maskUi.select(null);
		},
	},
	track('mask.trackForward', 'Track Selected Mask Forward', 'forward'),
	track('mask.trackBackward', 'Track Selected Mask Backward', 'backward'),
	track('mask.trackForwardOneFrame', 'Track Selected Mask Forward 1 Frame', 'step-forward'),
	track('mask.trackBackwardOneFrame', 'Track Selected Mask Backward 1 Frame', 'step-back'),
];
