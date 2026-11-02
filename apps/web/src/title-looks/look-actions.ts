// Spec 19 TL-089 / TL-097: actions on the look of the selection and on the project's looks, shared by Properties, the
// Graphics menu and the command palette. Each is one transaction = one History entry; refusals are toasts.
import {
	type Command,
	FACTORY_COLORWAYS,
	MAX_TITLE_LOOK_NAME,
	type TitleLook,
	titleLookOf,
	titleLooksOf,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { confirmDialog, toast } from '@jasper/ui';
import { promptName } from '../gaps/SmallDialogs.tsx';
import { t } from '../i18n/runtime.ts';
import { clipsLinkedTo, lookTargets } from './actions.ts';
import { type LookedClip, lookedClip } from './selection.ts';

function run(session: EditorSession, label: string, commands: Command[]): boolean {
	if (commands.length === 0) return false;
	const r = session.apply({ label, origin: 'user', commands });
	if (!r.ok)
		toast({
			kind: 'error',
			title: t('{0} refused', label),
			detail: r.errors.map((e) => e.message).join('; '),
		});
	return r.ok;
}

/** The selected clips wearing a look. */
export function lookedTargets(session: EditorSession): LookedClip[] {
	return lookTargets(session)
		.map(lookedClip)
		.filter((x): x is LookedClip => !!x);
}

const ids = (l: readonly LookedClip[]) => l.map((x) => x.clip.id);
const linked = (l: readonly LookedClip[]) => l.filter((x) => x.appearance.lookId !== undefined);

export function removeLook(session: EditorSession): boolean {
	const l = lookedTargets(session);
	return run(session, 'Remove Look', l.length ? [{ type: 'look.remove', clipIds: ids(l) } as Command] : []);
}

export function detachLook(session: EditorSession): boolean {
	const l = linked(lookedTargets(session));
	return run(session, 'Detach from Look', l.length ? [{ type: 'look.detach', clipIds: ids(l) } as Command] : []);
}

/** Back to the look: overrides, removed layers and Intensity. Keys on replaced params go, and the count is announced. */
export function resetLook(session: EditorSession, layerIds?: readonly string[]): boolean {
	const l = linked(lookedTargets(session));
	if (l.length === 0) return false;
	const r = session.apply({
		label: layerIds ? 'Reset Look Layer' : 'Reset Look',
		origin: 'user',
		commands: [{ type: 'look.reset', clipIds: ids(l), ...(layerIds ? { layerIds: [...layerIds] } : {}) } as Command],
	});
	if (!r.ok) {
		toast({ kind: 'error', title: t('Reset refused'), detail: r.errors.map((e) => e.message).join('; ') });
		return false;
	}
	const dropped = (r.results[0] as { droppedKeyframes?: number } | undefined)?.droppedKeyframes ?? 0;
	if (dropped > 0)
		toast({
			kind: 'info',
			title: dropped === 1 ? t('Reset removed 1 keyframe.') : t('Reset removed {0} keyframes.', dropped),
		});
	return true;
}

/** A free look name near `base`. */
function freeName(looks: readonly TitleLook[], base: string): string {
	const used = new Set(looks.map((l) => l.name.toLowerCase()));
	if (!used.has(base.toLowerCase())) return base;
	for (let i = 2; ; i++) if (!used.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

const nameProblem = (session: EditorSession, name: string, except?: string): string | null => {
	const n = name.trim();
	if (!n) return t('Give the look a name.');
	const taken = titleLooksOf(session.getCommitted()).some(
		(l) => l.id !== except && l.name.toLowerCase() === n.toLowerCase(),
	);
	return taken ? t('A look named “{0}” already exists.', n) : null;
};

/** Save Look…: names a project look made from the primary look and links the clip to it. */
export async function saveLook(session: EditorSession): Promise<void> {
	const source = lookedTargets(session)[0];
	if (!source) {
		toast({ kind: 'info', title: 'Select a clip with a look first' });
		return;
	}
	const name = await promptName({
		title: 'Save Look',
		label: 'Name',
		initial: freeName(titleLooksOf(session.getCommitted()), 'My Look'),
		primaryLabel: 'Save',
		maxLength: MAX_TITLE_LOOK_NAME,
		validate: (n) => nameProblem(session, n),
	});
	if (!name) return;
	run(session, 'Save Look', [
		{ type: 'look.create', name, fromClipId: source.clip.id, link: true } as Command,
	]);
}

/** Redefines a project look from a clip: every linked clip follows, keeping its own overrides (TL-016). */
export function updateProjectLook(session: EditorSession, lookId: string, clipId: string): boolean {
	return run(session, 'Update Look', [{ type: 'look.update', lookId, fromClipId: clipId } as Command]);
}

export async function renameProjectLook(session: EditorSession, lookId: string): Promise<void> {
	const look = titleLookOf(session.getCommitted(), lookId);
	if (!look) return;
	const name = await promptName({
		title: 'Rename Look',
		label: 'Name',
		initial: look.name,
		primaryLabel: 'Rename',
		maxLength: MAX_TITLE_LOOK_NAME,
		validate: (n) => nameProblem(session, n, lookId),
	});
	if (!name || name === look.name) return;
	run(session, 'Rename Look', [{ type: 'look.rename', lookId, name } as Command]);
}

/** Delete…: clips keep their values and only lose the link (TL-015). Undoable. */
export async function deleteProjectLook(session: EditorSession, lookId: string): Promise<void> {
	const doc = session.getCommitted();
	const look = titleLookOf(doc, lookId);
	if (!look) return;
	const uses = clipsLinkedTo(doc, lookId);
	const ok = await confirmDialog({
		title: t('Delete the look “{0}”?', look.name),
		body:
			uses === 0
				? t('No clip is linked to it. You can undo this.')
				: uses === 1
					? t('1 linked clip keeps how it looks and is detached. You can undo this.')
					: t('{0} linked clips keep how they look and are detached. You can undo this.', uses),
		confirmLabel: 'Delete Look',
	});
	if (!ok) return;
	run(session, 'Delete Look', [{ type: 'look.delete', lookId } as Command]);
}

/** Colourways a selection can cycle through: the look's own, then the library's. */
export function colorwaysFor(look: TitleLook | null): readonly { id: string; name: string; palette: object }[] {
	const seen = new Set<string>();
	const out: { id: string; name: string; palette: object }[] = [];
	for (const c of [...(look?.colorways ?? []), ...FACTORY_COLORWAYS]) {
		if (seen.has(c.id)) continue;
		seen.add(c.id);
		out.push(c);
	}
	return out;
}
