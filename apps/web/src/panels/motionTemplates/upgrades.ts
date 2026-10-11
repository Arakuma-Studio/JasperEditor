import type { Clip, Command, MgTemplateRegistry } from '@jasper/project';
import type { EditorSession } from '@jasper/session';

/** The version a clip's template can be upgraded to (null when there is no upgrade path). */
export function templateUpgradeFor(reg: MgTemplateRegistry, clip: Clip | undefined): number | null {
	if (clip?.kind !== 'motion-graphic') return null;
	const up = reg.upgrade?.(clip.template.id, clip.template.version, { ...clip.params }) ?? null;
	return up && reg.get(clip.template.id, up.version) ? up.version : null;
}

/** True when one of `clipIds` (any sequence) has a template upgrade. */
export function hasTemplateUpgrade(session: EditorSession, clipIds: readonly string[]): boolean {
	const reg = session.ctx.registries.mgTemplates;
	const seqs = Object.values(session.store.getState().document.sequences);
	return clipIds.some((id) => seqs.some((seq) => templateUpgradeFor(reg, seq.clips[id]) !== null));
}

/**
 * Upgrades the templates of `clipIds` (those with an upgrade path) in one transaction — one undo step — through
 * `clip.update {template: {version}}`. Returns the number of clips upgraded, or an error message.
 */
export function updateTemplates(
	session: EditorSession,
	clipIds: readonly string[],
): { ok: true; updated: number } | { ok: false; message: string } {
	const state = session.store.getState();
	const reg = session.ctx.registries.mgTemplates;
	const commands: Command[] = [];
	const names = new Set<string>();
	for (const seq of Object.values(state.document.sequences)) {
		for (const id of clipIds) {
			const clip = seq.clips[id];
			const to = templateUpgradeFor(reg, clip);
			if (to === null || clip?.kind !== 'motion-graphic') continue;
			commands.push({ type: 'clip.update', clipId: id, patch: { template: { version: to } } });
			names.add(reg.get(clip.template.id, to)?.name ?? clip.template.id);
		}
	}
	if (commands.length === 0) return { ok: false, message: 'No template update is available' };
	const label = `Update Template${names.size === 1 ? ` (${[...names][0]})` : 's'}`;
	const r = session.apply({
		label,
		origin: 'user',
		...(state.activeSequenceId ? { sequenceId: state.activeSequenceId } : {}),
		commands,
	});
	if (!r.ok) return { ok: false, message: r.errors.map((e) => e.message).join('; ') || 'Update failed' };
	return { ok: true, updated: commands.length };
}
