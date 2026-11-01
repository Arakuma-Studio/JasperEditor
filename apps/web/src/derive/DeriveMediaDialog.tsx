// Derive Media ▸ <op>… (spec 18 AF-OPS-002): one dialog per derivation op with its fields, live validation with the
// engine's refusal codes, and the job's progress. Derive queues `POST /api/media/:key/derive`, follows the job and
// commits ONE `media.derive` ("Derive Media", undoable); engine refusals and job failures are shown in the dialog
// as `CODE — explanation`. Closing the dialog while the job runs keeps it running: the result is still added.
import type { EngineJob } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import type { DeriveOp, MediaAsset } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { Checkbox, Dialog, type HostedDialogProps, ScrubbyNumber, Select, toast } from '@jasper/ui';
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { t } from '../i18n/runtime.ts';
import { useEngineOrNull } from '../state/engine.tsx';
import {
	DERIVE_DESCRIPTIONS,
	DERIVE_DIALOG_TITLES,
	DERIVE_ERROR_HINTS,
	DeriveError,
	type DeriveForm,
	type DeriveProblem,
	defaultDeriveForm,
	deriveFormProblems,
	durationSecOf,
	FPS_PRESETS,
	RATE_BOUNDS,
	recipeFromForm,
	runDerive,
} from './model.ts';

export type DeriveMediaDialogProps = {
	session: EditorSession;
	mediaId: string;
	op: DeriveOp;
	/** Default: the editor's engine. */
	engine?: EngineClient;
	/** Job polling interval (tests). */
	pollMs?: number;
};

function Row(props: { label: string; id?: string; children: ReactNode }) {
	return (
		<div className="flex min-h-[26px] items-center gap-2">
			<label htmlFor={props.id} className="w-40 shrink-0 text-pr-muted">
				{props.label}
			</label>
			<div className="flex min-w-0 flex-1 items-center gap-2">{props.children}</div>
		</div>
	);
}

function Problems(props: { problems: readonly DeriveProblem[] }) {
	if (!props.problems.length) return null;
	return (
		<ul
			className="flex flex-col gap-0.5 text-pr-small text-pr-danger"
			data-testid="derive-problems"
			role="alert"
		>
			{props.problems.map((p) => (
				<li key={`${p.code}:${p.field ?? ''}:${p.message}`} data-code={p.code}>
					<span className="font-semibold">{p.code}</span> — {DERIVE_ERROR_HINTS[p.code] ?? p.message}
					{DERIVE_ERROR_HINTS[p.code] && p.message !== DERIVE_ERROR_HINTS[p.code] ? (
						<span className="text-pr-muted"> ({p.message})</span>
					) : null}
				</li>
			))}
		</ul>
	);
}

const fmtSec = (s: number) => `${s.toFixed(3)} s`;

