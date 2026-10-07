// Synchronize, Merge Clips, Create Multi-Camera Source Sequence and Edit Cameras dialogs (wp-multicam), with
// Premiere's option names. Audio sync measures the offsets in the engine first (POST /api/sync/audio) and warns when
// a match is unreliable (low confidence, or a competing match): the second OK applies anyway.
import type { SyncAudioResponse } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import {
	type AudioSyncClip,
	audioSyncClipsForItems,
	audioSyncClipsForUnits,
	type MulticamAudioMode,
	type MulticamSource,
	type Sequence,
	SyncError,
	type SyncMethod,
	synchronizeReference,
	synchronizeUnits,
	trackLabel,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import {
	Button,
	Checkbox,
	Dialog,
	type HostedDialogProps,
	registerDialog,
	Select,
	TextField,
} from '@jasper/ui';
import { useMemo, useState } from 'react';

export const SYNCHRONIZE_DIALOG = 'multicam.synchronize';
export const MERGE_CLIPS_DIALOG = 'multicam.mergeClips';
export const CREATE_MULTICAM_DIALOG = 'multicam.create';
export const EDIT_CAMERAS_DIALOG = 'multicam.editCameras';

let registered = false;
export function registerMulticamDialogs(): void {
	if (registered) return;
	registered = true;
	registerDialog(SYNCHRONIZE_DIALOG, SynchronizeDialog);
	registerDialog(MERGE_CLIPS_DIALOG, MergeClipsDialog);
	registerDialog(CREATE_MULTICAM_DIALOG, CreateMulticamDialog);
	registerDialog(EDIT_CAMERAS_DIALOG, EditCamerasDialog);
}

function useClose(close: (r?: unknown) => void) {
	const [open, setOpen] = useState(true);
	const [done, setDone] = useState(false);
	return {
		open,
		finish(result?: unknown) {
			setOpen(false);
			if (done) return;
			setDone(true);
			close(result);
		},
	};
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex items-center gap-2">
			<span className="w-[150px] shrink-0 text-pr-muted">{label}</span>
			{children}
		</div>
	);
}

type AudioReport = {
	key: string;
	name: string;
	reliable: boolean;
	confidence: number | null;
	distinct: number | null;
	error?: string;
};

/** Measures audio offsets; returns them (on the engine's clock) and a per-clip report. */
async function measureAudio(
	engine: EngineClient,
	clips: AudioSyncClip[],
	reference: string | undefined,
	names: Record<string, string>,
): Promise<{ offsets: Record<string, number>; report: AudioReport[] }> {
	const res = (await engine.call('syncAudio', {
		body: { clips, ...(reference ? { reference } : {}) },
	})) as SyncAudioResponse;
	return {
		offsets: Object.fromEntries(res.results.map((r) => [r.key, r.offsetFlicks])),
		report: res.results.map((r) => ({
			key: r.key,
			name: names[r.key] ?? r.key,
			reliable: r.reliable,
			confidence: r.confidence,
			distinct: r.distinct,
			...(r.error ? { error: r.error } : {}),
		})),
	};
}

function Report({ report }: { report: AudioReport[] }) {
	const bad = report.filter((r) => !r.reliable);
	if (!bad.length) return null;
	return (
		<div
			className="flex flex-col gap-1 rounded-pr-control bg-pr-raised p-2 text-pr-small"
			role="alert"
			data-testid="sync-audio-warning"
		>
			<span className="text-pr-warning">The audio match is unreliable — check the result:</span>
			{bad.map((r) => (
				<span key={r.key} className="text-pr-text">
					{r.name}:{' '}
					{r.error ??
						`confidence ${r.confidence?.toFixed(1) ?? '—'} (≥ 8), distinct ${r.distinct?.toFixed(2) ?? '—'} (≥ 1.5)`}
				</span>
			))}
		</div>
	);
}

