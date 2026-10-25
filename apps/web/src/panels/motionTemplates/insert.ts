// Inserting motion templates (S05:MGT-002, S01:KND-009): default duration from the template, default
// params (C3: or a preset's params over them), at the playhead on the targeted video track, through the
// `clip.addMotionGraphic` command.
// Also the drag payload other panels (Timeline, Program) accept for template drops.
import { mgRegistry, templatePresetParams } from '@jasper/mg-templates';
import type { Command, Sequence } from '@jasper/project';
import type { EditorSession, SequenceViewState } from '@jasper/session';
import { z } from 'zod';
import { type CompositionRef, insertComposition } from '../../mg-bundles/insert.ts';

/** DataTransfer type of a template drag from the Motion Templates panel. */
export const MG_TEMPLATE_MIME = 'application/x-jasper-mg-template';

/**
 * A template, or (M2, wp-m2-mg) a composition of an imported Remotion bundle: `composition` set, `id` = the
 * composition id. Drops onto the Timeline / Program monitor insert it through `clip.addComposition`.
 * C3: `preset` = a preset of the template (the gallery card of that preset).
 */
export type MgTemplateRef = { id: string; version: number; preset?: string; composition?: CompositionRef };
const MgTemplateDragSchema = z.object({
	type: z.literal('jasper/mg-template'),
	template: z.object({
		id: z.string().min(1),
		version: z.number().int().positive(),
		preset: z.string().min(1).max(64).optional(),
		composition: z.object({ mediaId: z.string().min(1), compositionId: z.string().min(1) }).optional(),
	}),
});
type MgTemplateDragPayload = z.infer<typeof MgTemplateDragSchema>;

export function writeMgTemplateDrag(dt: DataTransfer, template: MgTemplateRef): void {
	const payload: MgTemplateDragPayload = { type: 'jasper/mg-template', template };
	dt.setData(MG_TEMPLATE_MIME, JSON.stringify(payload));
	dt.setData(
		'text/plain',
		template.composition
			? template.composition.compositionId
			: `${template.id}@${template.version}${template.preset ? `:${template.preset}` : ''}`,
	);
	dt.effectAllowed = 'copy';
}

/** Parses a template drag (null when the DataTransfer carries none). */
export function readMgTemplateDrag(dt: Pick<DataTransfer, 'getData'>): MgTemplateDragPayload | null {
	try {
		const raw = dt.getData(MG_TEMPLATE_MIME);
		if (!raw) return null;
		const parsed = MgTemplateDragSchema.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/**
 * Track for a new graphic: the topmost targeted, unlocked video track; else the topmost unlocked
 * video track; else `V1` (the command creates it).
 */
function targetVideoTrack(seq: Sequence, view: Pick<SequenceViewState, 'targeting'> | null): string {
	const tracks = seq.videoTracks.filter((t) => !t.locked);
	const targeted = new Set(view?.targeting.video ?? []);
	for (let i = tracks.length - 1; i >= 0; i--) if (targeted.has(tracks[i]!.id)) return tracks[i]!.id;
	const top = tracks.at(-1);
	return top ? top.id : 'V1';
}

/**
 * Inserts a template at the playhead of the active sequence and selects the new clip.
 * Returns the new clip id, or throws with a user-facing message.
 */
export function insertMotionTemplate(
	session: EditorSession,
	template: MgTemplateRef,
	opts: { at?: number; trackId?: string } = {},
): string {
	// Remotion compositions share the drag payload and the drop handlers (wp-m2-mg).
	if (template.composition) return insertComposition(session, template.composition, opts);
	const state = session.store.getState();
	const sequenceId = state.activeSequenceId;
	if (!sequenceId) throw new Error('Open a sequence first');
	const at = opts.at ?? session.transport.getState().frame;
	const seq = session.getCommitted().sequences[sequenceId];
	if (!seq) throw new Error(`Sequence ${sequenceId} not found`);
	const def = mgRegistry.getDefinition(template.id, template.version);
	if (!def) throw new Error(`Unknown motion template ${template.id}@${template.version}`);
	const preset = template.preset ? def.presets?.find((p) => p.id === template.preset) : undefined;
	const params = preset ? templatePresetParams(def, preset.id) : { ...def.defaults };
	if (template.preset && (!preset || !params))
		throw new Error(`Motion template ${def.id}@${def.version} has no preset ${template.preset}`);
	const { num, den } = seq.settings.frameRate;
	const result = session.apply({
		label: `Add ${preset ? preset.name : def.name}`,
		origin: 'user',
		sequenceId,
		commands: [
			{
				type: 'clip.addMotionGraphic',
				sequenceId,
				at: Math.max(0, Math.round(at)),
				duration: Math.max(1, Math.round((def.defaultDurationSeconds * num) / den)),
				track: opts.trackId ?? targetVideoTrack(seq, state.views[sequenceId] ?? null),
				template: { id: def.id, version: def.version },
				params,
			} as Command,
		],
	});
	if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('; ') || 'Insert failed');
	const clipId = (result.results[0] as { clipId?: string } | undefined)?.clipId ?? result.created[0];
	if (!clipId) throw new Error('Insert produced no clip');
	session.select('timeline', [clipId], 'replace');
	return clipId;
}
