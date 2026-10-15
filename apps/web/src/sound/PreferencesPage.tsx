// Preferences ▸ Sound Library (spec 12 §2.7, P1-R7): your sound folders (indexed in place by the engine, local engines
// only) with a licence declaration per folder, enable / disable, rescan and remove; the library status and reindexing
// (an engine `sound-index` job, also listed in the Jobs panel); and the audition options (audition on hover, loop,
// auto-play, volume) and row density. Folder changes are validated by the engine and saved with "Save Folders".
import {
	SOUND_ROOT_LICENSES,
	type SoundLibraryStatus,
	type SoundRoot,
	type SoundRootsPutRequest,
} from '@jasper/api';
import { EngineError } from '@jasper/engine-client';
import { requiresAttribution } from '@jasper/project';
import { Button, Checkbox, ScrubbyNumber, Select, TextField, Toggle } from '@jasper/ui';
import { useCallback, useEffect, useState } from 'react';
import { t } from '../i18n/runtime.ts';
import { getDesktopBridge } from '../runtime/platform.ts';
import { PrefGroup, PrefRow } from '../shell/preferences/GeneralPage.tsx';
import { useEngine } from '../state/engine.tsx';
import { MAX_AUDITION_DB, MIN_AUDITION_DB, soundLibraryPrefs, useSoundLibraryPrefs } from './prefs.ts';

type RootLicense = (typeof SOUND_ROOT_LICENSES)[number];

export const ROOT_LICENSE_LABELS: Record<RootLicense, string> = {
	'LicenseRef-UserProvided': 'Not declared (flagged in credits)',
	'LicenseRef-UserRoyaltyFree': 'Royalty-free for my use, no attribution',
	'CC0-1.0': 'CC0 1.0 (public domain)',
	'CC-BY-3.0': 'CC BY 3.0 (attribution required)',
	'CC-BY-4.0': 'CC BY 4.0 (attribution required)',
	'CC-BY-SA-3.0': 'CC BY-SA 3.0 (attribution, share-alike)',
	'CC-BY-SA-4.0': 'CC BY-SA 4.0 (attribution, share-alike)',
};

const LICENSE_OPTIONS = SOUND_ROOT_LICENSES.map((v) => ({ value: v, label: ROOT_LICENSE_LABELS[v] }));

/** A folder being edited (new ones have no id yet). */
type DraftRoot = {
	id?: string;
	path: string;
	label: string;
	license: RootLicense;
	attributionTemplate: string;
	author: string;
	enabled: boolean;
};

const draftOf = (r: SoundRoot): DraftRoot => ({
	id: r.id,
	path: r.path,
	label: r.label,
	license: r.license,
	attributionTemplate: r.attributionTemplate ?? '',
	author: r.author ?? '',
	enabled: r.enabled,
});

/** The `PUT /api/sounds/roots` body of the edited list (the complete list). */
export function rootsRequest(drafts: readonly DraftRoot[]): SoundRootsPutRequest {
	return {
		roots: drafts.map((d) => ({
			...(d.id ? { id: d.id } : {}),
			path: d.path.trim(),
			...(d.label.trim() ? { label: d.label.trim() } : {}),
			license: d.license,
			...(d.attributionTemplate.trim() ? { attributionTemplate: d.attributionTemplate.trim() } : {}),
			...(d.author.trim() ? { author: d.author.trim() } : {}),
			enabled: d.enabled,
		})),
	};
}

const errorText = (e: unknown) =>
	e instanceof EngineError ? `${e.message} (${e.code})` : e instanceof Error ? e.message : String(e);

