// Audio dialogs (audio-mix): Audio Gain (Premiere's G), Auto Duck, Loudness Normalization of the Mix (+ analysis)
// and Normalize Loudness of a media (a normalised version). Opened through the dialog host (registerAudioDialogs).
import type { AudioAnalyzeResult } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import { DUCK_DEFAULTS, type Sequence } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import {
	Checkbox,
	Dialog,
	type HostedDialogProps,
	registerDialog,
	ScrubbyNumber,
	Select,
	toast,
} from '@jasper/ui';
import { useId, useMemo, useState } from 'react';
import { useEngineOrNull } from '../state/engine.tsx';
import {
	analyzeAudio,
	analyzeSequenceLoudness,
	autoDuck,
	clipPeaks,
	loudnessAnalysisStale,
	normalizeMediaLoudness,
} from './engine-ops.ts';

export const AUDIO_GAIN_DIALOG = 'audio.gain';
export const AUTO_DUCK_DIALOG = 'audio.autoDuck';
export const LOUDNESS_DIALOG = 'audio.loudness';
export const NORMALIZE_MEDIA_DIALOG = 'audio.normalizeMedia';

/** Loudness targets (S05:EX-010 / S04:RN-032): streaming, podcast, EBU R128, ATSC A/85. */
export const LOUDNESS_PRESETS = [
	{ id: 'streaming', label: 'Streaming (−14 LUFS)', lufs: -14 },
	{ id: 'podcast', label: 'Podcast (−16 LUFS)', lufs: -16 },
	{ id: 'ebu', label: 'EBU R128 (−23 LUFS)', lufs: -23 },
	{ id: 'atsc', label: 'ATSC A/85 (−24 LKFS)', lufs: -24 },
	{ id: 'custom', label: 'Custom', lufs: null },
] as const;

