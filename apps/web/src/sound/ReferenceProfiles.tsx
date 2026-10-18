// Reference sound profiles in the editor (spec 12 §4 P6-E8; wp-note "Phase 6 → WP-E4"):
//   - Preferences ▸ Sound Library ▸ Reference profiles: the engine's per-user library — New Reference Profile…, Import…,
//     and per profile Rename, Export (the JSON file to share), Delete (asks first). Numbers only, never audio.
//   - The New Reference Profile dialog: a name, the project's media (with audio, ≥ 3 s) and sequences to measure, and on
//     a local engine files by absolute path; the `sound-profile` job's progress, then what was measured and skipped.
//   - Sound Check: the header's Reference select (the sequence's profile, one undo step; "New Reference Profile…") and
//     the Reference rows (one per metric, as MCP `sound_check` lists them).
// Every engine call is answered or caught: a dead engine shows a message, never an unhandled rejection.
import type { EngineJob, SoundCheckReference, SoundProfileSummary, SoundProfilesResponse } from '@jasper/api';
import { SoundProfileBuildResultSchema } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import type { EditorSession } from '@jasper/session';
import {
	Button,
	Checkbox,
	confirmDialog,
	Dialog,
	type HostedDialogProps,
	openDialog,
	registerDialog,
	Select,
	TextField,
	toast,
} from '@jasper/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDialogClose } from '../extensions/dialog.ts';
import { t } from '../i18n/runtime.ts';
import { downloadBytes } from '../panels/text/state.ts';
import { errorText, followJob } from '../processing/engine-jobs.ts';
import { PrefGroup } from '../shell/preferences/GeneralPage.tsx';
import { useEngine, useEngineOrNull } from '../state/engine.tsx';
import { messageText } from './check-model.ts';
import {
	buildRequest,
	NEW_PROFILE,
	NO_PROFILE,
	parsePaths,
	profileFileName,
	profileOptions,
	referenceCandidates,
	referenceHeading,
	rowRange,
	rowValue,
	STATUS_LABELS,
	selectedProfile,
	selectProfileCommand,
	WEIGHT_LABELS,
} from './profile-model.ts';

export const NEW_REFERENCE_PROFILE_DIALOG = 'sound.newReferenceProfile';

type ProfileEngine = Pick<
	EngineClient,
	| 'listSoundProfiles'
	| 'getSoundProfile'
	| 'buildSoundProfile'
	| 'renameSoundProfile'
	| 'deleteSoundProfile'
	| 'importSoundProfile'
	| 'getJob'
	| 'cancelJob'
>;

/** The library's profiles, refreshed when one is built, imported, renamed or deleted (by anyone). */
export function useSoundProfiles(engine: Pick<EngineClient, 'listSoundProfiles'> | null): {
	data: SoundProfilesResponse | null;
	error: string | null;
	reload(): void;
} {
	const engineState = useEngineOrNull();
	const subscribe = engineState?.subscribe;
	const [data, setData] = useState<SoundProfilesResponse | null>(null);
	const [error, setError] = useState<string | null>(null);
	const reload = useCallback(() => {
		// an engine without profile routes (an older engine, a test double): no list, never a throw
		if (!engine || typeof engine.listSoundProfiles !== 'function') return;
		try {
			void engine
				.listSoundProfiles()
				.then((r) => {
					setData(r);
					setError(null);
				})
				.catch((e) => setError(errorText(e)));
		} catch (e) {
			setError(errorText(e));
		}
	}, [engine]);
	useEffect(() => reload(), [reload]);
	useEffect(
		() =>
			subscribe?.((e) => {
				if (e?.type === 'soundProfiles.changed') reload();
			}),
		[subscribe, reload],
	);
	return { data, error, reload };
}

let registered = false;
export function registerReferenceProfileDialogs(): void {
	if (registered) return;
	registered = true;
	registerDialog(NEW_REFERENCE_PROFILE_DIALOG, NewReferenceProfileDialog);
}