/** The shared sync-point controls (Premiere: Synchronize Point). */
function SyncPoint(props: {
	method: SyncMethod;
	setMethod(m: SyncMethod): void;
	ignoreHours: boolean;
	setIgnoreHours(v: boolean): void;
	marker: string;
	setMarker(v: string): void;
	markerNames: string[];
	labels: Record<SyncMethod, string>;
}) {
	const methods: SyncMethod[] = ['in', 'out', 'timecode', 'marker', 'audio'];
	return (
		<fieldset className="flex flex-col gap-1.5" aria-label="Synchronize Point">
			<legend className="mb-1 text-pr-muted">Synchronize Point</legend>
			{methods.map((m) => (
				<label key={m} className="flex items-center gap-2">
					<input
						type="radio"
						name="sync-point"
						checked={props.method === m}
						onChange={() => props.setMethod(m)}
						data-testid={`sync-point-${m}`}
					/>
					<span>{props.labels[m]}</span>
					{m === 'timecode' && props.method === 'timecode' ? (
						<Checkbox
							checked={props.ignoreHours}
							onCheckedChange={props.setIgnoreHours}
							label="Ignore Hours"
							id="sync-ignore-hours"
						/>
					) : null}
					{m === 'marker' && props.method === 'marker' ? (
						<Select
							value={props.marker || '(first)'}
							onValueChange={(v) => props.setMarker(v === '(first)' ? '' : v)}
							options={[
								{ value: '(first)', label: 'First clip marker' },
								...props.markerNames.map((n) => ({ value: n, label: n })),
							]}
							label="Clip Marker"
							id="sync-marker"
						/>
					) : null}
				</label>
			))}
		</fieldset>
	);
}

function syncFields(method: SyncMethod, ignoreHours: boolean, marker: string, offsetFrames: number) {
	return {
		method,
		...(method === 'timecode' && ignoreHours ? { ignoreHours: true } : {}),
		...(method === 'marker' && marker ? { marker } : {}),
		...(offsetFrames ? { offsetFrames } : {}),
	};
}

function useAudioStep() {
	const [report, setReport] = useState<AudioReport[] | null>(null);
	const [offsets, setOffsets] = useState<Record<string, number> | null>(null);
	const [busy, setBusy] = useState(false);
	return { report, setReport, offsets, setOffsets, busy, setBusy };
}

// ---------------------------------------------------------------- Synchronize

type SyncProps = { session: EditorSession; engine: EngineClient; sequenceId: string; clipIds: string[] };

export function SynchronizeDialog(props: HostedDialogProps<SyncProps>) {
	const { session, engine, sequenceId, clipIds } = props;
	const { open, finish } = useClose(props.close);
	const seq = session.getCommitted().sequences[sequenceId] as Sequence;
	const [method, setMethod] = useState<SyncMethod>('in');
	const [ignoreHours, setIgnoreHours] = useState(false);
	const [marker, setMarker] = useState('');
	const [error, setError] = useState<string | null>(null);
	const audio = useAudioStep();
	const tracks = useMemo(() => {
		const ids = new Set(clipIds.map((id) => seq.clips[id]?.trackId).filter((x): x is string => !!x));
		return [...seq.videoTracks, ...seq.audioTracks].filter((t) => ids.has(t.id)).map((t) => t.id);
	}, [seq, clipIds]);
	const [refTrack, setRefTrack] = useState(tracks[0] ?? '');
	const markerNames = useMemo(
		() => [
			...new Set(clipIds.flatMap((id) => seq.clips[id]?.markers.map((m) => m.name) ?? []).filter(Boolean)),
		],
		[seq, clipIds],
	);
	const run = async () => {
		setError(null);
		let audioOffsets: Record<string, number> | undefined;
		if (method === 'audio') {
			if (!audio.offsets) {
				try {
					const units = synchronizeUnits(seq, clipIds, 'audio');
					const clips = audioSyncClipsForUnits(session.getCommitted(), seq, units);
					const ref = synchronizeReference(seq, units, refTrack ? { referenceTrackId: refTrack } : {});
					const names = Object.fromEntries(units.map((u) => [u.repId, seq.clips[u.repId]?.name ?? u.repId]));
					audio.setBusy(true);
					const m = await measureAudio(engine, clips, ref >= 0 ? clips[ref]!.key : undefined, names);
					audio.setBusy(false);
					audio.setReport(m.report);
					if (m.report.some((r) => r.error)) {
						setError('Some clips have no common audio with the reference');
						return false;
					}
					if (m.report.some((r) => !r.reliable)) {
						audio.setOffsets(m.offsets);
						return false;
					}
					audioOffsets = m.offsets;
				} catch (e) {
					audio.setBusy(false);
					setError(e instanceof SyncError || e instanceof Error ? e.message : String(e));
					return false;
				}
			} else audioOffsets = audio.offsets;
		}
		const r = session.apply({
			label: `Synchronize`,
			origin: 'user',
			sequenceId,
			commands: [
				{
					type: 'clip.synchronize',
					clipIds,
					...syncFields(method, ignoreHours, marker, 0),
					...(refTrack ? { referenceTrack: refTrack } : {}),
					...(audioOffsets ? { audioOffsets } : {}),
				} as never,
			],
		});
		if (!r.ok) {
			setError(r.errors[0]?.message ?? 'Synchronize failed');
			return false;
		}
		finish(r.results[0]);
		return true;
	};
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => !o && finish()}
			title="Synchronize Clips"
			size="small"
			primaryLabel={audio.busy ? 'Analysing…' : audio.offsets ? 'Synchronize Anyway' : 'OK'}
			primaryDisabled={audio.busy}
			onPrimary={run}
			data-testid="synchronize-dialog"
		>
			<div className="flex flex-col gap-3 text-pr-ui">
				<SyncPoint
					method={method}
					setMethod={(m) => {
						setMethod(m);
						audio.setOffsets(null);
						audio.setReport(null);
					}}
					ignoreHours={ignoreHours}
					setIgnoreHours={setIgnoreHours}
					marker={marker}
					setMarker={setMarker}
					markerNames={markerNames}
					labels={{
						in: 'Clip Start',
						out: 'Clip End',
						timecode: 'Timecode',
						marker: 'Clip Marker',
						audio: 'Audio',
					}}
				/>
				<Row label="Synchronize on track">
					<Select
						value={refTrack}
						onValueChange={(v) => {
							setRefTrack(v);
							audio.setOffsets(null);
						}}
						options={tracks.map((t) => ({ value: t, label: trackLabel(seq, t) ?? t }))}
						label="Reference track"
						id="sync-ref-track"
					/>
				</Row>
				{audio.report ? <Report report={audio.report} /> : null}
				{error ? (
					<p className="text-pr-small text-pr-danger" role="alert">
						{error}
					</p>
				) : null}
			</div>
		</Dialog>
	);
}