export function DeriveMediaDialog(props: HostedDialogProps<DeriveMediaDialogProps>) {
	const { session, mediaId, op } = props;
	const fallbackEngine = useEngineOrNull()?.client;
	const engine = props.engine ?? fallbackEngine ?? null;
	const doc = session.getCommitted();
	const asset = doc.media[mediaId] as MediaAsset | undefined;
	const item = Object.values(doc.items).find((it) => it.kind === 'media' && it.mediaId === mediaId) as
		| { name: string; marks?: { in: { flicks: number } | null; out: { flicks: number } | null } }
		| undefined;
	const [form, setForm] = useState<DeriveForm | null>(() =>
		asset ? defaultDeriveForm(asset, item?.marks ?? null) : null,
	);
	const [busy, setBusy] = useState(false);
	const [job, setJob] = useState<EngineJob | null>(null);
	const [failure, setFailure] = useState<DeriveProblem | null>(null);
	const open = useRef(true);
	// Unmounted without `close` (project switched, dialog host reset): a job still running reports through toasts.
	// (Set on mount too: React's dev StrictMode runs effect cleanups once on mount.)
	useEffect(() => {
		open.current = true;
		return () => {
			open.current = false;
		};
	}, []);
	const ids = { a: useId(), b: useId() };
	const problems = useMemo(
		() => (asset && form ? deriveFormProblems(asset, op, form) : []),
		[asset, form, op],
	);
	const set = (patch: Partial<DeriveForm>) => {
		setFailure(null);
		setForm((f) => (f ? { ...f, ...patch } : f));
	};
	const close = (result?: unknown) => {
		open.current = false;
		props.close(result);
	};
	if (!asset || !form)
		return (
			<Dialog open onOpenChange={(o) => !o && close()} title={DERIVE_DIALOG_TITLES[op]} size="small">
				<Problems
					problems={[{ code: 'ASSET_NOT_FOUND', message: t('The media is no longer in the project') }]}
				/>
			</Dialog>
		);
	const dur = durationSecOf(asset);
	const video = asset.probe.streams.find((s) => s.type === 'video');
	const audio = asset.probe.streams.filter((s) => s.type === 'audio');
	const name = item?.name ?? asset.originalName;

	const derive = async () => {
		if (!engine) {
			setFailure({ code: 'ENGINE_OFFLINE', message: t('The engine is not connected') });
			return false;
		}
		setBusy(true);
		setFailure(null);
		try {
			const r = await runDerive(session, engine, mediaId, recipeFromForm(op, form), {
				...(props.pollMs ? { pollMs: props.pollMs } : {}),
				onJob: (j) => {
					if (open.current) setJob(j);
				},
			});
			toast({
				kind: 'success',
				title: t('Derived media added to the Project panel'),
				detail: `${r.result.registered.originalName}${r.result.reused ? ` (${t('reused the finished file')})` : ''}`,
			});
			close(r);
		} catch (e) {
			const err = e instanceof DeriveError ? e : new DeriveError('DERIVE_FAILED', String(e));
			if (open.current) setFailure({ code: err.code, message: err.message });
			else toast({ kind: 'error', title: t('Derive Media failed'), detail: `${err.code}: ${err.message}` });
		} finally {
			if (open.current) {
				setBusy(false);
				setJob(null);
			}
		}
		return false;
	};

	const cancelJob = () => {
		if (job && engine) void engine.cancelJob(job.id).catch(() => undefined);
	};

	const shown = failure ? [failure] : problems;
	return (
		<Dialog
			open
			onOpenChange={(o) => !o && close()}
			title={DERIVE_DIALOG_TITLES[op]}
			description={DERIVE_DESCRIPTIONS[op]}
			size="small"
			primaryLabel={busy ? 'Deriving…' : 'Derive'}
			primaryDisabled={busy || problems.length > 0 || !engine}
			onPrimary={derive}
			footerExtra={
				busy && job ? (
					<button
						type="button"
						className="text-pr-small text-pr-muted underline hover:text-pr-text"
						onClick={cancelJob}
						data-testid="derive-cancel-job"
					>
						Stop
					</button>
				) : undefined
			}
			data-testid="derive-media-dialog"
		>
			<div className="flex flex-col gap-1" data-op={op}>
				<div className="truncate text-pr-muted">{name}</div>
				<div className="text-pr-small text-pr-muted">{DERIVE_DESCRIPTIONS[op]}</div>
				{op === 'conform-cfr' ? (
					<Row label="Frame Rate" id={ids.a}>
						<Select
							id={ids.a}
							label="Frame rate"
							value={form.fps}
							onValueChange={(v) => set({ fps: v })}
							options={FPS_PRESETS}
						/>
						{video?.type === 'video' ? (
							<span className="text-pr-small text-pr-muted">
								{asset.probe.variableFrameRate
									? t('source: variable, ≈ {0} fps', (video.frameRate.num / video.frameRate.den).toFixed(3))
									: t('source: {0} fps', (video.frameRate.num / video.frameRate.den).toFixed(3))}
							</span>
						) : null}
					</Row>
				) : null}
				{op === 'reverse' && dur !== null ? (
					<div className="text-pr-small text-pr-muted">{t('Length: {0}', fmtSec(dur))}</div>
				) : null}
				{op === 'denoise-audio' ? (
					<Row label="Strength" id={ids.a}>
						<ScrubbyNumber
							id={ids.a}
							label="Strength"
							value={Math.round(form.strength * 100)}
							min={0}
							max={100}
							step={1}
							unit="%"
							onCommit={(v) => set({ strength: v / 100 })}
							onScrub={(v) => set({ strength: v / 100 })}
						/>
						<span className="text-pr-small text-pr-muted">
							{t('noise reduction {0} dB', String(Math.round(6 + 30 * form.strength)))}
						</span>
					</Row>
				) : null}
				{op === 'extract-audio' ? (
					<>
						<Row label="Audio Stream" id={ids.a}>
							<Select
								id={ids.a}
								label="Audio stream"
								value={String(form.streamIndex)}
								onValueChange={(v) => set({ streamIndex: Number(v) })}
								options={audio.map((s) => ({
									value: String(s.index),
									label:
										s.type === 'audio'
											? t(
													'Stream {0} · {1} · {2} kHz · {3} ch',
													String(s.index),
													s.codec,
													(s.sampleRate / 1000).toFixed(1),
													String(s.channels),
												)
											: String(s.index),
								}))}
							/>
						</Row>
						<Row label="Format" id={ids.b}>
							<Select
								id={ids.b}
								label="Format"
								value={form.format}
								onValueChange={(v) => set({ format: v === 'flac' ? 'flac' : 'wav' })}
								options={[
									{ value: 'wav', label: 'WAV (24-bit PCM)' },
									{ value: 'flac', label: 'FLAC (lossless)' },
								]}
							/>
						</Row>
					</>
				) : null}
				{op === 'time-stretch' ? (
					<>
						<Row label="Speed" id={ids.a}>
							<ScrubbyNumber
								id={ids.a}
								label="Speed"
								value={form.rate}
								min={RATE_BOUNDS.min}
								max={RATE_BOUNDS.max}
								step={0.05}
								precision={2}
								unit="×"
								onCommit={(v) => set({ rate: v })}
								onScrub={(v) => set({ rate: v })}
							/>
							{dur !== null && form.rate > 0 ? (
								<span className="text-pr-small text-pr-muted">
									{t('new length {0}', fmtSec(dur / form.rate))}
								</span>
							) : null}
						</Row>
						<Checkbox
							checked={form.preservePitch}
							onCheckedChange={(c) => set({ preservePitch: c })}
							label="Maintain audio pitch"
						/>
					</>
				) : null}
				{op === 'range' ? (
					<>
						<Row label="In" id={ids.a}>
							<ScrubbyNumber
								id={ids.a}
								label="In"
								value={form.inSec}
								min={0}
								max={dur ?? undefined}
								step={0.001}
								precision={3}
								unit="s"
								onCommit={(v) => set({ inSec: v })}
								onScrub={(v) => set({ inSec: v })}
							/>
						</Row>
						<Row label="Out" id={ids.b}>
							<ScrubbyNumber
								id={ids.b}
								label="Out"
								value={form.outSec}
								min={0}
								max={dur ?? undefined}
								step={0.001}
								precision={3}
								unit="s"
								onCommit={(v) => set({ outSec: v })}
								onScrub={(v) => set({ outSec: v })}
							/>
						</Row>
						{dur !== null ? (
							<div className="text-pr-small text-pr-muted">{t('Media length: {0}', fmtSec(dur))}</div>
						) : null}
					</>
				) : null}
				{busy ? (
					<div className="text-pr-small text-pr-muted" data-testid="derive-progress">
						{job?.progress != null ? `${Math.round(job.progress * 100)}%` : t('Queued')}
						{job?.stage ? ` · ${job.stage}` : ''}
					</div>
				) : null}
				<Problems problems={shown} />
			</div>
		</Dialog>
	);
}