/** Opens the New Reference Profile dialog; resolves with the new profile's id (undefined: cancelled / failed). */
export function openNewReferenceProfile(
	session: EditorSession | null,
	engine: ProfileEngine,
	paths: boolean,
): Promise<string | undefined> {
	registerReferenceProfileDialogs();
	return openDialog<string>(NEW_REFERENCE_PROFILE_DIALOG, { session, engine, paths });
}

const jobLine = (j: EngineJob) =>
	j.progress !== null && j.progress !== undefined
		? `${j.stage ?? t('Measuring')} — ${Math.round(j.progress * 100)} %`
		: (j.stage ?? j.state);

export function NewReferenceProfileDialog(
	props: HostedDialogProps<{ session: EditorSession | null; engine: ProfileEngine; paths: boolean }>,
) {
	const { open, finish } = useDialogClose<string>(props.close);
	const doc = props.session?.getCommitted() ?? null;
	const candidates = useMemo(() => referenceCandidates(doc), [doc]);
	const [name, setName] = useState('');
	const [media, setMedia] = useState<string[]>([]);
	const [sequences, setSequences] = useState<string[]>([]);
	const [pathText, setPathText] = useState('');
	const [job, setJob] = useState<EngineJob | null>(null);
	const [result, setResult] = useState<{
		id: string;
		text: string;
		skipped: string[];
		warnings: string[];
	} | null>(null);
	const [error, setError] = useState<string | null>(null);
	const running = !!job && !result && !error;
	const parsed = parsePaths(pathText);
	const req = buildRequest({
		name,
		projectId: props.session?.projectId ?? null,
		mediaIds: media,
		sequenceIds: sequences,
		paths: props.paths ? parsed.paths : [],
	});
	const toggle = (list: string[], set: (v: string[]) => void, id: string, on: boolean) =>
		set(on ? [...list, id] : list.filter((x) => x !== id));
	const start = async () => {
		if (!req.ok) return;
		setError(null);
		try {
			const j = await props.engine.buildSoundProfile(req.request);
			setJob(j);
			const end = await followJob(props.engine as EngineClient, j.id, { onUpdate: setJob, intervalMs: 500 });
			if (end.state !== 'succeeded') {
				setError(end.error?.message ?? end.state);
				return;
			}
			const r = SoundProfileBuildResultSchema.parse(end.result);
			setResult({
				id: r.profile.id,
				text: t('“{0}”: {1} references measured.', r.profile.name, r.profile.n),
				skipped: r.skipped.map((s) => t('{0}: {1}', s.title, s.reason)),
				warnings: r.warnings,
			});
		} catch (e) {
			setError(errorText(e));
		}
	};
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => {
				if (o) return;
				if (running && job) void props.engine.cancelJob(job.id).catch(() => undefined);
				finish(result?.id);
			}}
			title={t('New Reference Profile')}
			description={t('Measure your own reference media: the profile keeps numbers only, never audio.')}
			size="medium"
			primaryLabel={result ? t('Done') : running ? t('Measuring…') : t('Build Profile')}
			primaryDisabled={!result && (running || !req.ok)}
			hideCancel={!!result}
			onPrimary={async () => {
				if (result) {
					finish(result.id);
					return;
				}
				await start();
				return false;
			}}
			data-testid="new-reference-profile-dialog"
		>
			<div className="flex flex-col gap-2 text-pr-ui">
				<p className="m-0 text-pr-small text-pr-muted">
					{t(
						'Pick media or sequences whose sound you want to compare with (your channel, films you like). Five or more give ranges worth judging by. Each is measured as a whole: loudness, its arc and ending, density, sync to its picture, spectrum, stereo width and speech.',
					)}
				</p>
				<div className="flex items-center gap-2">
					<label htmlFor="new-reference-profile-name" className="w-[90px] shrink-0 text-pr-muted">
						{t('Name')}
					</label>
					<TextField
						id="new-reference-profile-name"
						aria-label={t('Profile name')}
						className="min-w-0 flex-1"
						value={name}
						disabled={running || !!result}
						placeholder={t('My channel')}
						onChange={(e) => setName(e.target.value)}
						data-testid="new-reference-profile-name"
					/>
				</div>
				<fieldset className="m-0 flex flex-col gap-1 border-0 p-0" disabled={running || !!result}>
					<legend className="mb-1 font-semibold text-pr-strong">{t('Media from the project')}</legend>
					{candidates.media.length === 0 ? (
						<p className="m-0 text-pr-small text-pr-muted">
							{props.session
								? t('No media with audio of 3 s or more in this project.')
								: t('Open a project to pick its media.')}
						</p>
					) : (
						<ul
							className="m-0 flex max-h-[160px] list-none flex-col gap-0.5 overflow-auto p-0"
							aria-label={t('Media')}
						>
							{candidates.media.map((m) => (
								<li key={m.mediaId}>
									<Checkbox
										checked={media.includes(m.mediaId)}
										onCheckedChange={(on) => toggle(media, setMedia, m.mediaId, on)}
										label={`${m.name} · ${Math.round(m.seconds)} s${m.hasPicture ? '' : ` · ${t('no picture')}`}`}
										aria-label={m.name}
									/>
								</li>
							))}
						</ul>
					)}
					{candidates.sequences.length ? (
						<>
							<legend className="mt-1 mb-1 font-semibold text-pr-strong">{t('Sequences')}</legend>
							<ul
								className="m-0 flex max-h-[100px] list-none flex-col gap-0.5 overflow-auto p-0"
								aria-label={t('Sequences')}
							>
								{candidates.sequences.map((s) => (
									<li key={s.sequenceId}>
										<Checkbox
											checked={sequences.includes(s.sequenceId)}
											onCheckedChange={(on) => toggle(sequences, setSequences, s.sequenceId, on)}
											label={s.name}
											aria-label={s.name}
										/>
									</li>
								))}
							</ul>
						</>
					) : null}
					{props.paths ? (
						<>
							<legend className="mt-1 mb-1 font-semibold text-pr-strong">
								{t('Files on this computer')}
							</legend>
							<textarea
								aria-label={t('Files on this computer, one absolute path per line')}
								placeholder={t('One absolute path per line')}
								className="h-[60px] w-full resize-none rounded-pr-control bg-pr-field p-1 font-pr-mono text-pr-small text-pr-text"
								value={pathText}
								onChange={(e) => setPathText(e.target.value)}
								data-testid="new-reference-profile-paths"
							/>
							{parsed.bad.length ? (
								<p className="m-0 text-pr-small text-pr-warning" role="alert">
									{t('Not absolute, left out: {0}', parsed.bad.slice(0, 3).join(', '))}
								</p>
							) : null}
						</>
					) : null}
				</fieldset>
				{!req.ok && !running && !result ? (
					<p className="m-0 text-pr-small text-pr-muted" data-testid="new-reference-profile-why">
						{req.why}
					</p>
				) : null}
				{job && !result && !error ? (
					<div data-testid="new-reference-profile-progress">
						<p className="m-0 text-pr-small text-pr-text" role="status">
							{jobLine(job)}
						</p>
						<div
							role="progressbar"
							aria-label={t('Measuring the references')}
							aria-valuemin={0}
							aria-valuemax={100}
							aria-valuenow={job.progress === null ? undefined : Math.round((job.progress ?? 0) * 100)}
							className="mt-0.5 h-1 w-full overflow-hidden rounded-pr-pill bg-pr-field"
						>
							<div
								className="h-full bg-pr-accent-fill"
								style={{ width: `${Math.round((job.progress ?? 0.02) * 100)}%` }}
							/>
						</div>
					</div>
				) : null}
				{error ? (
					<p className="m-0 text-pr-small text-pr-danger" role="alert">
						{t('The profile was not built: {0}', error)}
					</p>
				) : null}
				{result ? (
					<div className="flex flex-col gap-0.5" data-testid="new-reference-profile-result">
						<p className="m-0 text-pr-text">{result.text}</p>
						{result.skipped.map((s) => (
							<p key={s} className="m-0 text-pr-small text-pr-warning">
								{t('Skipped {0}', s)}
							</p>
						))}
						{result.warnings.map((w) => (
							<p key={w} className="m-0 text-pr-small text-pr-muted">
								{w}
							</p>
						))}
					</div>
				) : null}
			</div>
		</Dialog>
	);
}

