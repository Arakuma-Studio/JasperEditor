// Effect preset actions shared by the Effects panel (Presets bin) and Effect Controls (Save Preset…): the dialogs,
// confirmations, and Import… / Export… of `.json` files (the format agents use too, S03:FX-030 / AGT-020).
import {
	buildPresetBundle,
	type EffectPreset,
	type EffectPresetFolder,
	type PresetSections,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { confirmDialog, openDialog } from '@jasper/ui';
import { PRESET_BIN_DIALOG, type PresetBinDialogProps } from './PresetBinDialog.tsx';
import { SAVE_PRESET_DIALOG, type SavePresetDialogProps } from './SavePresetDialog.tsx';
import {
	createPresetBin,
	deletePreset,
	deletePresetBin,
	importPresetFile,
	presetLibrary,
	renamePresetBin,
	updatePreset,
} from './store.ts';

export function openSavePreset(
	session: EditorSession,
	clipId: string,
	sections: PresetSections,
	subject: string,
	defaultName?: string,
): Promise<EffectPreset | undefined> {
	const props: SavePresetDialogProps = {
		mode: 'create',
		session,
		clipId,
		sections,
		subject,
		...(defaultName ? { defaultName } : {}),
	};
	return openDialog<EffectPreset>(SAVE_PRESET_DIALOG, props);
}

export function openPresetProperties(preset: EffectPreset): Promise<EffectPreset | undefined> {
	const props: SavePresetDialogProps = { mode: 'edit', preset };
	return openDialog<EffectPreset>(SAVE_PRESET_DIALOG, props);
}

async function askName(props: PresetBinDialogProps): Promise<string | undefined> {
	return openDialog<string>(PRESET_BIN_DIALOG, props);
}

export async function newPresetBin(parentId: string | null): Promise<EffectPresetFolder | null> {
	const name = await askName({ title: 'New Preset Bin', confirmLabel: 'Create' });
	return name ? createPresetBin(name, parentId) : null;
}

export async function renameBin(folder: EffectPresetFolder): Promise<boolean> {
	const name = await askName({ title: 'Rename Bin', initial: folder.name, confirmLabel: 'Rename' });
	if (!name || name === folder.name) return false;
	await renamePresetBin(folder.id, name);
	return true;
}

export async function renamePreset(preset: EffectPreset): Promise<boolean> {
	const name = await askName({ title: 'Rename Preset', initial: preset.name, confirmLabel: 'Rename' });
	if (!name || name === preset.name) return false;
	await updatePreset(preset.id, { name });
	return true;
}

/** Library deletes are not undoable (they are not project edits): confirm first (S05:DG-007). */
export async function confirmDeletePreset(preset: EffectPreset): Promise<boolean> {
	const ok = await confirmDialog({
		title: `Delete preset “${preset.name}”?`,
		body: 'The preset is removed from your library in every project. This cannot be undone. Clips it was applied to keep their effects.',
		confirmLabel: 'Delete Preset',
		danger: true,
	});
	if (ok) await deletePreset(preset.id);
	return ok;
}

export async function confirmDeleteBin(folder: EffectPresetFolder): Promise<boolean> {
	const { folders, presets } = presetLibrary().getState();
	const inside = new Set([folder.id]);
	for (let grew = true; grew; ) {
		grew = false;
		for (const f of folders)
			if (f.parentId && inside.has(f.parentId) && !inside.has(f.id)) {
				inside.add(f.id);
				grew = true;
			}
	}
	const n = presets.filter((p) => p.folderId && inside.has(p.folderId)).length;
	const ok = await confirmDialog({
		title: `Delete bin “${folder.name}”?`,
		body:
			n > 0
				? `The bin and the ${n} preset${n === 1 ? '' : 's'} inside it are removed from your library. This cannot be undone.`
				: 'The empty bin is removed from your library.',
		confirmLabel: 'Delete Bin',
		danger: n > 0,
	});
	if (ok) await deletePresetBin(folder.id);
	return ok;
}

const fileName = (name: string) => `${name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'presets'}.json`;

/** Export…: one `.json` bundle of the presets (with the bins they sit in). */
export function exportPresets(presets: readonly EffectPreset[], name: string): void {
	const bundle = buildPresetBundle(presets, presetLibrary().getState().folders, new Date().toISOString());
	const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
	const a = document.createElement('a');
	a.href = url;
	a.download = fileName(name);
	a.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
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
		input.click();
	});
}

/** Import…: reads a `.json` preset file into the library (bin `folderId`); answers a status line. */
export async function importPresets(folderId: string | null, text?: string): Promise<string | null> {
	const raw = text ?? (await pickJsonFile());
	if (raw === null) return null;
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return 'The file is not valid JSON.';
	}
	const r = await importPresetFile(json, folderId);
	const n = r.presets.length;
	return `Imported ${n} preset${n === 1 ? '' : 's'}${r.errors.length ? ` (${r.errors.length} skipped: ${r.errors[0]!.message})` : ''}.`;
}
