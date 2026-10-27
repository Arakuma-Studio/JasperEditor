// Spec 17 SC-072: Edit ▸ Preferences ▸ Transcription ▸ Glossary — the personal speech glossary (names and words the
// recogniser gets wrong, with the right spelling), kept by the engine in `<appdir>/speech/glossary.json` and shared by
// every project and agent. List with search, add, edit, delete (after a confirmation: the glossary has no undo),
// import and export JSON. A glossary written by a newer version is shown read-only; repairs the engine made when it
// opened the file and every failure are shown on the page. Refreshes on `glossary.changed` (another window or an
// agent changed it).
import type { GlossaryLibraryResponse } from '@jasper/api';
import type { GlossaryEntry } from '@jasper/project';
import { Button, confirmDialog, SearchField, Select, TextField, toast } from '@jasper/ui';
import { TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { t } from '../i18n/runtime.ts';
import { downloadBytes } from '../panels/text/state.ts';
import { errorText } from '../processing/engine-jobs.ts';
import { PrefGroup } from '../shell/preferences/GeneralPage.tsx';
import { useEngine, useEngineEvents } from '../state/engine.tsx';
import { languageName, WHISPER_LANGUAGES } from './model.ts';

const ANY = 'any';

/** Spellings typed one per line (commas also separate), trimmed, empty lines dropped. */
export function parseSpellings(text: string): string[] {
	return text
		.split(/[\n,]/)
		.map((s) => s.trim())
		.filter(Boolean);
}

type Draft = { to: string; from: string; lang: string };

function EntryEditor(props: {
	initial: Draft;
	busy: boolean;
	error: string | null;
	onSave(d: Draft): void;
	onCancel(): void;
	testId: string;
}) {
	const [d, setD] = useState<Draft>(props.initial);
	const toId = useId();
	const fromId = useId();
	const languages = useMemo(
		() => [
			{ value: ANY, label: t('Any language') },
			...WHISPER_LANGUAGES.map(([value, label]) => ({ value, label })),
		],
		[],
	);
	return (
		<form
			className="flex flex-col gap-2 rounded-pr-control border border-pr-border-subtle bg-pr-panel-alt p-2"
			data-testid={props.testId}
			onSubmit={(e) => {
				e.preventDefault();
				if (d.to.trim()) props.onSave(d);
			}}
		>
			<div className="flex items-center gap-2">
				<label htmlFor={toId} className="w-36 shrink-0 text-pr-muted">
					Right spelling
				</label>
				<TextField
					id={toId}
					className="flex-1"
					value={d.to}
					maxLength={64}
					placeholder="NovaPlay Studio"
					onChange={(e) => setD({ ...d, to: e.target.value })}
					data-testid="glossary-edit-to"
				/>
			</div>
			<div className="flex items-start gap-2">
				<label htmlFor={fromId} className="w-36 shrink-0 pt-1 text-pr-muted">
					Recognised as (one per line)
				</label>
				<textarea
					id={fromId}
					value={d.from}
					spellCheck={false}
					placeholder={'nova play studio\nnovaplei estudio'}
					onChange={(e) => setD({ ...d, from: e.target.value })}
					className="h-16 flex-1 resize-y rounded-pr-control border border-transparent bg-pr-field px-2 py-1 font-pr text-pr-ui text-pr-text hover:border-pr-border-strong focus:border-pr-focus focus:outline-none"
					data-testid="glossary-edit-from"
				/>
			</div>
			<div className="flex items-center gap-2">
				<span className="w-36 shrink-0 text-pr-muted">Language</span>
				<Select
					label="Language of the entry"
					className="w-48"
					value={d.lang}
					onValueChange={(lang) => setD({ ...d, lang })}
					options={languages}
				/>
				<span className="ml-auto flex items-center gap-2">
					<Button variant="quiet" onClick={props.onCancel} data-testid="glossary-edit-cancel">
						Cancel
					</Button>
					<Button
						type="submit"
						variant="primary"
						busy={props.busy}
						disabled={!d.to.trim()}
						disabledReason="Type the right spelling"
						data-testid="glossary-edit-save"
					>
						Save
					</Button>
				</span>
			</div>
			{props.error ? (
				<p className="text-pr-small text-pr-danger" role="alert" data-testid="glossary-edit-error">
					{props.error}
				</p>
			) : null}
		</form>
	);
}

function EntryRow(props: { entry: GlossaryEntry; readOnly: boolean; onEdit(): void; onDelete(): void }) {
	const e = props.entry;
	return (
		<li
			className="flex items-start gap-3 border-b border-pr-border-subtle py-1.5"
			data-testid="glossary-entry"
			data-entry-id={e.id}
		>
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-baseline gap-x-2">
					<span className="font-semibold text-pr-strong" data-testid="glossary-entry-to">
						{e.to}
					</span>
					{e.lang ? <span className="text-pr-small text-pr-muted">{languageName(e.lang)}</span> : null}
					{e.count > 0 ? (
						<span className="text-pr-small text-pr-dim">
							{e.count === 1 ? t('taught once') : t('taught {0} times', e.count)}
						</span>
					) : null}
				</div>
				<p className="truncate text-pr-small text-pr-muted" data-testid="glossary-entry-from">
					{e.from.length ? t('Recognised as: {0}', e.from.join(' · ')) : t('No misspellings yet')}
				</p>
			</div>
			<Button
				variant="quiet"
				disabled={props.readOnly}
				onClick={props.onEdit}
				aria-label={t('Edit {0}', e.to)}
				data-testid="glossary-entry-edit"
			>
				Edit…
			</Button>
			<Button
				variant="quiet"
				disabled={props.readOnly}
				onClick={props.onDelete}
				aria-label={t('Delete {0}', e.to)}
				data-testid="glossary-entry-delete"
			>
				Delete
			</Button>
		</li>
	);
}

export function GlossaryPreferencesPage() {
	const { client, status } = useEngine();
	const [lib, setLib] = useState<GlossaryLibraryResponse | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [query, setQuery] = useState('');
	const [editing, setEditing] = useState<string | null>(null);
	const [editError, setEditError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [notice, setNotice] = useState<{ text: string; details: string[] } | null>(null);
	const [busy, setBusy] = useState<'import' | 'export' | null>(null);
	const fileRef = useRef<HTMLInputElement>(null);

	const reload = useCallback(async () => {
		try {
			setLib(await client.listGlossary());
			setLoadError(null);
		} catch (e) {
			setLoadError(errorText(e));
		}
	}, [client]);
	useEffect(() => {
		if (status === 'connected') void reload();
	}, [reload, status]);
	useEngineEvents(() => void reload(), ['glossary.changed']);

	const entries = lib?.entries ?? [];
	const shown = useMemo(() => {
		const q = query.trim().toLowerCase();
		const list = q
			? entries.filter((e) => [e.to, ...e.from].some((s) => s.toLowerCase().includes(q)))
			: entries;
		return [...list].sort((a, b) => a.to.localeCompare(b.to));
	}, [entries, query]);
	const readOnly = lib?.readOnly ?? false;
	const ready = status === 'connected' && lib !== null;

	const startEdit = (id: string) => {
		setEditing(id);
		setEditError(null);
	};

	const save = async (d: Draft, entry: GlossaryEntry | null) => {
		setSaving(true);
		setEditError(null);
		const from = parseSpellings(d.from);
		try {
			if (entry) {
				await client.updateGlossaryEntry(entry.id, {
					to: d.to,
					from,
					lang: d.lang === ANY ? null : d.lang,
				});
				setNotice(null);
			} else {
				const r = await client.saveGlossaryEntry({
					to: d.to,
					from,
					...(d.lang === ANY ? {} : { lang: d.lang }),
				});
				setNotice(
					r.created
						? null
						: {
								text: r.changed
									? t('“{0}” was already in the glossary: the spellings were added to it.', r.entry.to)
									: t('“{0}” already had these spellings: nothing changed.', r.entry.to),
								details: [],
							},
				);
			}
			setEditing(null);
			await reload();
		} catch (e) {
			setEditError(errorText(e));
		} finally {
			setSaving(false);
		}
	};

	const remove = async (entry: GlossaryEntry) => {
		const ok = await confirmDialog({
			title: t('Delete “{0}”?', entry.to),
			body: t('The entry is removed from your glossary in every project. This cannot be undone.'),
			confirmLabel: 'Delete Entry',
			danger: true,
		});
		if (!ok) return;
		try {
			await client.removeGlossaryEntry(entry.id);
		} catch (e) {
			toast({ kind: 'error', title: 'The glossary entry was not deleted', detail: errorText(e) });
		}
		await reload();
	};

	const importFile = async (file: File | undefined) => {
		if (!file) return;
		let json: unknown;
		try {
			json = JSON.parse(await file.text());
		} catch {
			setNotice({ text: t('The file is not valid JSON: nothing was imported.'), details: [] });
			return;
		}
		setBusy('import');
		try {
			const r = await client.importGlossary(json);
			setNotice({
				text: t(
					'Imported: {0} added, {1} merged, {2} already there, {3} skipped.',
					r.added,
					r.merged,
					r.unchanged,
					r.skipped.length,
				),
				details: r.skipped.slice(0, 8).map((s) => t('Entry {0}: {1}', s.index + 1, s.reason)),
			});
			await reload();
		} catch (e) {
			setNotice({ text: t('Nothing was imported: {0}', errorText(e)), details: [] });
		} finally {
			setBusy(null);
		}
	};

	const exportFile = async () => {
		setBusy('export');
		try {
			const file = await client.exportGlossary();
			downloadBytes(
				new TextEncoder().encode(`${JSON.stringify(file, null, 2)}\n`),
				'glossary.json',
				'application/json',
			);
		} catch (e) {
			toast({ kind: 'error', title: 'The glossary was not exported', detail: errorText(e) });
		} finally {
			setBusy(null);
		}
	};

	const offlineReason = status !== 'connected' ? 'The engine is not connected' : undefined;
	const writeReason = offlineReason ?? (readOnly ? 'The glossary is read-only' : undefined);

	return (
		<div className="flex flex-col gap-2" data-testid="prefs-glossary">
			<p className="text-pr-muted">
				Names and words the speech recogniser gets wrong, with their right spelling. The glossary is kept on
				this computer and shared by every project and agent.
			</p>
			{status === 'disconnected' ? (
				<p className="text-pr-warning" role="alert">
					The engine is not connected: the glossary cannot be shown or changed.
				</p>
			) : null}
			{loadError ? (
				<p className="text-pr-danger" role="alert" data-testid="glossary-load-error">
					{t('The glossary could not be loaded: {0}', loadError)}
				</p>
			) : null}
			{readOnly ? (
				<p className="flex items-center gap-1 text-pr-warning" data-testid="glossary-read-only">
					<TriangleAlert size={12} aria-hidden />
					This glossary was written by a newer version of JasperEditor: it is read-only here.
				</p>
			) : null}
			{lib?.repairs.length ? (
				<div
					className="rounded-pr-control border border-pr-border-subtle p-2 text-pr-small"
					data-testid="glossary-repairs"
				>
					<p className="font-semibold text-pr-strong">The glossary was repaired when the engine opened it:</p>
					<ul className="list-disc pl-4 text-pr-muted">
						{lib.repairs.map((r) => (
							<li key={r}>{r}</li>
						))}
					</ul>
				</div>
			) : null}
			{notice ? (
				<div className="text-pr-small" role="status" data-testid="glossary-notice">
					<p className="text-pr-text">{notice.text}</p>
					{notice.details.length ? (
						<ul className="list-disc pl-4 text-pr-muted">
							{notice.details.map((d) => (
								<li key={d}>{d}</li>
							))}
						</ul>
					) : null}
				</div>
			) : null}
			<PrefGroup
				title="Glossary"
				testId="glossary-entries"
				actions={
					<>
						{lib ? (
							<span className="pr-tabular text-pr-small text-pr-muted" data-testid="glossary-count">
								{entries.length} / {lib.limits.maxEntries}
							</span>
						) : null}
						<Button
							variant="quiet"
							disabled={!ready || readOnly}
							disabledReason={writeReason}
							busy={busy === 'import'}
							onClick={() => fileRef.current?.click()}
							data-testid="glossary-import"
						>
							Import…
						</Button>
						<input
							ref={fileRef}
							type="file"
							accept=".json,application/json"
							className="hidden"
							aria-label={t('Import a glossary file')}
							data-testid="glossary-import-file"
							onChange={(e) => {
								const f = e.target.files?.[0];
								e.target.value = '';
								void importFile(f);
							}}
						/>
						<Button
							variant="quiet"
							disabled={!ready}
							disabledReason={offlineReason}
							busy={busy === 'export'}
							onClick={() => void exportFile()}
							data-testid="glossary-export"
						>
							Export…
						</Button>
						<Button
							variant="secondary"
							disabled={!ready || readOnly || editing === 'new'}
							disabledReason={writeReason}
							onClick={() => startEdit('new')}
							data-testid="glossary-new"
						>
							New Entry
						</Button>
					</>
				}
			>
				{editing === 'new' ? (
					<EntryEditor
						testId="glossary-editor-new"
						initial={{ to: '', from: '', lang: ANY }}
						busy={saving}
						error={editError}
						onSave={(d) => void save(d, null)}
						onCancel={() => setEditing(null)}
					/>
				) : null}
				{entries.length > 0 ? (
					<SearchField
						value={query}
						onValueChange={setQuery}
						placeholder="Search the glossary"
						aria-label="Search the glossary"
						className="my-1 w-64"
						data-testid="glossary-search"
					/>
				) : null}
				{lib && entries.length === 0 && editing !== 'new' ? (
					<p className="py-4 text-center text-pr-muted" data-testid="glossary-empty">
						No entries yet. Add one, or import a glossary file.
					</p>
				) : null}
				{lib && entries.length > 0 && shown.length === 0 ? (
					<p className="py-2 text-pr-muted">No entry matches the search.</p>
				) : null}
				{!lib && !loadError && status === 'connected' ? <p className="text-pr-muted">Loading…</p> : null}
				<ul>
					{shown.map((e) =>
						editing === e.id ? (
							<li key={e.id} className="py-1.5">
								<EntryEditor
									testId="glossary-editor"
									initial={{ to: e.to, from: e.from.join('\n'), lang: e.lang ?? ANY }}
									busy={saving}
									error={editError}
									onSave={(d) => void save(d, e)}
									onCancel={() => setEditing(null)}
								/>
							</li>
						) : (
							<EntryRow
								key={e.id}
								entry={e}
								readOnly={readOnly}
								onEdit={() => startEdit(e.id)}
								onDelete={() => void remove(e)}
							/>
						),
					)}
				</ul>
			</PrefGroup>
		</div>
	);
}
