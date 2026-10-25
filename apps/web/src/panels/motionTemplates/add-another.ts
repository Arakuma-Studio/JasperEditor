// "Add another" (social-comments design §7.9; docs/wp-notes/social-comments.md "Add another & bulk import"): a copy of
// each selected motion-graphic clip right after it, never overwriting, with the params its template re-randomizes
// (`ui.addAnother.reroll`, e.g. a comment's identity and stats) refilled from a fresh seed — one
// `clip.duplicateMotionGraphic` per clip in ONE transaction (one undo step). Shared by the timeline clip menu, the
// Properties ▸ Template section, the Motion Templates panel, the Graphics menu and the command palette (`mg.addAnother`).
import { type Clip, type Command, mgItemSeed } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { t } from '../../i18n/runtime.ts';

type MgClip = Extract<Clip, { kind: 'motion-graphic' }>;

/** A random uint32 seed (the command stores it, so the result is reproducible). */
export function randomSeed(): number {
	const c = globalThis.crypto;
	if (c?.getRandomValues) return c.getRandomValues(new Uint32Array(1))[0]!;
	return Math.floor(Math.random() * 0x1_0000_0000) >>> 0;
}

/** The motion-graphic clips among `clipIds` (default: the timeline selection) in the active sequence. */
export function addAnotherTargets(session: EditorSession, clipIds?: readonly string[]): MgClip[] {
	const state = session.getState();
	const seqId = state.activeSequenceId;
	const seq = seqId ? session.getCommitted().sequences[seqId] : undefined;
	if (!seq) return [];
	const ids = clipIds ?? state.selection.timeline.clips;
	return ids.map((id) => seq.clips[id]).filter((c): c is MgClip => c?.kind === 'motion-graphic');
}

/** Why Add another is unavailable for the selection (undefined when it can run). */
export function addAnotherDisabledReason(session: EditorSession | null): string | undefined {
	if (!session) return t('Open a project first');
	if (session.getState().readOnly) return t('The project is read-only');
	if (addAnotherTargets(session).length === 0) return t('Select a motion-graphic clip');
	const reg = session.ctx.registries.mgTemplates;
	if (addAnotherTargets(session).every((c) => !reg.get(c.template.id, c.template.version)))
		return t('The template of the selected clip is not installed');
	return undefined;
}

export type AddAnotherResult = { ok: true; clipIds: string[] } | { ok: false; message: string };

/**
 * Adds another copy of each target clip (default: the selected motion-graphic clips) after it, selects the copies and
 * returns their ids. One History entry ("Add Another").
 */
export function addAnotherMotionGraphics(
	session: EditorSession,
	opts: { clipIds?: readonly string[]; seed?: number } = {},
): AddAnotherResult {
	if (session.getState().readOnly) return { ok: false, message: 'The project is read-only' };
	const targets = addAnotherTargets(session, opts.clipIds);
	if (targets.length === 0) return { ok: false, message: 'Select a motion-graphic clip' };
	const sequenceId = session.getState().activeSequenceId!;
	const seed = (opts.seed ?? randomSeed()) >>> 0;
	const commands = targets.map(
		(c, i) =>
			({
				type: 'clip.duplicateMotionGraphic',
				clipId: c.id,
				seed: mgItemSeed(seed, i),
			}) as Command,
	);
	const result = session.apply({ label: 'Add Another', origin: 'user', sequenceId, commands });
	if (!result.ok)
		return { ok: false, message: result.errors.map((e) => e.message).join('; ') || 'Add another failed' };
	const clipIds = (result.results as { clipId?: string }[])
		.map((r) => r.clipId)
		.filter((id): id is string => !!id);
	if (clipIds.length) session.select('timeline', clipIds, 'replace');
	return { ok: true, clipIds };
}