// ---------------------------------------------------------------- Merge Clips

type ItemsProps = { session: EditorSession; engine: EngineClient; itemIds: string[] };

function itemNames(session: EditorSession, ids: string[]): Record<string, string> {
	const doc = session.getCommitted();
	return Object.fromEntries(ids.map((id) => [id, doc.items[id]?.name ?? id]));
}

function itemMarkerNames(session: EditorSession, ids: string[]): string[] {
	const doc = session.getCommitted();
	return [
		...new Set(
			ids.flatMap((id) =>
				((doc.items[id] as { markers?: { name: string }[] } | undefined)?.markers ?? []).map((m) => m.name),
			),
		),
	].filter(Boolean);
}

export function MergeClipsDialog(props: HostedDialogProps<ItemsProps>) {
	const { session, engine, itemIds } = props;
	const { open, finish } = useClose(props.close);
	const doc = session.getCommitted();
	const video = itemIds.find((id) => {
		const it = doc.items[id];
		return it?.kind === 'media' && doc.media[it.mediaId]?.kind === 'video';
	});
	const [name, setName] = useState(`${doc.items[video ?? itemIds[0] ?? '']?.name ?? 'Clip'} - Merged`);
	const [method, setMethod] = useState<SyncMethod>('in');
	const [ignoreHours, setIgnoreHours] = useState(false);
	const [marker, setMarker] = useState('');
	const [removeVideoAudio, setRemoveVideoAudio] = useState(false);
	const [offset, setOffset] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const audio = useAudioStep();
	const run = async () => {
		setError(null);
		let audioOffsets: Record<string, number> | undefined;
		if (method === 'audio') {
			if (!audio.offsets) {
				try {
					const clips = audioSyncClipsForItems(session.getCommitted(), itemIds);
					audio.setBusy(true);
					const m = await measureAudio(engine, clips, video, itemNames(session, itemIds));
					audio.setBusy(false);
					audio.setReport(m.report);
					if (m.report.some((r) => r.error)) {
						setError('Some clips have no common audio with the video');
						return false;
					}
					if (m.report.some((r) => !r.reliable)) {
						audio.setOffsets(m.offsets);
						return false;
					}
					audioOffsets = m.offsets;
				} catch (e) {
					audio.setBusy(false);
					setError((e as Error).message);
					return false;
				}
			} else audioOffsets = audio.offsets;
		}
		const r = session.apply({
			label: 'Merge Clips',
			origin: 'user',
			commands: [
				{
					type: 'item.mergeClips',
					itemIds,
					name: name.trim() || undefined,
					removeVideoAudio,
					...syncFields(method, ignoreHours, marker, offset),
					...(audioOffsets ? { audioOffsets } : {}),
				} as never,
			],
		});
		if (!r.ok) {
			setError(r.errors[0]?.message ?? 'Merge Clips failed');
			return false;
		}
		session.select('project', [(r.results[0] as { itemId: string }).itemId], 'replace');
		finish(r.results[0]);
		return true;
	};
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => !o && finish()}
			title="Merge Clips"
			size="small"
			primaryLabel={audio.busy ? 'Analysing…' : audio.offsets ? 'Merge Anyway' : 'OK'}
			primaryDisabled={audio.busy}
			onPrimary={run}
			data-testid="merge-clips-dialog"
		>
			<div className="flex flex-col gap-3 text-pr-ui">
				<Row label="Name">
					<TextField
						value={name}
						onChange={(e) => setName(e.target.value)}
						aria-label="Merged clip name"
						data-testid="merge-name"
					/>
				</Row>
				<SyncPoint
					method={method}
					setMethod={(m) => {
						setMethod(m);
						audio.setOffsets(null);
						audio.setReport(null);
					}}
					ignoreHours={ignoreHours}
					setIgnoreHours={setIgnoreHours}
					marker={marker}
					setMarker={setMarker}
					markerNames={itemMarkerNames(session, itemIds)}
					labels={{
						in: 'In Point',
						out: 'Out Point',
						timecode: 'Matching Timecode',
						marker: 'Clip Marker',
						audio: 'Audio',
					}}
				/>
				<Row label="Offset Audio by (frames)">
					<TextField
						type="number"
						value={String(offset)}
						onChange={(e) => setOffset(Math.round(Number(e.target.value) || 0))}
						aria-label="Offset audio by frames"
					/>
				</Row>
				<Checkbox
					checked={removeVideoAudio}
					onCheckedChange={setRemoveVideoAudio}
					label="Remove Audio From AV Clip"
					id="merge-remove-av-audio"
				/>
				{audio.report ? <Report report={audio.report} /> : null}
				{error ? (
					<p className="text-pr-small text-pr-danger" role="alert">
						{error}
					</p>
				) : null}
			</div>
		</Dialog>
	);
}

