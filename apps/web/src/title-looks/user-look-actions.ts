// Spec 19 TL-054: actions on My Looks, the user's own looks kept by the engine, shared by the Looks tab, the Graphics menu
// and the palette. They change a file outside the project, so they are not History entries: deleting asks first, and every
// outcome is said in a toast or the tab's status line. When the engine cannot take them, they say why instead.
import {
	MAX_TITLE_LOOK_NAME,
	recipeFromAppearance,
	type TitleLook,
	titleLookOf,
	type UserLook,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { confirmDialog, toast } from '@jasper/ui';
import { promptName } from '../gaps/SmallDialogs.tsx';
import { t } from '../i18n/runtime.ts';
import { lookedTargets } from './look-actions.ts';
import {
	currentUserLooks,
	deleteUserLook,
	exportUserLookBundle,
	importUserLookFile,
	renameUserLook,
	saveUserLook,
	type UserLookInit,
	userLooksUnavailable,
} from './user-library.ts';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Why the name cannot be used in My Looks, or null. */
export function userLookNameProblem(
	name: string,
	looks: readonly Pick<UserLook, 'id' | 'name'>[],
	except?: string,
): string | null {
	const n = name.trim();
	if (!n) return t('Give the look a name.');
	const taken = looks.some((l) => l.id !== except && l.name.toLowerCase() === n.toLowerCase());
	return taken ? t('A look named “{0}” already exists.', n) : null;
}

/** A free name near `base` among `looks`. */
export function freeUserLookName(looks: readonly Pick<UserLook, 'name'>[], base: string): string {
	const used = new Set(looks.map((l) => l.name.toLowerCase()));
	if (!used.has(base.toLowerCase())) return base;
	for (let i = 2; ; i++) if (!used.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

/**
 * What My Looks stores for the look of the primary selected clip: its values at the clip's first frame, as Save Look
 * takes them (TL-015: keyframes stay on clips), with the tags, category and colourways of the look it is linked to.
 */
export function userLookFromSelection(session: EditorSession): UserLookInit | null {
	const source = lookedTargets(session)[0];
	if (!source) return null;
	const doc = session.getCommitted();
	const linked: TitleLook | null = source.appearance.lookId
		? titleLookOf(doc, source.appearance.lookId)
		: null;
	return {
		name: linked?.name ?? 'My Look',
		recipe: recipeFromAppearance(source.appearance, 0),
		...(linked?.tags?.length ? { tags: [...linked.tags] } : {}),
		...(linked?.category ? { category: linked.category } : {}),
		...(linked?.colorways?.length ? { colorways: structuredClone(linked.colorways) } : {}),
	};
}

/** Why Save to My Looks is unavailable now, or undefined. */
export function saveToMyLooksDisabled(session: EditorSession | null): string | undefined {
	if (!session || lookedTargets(session).length === 0) return t('Select a clip with a look first.');
	return userLooksUnavailable() ?? undefined;
}

/** Save to My Looks…: names the selected clip's look and stores it with the engine, for every project. */
export async function saveToMyLooks(session: EditorSession): Promise<UserLook | null> {
	const why = saveToMyLooksDisabled(session);
	if (why) {
		toast({ kind: 'info', title: why });
		return null;
	}
	const init = userLookFromSelection(session)!;
	const name = await promptName({
		title: 'Save to My Looks',
		label: 'Name',
		initial: freeUserLookName(currentUserLooks(), init.name),
		primaryLabel: 'Save',
		maxLength: MAX_TITLE_LOOK_NAME,
		validate: (n) => userLookNameProblem(n, currentUserLooks()),
	});
	if (!name) return null;
	try {
		const saved = await saveUserLook({ ...init, name: name.trim() });
		toast({ kind: 'success', title: t('Saved “{0}” to My Looks.', saved.name) });
		return saved;
	} catch (e) {
		toast({ kind: 'error', title: t('The look could not be saved to My Looks.'), detail: message(e) });
		return null;
	}
}

export async function renameMyLook(look: Pick<UserLook, 'id' | 'name'>): Promise<boolean> {
	const why = userLooksUnavailable();
	if (why) {
		toast({ kind: 'info', title: why });
		return false;
	}
	const name = await promptName({
		title: 'Rename Look',
		label: 'Name',
		initial: look.name,
		primaryLabel: 'Rename',
		maxLength: MAX_TITLE_LOOK_NAME,
		validate: (n) => userLookNameProblem(n, currentUserLooks(), look.id),
	});
	if (!name || name.trim() === look.name) return false;
	try {
		await renameUserLook(look.id, name.trim());
		return true;
	} catch (e) {
		toast({ kind: 'error', title: t('The look could not be renamed.'), detail: message(e) });
		return false;
	}
}

/** Delete…: My Looks has no undo, so it asks. Projects that use the look keep their own copy (TL-015). */
export async function deleteMyLook(look: Pick<UserLook, 'id' | 'name'>): Promise<boolean> {
	const why = userLooksUnavailable();
	if (why) {
		toast({ kind: 'info', title: why });
		return false;
	}
	const ok = await confirmDialog({
		title: t('Delete “{0}” from My Looks?', look.name),
		body: t('Titles that use it keep how they look. This cannot be undone.'),
		confirmLabel: 'Delete Look',
		danger: true,
	});
	if (!ok) return false;
	try {
		await deleteUserLook(look.id);
		return true;
	} catch (e) {
		toast({ kind: 'error', title: t('The look could not be deleted.'), detail: message(e) });
		return false;
	}
}

function pickJsonFile(): Promise<string | null> {
	return new Promise((resolve) => {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = '.json,application/json';
		input.onchange = () => {
			const f = input.files?.[0];
			if (!f) resolve(null);
			else void f.text().then(resolve, () => resolve(null));
		};
		input.oncancel = () => resolve(null);
		input.click();
	});
}

/** Import…: a `.json` of looks into My Looks. Answers what happened, or null when nothing was picked. */
export async function importMyLooks(text?: string): Promise<{ ok: boolean; message: string } | null> {
	const why = userLooksUnavailable();
	if (why) return { ok: false, message: why };
	const raw = text ?? (await pickJsonFile());
	if (raw === null) return null;
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return { ok: false, message: t('The file is not valid JSON.') };
	}
	try {
		const r = await importUserLookFile(json);
		const n = r.looks.length;
		const added = n === 1 ? t('Imported 1 look.') : t('Imported {0} looks.', n);
		if (!r.errors.length) return { ok: true, message: added };
		return {
			ok: true,
			message: t('{0} {1} skipped: {2}', added, r.errors.length, r.errors[0]!.message),
		};
	} catch (e) {
		return { ok: false, message: t('Nothing was imported: {0}', message(e)) };
	}
}

const fileName = (name: string) => `${name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'looks'}.json`;

/** Export…: these looks (all when `ids` is absent) as one `.json` bundle, the format Import… and agents read. */
export async function exportMyLooks(
	ids: readonly string[] | undefined,
	name: string,
): Promise<{ ok: boolean; message: string }> {
	try {
		const bundle = await exportUserLookBundle(ids);
		const url = URL.createObjectURL(
			new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }),
		);
		const a = document.createElement('a');
		a.href = url;
		a.download = fileName(name);
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
		const n = bundle.looks.length;
		return { ok: true, message: n === 1 ? t('Exported 1 look.') : t('Exported {0} looks.', n) };
	} catch (e) {
		return { ok: false, message: t('The looks could not be exported: {0}', message(e)) };
	}
}
