// "Save Preset" dialog (S03:FX-030, EC-004; Premiere's Save Preset): Name, Type (Scale / Anchor to In Point /
// Anchor to Out Point, which decides how key times map onto clips of other lengths) and Description, plus the
// preset bin when the user has bins. Also "Preset Properties" (rename, retype, re-describe a saved preset). The
// preset goes to the user library on the engine; nothing in the project changes, so there is no History entry.
import {
	buildEffectPreset,
	EFFECT_PRESET_TYPE_LABELS,
	EFFECT_PRESET_TYPES,
	type EffectPreset,
	type EffectPresetFolder,
	type EffectPresetType,
	PresetBuildError,
	type PresetSections,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { Dialog, type HostedDialogProps, registerDialog, Select, TextField } from '@jasper/ui';
import { useId, useState } from 'react';
import { presetLibrary, savePreset, updatePreset } from './store.ts';

export const SAVE_PRESET_DIALOG = 'effects.savePreset';

export type SavePresetDialogProps =
	| {
			mode: 'create';
			session: EditorSession;
			clipId: string;
			sections: PresetSections;
			/** What is being saved, e.g. "Motion, Gaussian Blur". */
			subject: string;
			defaultName?: string;
	  }
	| { mode: 'edit'; preset: EffectPreset };

const TYPE_HINTS: Record<EffectPresetType, string> = {
	scale: 'Keyframes stretch to the length of the target clip.',
	'anchor-in': 'Keyframes keep their distance from the In point of the target clip.',
	'anchor-out': 'Keyframes keep their distance from the Out point of the target clip.',
};

const ROOT = '__root__';

/** "Bin / Sub-bin" labels for the bin picker, parents first. */
function binOptions(folders: readonly EffectPresetFolder[]) {
	const path = (f: EffectPresetFolder): string => {
		const parent = f.parentId ? folders.find((x) => x.id === f.parentId) : undefined;
		return parent ? `${path(parent)} / ${f.name}` : f.name;
	};
	return [
		{ value: ROOT, label: 'Presets' },
		...folders
			.map((f) => ({ value: f.id, label: `Presets / ${path(f)}` }))
			.sort((a, b) => a.label.localeCompare(b.label)),
	];
}

export function SavePresetDialog(props: HostedDialogProps<SavePresetDialogProps>) {
	const edit = props.mode === 'edit' ? props.preset : null;
	const [open, setOpen] = useState(true);
	const [name, setName] = useState(
		edit?.name ?? (props.mode === 'create' ? (props.defaultName ?? props.subject) : ''),
	);
	const [type, setType] = useState<EffectPresetType>(edit?.type ?? 'scale');
	const [description, setDescription] = useState(edit?.description ?? '');
	const folders = presetLibrary().getState().folders;
	const [bin, setBin] = useState<string>(edit?.folderId ?? ROOT);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const ids = useId();

	const finish = (result?: unknown) => {
		setOpen(false);
		props.close(result);
	};
	const submit = async () => {
		const trimmed = name.trim();
		if (!trimmed) {
			setError('Enter a name for the preset.');
			return false;
		}
		setBusy(true);
		setError(null);
		try {
			const folderId = bin === ROOT ? null : bin;
			if (props.mode === 'edit') {
				const saved = await updatePreset(props.preset.id, {
					name: trimmed,
					type,
					description,
					...(folderId !== (props.preset.folderId ?? null) ? { folderId } : {}),
				});
				finish(saved);
				return false;
			}
			const preset = buildEffectPreset(props.session.getCommitted(), props.clipId, {
				name: trimmed,
				type,
				description,
				sections: props.sections,
			});
			finish(await savePreset(preset, folderId));
			return false;
		} catch (e) {
			setError(
				e instanceof PresetBuildError ? e.message : `Could not save the preset: ${(e as Error).message}`,
			);
			return false;
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(o) => {
				if (!o) finish();
			}}
			title={edit ? 'Preset Properties' : 'Save Preset'}
			description="Name, type and description of an effect preset"
			size="medium"
			primaryLabel="OK"
			primaryDisabled={busy || !name.trim()}
			onPrimary={submit}
			data-testid="save-preset-dialog"
		>
			<div className="flex flex-col gap-3 text-pr-ui">
				{props.mode === 'create' ? (
					<p className="text-pr-muted" data-testid="save-preset-subject">
						{props.subject}
					</p>
				) : null}
				<div className="flex items-center gap-2">
					<label htmlFor={`${ids}-name`} className="w-[92px] shrink-0 text-pr-muted">
						Name
					</label>
					<TextField
						id={`${ids}-name`}
						value={name}
						maxLength={120}
						onChange={(e) => setName(e.target.value)}
						className="flex-1"
						data-testid="save-preset-name"
					/>
				</div>
				{folders.length ? (
					<div className="flex items-center gap-2">
						<label htmlFor={`${ids}-bin`} className="w-[92px] shrink-0 text-pr-muted">
							Bin
						</label>
						<Select
							id={`${ids}-bin`}
							value={bin}
							onValueChange={setBin}
							options={binOptions(folders)}
							label="Preset bin"
							className="flex-1"
						/>
					</div>
				) : null}
				<fieldset className="m-0 flex flex-col gap-1 border-0 p-0" aria-label="Preset type">
					<legend className="mb-1 text-pr-muted">Type</legend>
					{EFFECT_PRESET_TYPES.map((t) => (
						<label
							key={t}
							className="flex cursor-pointer items-start gap-2 text-pr-text"
							data-testid={`save-preset-type-${t}`}
						>
							<input
								type="radio"
								name={`${ids}-type`}
								checked={type === t}
								onChange={() => setType(t)}
								className="mt-[3px] size-[12px] accent-[var(--pr-accent)]"
							/>
							<span className="flex flex-col">
								<span>{EFFECT_PRESET_TYPE_LABELS[t]}</span>
								<span className="text-pr-small text-pr-muted">{TYPE_HINTS[t]}</span>
							</span>
						</label>
					))}
				</fieldset>
				<div className="flex flex-col gap-1">
					<label htmlFor={`${ids}-desc`} className="text-pr-muted">
						Description
					</label>
					<textarea
						id={`${ids}-desc`}
						value={description}
						maxLength={2000}
						onChange={(e) => setDescription(e.target.value)}
						className="h-16 w-full resize-y rounded-pr-control border border-transparent bg-pr-field px-2 py-1 font-pr text-pr-ui text-pr-text hover:border-pr-border-strong focus:border-pr-focus focus:outline-none"
						data-testid="save-preset-description"
					/>
				</div>
				{error ? (
					<p className="text-pr-small text-pr-danger" role="alert" data-testid="save-preset-error">
						{error}
					</p>
				) : null}
			</div>
		</Dialog>
	);
}

registerDialog(SAVE_PRESET_DIALOG, SavePresetDialog);