// ---------------------------------------------------------------- Create Multi-Camera Source Sequence

export function CreateMulticamDialog(props: HostedDialogProps<ItemsProps>) {
	const { session, engine, itemIds } = props;
	const { open, finish } = useClose(props.close);
	const doc = session.getCommitted();
	const firstName = doc.items[itemIds[0] ?? '']?.name ?? 'Clip';
	const [nameMode, setNameMode] = useState<'clip' | 'custom'>('clip');
	const [custom, setCustom] = useState(`${firstName} Multicam`);
	const [method, setMethod] = useState<SyncMethod>('in');
	const [ignoreHours, setIgnoreHours] = useState(false);
	const [marker, setMarker] = useState('');
	const [offset, setOffset] = useState(0);
	const [preset, setPreset] = useState('automatic');
	const [processed, setProcessed] = useState(false);
	const [audioMode, setAudioMode] = useState<MulticamAudioMode>('camera1');
	const [cameraNames, setCameraNames] = useState<'enumerate' | 'clip'>('enumerate');
	const [order, setOrder] = useState<'selection' | 'name' | 'timecode'>('selection');
	const [error, setError] = useState<string | null>(null);
	const audio = useAudioStep();
	const presets = session.ctx.registries.presets.list();
	const run = async () => {
		setError(null);
		let audioOffsets: Record<string, number> | undefined;
		if (method === 'audio') {
			if (!audio.offsets) {
				try {
					const clips = audioSyncClipsForItems(session.getCommitted(), itemIds);
					audio.setBusy(true);
					const m = await measureAudio(engine, clips, undefined, itemNames(session, itemIds));
					audio.setBusy(false);
					audio.setReport(m.report);
					if (m.report.some((r) => r.error)) {
						setError('Some clips have no common audio');
						return false;
					}
					if (m.report.some((r) => !r.reliable)) {
						audio.setOffsets(m.offsets);
						return false;
					}
					audioOffsets = m.offsets;
				} catch (e) {
					audio.setBusy(false);
					setError((e as Error).message);
					return false;
				}
			} else audioOffsets = audio.offsets;
		}
		const r = session.apply({
			label: 'Create Multi-Camera Source Sequence',
			origin: 'user',
			commands: [
				{
					type: 'multicam.create',
					itemIds,
					...(nameMode === 'custom' && custom.trim() ? { name: custom.trim() } : {}),
					...syncFields(method, ignoreHours, marker, offset),
					preset,
					audio: audioMode,
					cameraNames,
					order,
					moveToProcessedBin: processed,
					...(audioOffsets ? { audioOffsets } : {}),
				} as never,
			],
		});
		if (!r.ok) {
			setError(r.errors[0]?.message ?? 'Create Multi-Camera Source Sequence failed');
			return false;
		}
		session.select('project', [(r.results[0] as { itemId: string }).itemId], 'replace');
		finish(r.results[0]);
		return true;
	};
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => !o && finish()}
			title="Create Multi-Camera Source Sequence"
			size="medium"
			primaryLabel={audio.busy ? 'Analysing…' : audio.offsets ? 'Create Anyway' : 'OK'}
			primaryDisabled={audio.busy}
			onPrimary={run}
			data-testid="create-multicam-dialog"
		>
			<div className="flex flex-col gap-3 text-pr-ui">
				<Row label="Name">
					<Select
						value={nameMode}
						onValueChange={(v) => setNameMode(v as 'clip' | 'custom')}
						options={[
							{ value: 'clip', label: 'Video Clip Name + Multicam' },
							{ value: 'custom', label: 'Custom' },
						]}
						label="Name"
						id="mc-name-mode"
					/>
					{nameMode === 'custom' ? (
						<TextField
							value={custom}
							onChange={(e) => setCustom(e.target.value)}
							aria-label="Sequence name"
							data-testid="mc-name"
						/>
					) : null}
				</Row>
				<SyncPoint
					method={method}
					setMethod={(m) => {
						setMethod(m);
						audio.setOffsets(null);
						audio.setReport(null);
					}}
					ignoreHours={ignoreHours}
					setIgnoreHours={setIgnoreHours}
					marker={marker}
					setMarker={setMarker}
					markerNames={itemMarkerNames(session, itemIds)}
					labels={{ in: 'In', out: 'Out', timecode: 'Timecode', marker: 'Clip Marker', audio: 'Audio' }}
				/>
				<Row label="Sequence Offset (frames)">
					<TextField
						type="number"
						value={String(offset)}
						onChange={(e) => setOffset(Math.round(Number(e.target.value) || 0))}
						aria-label="Sequence offset frames"
					/>
				</Row>
				<Row label="Sequence Preset">
					<Select
						value={preset}
						onValueChange={setPreset}
						options={[
							{ value: 'automatic', label: 'Automatic' },
							...presets.map((p) => ({ value: p.id, label: p.name })),
						]}
						label="Sequence Preset"
						id="mc-preset"
					/>
				</Row>
				<Checkbox
					checked={processed}
					onCheckedChange={setProcessed}
					label="Move source clips to Processed Clips bin"
					id="mc-processed"
				/>
				<Row label="Audio">
					<Select
						value={audioMode}
						onValueChange={(v) => setAudioMode(v as MulticamAudioMode)}
						options={[
							{ value: 'camera1', label: 'Camera 1' },
							{ value: 'all', label: 'All Cameras' },
							{ value: 'switch', label: 'Switch Audio' },
						]}
						label="Audio Sequence Settings"
						id="mc-audio"
					/>
				</Row>
				<Row label="Camera Names">
					<Select
						value={cameraNames}
						onValueChange={(v) => setCameraNames(v as 'enumerate' | 'clip')}
						options={[
							{ value: 'enumerate', label: 'Enumerate Angles' },
							{ value: 'clip', label: 'Use Clip Names' },
						]}
						label="Camera Names"
						id="mc-camera-names"
					/>
				</Row>
				<Row label="Camera Order">
					<Select
						value={order}
						onValueChange={(v) => setOrder(v as 'selection' | 'name' | 'timecode')}
						options={[
							{ value: 'selection', label: 'Selection Order' },
							{ value: 'name', label: 'Clip Name' },
							{ value: 'timecode', label: 'Start Timecode' },
						]}
						label="Camera Order"
						id="mc-order"
					/>
				</Row>
				{audio.report ? <Report report={audio.report} /> : null}
				{error ? (
					<p className="text-pr-small text-pr-danger" role="alert">
						{error}
					</p>
				) : null}
			</div>
		</Dialog>
	);
}

