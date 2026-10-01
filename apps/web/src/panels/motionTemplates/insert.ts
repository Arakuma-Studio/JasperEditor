// Inserting motion templates (S05:MGT-002, S01:KND-009): default duration from the template, default
// params, at the playhead on the targeted video track, through the `clip.addMotionGraphic` command.
// Also the drag payload other panels (Timeline, Program) accept for template drops.
import { type AnyMgTemplate, mgRegistry } from '@jasper/mg-templates';
import type { Command, ProjectDocument, Sequence } from '@jasper/project';
import type { EditorSession, SequenceViewState } from '@jasper/session';
import { type CompositionRef, insertComposition } from '../../mg-bundles/insert.ts';

/** DataTransfer type of a template drag from the Motion Templates panel. */
export const MG_TEMPLATE_MIME = 'application/x-jasper-mg-template';

/**
 * A template, or (M2, wp-m2-mg) a composition of an imported Remotion bundle: `composition` set, `id` = the
 * composition id. Drops onto the Timeline / Program monitor insert it through `clip.addComposition`.
 */
export type MgTemplateRef = { id: string; version: number; composition?: CompositionRef };
export type MgTemplateDragPayload = { type: 'jasper/mg-template'; template: MgTemplateRef };

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
		const p = JSON.parse(raw) as MgTemplateDragPayload;
		return p?.type === 'jasper/mg-template' && typeof p.template?.id === 'string' ? p : null;
	} catch {
		return null;
	}
}

/** Default clip length in frames at the sequence rate. */
export function defaultDurationFrames(
	def: Pick<AnyMgTemplate, 'defaultDurationSeconds'>,
	seq: Sequence,
): number {
	const { num, den } = seq.settings.frameRate;
	return Math.max(1, Math.round((def.defaultDurationSeconds * num) / den));
}

/**
 * Track for a new graphic: the topmost targeted, unlocked video track; else the topmost unlocked
 * video track; else `V1` (the command creates it).
 */
export function targetVideoTrack(seq: Sequence, view: Pick<SequenceViewState, 'targeting'> | null): string {
	const tracks = seq.videoTracks.filter((t) => !t.locked);
	const targeted = new Set(view?.targeting.video ?? []);
	for (let i = tracks.length - 1; i >= 0; i--) if (targeted.has(tracks[i]!.id)) return tracks[i]!.id;
	const top = tracks.at(-1);
	return top ? top.id : 'V1';
}

export type InsertPlan = { command: Command; label: string };

/** Builds the `clip.addMotionGraphic` command for a template at `at` (frames). */
export function planMotionTemplateInsert(
	doc: ProjectDocument,
	sequenceId: string,
	template: MgTemplateRef,
	opts: {
		at: number;
		view: Pick<SequenceViewState, 'targeting'> | null;
		trackId?: string;
		duration?: number;
	},
): InsertPlan {
	const seq = doc.sequences[sequenceId];
	if (!seq) throw new Error(`Sequence ${sequenceId} not found`);
	const def = mgRegistry.getDefinition(template.id, template.version);
	if (!def) throw new Error(`Unknown motion template ${template.id}@${template.version}`);
	const command = {
		type: 'clip.addMotionGraphic',
		sequenceId,
		at: Math.max(0, Math.round(opts.at)),
		duration: opts.duration ?? defaultDurationFrames(def, seq),
		track: opts.trackId ?? targetVideoTrack(seq, opts.view),
		template: { id: def.id, version: def.version },
		params: { ...def.defaults },
	} as Command;
	return { command, label: `Add ${def.name}` };
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
	const plan = planMotionTemplateInsert(session.getCommitted(), sequenceId, template, {
		at,
		view: state.views[sequenceId] ?? null,
		trackId: opts.trackId,
	});
	const result = session.apply({ label: plan.label, origin: 'user', sequenceId, commands: [plan.command] });
	if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('; ') || 'Insert failed');
	const clipId = (result.results[0] as { clipId?: string } | undefined)?.clipId ?? result.created[0];
	if (!clipId) throw new Error('Insert produced no clip');
	session.select('timeline', [clipId], 'replace');
	return clipId;
}