const fmt = (v: number | null | undefined, unit: string) =>
	v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v.toFixed(1)} ${unit}`;

function Row(props: { label: string; children: React.ReactNode; id?: string }) {
	return (
		<div className="flex min-h-[26px] items-center gap-2">
			<label htmlFor={props.id} className="w-44 shrink-0 text-pr-muted">
				{props.label}
			</label>
			<div className="flex min-w-0 flex-1 items-center gap-2">{props.children}</div>
		</div>
	);
}

// ------------------------------------------------------------------ Audio Gain

type GainMode = 'set' | 'adjust' | 'normalizeMax' | 'normalizeAll';

export type AudioGainProps = {
	session: EditorSession;
	/** Default: the editor's engine. */
	engine?: EngineClient;
	sequenceId: string;
	clipIds: string[];
};

/**
 * Premiere's Audio Gain dialog: Set Gain to, Adjust Gain by, Normalize Max Peak to, Normalize All Peaks to. The
 * normalise modes measure each clip's source peak on the engine first (the Peak Amplitude readout).
 */
function AudioGainDialog(props: HostedDialogProps<AudioGainProps>) {
	const { session, sequenceId, clipIds } = props;
	const engine = useDialogEngine(props.engine);
	const doc = session.getCommitted();
	const seq = doc.sequences[sequenceId] as Sequence | undefined;
	const clips = clipIds.map((id) => seq?.clips[id]).filter((c) => !!c) as { id: string; gainDb: number }[];
	const same = clips.every((c) => c.gainDb === clips[0]?.gainDb);
	const [mode, setMode] = useState<GainMode>('set');
	const [values, setValues] = useState<Record<GainMode, number>>({
		set: same ? (clips[0]?.gainDb ?? 0) : 0,
		adjust: 0,
		normalizeMax: 0,
		normalizeAll: 0,
	});
	const [peaks, setPeaks] = useState<Record<string, number | null> | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const measure = async () => {
		setBusy(true);
		setError(null);
		try {
			setPeaks(await clipPeaks(session, need(engine), sequenceId, clipIds));
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	};
	const peakText = useMemo(() => {
		if (!peaks) return null;
		const vals = clips.map((c) => (peaks[c.id] ?? -Infinity) + c.gainDb).filter((v) => Number.isFinite(v));
		return vals.length ? `${Math.max(...vals).toFixed(1)} dB` : 'silent';
	}, [peaks, clips]);
	const radio = (m: GainMode, label: string, unit: string) => (
		<div className="flex min-h-[26px] items-center gap-2">
			<label className="flex w-52 shrink-0 items-center gap-2">
				<input
					type="radio"
					name="audio-gain-mode"
					checked={mode === m}
					onChange={() => {
						setMode(m);
						if ((m === 'normalizeMax' || m === 'normalizeAll') && !peaks) void measure();
					}}
					data-testid={`audio-gain-${m}`}
				/>
				{label}
			</label>
			<ScrubbyNumber
				label={label}
				value={values[m]}
				min={-96}
				max={96}
				step={0.1}
				precision={1}
				unit={unit}
				disabled={mode !== m}
				onCommit={(v) => setValues((x) => ({ ...x, [m]: v }))}
				onScrub={(v) => setValues((x) => ({ ...x, [m]: v }))}
				onScrubEnd={(v) => setValues((x) => ({ ...x, [m]: v }))}
			/>
		</div>
	);
	return (
		<Dialog
			open
			onOpenChange={(o) => !o && props.close()}
			title="Audio Gain"
			size="small"
			primaryLabel="OK"
			primaryDisabled={busy || ((mode === 'normalizeMax' || mode === 'normalizeAll') && !peaks)}
			onPrimary={() => {
				const r = session.apply({
					label: 'Audio Gain',
					origin: 'user',
					commands: [
						{
							type: 'audio.setGain',
							clipIds,
							mode,
							db: values[mode],
							...(peaks ? { peaks } : {}),
						},
					] as never,
				});
				if (!r.ok) {
					setError(r.errors[0]?.message ?? 'Audio Gain failed');
					return false;
				}
				props.close(true);
				return false;
			}}
			data-testid="audio-gain-dialog"
		>
			<div className="flex flex-col gap-1">
				{radio('set', 'Set Gain to:', 'dB')}
				{radio('adjust', 'Adjust Gain by:', 'dB')}
				{radio('normalizeMax', 'Normalize Max Peak to:', 'dB')}
				{radio('normalizeAll', 'Normalize All Peaks to:', 'dB')}
				<div className="mt-2 flex items-center gap-2 text-pr-muted">
					<span>Peak Amplitude:</span>
					<span className="pr-tabular text-pr-text" data-testid="audio-gain-peak">
						{busy ? 'measuring…' : (peakText ?? '—')}
					</span>
					{!peaks && !busy ? (
						<button type="button" className="text-pr-accent underline" onClick={() => void measure()}>
							Measure
						</button>
					) : null}
				</div>
				{error ? <div className="text-pr-small text-pr-danger">{error}</div> : null}
			</div>
		</Dialog>
	);
}

// ------------------------------------------------------------------ Auto Duck

export type AutoDuckProps = {
	session: EditorSession;
	/** Default: the editor's engine. */
	engine?: EngineClient;
	sequenceId: string;
	clipIds: string[];
};

/** Essential Sound ▸ Ducking as a dialog: duck the selected clips under the chosen trigger tracks. */
function AutoDuckDialog(props: HostedDialogProps<AutoDuckProps>) {
	const { session, sequenceId, clipIds } = props;
	const engine = useDialogEngine(props.engine);
	const seq = session.getCommitted().sequences[sequenceId] as Sequence | undefined;
	const targetTracks = new Set(clipIds.map((id) => seq?.clips[id]?.trackId));
	const tracks = seq?.audioTracks ?? [];
	const [triggers, setTriggers] = useState<Set<string>>(
		() => new Set(tracks.filter((t) => !targetTracks.has(t.id)).map((t) => t.id)),
	);
	const [sensitivity, setSensitivity] = useState<number>(DUCK_DEFAULTS.sensitivity);
	const [amount, setAmount] = useState<number>(DUCK_DEFAULTS.amountDb);
	const [fade, setFade] = useState<number>(DUCK_DEFAULTS.fadeMs);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	return (
		<Dialog
			open
			onOpenChange={(o) => !o && props.close()}
			title="Auto Duck"
			size="small"
			primaryLabel={busy ? 'Generating…' : 'Generate Keyframes'}
			primaryDisabled={busy || triggers.size === 0}
			onPrimary={async () => {
				setBusy(true);
				setError(null);
				try {
					const r = await autoDuck(session, need(engine), {
						sequenceId,
						targetClipIds: clipIds,
						triggers: { trackIds: [...triggers] },
						sensitivity,
						amountDb: amount,
						fadeMs: fade,
					});
					toast({
						kind: 'success',
						title: `Ducked ${clipIds.length} ${clipIds.length === 1 ? 'clip' : 'clips'}`,
						detail: `${r.regions.length} trigger ${r.regions.length === 1 ? 'region' : 'regions'}`,
					});
					props.close(true);
				} catch (e) {
					setError((e as Error).message);
				} finally {
					setBusy(false);
				}
				return false;
			}}
			data-testid="auto-duck-dialog"
		>
			<div className="flex flex-col gap-1">
				<div className="text-pr-muted">Duck the {clipIds.length} selected clip(s) against:</div>
				<div className="flex flex-wrap gap-x-3 gap-y-1 py-1">
					{tracks.map((t, i) => (
						<Checkbox
							key={t.id}
							checked={triggers.has(t.id)}
							disabled={targetTracks.has(t.id)}
							label={t.name ?? `A${i + 1}`}
							onCheckedChange={(on) =>
								setTriggers((s) => {
									const n = new Set(s);
									if (on) n.add(t.id);
									else n.delete(t.id);
									return n;
								})
							}
						/>
					))}
				</div>
				<Row label="Sensitivity">
					<ScrubbyNumber
						label="Sensitivity"
						value={sensitivity}
						min={0}
						max={10}
						step={0.1}
						precision={1}
						onCommit={setSensitivity}
						onScrub={setSensitivity}
					/>
				</Row>
				<Row label="Reduce By">
					<ScrubbyNumber
						label="Reduce by"
						value={-amount}
						min={-96}
						max={0}
						step={0.1}
						precision={1}
						unit="dB"
						onCommit={(v) => setAmount(-v)}
						onScrub={(v) => setAmount(-v)}
					/>
				</Row>
				<Row label="Fades">
					<ScrubbyNumber
						label="Fades"
						value={fade}
						min={0}
						max={10_000}
						step={10}
						precision={0}
						unit="ms"
						onCommit={setFade}
						onScrub={setFade}
					/>
				</Row>
				{error ? <div className="text-pr-small text-pr-danger">{error}</div> : null}
			</div>
		</Dialog>
	);
}

// ------------------------------------------------------------------ Loudness Normalization (the Mix)

export type LoudnessProps = { session: EditorSession; engine: EngineClient; sequenceId: string };

function LoudnessDialog(props: HostedDialogProps<LoudnessProps>) {
	const { session, sequenceId } = props;
	const engine = useDialogEngine(props.engine);
	const seq = session.getCommitted().sequences[sequenceId] as Sequence | undefined;
	const cur = seq?.master.loudness;
	const [enabled, setEnabled] = useState(cur?.enabled ?? true);
	const [target, setTarget] = useState(cur?.targetLufs ?? -23);
	const [tp, setTp] = useState(cur?.truePeakDb ?? -1);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [result, setResult] = useState<AudioAnalyzeResult | null>(null);
	const preset = LOUDNESS_PRESETS.find((p) => p.lufs === target)?.id ?? 'custom';
	const stale = loudnessAnalysisStale(session.getCommitted(), sequenceId);
	const a =
		result?.loudness ??
		(cur?.analysis
			? {
					integratedLufs: cur.analysis.integratedLufs,
					truePeakDbtp: cur.analysis.truePeakDbtp,
					lra: cur.analysis.lra,
				}
			: null);
	const presetId = useId();
	return (
		<Dialog
			open
			onOpenChange={(o) => !o && props.close()}
			title="Loudness Normalization"
			size="medium"
			primaryLabel="OK"
			primaryDisabled={busy}
			onPrimary={() => {
				const r = session.apply({
					label: 'Loudness Normalization',
					origin: 'user',
					commands: [
						{ type: 'mixer.setLoudness', sequenceId, enabled, targetLufs: target, truePeakDb: tp },
					] as never,
				});
				if (!r.ok) {
					setError(r.errors[0]?.message ?? 'Failed');
					return false;
				}
				props.close(true);
				return false;
			}}
			footerExtra={
				<button
					type="button"
					disabled={busy}
					className="text-pr-accent underline disabled:opacity-40"
					onClick={async () => {
						setBusy(true);
						setError(null);
						try {
							setResult(await analyzeSequenceLoudness(session, need(engine), sequenceId));
						} catch (e) {
							setError((e as Error).message);
						} finally {
							setBusy(false);
						}
					}}
					data-testid="loudness-analyze"
				>
					{busy ? 'Analyzing…' : 'Analyze'}
				</button>
			}
			data-testid="loudness-dialog"
		>
			<div className="flex flex-col gap-1">
				<Checkbox
					checked={enabled}
					onCheckedChange={setEnabled}
					label="Normalize the Mix to the target loudness (preview and export)"
				/>
				<Row label="Target" id={presetId}>
					<Select
						id={presetId}
						value={preset}
						onValueChange={(v) => {
							const p = LOUDNESS_PRESETS.find((x) => x.id === v);
							if (p?.lufs !== null && p?.lufs !== undefined) setTarget(p.lufs);
						}}
						options={LOUDNESS_PRESETS.map((p) => ({ value: p.id, label: p.label }))}
					/>
					<ScrubbyNumber
						label="Target loudness"
						value={target}
						min={-60}
						max={0}
						step={0.1}
						precision={1}
						unit="LUFS"
						onCommit={setTarget}
						onScrub={setTarget}
					/>
				</Row>
				<Row label="True Peak Limit">
					<ScrubbyNumber
						label="True peak limit"
						value={tp}
						min={-20}
						max={0}
						step={0.1}
						precision={1}
						unit="dBTP"
						onCommit={setTp}
						onScrub={setTp}
					/>
				</Row>
				<div className="mt-2 rounded-pr-control bg-pr-field p-2 pr-tabular" data-testid="loudness-analysis">
					<div className="mb-1 text-pr-muted">
						Analysis of the Mix (ITU-R BS.1770-4)
						{a && stale && !result ? ' — out of date: analyze again' : ''}
					</div>
					<div>Integrated: {fmt(a?.integratedLufs, 'LUFS')}</div>
					<div>True Peak: {fmt(a?.truePeakDbtp, 'dBTP')}</div>
					<div>Loudness Range: {fmt(a?.lra, 'LU')}</div>
					{a?.integratedLufs !== null && a?.integratedLufs !== undefined ? (
						<div className="mt-1 text-pr-muted">
							Gain to target: {(target - a.integratedLufs).toFixed(1)} dB (true peaks limited at{' '}
							{tp.toFixed(1)} dBTP)
						</div>
					) : null}
				</div>
				{error ? <div className="text-pr-small text-pr-danger">{error}</div> : null}
			</div>
		</Dialog>
	);
}

// ------------------------------------------------------------------ Normalize Loudness (media version)

export type NormalizeMediaProps = {
	session: EditorSession;
	/** Default: the editor's engine. */
	engine?: EngineClient;
	mediaId: string;
	/** Audio clips of this media to switch to the normalised version. */
	clipIds: string[];
};

function NormalizeMediaDialog(props: HostedDialogProps<NormalizeMediaProps>) {
	const { session, mediaId, clipIds } = props;
	const engine = useDialogEngine(props.engine);
	const [target, setTarget] = useState(-16);
	const [tp, setTp] = useState(-1);
	const [replace, setReplace] = useState(clipIds.length > 0);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const name = session.getCommitted().media[mediaId]?.originalName ?? mediaId;
	return (
		<Dialog
			open
			onOpenChange={(o) => !o && props.close()}
			title="Normalize Loudness"
			size="small"
			primaryLabel={busy ? 'Normalizing…' : 'Normalize'}
			primaryDisabled={busy}
			onPrimary={async () => {
				setBusy(true);
				setError(null);
				try {
					const r = await normalizeMediaLoudness(session, need(engine), mediaId, {
						targetLufs: target,
						truePeakDb: tp,
						...(replace ? { replaceInClips: clipIds } : {}),
					});
					toast({
						kind: 'success',
						title: 'Normalized version added',
						detail: `${fmt(r.before.integratedLufs, 'LUFS')} → ${fmt(r.after.integratedLufs, 'LUFS')}, true peak ${fmt(r.after.truePeakDbtp, 'dBTP')}`,
					});
					props.close(true);
				} catch (e) {
					setError((e as Error).message);
				} finally {
					setBusy(false);
				}
				return false;
			}}
			data-testid="normalize-media-dialog"
		>
			<div className="flex flex-col gap-1">
				<div className="truncate text-pr-muted">{name}</div>
				<Row label="Target">
					<ScrubbyNumber
						label="Target loudness"
						value={target}
						min={-60}
						max={0}
						step={0.1}
						precision={1}
						unit="LUFS"
						onCommit={setTarget}
						onScrub={setTarget}
					/>
				</Row>
				<Row label="True Peak Limit">
					<ScrubbyNumber
						label="True peak limit"
						value={tp}
						min={-20}
						max={0}
						step={0.1}
						precision={1}
						unit="dBTP"
						onCommit={setTp}
						onScrub={setTp}
					/>
				</Row>
				{clipIds.length ? (
					<Checkbox
						checked={replace}
						onCheckedChange={setReplace}
						label={`Use it in the ${clipIds.length} selected audio clip(s)`}
					/>
				) : null}
				{error ? <div className="text-pr-small text-pr-danger">{error}</div> : null}
			</div>
		</Dialog>
	);
}

/** The engine of a dialog: its prop, else the editor's engine (dialogs opened from context menus). */
function useDialogEngine(e: EngineClient | undefined): EngineClient | null {
	const fallback = useEngineOrNull()?.client;
	return e ?? fallback ?? null;
}

/** Inside the dialogs' try blocks: the engine, or an error the dialog shows. */
function need(engine: EngineClient | null): EngineClient {
	if (!engine) throw new Error('The engine is not connected');
	return engine;
}

let registered = false;
export function registerAudioDialogs(): void {
	if (registered) return;
	registered = true;
	registerDialog(AUDIO_GAIN_DIALOG, AudioGainDialog);
	registerDialog(AUTO_DUCK_DIALOG, AutoDuckDialog);
	registerDialog(LOUDNESS_DIALOG, LoudnessDialog);
	registerDialog(NORMALIZE_MEDIA_DIALOG, NormalizeMediaDialog);
}

/** Measures loudness of clips / a range and reports it (Clip ▸ Measure Loudness). */
export async function reportLoudness(
	session: EditorSession,
	engine: EngineClient,
	sequenceId: string,
	clipIds: string[],
): Promise<void> {
	const r = await analyzeAudio(session, engine, {
		sequenceId,
		scope: clipIds.length ? { type: 'clips', clipIds } : { type: 'sequence' },
	});
	const l = r.loudness;
	toast({
		kind: 'info',
		title: `Loudness ${fmt(l.integratedLufs, 'LUFS')}`,
		detail: `True peak ${fmt(l.truePeakDbtp, 'dBTP')} · LRA ${fmt(l.lra, 'LU')} · max momentary ${fmt(l.maxMomentaryLufs, 'LUFS')}`,
	});
}
