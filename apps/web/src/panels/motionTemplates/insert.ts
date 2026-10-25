// Inserting motion templates (S05:MGT-002, S01:KND-009): default duration from the template, default
// params, at the playhead, through the `clip.addMotionGraphic` command. Insertion never overwrites
// (social-comments design §7.9): without an explicit track (gallery double-click / Enter, Program drop, a timeline
// drop outside the video tracks) the clip goes on the first free unlocked video track from the targeted one up
// (`placement: 'first-free'`), a new top track when all are busy; a drop on a video track keeps overwriting there.
// Also the drag payload other panels (Timeline, Program) accept for template drops.
import { mgRegistry } from '@jasper/mg-templates';
import type { Command, Sequence } from '@jasper/project';
import type { EditorSession, SequenceViewState } from '@jasper/session';
import { z } from 'zod';
import { type CompositionRef, insertComposition } from '../../mg-bundles/insert.ts';

/** DataTransfer type of a template drag from the Motion Templates panel. */
export const MG_TEMPLATE_MIME = 'application/x-jasper-mg-template';

/**
 * A template, or (M2, wp-m2-mg) a composition of an imported Remotion bundle: `composition` set, `id` = the
 * composition id. Drops onto the Timeline / Program monitor insert it through `clip.addComposition`.
 */
export type MgTemplateRef = { id: string; version: number; composition?: CompositionRef };
const MgTemplateDragSchema = z.object({
	type: z.literal('jasper/mg-template'),
	template: z.object({
		id: z.string().min(1),
		version: z.number().int().positive(),
		composition: z.object({ mediaId: z.string().min(1), compositionId: z.string().min(1) }).optional(),
	}),
});
type MgTemplateDragPayload = z.infer<typeof MgTemplateDragSchema>;

export function writeMgTemplateDrag(dt: DataTransfer, template: MgTemplateRef): void {
	const payload: MgTemplateDragPayload = { type: 'jasper/mg-template', template };
	dt.setData(MG_TEMPLATE_MIME, JSON.stringify(payload));
	dt.setData(
		'text/plain',
		template.composition ? template.composition.compositionId : `${template.id}@${template.version}`,
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
 * Lowest track a first-free insert considers: the topmost targeted video track (a locked one is skipped upward by
 * the placement), else the first video track (`V1`; the command creates it when the sequence has none).
 */
export function firstFreeFloor(seq: Sequence, view: Pick<SequenceViewState, 'targeting'> | null): string {
	const targeted = new Set(view?.targeting.video ?? []);
	for (let i = seq.videoTracks.length - 1; i >= 0; i--)
		if (targeted.has(seq.videoTracks[i]!.id)) return seq.videoTracks[i]!.id;
	return seq.videoTracks[0]?.id ?? 'V1';
}

/**
 * Inserts a template at the playhead of the active sequence and selects the new clip: on `trackId` (overwriting
 * the range there) when given, else first-free from the targeted video track up (one undo step either way).
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
	const { num, den } = seq.settings.frameRate;
	const result = session.apply({
		label: `Add ${def.name}`,
		origin: 'user',
		sequenceId,
		commands: [
			{
				type: 'clip.addMotionGraphic',
				sequenceId,
				at: Math.max(0, Math.round(at)),
				duration: Math.max(1, Math.round((def.defaultDurationSeconds * num) / den)),
				...(opts.trackId
					? { track: opts.trackId }
					: { track: firstFreeFloor(seq, state.views[sequenceId] ?? null), placement: 'first-free' }),
				template: { id: def.id, version: def.version },
				params: { ...def.defaults },
			} as Command,
		],
	});
	if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('; ') || 'Insert failed');
	const clipId = (result.results[0] as { clipId?: string } | undefined)?.clipId ?? result.created[0];
	if (!clipId) throw new Error('Insert produced no clip');
	session.select('timeline', [clipId], 'replace');
	return clipId;
}