export function SoundLibraryPreferencesPage() {
	const p = useSoundLibraryPrefs();
	const { client: engine, subscribe } = useEngine();
	const [status, setStatus] = useState<SoundLibraryStatus | null>(null);
	const [local, setLocal] = useState(true);
	const [saved, setSaved] = useState<DraftRoot[]>([]);
	const [drafts, setDrafts] = useState<DraftRoot[]>([]);
	const [newPath, setNewPath] = useState('');
	const [newLicense, setNewLicense] = useState<RootLicense>('LicenseRef-UserProvided');
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);

	// Every engine call here is answered or caught: a dead engine shows "not available", never an unhandled rejection.
	const refreshStatus = useCallback(
		() =>
			void engine
				.soundLibraryStatus()
				.then(setStatus)
				.catch(() => setStatus(null)),
		[engine],
	);
	const load = useCallback(() => {
		refreshStatus();
		void engine
			.getSoundRoots()
			.then((r) => {
				const d = r.roots.map(draftOf);
				setSaved(d);
				setDrafts(d);
				setLocal(r.local);
			})
			.catch((e) => setMessage({ kind: 'error', text: errorText(e) }));
	}, [engine, refreshStatus]);
	useEffect(() => load(), [load]);
	useEffect(
		() =>
			subscribe((e) => {
				if (e?.type === 'sounds.changed') refreshStatus();
			}),
		[subscribe, refreshStatus],
	);
	const indexing = !!status?.indexing;
	useEffect(() => {
		if (!indexing) return;
		const timer = setInterval(
			() =>
				void engine
					.soundLibraryStatus()
					.then(setStatus)
					.catch(() => undefined),
			1500,
		);
		return () => clearInterval(timer);
	}, [indexing, engine]);

	const dirty = JSON.stringify(saved) !== JSON.stringify(drafts);
	const patch = (i: number, d: Partial<DraftRoot>) =>
		setDrafts((list) => list.map((x, k) => (k === i ? { ...x, ...d } : x)));

	/** Saves the folder list; resolves true when the engine accepted it. */
	const save = async (list: DraftRoot[]): Promise<boolean> => {
		setBusy(true);
		setMessage(null);
		try {
			const r = await engine.putSoundRoots(rootsRequest(list));
			const d = r.roots.map(draftOf);
			setSaved(d);
			setDrafts(d);
			setMessage({
				kind: 'info',
				text: r.job
					? t('Folders saved. Indexing them (see the Jobs panel).')
					: r.removedSounds
						? t('Folders saved. {0} sounds left the library.', r.removedSounds)
						: t('Folders saved.'),
			});
			refreshStatus();
			return true;
		} catch (e) {
			setMessage({ kind: 'error', text: errorText(e) });
			return false;
		} finally {
			setBusy(false);
		}
	};

	const reindex = async (full: boolean) => {
		setMessage(null);
		try {
			await engine.indexSounds(full ? { full: true } : {});
			setMessage({ kind: 'info', text: t('Indexing the sound library (see the Jobs panel).') });
			refreshStatus();
		} catch (e) {
			setMessage({ kind: 'error', text: errorText(e) });
		}
	};

	const desktop = getDesktopBridge();
	const progress = status?.indexing?.progress;

	return (
		<div className="flex flex-col" data-testid="prefs-sound-library">
			<PrefGroup
				title="Library"
				actions={
					<>
						<Button variant="secondary" disabled={indexing} onClick={() => void reindex(false)}>
							Rescan
						</Button>
						<Button variant="quiet" disabled={indexing} onClick={() => void reindex(true)}>
							Full Rescan
						</Button>
					</>
				}
			>
				<p className="text-pr-muted" data-testid="sound-prefs-status">
					{status
						? `${status.sounds} sounds · starter kit ${status.bySource.starter ?? 0} · packs ${status.bySource.pack ?? 0} · folders ${status.bySource.folder ?? 0} · Jasper Synth ${status.bySource.synth ?? 0}`
						: 'The library status is not available.'}
				</p>
				{indexing ? (
					<p className="text-pr-text" role="status">
						Indexing{progress !== null && progress !== undefined ? ` ${Math.round(progress * 100)} %` : '…'}
					</p>
				) : status?.indexedAt ? (
					<p className="text-pr-small text-pr-dim">
						Last indexed {new Date(status.indexedAt).toLocaleString()}
					</p>
				) : null}
				{status?.starter.status === 'invalid' ? (
					<p className="text-pr-small text-pr-warning">The bundled starter kit could not be read.</p>
				) : null}
			</PrefGroup>

			<PrefGroup
				title="Folders"
				testId="sound-prefs-folders"
				actions={
					<>
						<Button variant="quiet" disabled={!dirty || busy} onClick={() => setDrafts(saved)}>
							Revert
						</Button>
						<Button
							variant="primary"
							disabled={!dirty || busy || !local}
							busy={busy}
							onClick={() => void save(drafts)}
						>
							Save Folders
						</Button>
					</>
				}
			>
				{!local ? (
					<p className="text-pr-warning">
						This engine is remote: folders can only be added on the computer that runs the engine.
					</p>
				) : null}
				{drafts.length === 0 ? <p className="text-pr-muted">No folders yet.</p> : null}
				<ul className="flex flex-col gap-2" aria-label="Sound folders">
					{drafts.map((d, i) => (
						<li
							key={d.id ?? `new-${d.path}`}
							className="flex flex-col gap-1 rounded-pr-control border border-pr-border-subtle p-2"
							data-sound-root={d.id ?? 'new'}
						>
							<div className="flex items-center gap-2">
								<Toggle
									checked={d.enabled}
									onCheckedChange={(v) => patch(i, { enabled: v })}
									aria-label={`Use ${d.label || d.path}`}
									disabled={!local}
								/>
								<TextField
									aria-label="Folder name"
									className="w-[160px]"
									value={d.label}
									placeholder="Name"
									onChange={(e) => patch(i, { label: e.target.value })}
									disabled={!local}
								/>
								<span
									className="min-w-0 flex-1 truncate font-pr-mono text-pr-small text-pr-muted"
									title={d.path}
								>
									{d.path}
								</span>
								<Button
									variant="quiet"
									onClick={() => setDrafts((list) => list.filter((_, k) => k !== i))}
									disabled={!local}
								>
									Remove
								</Button>
							</div>
							<PrefRow label="Licence">
								<Select
									label="Licence"
									value={d.license}
									onValueChange={(v) => patch(i, { license: v as RootLicense })}
									options={LICENSE_OPTIONS}
									disabled={!local}
								/>
							</PrefRow>
							<PrefRow label="Author">
								<TextField
									aria-label="Author"
									className="flex-1"
									value={d.author}
									placeholder="Author or copyright holder"
									onChange={(e) => patch(i, { author: e.target.value })}
									disabled={!local}
								/>
							</PrefRow>
							{requiresAttribution(d.license) ? (
								<PrefRow label="Credit template">
									<TextField
										aria-label="Credit template"
										className="flex-1"
										value={d.attributionTemplate}
										placeholder="“{title}” by {author}, {license}"
										onChange={(e) => patch(i, { attributionTemplate: e.target.value })}
										disabled={!local}
									/>
								</PrefRow>
							) : null}
						</li>
					))}
				</ul>
				<div className="mt-1 flex items-center gap-2">
					<TextField
						aria-label="Folder path"
						className="min-w-0 flex-1"
						placeholder="/path/to/your/sounds"
						value={newPath}
						onChange={(e) => setNewPath(e.target.value)}
						disabled={!local}
						data-testid="sound-prefs-new-path"
					/>
					{desktop ? (
						<Button
							variant="secondary"
							disabled={!local}
							onClick={() =>
								void desktop
									.pickFolder()
									.then((path) => {
										if (path) setNewPath(path);
									})
									.catch((e) => setMessage({ kind: 'error', text: errorText(e) }))
							}
						>
							Browse…
						</Button>
					) : null}
					<Select
						label="Licence of the new folder"
						value={newLicense}
						onValueChange={(v) => setNewLicense(v as RootLicense)}
						options={LICENSE_OPTIONS}
						disabled={!local}
					/>
					<Button
						variant="secondary"
						disabled={!local || !newPath.trim() || busy}
						data-testid="sound-prefs-add-folder"
						onClick={() => {
							const next = [
								...drafts,
								{
									path: newPath.trim(),
									label: '',
									license: newLicense,
									attributionTemplate: '',
									author: '',
									enabled: true,
								},
							];
							// The typed path stays until the engine accepted the folder (a refusal keeps it to fix).
							const typed = newPath;
							void save(next).then((ok) => {
								if (ok) setNewPath((cur) => (cur === typed ? '' : cur));
							});
						}}
					>
						Add Folder
					</Button>
				</div>
				{message ? (
					<p
						className={message.kind === 'error' ? 'text-pr-danger' : 'text-pr-muted'}
						role={message.kind === 'error' ? 'alert' : 'status'}
						data-testid="sound-prefs-message"
					>
						{message.text}
					</p>
				) : null}
				<p className="text-pr-small text-pr-dim">
					The licence you declare decides whether a folder&rsquo;s sounds count as commercial-safe and what
					the credits say. Undeclared folders are flagged.
				</p>
			</PrefGroup>

			<PrefGroup title="Audition">
				<Checkbox
					checked={p.auditionOnHover}
					onCheckedChange={(v) => soundLibraryPrefs.set({ auditionOnHover: v })}
					label="Audition on hover"
				/>
				<Checkbox
					checked={p.autoPlay}
					onCheckedChange={(v) => soundLibraryPrefs.set({ autoPlay: v })}
					label="Auto-play the selected sound"
				/>
				<Checkbox checked={p.loop} onCheckedChange={(v) => soundLibraryPrefs.set({ loop: v })} label="Loop" />
				<PrefRow label="Audition volume">
					<ScrubbyNumber
						label="Audition volume"
						value={p.volumeDb}
						min={MIN_AUDITION_DB}
						max={MAX_AUDITION_DB}
						step={1}
						precision={0}
						unit="dB"
						onCommit={(v) => soundLibraryPrefs.set({ volumeDb: v })}
						onScrubEnd={(v) => soundLibraryPrefs.set({ volumeDb: v })}
					/>
				</PrefRow>
			</PrefGroup>

			<PrefGroup title="Display">
				<Checkbox
					checked={p.density === 'compact'}
					onCheckedChange={(v) => soundLibraryPrefs.set({ density: v ? 'compact' : 'normal' })}
					label="Compact rows"
				/>
			</PrefGroup>
		</div>
	);
}
