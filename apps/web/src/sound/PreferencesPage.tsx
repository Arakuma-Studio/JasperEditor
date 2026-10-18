// Preferences ▸ Sound Library (spec 12 §2.7, P1-R7): your sound folders (indexed in place by the engine, local engines
// only) with a licence declaration per folder, enable / disable, rescan and remove; downloadable sound packs (install
// after the licence is shown, remove; WP6.1, PacksSection.tsx); the library status and reindexing
// (an engine `sound-index` job, also listed in the Jobs panel); and the audition options (audition on hover, loop,
// auto-play, volume) and row density. Folder changes are validated by the engine and saved with "Save Folders".
// Proposals: "Allow agents to apply sound proposals" for the active sequence (WP3.3b). Sound design style: the active
// sequence's cue grammar and personality (P6-E10, `soundDesign.setSettings {style}`; WP-E6). Reference profiles: the
// engine's library of profiles measured from the user's own media (P6-E8, ReferenceProfiles.tsx; WP-E4).
import {
	SOUND_ROOT_LICENSES,
	type SoundLibraryStatus,
	type SoundRoot,
	type SoundRootsPutRequest,
} from '@jasper/api';
import { EngineError } from '@jasper/engine-client';
import {
	DELIVERY_PRESETS,
	type ResolvedSoundStyle,
	readSoundDesignSettings,
	requiresAttribution,
	resolveSoundStyle,
	type SoundDelivery,
} from '@jasper/project';
import type { SessionState } from '@jasper/session';
import { useSessionOrNull, useStoreSelector } from '@jasper/session/react';
import { Button, Checkbox, ScrubbyNumber, Select, TextField, Toggle } from '@jasper/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { runCommand } from '../commands/registry.ts';
import { t } from '../i18n/runtime.ts';
import { EMPTY_SESSION_STORE } from '../panels/session-store.ts';
import { getDesktopBridge } from '../runtime/platform.ts';
import { useShellRuntimeOrNull } from '../shell/context.tsx';
import { PrefGroup, PrefRow } from '../shell/preferences/GeneralPage.tsx';
import { useEngine } from '../state/engine.tsx';
import { DELIVERY_IDS, deliveryOptionLabel, sequenceDelivery } from './mix-model.ts';
import { PacksSection } from './PacksSection.tsx';
import {
	MAX_AUDITION_DB,
	MAX_PRE_ROLL_SEC,
	MIN_AUDITION_DB,
	MIN_PRE_ROLL_SEC,
	soundLibraryPrefs,
	useSoundLibraryPrefs,
} from './prefs.ts';
import { ReferenceProfilesSection } from './ReferenceProfiles.tsx';
import { SoundStyleFields, type StyleField } from './StyleControls.tsx';

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
	const session = useSessionOrNull();
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

			<PacksSection />
			<ReferenceProfilesSection session={session} />

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
				<Checkbox
					checked={p.inContext}
					onCheckedChange={(v) => soundLibraryPrefs.set({ inContext: v })}
					label="Audition in context (play the timeline with the sound on the selected cue)"
				/>
				<Checkbox
					checked={p.auditionOnSwap}
					onCheckedChange={(v) => soundLibraryPrefs.set({ auditionOnSwap: v })}
					label="Audition on swap (play the 2 s around a swapped sound)"
				/>
				<PrefRow label="In Context pre-roll">
					<ScrubbyNumber
						label="In Context pre-roll"
						value={p.preRollSec}
						min={MIN_PRE_ROLL_SEC}
						max={MAX_PRE_ROLL_SEC}
						step={0.5}
						precision={1}
						unit="s"
						onCommit={(v) => soundLibraryPrefs.set({ preRollSec: v })}
						onScrubEnd={(v) => soundLibraryPrefs.set({ preRollSec: v })}
					/>
				</PrefRow>
			</PrefGroup>

			<AgentApplyPreference />
			<DeliveryPreference />
			<StylePreference />

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