// ── Preferences ▸ Sound Library ▸ Reference profiles ──────────────────────────────────────────────────────────────

export function ReferenceProfilesSection(props: { session: EditorSession | null }) {
	const { client: engine } = useEngine();
	const { data, error, reload } = useSoundProfiles(engine);
	const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const fileRef = useRef<HTMLInputElement | null>(null);

	const rename = async () => {
		if (!renaming) return;
		const name = renaming.name.trim();
		if (!name) return;
		setBusy(renaming.id);
		try {
			await engine.renameSoundProfile(renaming.id, name);
			setRenaming(null);
			reload();
		} catch (e) {
			toast({ kind: 'error', title: t('The profile was not renamed'), detail: errorText(e) });
		} finally {
			setBusy(null);
		}
	};
	const exportOne = async (p: SoundProfileSummary) => {
		try {
			const file = await engine.getSoundProfile(p.id);
			downloadBytes(
				new TextEncoder().encode(`${JSON.stringify(file, null, 2)}\n`),
				profileFileName(p.name),
				'application/json',
			);
		} catch (e) {
			toast({ kind: 'error', title: t('The profile was not exported'), detail: errorText(e) });
		}
	};
	const remove = async (p: SoundProfileSummary) => {
		const ok = await confirmDialog({
			title: t('Delete “{0}”?', p.name),
			body: t(
				'Its numbers leave the sound library on this computer; building it again needs its {0} references. Sequences that compare with it lose their Reference rows. Export it first to keep a copy.',
				p.n,
			),
			confirmLabel: 'Delete Profile',
			danger: true,
		});
		if (!ok) return;
		setBusy(p.id);
		try {
			await engine.deleteSoundProfile(p.id);
			reload();
		} catch (e) {
			toast({ kind: 'error', title: t('The profile was not deleted'), detail: errorText(e) });
		} finally {
			setBusy(null);
		}
	};
	const importFile = async (f: File | undefined) => {
		if (!f) return;
		try {
			if (f.size > 1_000_000) throw new Error(t('The file is larger than 1 MB'));
			let profile: unknown;
			try {
				profile = JSON.parse(await f.text());
			} catch {
				throw new Error(t('{0} is not a reference profile file (not JSON)', f.name));
			}
			const p = await engine.importSoundProfile({ profile });
			toast({ kind: 'success', title: t('Imported “{0}”: {1} references', p.name, p.n) });
			reload();
		} catch (e) {
			toast({ kind: 'error', title: t('The profile was not imported'), detail: errorText(e) });
		} finally {
			if (fileRef.current) fileRef.current.value = '';
		}
	};

	return (
		<PrefGroup
			title="Reference profiles"
			testId="prefs-sound-profiles"
			actions={
				<>
					<Button
						variant="secondary"
						data-testid="sound-profiles-new"
						onClick={() =>
							void openNewReferenceProfile(props.session, engine, data?.paths ?? false).then(() => reload())
						}
					>
						{t('New Reference Profile…')}
					</Button>
					<Button
						variant="quiet"
						data-testid="sound-profiles-import"
						onClick={() => fileRef.current?.click()}
					>
						{t('Import…')}
					</Button>
					<input
						ref={fileRef}
						type="file"
						accept=".json,application/json"
						className="hidden"
						aria-label={t('Import a reference profile file')}
						data-testid="sound-profiles-import-file"
						onChange={(e) => void importFile(e.target.files?.[0])}
					/>
				</>
			}
		>
			<p className="m-0 text-pr-small text-pr-muted">
				{t(
					'Profiles you build from your own media describe a sound you want (your channel, films you like). Sound Check compares a sequence with one: what differs, and what to do. They hold numbers only; there is no built-in profile.',
				)}
			</p>
			{error ? (
				<p className="m-0 text-pr-small text-pr-danger" role="alert">
					{t('The profiles are not available: {0}', error)}
				</p>
			) : null}
			{data === null && !error ? <p className="m-0 text-pr-muted">{t('Loading…')}</p> : null}
			{data && data.profiles.length === 0 ? (
				<p className="m-0 text-pr-muted" data-testid="sound-profiles-empty">
					{t('No reference profile yet.')}
				</p>
			) : null}
			{data?.unreadable.length ? (
				<p className="m-0 text-pr-small text-pr-warning">
					{t(
						'{0} damaged profile file(s) were moved aside: {1}',
						data.unreadable.length,
						data.unreadable.map((u) => `${u.file} (${u.error})`).join('; '),
					)}
				</p>
			) : null}
			<ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label={t('Reference profiles')}>
				{data?.profiles.map((p) => (
					<li
						key={p.id}
						className="flex flex-col gap-1 rounded-pr-control border border-pr-border-subtle p-2"
						data-sound-profile={p.id}
					>
						<div className="flex items-center gap-2">
							{renaming?.id === p.id ? (
								<TextField
									aria-label={t('Profile name')}
									className="min-w-0 flex-1"
									value={renaming.name}
									autoFocus
									onChange={(e) => setRenaming({ id: p.id, name: e.target.value })}
									onKeyDown={(e) => {
										if (e.key === 'Enter') void rename();
										if (e.key === 'Escape') setRenaming(null);
									}}
									onBlur={() => void rename()}
									data-testid={`sound-profile-name-${p.id}`}
								/>
							) : (
								<span className="min-w-0 flex-1 truncate font-semibold text-pr-strong">{p.name}</span>
							)}
							<Button
								variant="quiet"
								disabled={busy === p.id}
								aria-label={t('Rename {0}', p.name)}
								onClick={() => setRenaming({ id: p.id, name: p.name })}
								data-testid={`sound-profile-rename-${p.id}`}
							>
								{t('Rename')}
							</Button>
							<Button
								variant="quiet"
								aria-label={t('Export {0}', p.name)}
								onClick={() => void exportOne(p)}
								data-testid={`sound-profile-export-${p.id}`}
							>
								{t('Export…')}
							</Button>
							<Button
								variant="quiet"
								disabled={busy === p.id}
								aria-label={t('Delete {0}', p.name)}
								onClick={() => void remove(p)}
								data-testid={`sound-profile-delete-${p.id}`}
							>
								{t('Delete…')}
							</Button>
						</div>
						<p className="m-0 text-pr-small text-pr-muted">
							{t('{0} references: {1}', p.n, p.references.map((r) => r.title).join(', '))}
						</p>
						{p.warnings.map((w) => (
							<p key={w} className="m-0 text-pr-small text-pr-dim">
								{w}
							</p>
						))}
					</li>
				))}
			</ul>
		</PrefGroup>
	);
}

