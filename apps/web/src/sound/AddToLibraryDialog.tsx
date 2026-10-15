// Clip ▸ Audio Options ▸ Add to Sound Library… (spec 12 §2.7, "other audio"): the folder the clip's media file lives
// in becomes a Sound Library folder (Preferences ▸ Sound Library), with the licence the user declares for it, and the
// engine indexes it. Decision: the file is not copied — the library indexes folders in place (WP1.2), so adding the
// folder is the only way that keeps one source of truth; a media without a local path (a browser upload, an
// engine-store copy) cannot be added and the entry says why. A folder already in the library is rescanned instead.
import { SOUND_ROOT_LICENSES, type SoundRoot } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import type { MediaAsset } from '@jasper/project';
import { Dialog, type HostedDialogProps, registerDialog, Select, TextField } from '@jasper/ui';
import { useEffect, useState } from 'react';
import type { ToastRequest } from '../commands/types.ts';
import { useDialogClose } from '../extensions/dialog.ts';
import { t } from '../i18n/runtime.ts';
import { ROOT_LICENSE_LABELS } from './PreferencesPage.tsx';

export const ADD_TO_LIBRARY_DIALOG = 'sound.addToLibrary';

type RootLicense = (typeof SOUND_ROOT_LICENSES)[number];

/** The local file path of a media (its `path` locator), or null. */
export function mediaFilePath(asset: Pick<MediaAsset, 'locators'> | undefined): string | null {
	for (const l of asset?.locators ?? []) if (l.type === 'path' && l.path) return l.path;
	return null;
}

/** The folder of a file path (either separator), or null for a bare name. */
export function folderOf(path: string): string | null {
	const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	if (i <= 0) return i === 0 ? path.slice(0, 1) : null;
	return path.slice(0, i);
}

const norm = (p: string) =>
	p
		.replace(/[\\/]+$/, '')
		.replace(/\\/g, '/')
		.toLowerCase();

/** The library folder that already holds `folder` (the same or a parent), or null. */
export function rootHolding(roots: readonly SoundRoot[], folder: string): SoundRoot | null {
	const f = norm(folder);
	return roots.find((r) => f === norm(r.path) || f.startsWith(`${norm(r.path)}/`)) ?? null;
}

type Props = {
	engine: Pick<EngineClient, 'getSoundRoots' | 'putSoundRoots' | 'indexSounds'>;
	folder: string;
	toast(r: ToastRequest): void;
};

export function AddToLibraryDialog(props: HostedDialogProps<Props>) {
	const { open, finish } = useDialogClose(props.close);
	const [roots, setRoots] = useState<SoundRoot[] | null>(null);
	const [local, setLocal] = useState(true);
	const [license, setLicense] = useState<RootLicense>('LicenseRef-UserProvided');
	const [author, setAuthor] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		let off = false;
		props.engine
			.getSoundRoots()
			.then((r) => {
				if (off) return;
				setRoots(r.roots);
				setLocal(r.local);
			})
			.catch((e) => !off && setError(e instanceof Error ? e.message : String(e)));
		return () => {
			off = true;
		};
	}, [props.engine]);
	const holding = roots ? rootHolding(roots, props.folder) : null;
	const submit = async () => {
		if (!roots) return;
		setBusy(true);
		setError(null);
		try {
			if (holding) {
				await props.engine.indexSounds({});
				props.toast({
					kind: 'info',
					message: t('The folder is already in the Sound Library'),
					detail: t('Rescanning {0}', holding.label || holding.path),
				});
			} else {
				const label = props.folder.split(/[\\/]/).filter(Boolean).at(-1) ?? props.folder;
				await props.engine.putSoundRoots({
					roots: [
						...roots.map((r) => ({
							id: r.id,
							path: r.path,
							label: r.label,
							license: r.license,
							...(r.attributionTemplate ? { attributionTemplate: r.attributionTemplate } : {}),
							...(r.author ? { author: r.author } : {}),
							enabled: r.enabled,
						})),
						{
							path: props.folder,
							label,
							license,
							...(author.trim() ? { author: author.trim() } : {}),
							enabled: true,
						},
					],
				});
				props.toast({
					kind: 'success',
					message: t('Added {0} to the Sound Library', label),
					detail: t('Its sounds appear when the indexing job ends (Jobs panel).'),
				});
			}
			finish();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => !o && finish()}
			title="Add to Sound Library"
			size="medium"
			primaryLabel={holding ? 'Rescan Folder' : 'Add Folder'}
			primaryDisabled={!roots || busy || !local}
			onPrimary={() => void submit()}
			data-testid="sound-add-to-library-dialog"
		>
			<div className="flex flex-col gap-2 text-pr-ui">
				<p className="text-pr-muted">
					The Sound Library indexes folders in place. This adds the folder of the clip’s file, with every
					sound in it:
				</p>
				<p className="break-all text-pr-text" data-testid="sound-add-folder-path">
					{props.folder}
				</p>
				{!local ? (
					<p className="text-pr-warning">Folders can only be added on a local engine.</p>
				) : holding ? (
					<p className="text-pr-muted">
						{t('It is already in the library as “{0}”: it will be rescanned.', holding.label || holding.path)}
					</p>
				) : (
					<>
						<Select
							label="Licence of these sounds"
							value={license}
							onValueChange={(v) => setLicense(v as RootLicense)}
							options={SOUND_ROOT_LICENSES.map((v) => ({ value: v, label: ROOT_LICENSE_LABELS[v] }))}
						/>
						<label className="flex items-center gap-2">
							<span className="w-[110px] shrink-0 text-pr-muted">Author</span>
							<TextField
								className="min-w-0 flex-1"
								value={author}
								onChange={(e) => setAuthor(e.currentTarget.value)}
								placeholder="Optional"
							/>
						</label>
						<p className="text-pr-small text-pr-dim">
							Sounds of an undeclared folder are flagged and hidden by Commercial-safe until you declare a
							licence.
						</p>
					</>
				)}
				{error ? <p className="text-pr-danger">{error}</p> : null}
			</div>
		</Dialog>
	);
}

let registered = false;
export function registerAddToLibraryDialog(): void {
	if (registered) return;
	registered = true;
	registerDialog(ADD_TO_LIBRARY_DIALOG, AddToLibraryDialog);
}
