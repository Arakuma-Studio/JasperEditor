import type { MgRenderSpec } from '@jasper/api';
import { isSvgTemplate, mgRegistry, resolveSpecParams } from '@jasper/mg-templates';
import type { Clip, ProjectDocument } from '@jasper/project';
import { FLICKS_PER_SECOND } from '@jasper/project';
import { z } from 'zod';
import { clipSections } from '../extensions/index.ts';
import { insertMotionTemplate } from '../panels/motionTemplates/insert.ts';
import { MgTemplateSection } from '../panels/motionTemplates/TemplateSection.tsx';
import { hasTemplateUpgrade, updateTemplates } from '../panels/motionTemplates/upgrades.ts';
import { trackMgRenderJob } from '../panels/program/mg-render-state.tsx';
import type { CommandCtx, UiCommand } from './types.ts';

const InsertArgs = z.object({
	templateId: z.string().min(1),
	version: z.number().int().positive().default(1),
	/** Sequence frame; default the playhead. */
	at: z.number().int().min(0).optional(),
	/** Track id or label to overwrite on; default: the first free video track from the targeted one up. */
	trackId: z.string().optional(),
});

/** Render spec of a motion-graphic clip in the document (null for other kinds / unknown ids). */
function mgSpecForClip(doc: ProjectDocument, sequenceId: string, clipId: string): MgRenderSpec | null {
	const seq = doc.sequences[sequenceId];
	const clip = seq?.clips[clipId];
	// Anime templates (and templates this build lacks) have no jasper-mg spec (S11:ATP-008).
	if (!seq || !clip || !isFframesClip(clip)) return null;
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

type MgClip = Extract<Clip, { kind: 'motion-graphic' }>;

/** True for clips of an installed fframes template (the only ones jasper-mg renders, S11:ATP-008). */
function isFframesClip(clip: Clip | undefined): clip is MgClip {
	if (clip?.kind !== 'motion-graphic') return false;
	const def = mgRegistry.getDefinition(clip.template.id, clip.template.version);
	return !!def && isSvgTemplate(def);
}

function selectedMgClips(
	ctx: CommandCtx,
	filter: (c: Clip | undefined) => boolean = isFframesClip,
): { sequenceId: string; clipIds: string[] } | null {
	const state = ctx.session?.store.getState();
	const sequenceId = state?.activeSequenceId;
	if (!state || !sequenceId) return null;
	const seq = state.document.sequences[sequenceId];
	const clipIds = state.selection.timeline.clips.filter((id) => filter(seq?.clips[id]));
	return { sequenceId, clipIds };
}

const UpdateArgs = z
	.object({
		/** Clips to update; default: the selected motion-graphic clips. */
		clipIds: z.array(z.string()).optional(),
	})
	.optional();

export const mgCommands: UiCommand[] = [
	{
		id: 'mg.insert',
		label: 'Insert Motion Template',
		description:
			'Adds a motion-graphic template at the playhead (default duration and params) without overwriting: on the first free video track from the targeted one up (a new track on top when all are busy); with trackId, on that track (overwriting its range).',
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
			'Renders the selected fframes motion-graphic clips with the native fframes renderer (preview + ProRes master). Anime templates are drawn by Remotion and are not re-rendered.',
		icon: 'engine.fframes',
		scope: 'editing',
		capability: 'fframes',
		agentExposed: true,
		// fframes-only (S11:ATP-008): unavailable when only anime-template clips are selected.
		when: (ctx) => (selectedMgClips(ctx)?.clipIds.length ?? 0) > 0,
		run: async (ctx) => {
			const sel = selectedMgClips(ctx);
			if (!sel || !ctx.session || sel.clipIds.length === 0) return;
			const doc = ctx.session.getCommitted();
			let queued = 0;
			for (const clipId of sel.clipIds) {
				const spec = mgSpecForClip(doc, sel.sequenceId, clipId);
				if (!spec) continue;
				const job = await ctx.engine.mgRender({ spec, quality: 'preview' });
				trackMgRenderJob(clipId, job.id); // Program monitor badge (MgRenderStateContext)
				queued++;
			}
			ctx.ui.toast({
				kind: 'info',
				message: `Rendering ${queued} motion graphic${queued === 1 ? '' : 's'}`,
				detail: 'Progress appears in the Jobs panel.',
			});
		},
	},
	{
		id: 'mg.updateTemplate',
		label: 'Update Template to Latest Version',
		description:
			'Upgrades the template of the selected motion-graphic clips to its newest installed version (params migrated; one undo step).',
		icon: 'panel.motionTemplates',
		scope: 'editing',
		argsSchema: UpdateArgs,
		agentExposed: true,
		// Agents pass clipIds, so the selection is not required to run it (it is checked in `run`, like
		// text.applyAnimation).
		when: (ctx) => !!ctx.session && !ctx.session.getState().readOnly,
		run: (ctx, args) => {
			if (!ctx.session) throw new Error('No project is open');
			const a = args as z.infer<typeof UpdateArgs> | undefined;
			const ids = a?.clipIds ?? selectedMgClips(ctx, (c) => c?.kind === 'motion-graphic')?.clipIds ?? [];
			if (!a?.clipIds && !hasTemplateUpgrade(ctx.session, ids)) {
				ctx.ui.toast({ kind: 'info', message: 'Select a motion-graphic clip whose template has an update' });
				return;
			}
			const r = updateTemplates(ctx.session, ids);
			if (!r.ok) throw new Error(r.message);
			ctx.ui.toast({ kind: 'info', message: `Updated ${r.updated} template${r.updated === 1 ? '' : 's'}` });
		},
	},
];

clipSections.register({
	id: 'mg-template',
	title: 'Template',
	appliesTo: (clips) => clips.length > 0 && clips.every((c) => c.kind === 'motion-graphic'),
	component: MgTemplateSection,
	defaultOpen: true,
	order: 5,
});