// ── Sound Check: the Reference select and rows ────────────────────────────────────────────────────────────────────

/** The header's Reference select: the sequence's profile (one undo step), or a new one. */
export function ReferenceSelect(props: {
	session: EditorSession;
	sequenceId: string | null;
	disabled: boolean;
	readOnly: boolean;
}) {
	const engineState = useEngineOrNull();
	const engine = (engineState?.client ?? null) as ProfileEngine | null;
	const { data } = useSoundProfiles(engine);
	const doc = props.session.getCommitted();
	const selected = selectedProfile(doc, props.sequenceId);
	const options = useMemo(() => profileOptions(data?.profiles ?? [], selected), [data, selected]);
	const choose = (profileId: string | null) => {
		if (!props.sequenceId) return;
		props.session.apply({
			label: profileId ? t('Compare with Reference Profile') : t('Stop Comparing with a Reference Profile'),
			origin: 'user',
			sequenceId: props.sequenceId,
			commands: [selectProfileCommand(props.sequenceId, profileId)],
		});
	};
	return (
		<span className="flex min-w-0 max-w-[220px] flex-1" data-testid="sound-check-reference">
			<Select
				label={t('Compare with reference')}
				value={selected ?? NO_PROFILE}
				options={options}
				disabled={props.disabled || props.readOnly || !props.sequenceId || !engine}
				onValueChange={(v) => {
					if (v === NEW_PROFILE) {
						if (engine)
							void openNewReferenceProfile(props.session, engine, data?.paths ?? false).then((id) => {
								if (id) choose(id);
							});
						return;
					}
					choose(v === NO_PROFILE ? null : v);
				}}
				className="min-w-0 flex-1"
			/>
		</span>
	);
}