/**
 * "Allow agents to apply sound proposals" (spec 12 §0, §2.7 Preferences; WP3.3b): per sequence, stored in the project
 * (`soundDesign.settings.agentsMayApply`, default off) with `soundDesign.setSettings` as the user's own undoable edit.
 * Off, an agent's `accept_proposal` is refused (E_APPROVAL_REQUIRED) and only the user applies, in review. An agent can
 * never turn it on by itself: the engine asks the user on an approval card (the guard in `@jasper/project`).
 */
export function AgentApplyPreference() {
	const session = useSessionOrNull();
	const seqId = useStoreSelector(
		session?.store ?? EMPTY_SESSION_STORE,
		(s: SessionState | null) => s?.activeSequenceId ?? null,
	);
	const on = useStoreSelector(session?.store ?? EMPTY_SESSION_STORE, (s: SessionState | null) => {
		const seq = seqId ? s?.document.sequences[seqId] : undefined;
		return (
			readSoundDesignSettings(
				(seq as { soundDesign?: { settings?: unknown } } | undefined)?.soundDesign?.settings,
			).agentsMayApply === true
		);
	});
	const name = useStoreSelector(session?.store ?? EMPTY_SESSION_STORE, (s: SessionState | null) => {
		if (!s || !seqId) return null;
		const item = Object.values(s.document.items).find(
			(i) => i.kind === 'sequence' && (i as { sequenceId?: string }).sequenceId === seqId,
		);
		return item?.name ?? null;
	});
	const readOnly = useStoreSelector(
		session?.store ?? EMPTY_SESSION_STORE,
		(s: SessionState | null) => !!s?.readOnly,
	);
	const [error, setError] = useState<string | null>(null);
	const set = (v: boolean) => {
		if (!session || !seqId) return;
		const r = session.apply({
			label: v ? t('Allow Agents to Apply Sound Proposals') : t('Stop Agents Applying Sound Proposals'),
			origin: 'user',
			sequenceId: seqId,
			commands: [{ type: 'soundDesign.setSettings', sequenceId: seqId, agentsMayApply: v } as never],
		});
		setError(r.ok ? null : (r.errors[0]?.message ?? t('Edit failed')));
	};
	return (
		<PrefGroup title="Proposals" testId="prefs-sound-proposals">
			<Checkbox
				checked={on}
				disabled={!session || !seqId || readOnly}
				onCheckedChange={set}
				label={
					name
						? t('Allow agents to apply sound proposals in “{0}”', name)
						: t('Allow agents to apply sound proposals (open a sequence first)')
				}
			/>
			<p className="text-pr-small text-pr-muted">
				Off (the default): agents only propose; you apply in review. Saved with the sequence; an agent cannot
				turn it on by itself.
			</p>
			{error ? <p className="text-pr-small text-pr-warning">{error}</p> : null}
		</PrefGroup>
	);
}

/**
 * The active sequence's delivery target (spec 12 §2.4 "Delivery presets"; WP4.2b): what placement's default levels and
 * the masking solver aim at (`soundDesign.setSettings {delivery}`, the user's undoable edit). Mixing the sequence to it
 * (normalisation, Auto-Match, ducking) is Sequence ▸ Sound Design ▸ Delivery Target…, linked here.
 */