// ---------------------------------------------------------------- Edit Cameras

type EditCamerasProps = { session: EditorSession; sequenceId: string };

export function EditCamerasDialog(props: HostedDialogProps<EditCamerasProps>) {
	const { session, sequenceId } = props;
	const { open, finish } = useClose(props.close);
	const mc = (session.getCommitted().sequences[sequenceId] as Sequence | undefined)?.multicam as
		| MulticamSource
		| undefined;
	const [angles, setAngles] = useState(() => (mc?.angles ?? []).map((a) => ({ ...a })));
	const [audioMode, setAudioMode] = useState<MulticamAudioMode>(mc?.audio ?? 'camera1');
	const [error, setError] = useState<string | null>(null);
	const move = (i: number, d: number) =>
		setAngles((list) => {
			const j = i + d;
			if (j < 0 || j >= list.length) return list;
			const next = [...list];
			[next[i], next[j]] = [next[j]!, next[i]!];
			return next;
		});
	const apply = () => {
		const r = session.apply({
			label: 'Edit Cameras',
			origin: 'user',
			commands: [
				{
					type: 'multicam.editAngles',
					sequenceId,
					angles: angles.map((a) => ({ angle: a.id, name: a.name.trim() || a.id, enabled: a.enabled })),
					order: angles.map((a) => a.id),
					audio: audioMode,
				} as never,
			],
		});
		if (!r.ok) {
			setError(r.errors[0]?.message ?? 'Edit Cameras failed');
			return false;
		}
		finish(r.results[0]);
		return true;
	};
	let camera = 0;
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => !o && finish()}
			title="Edit Cameras"
			size="small"
			primaryLabel="OK"
			onPrimary={apply}
			data-testid="edit-cameras-dialog"
		>
			<div className="flex flex-col gap-2 text-pr-ui">
				{angles.map((a, i) => {
					const shown = a.enabled && a.videoTrackId !== null;
					if (shown) camera++;
					return (
						<div key={a.id} className="flex items-center gap-2" data-testid={`edit-camera-${i}`}>
							<span className="w-6 text-right text-pr-muted">{shown ? camera : '–'}</span>
							<Checkbox
								checked={a.enabled}
								onCheckedChange={(v) =>
									setAngles((l) => l.map((x) => (x.id === a.id ? { ...x, enabled: v } : x)))
								}
								label=""
								id={`edit-camera-enabled-${i}`}
							/>
							<TextField
								value={a.name}
								onChange={(e) =>
									setAngles((l) => l.map((x) => (x.id === a.id ? { ...x, name: e.target.value } : x)))
								}
								aria-label={`Camera ${i + 1} name`}
							/>
							<Button variant="quiet" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">
								↑
							</Button>
							<Button
								variant="quiet"
								onClick={() => move(i, 1)}
								disabled={i === angles.length - 1}
								aria-label="Move down"
							>
								↓
							</Button>
						</div>
					);
				})}
				<Row label="Audio">
					<Select
						value={audioMode}
						onValueChange={(v) => setAudioMode(v as MulticamAudioMode)}
						options={[
							{ value: 'camera1', label: 'Camera 1' },
							{ value: 'all', label: 'All Cameras' },
							{ value: 'switch', label: 'Switch Audio' },
						]}
						label="Audio"
						id="edit-cameras-audio"
					/>
				</Row>
				{error ? (
					<p className="text-pr-small text-pr-danger" role="alert">
						{error}
					</p>
				) : null}
			</div>
		</Dialog>
	);
}