/** The Reference rows of a report: one per metric, with the advice of the ones out of range. */
export function ReferenceRows(props: { reference: SoundCheckReference; onShow?(issueId: string): void }) {
	const ref = props.reference;
	const [all, setAll] = useState(false);
	const flagged = ref.rows.filter((r) => r.status === 'low' || r.status === 'high');
	const rows = all ? ref.rows : flagged.length ? flagged : [];
	return (
		<section
			className="border-b border-pr-border px-2 py-1"
			aria-label={t('Reference comparison')}
			data-testid="sound-check-reference-rows"
		>
			<div className="flex items-center gap-2">
				<h4 className="m-0 font-semibold text-pr-strong">{t('Reference')}</h4>
				<span
					className="min-w-0 flex-1 truncate text-pr-small text-pr-muted"
					data-testid="sound-check-reference-heading"
				>
					{referenceHeading(ref)}
				</span>
				<Button
					variant="quiet"
					onClick={() => setAll((x) => !x)}
					data-testid="sound-check-reference-all"
					aria-expanded={all}
				>
					{all ? t('Differences only') : t('All {0} metrics', ref.rows.length)}
				</Button>
			</div>
			{ref.leaveOneOut ? (
				<p className="m-0 text-pr-small text-pr-muted">
					{t(
						'This sequence is reference “{0}” of the profile: it is judged against the other {1}.',
						ref.leaveOneOut.title,
						ref.scoredAgainst,
					)}
				</p>
			) : null}
			{rows.length === 0 ? (
				<p className="m-0 text-pr-small text-pr-muted">
					{t('Every scored metric is within the references’ range.')}
				</p>
			) : (
				<table className="w-full border-collapse text-pr-small">
					<thead>
						<tr className="text-left text-pr-muted">
							<th className="py-0.5 pr-2 font-normal">{t('Metric')}</th>
							<th className="py-0.5 pr-2 font-normal">{t('Value')}</th>
							<th className="py-0.5 pr-2 font-normal">{t('References')}</th>
							<th className="py-0.5 pr-2 font-normal">{t('Median')}</th>
							<th className="py-0.5 font-normal">{t('Status')}</th>
						</tr>
					</thead>
					<tbody>
						{rows.map((r) => {
							const off = r.status === 'low' || r.status === 'high';
							return (
								<tr
									key={r.metric}
									data-reference-metric={r.metric}
									data-reference-status={r.status}
									className="align-top"
								>
									<td className="py-0.5 pr-2 text-pr-text" title={t(r.why)}>
										{t(r.label)}
										{off && r.advice?.length ? (
											<div className="text-pr-muted">{r.advice.map((a) => messageText(a)).join(' ')}</div>
										) : null}
									</td>
									<td className="py-0.5 pr-2 pr-tabular text-pr-text">
										{rowValue(r.metric, r.value)}
										{r.chance !== undefined && r.chance !== null ? (
											<span className="text-pr-muted">
												{' '}
												{t('(chance {0})', rowValue(r.metric, r.chance))}
											</span>
										) : null}
									</td>
									<td className="py-0.5 pr-2 pr-tabular text-pr-muted">{rowRange(r)}</td>
									<td className="py-0.5 pr-2 pr-tabular text-pr-muted">{rowValue(r.metric, r.median)}</td>
									<td
										className={`py-0.5 ${off ? (r.weight === 'major' ? 'text-pr-warning' : 'text-pr-text') : 'text-pr-muted'}`}
									>
										{off && r.issueId && props.onShow ? (
											<button
												type="button"
												className="underline underline-offset-2"
												onClick={() => props.onShow?.(r.issueId!)}
												title={WEIGHT_LABELS[r.weight]}
											>
												{STATUS_LABELS[r.status]}
											</button>
										) : (
											<span title={WEIGHT_LABELS[r.weight]}>{STATUS_LABELS[r.status]}</span>
										)}
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			)}
		</section>
	);
}
