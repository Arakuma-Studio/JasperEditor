// mg UI commands — owned by WP-2G (ARCHITECTURE §7.3). No default key bindings.
//   mg.insert   insert a motion template at the playhead on the targeted video track
//   mg.rerender ask the engine to (re)render the selected motion-graphic clips (preview + master)
import type { MgRenderSpec } from '@jasper/api';
import { mgRegistry, resolveSpecParams } from '@jasper/mg-templates';
import { FLICKS_PER_SECOND, type ProjectDocument } from '@jasper/project';
import { z } from 'zod';
import { insertMotionTemplate } from '../panels/motionTemplates/insert.ts';
import type { CommandCtx, UiCommand } from './types.ts';

const InsertArgs = z.object({
	templateId: z.string().min(1),
	version: z.number().int().positive().default(1),
	/** Sequence frame; default the playhead. */
	at: z.number().int().min(0).optional(),
	trackId: z.string().optional(),
});

/** Render spec of a motion-graphic clip in the document (null for other kinds / unknown ids). */
export function mgSpecForClip(doc: ProjectDocument, sequenceId: string, clipId: string): MgRenderSpec | null {
	const seq = doc.sequences[sequenceId];
	const clip = seq?.clips[clipId];
	if (!seq || !clip || clip.kind !== 'motion-graphic') return null;
	const fps = seq.settings.frameRate;
	const canvas =
		clip.canvas === 'sequence' ? { width: seq.settings.width, height: seq.settings.height } : clip.canvas;
	return resolveSpecParams(
		{
			template: { id: clip.template.id, version: clip.template.version },
			params: { ...clip.params },
			width: canvas.width,
			height: canvas.height,
			fps: { num: fps.num, den: fps.den },
			durationFrames: clip.duration,
			sourceInFrames: Math.max(0, Math.round((clip.sourceIn * fps.num) / (fps.den * FLICKS_PER_SECOND))),
		},
		mgRegistry,
	);
}

function selectedMgClips(ctx: CommandCtx): { sequenceId: string; clipIds: string[] } | null {
	const state = ctx.session?.store.getState();
	const sequenceId = state?.activeSequenceId;
	if (!state || !sequenceId) return null;
	const seq = state.document.sequences[sequenceId];
	const clipIds = state.selection.timeline.clips.filter((id) => seq?.clips[id]?.kind === 'motion-graphic');
	return { sequenceId, clipIds };
}

export const mgCommands: UiCommand[] = [
	{
		id: 'mg.insert',
		label: 'Insert Motion Template',
		description:
			'Adds a motion-graphic template at the playhead on the targeted video track (default duration and params).',
		icon: 'panel.motionTemplates',
		scope: 'editing',
		argsSchema: InsertArgs,
		agentExposed: true,
		when: (ctx) => !!ctx.session?.store.getState().activeSequenceId,
		run: (ctx, args) => {
			const a = args as z.infer<typeof InsertArgs>;
			if (!ctx.session) throw new Error('No project is open');
			insertMotionTemplate(
				ctx.session,
				{ id: a.templateId, version: a.version },
				{ at: a.at, trackId: a.trackId },
			);
		},
	},
	{
		id: 'mg.rerender',
		label: 'Re-render Motion Graphics',
		description:
			'Renders the selected motion-graphic clips with the native fframes renderer (preview + ProRes master).',
		icon: 'engine.fframes',
		scope: 'editing',
		capability: 'fframes',
		agentExposed: true,
		when: (ctx) => (selectedMgClips(ctx)?.clipIds.length ?? 0) > 0,
		run: async (ctx) => {
			const sel = selectedMgClips(ctx);
			if (!sel || !ctx.session || sel.clipIds.length === 0) return;
			const doc = ctx.session.getCommitted();
			let queued = 0;
			for (const clipId of sel.clipIds) {
				const spec = mgSpecForClip(doc, sel.sequenceId, clipId);
				if (!spec) continue;
				await ctx.engine.mgRender({ spec, quality: 'preview' });
				queued++;
			}
			ctx.ui.toast({
				kind: 'info',
				message: `Rendering ${queued} motion graphic${queued === 1 ? '' : 's'}`,
				detail: 'Progress appears in the Jobs panel.',
			});
		},
	},
];