export function DeliveryPreference() {
	const session = useSessionOrNull();
	const runtime = useShellRuntimeOrNull();
	const seqId = useStoreSelector(
		session?.store ?? EMPTY_SESSION_STORE,
		(s: SessionState | null) => s?.activeSequenceId ?? null,
	);
	const delivery = useStoreSelector(session?.store ?? EMPTY_SESSION_STORE, (s: SessionState | null) => {
		const seq = seqId ? s?.document.sequences[seqId] : undefined;
		return sequenceDelivery(seq);
	});
	const readOnly = useStoreSelector(
		session?.store ?? EMPTY_SESSION_STORE,
		(s: SessionState | null) => !!s?.readOnly,
	);
	const [error, setError] = useState<string | null>(null);
	const set = (v: SoundDelivery) => {
		if (!session || !seqId || v === delivery) return;
		const r = session.apply({
			label: t('Sound Delivery Target'),
			origin: 'user',
			sequenceId: seqId,
			commands: [{ type: 'soundDesign.setSettings', sequenceId: seqId, delivery: v } as never],
		});
		setError(r.ok ? null : (r.errors[0]?.message ?? t('Edit failed')));
	};
	return (
		<PrefGroup title="Delivery" testId="prefs-sound-delivery">
			<div className="flex items-center gap-2">
				<span className="w-[140px] shrink-0 text-pr-muted">{t('Sequence target')}</span>
				<Select
					label={t('Sequence delivery target')}
					value={delivery}
					disabled={!session || !seqId || readOnly}
					onValueChange={(v) => set(v as SoundDelivery)}
					options={DELIVERY_IDS.map((id) => ({
						value: id,
						label: deliveryOptionLabel(DELIVERY_PRESETS[id]),
					}))}
				/>
			</div>
			<p className="text-pr-small text-pr-muted">
				Default levels and Rebalance aim at this target. To mix the sequence to it (normalisation, Auto-Match,
				ducking), use Delivery Target….
			</p>
			<div>
				<Button
					variant="secondary"
					disabled={!session || !seqId || readOnly}
					onClick={() => {
						const ctx = runtime?.getCtx();
						if (ctx) void runCommand('sound.deliveryTarget', ctx);
					}}
					data-testid="prefs-delivery-open"
				>
					Delivery Target…
				</Button>
			</div>
			{error ? <p className="text-pr-small text-pr-warning">{error}</p> : null}
		</PrefGroup>
	);
}

/**
 * The active sequence's sound design style (spec 12 P6-E10; WP-E6): personality, runs, typing, music carries the cuts
 * and duck under typing, stored in the project (`soundDesign.settings.style`) with `soundDesign.setSettings {style}` as
 * the user's undoable edit. Auto Sound Pass…, Fill Unfilled Cues, Suggest Cues… and agents (plan_sound_design,
 * place_sound picks, find_sound_cues) start from it.
 */
export function StylePreference() {
	const session = useSessionOrNull();
	const seqId = useStoreSelector(
		session?.store ?? EMPTY_SESSION_STORE,
		(s: SessionState | null) => s?.activeSequenceId ?? null,
	);
	// a string snapshot (a fresh object per read would never be equal to the last one)
	const raw = useStoreSelector(session?.store ?? EMPTY_SESSION_STORE, (s: SessionState | null) => {
		const seq = seqId ? s?.document.sequences[seqId] : undefined;
		return JSON.stringify(
			readSoundDesignSettings(
				(seq as { soundDesign?: { settings?: unknown } } | undefined)?.soundDesign?.settings,
			).style ?? {},
		);
	});
	const readOnly = useStoreSelector(
		session?.store ?? EMPTY_SESSION_STORE,
		(s: SessionState | null) => !!s?.readOnly,
	);
	const [error, setError] = useState<string | null>(null);
	const value = useMemo(() => resolveSoundStyle(JSON.parse(raw) as ResolvedSoundStyle), [raw]);
	const set = (next: ResolvedSoundStyle, field: StyleField) => {
		if (!session || !seqId || next[field] === value[field]) return;
		const r = session.apply({
			label: t('Sound Design Style'),
			origin: 'user',
			sequenceId: seqId,
			commands: [
				{ type: 'soundDesign.setSettings', sequenceId: seqId, style: { [field]: next[field] } } as never,
			],
		});
		setError(r.ok ? null : (r.errors[0]?.message ?? t('Edit failed')));
	};
	return (
		<PrefGroup title="Sound design style" testId="prefs-sound-style">
			<SoundStyleFields
				value={value}
				onChange={set}
				legend={false}
				disabled={!session || !seqId || readOnly}
				testId="prefs-style-fields"
			/>
			<p className="text-pr-small text-pr-muted">
				Saved with the sequence. Auto Sound Pass, Fill Unfilled Cues, Suggest Cues and agents start from it:
				one click voice, takes for keys, climbing runs, one key per word for fast typing, fewer cut sounds
				under music, chimes in the music's key, stops on the bar line.
			</p>
			{error ? <p className="text-pr-small text-pr-warning">{error}</p> : null}
		</PrefGroup>
	);
}
