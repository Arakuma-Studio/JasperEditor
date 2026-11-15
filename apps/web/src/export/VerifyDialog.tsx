// Verify Export (spec 18 AF-VER-005; docs/wp-notes/agent-footage-verify.md "Editor"): runs the engine's
// `export-verify` job on a finished export (Jobs panel ▸ Verify, the export-finished toast) and lists its rows grouped
// Fail / Warn / Pass / Not checked; "Go to" opens the exported sequence and seeks the Program monitor to the row's
// frame. A delivery target re-runs the check with the platform's rows. Failures (engine refusals, a gone file) are shown
// in the dialog, never thrown.
import {
	type ExportVerifyResult,
	ExportVerifyResultSchema,
	TERMINAL_JOB_STATES,
	type VerifyRow,
} from '@jasper/api';
import { type EngineClient, EngineError } from '@jasper/engine-client';
import { DELIVERY_TARGETS, type DeliveryTargetId } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { Button, cx, Dialog, type HostedDialogProps, openDialog, registerDialog, Select } from '@jasper/ui';
import { useEffect, useMemo, useState } from 'react';

export const VERIFY_EXPORT_DIALOG = 'jasper.export.verify';

export type VerifyDialogProps = {
	engine: EngineClient;
	session: EditorSession | null;
	/** The finished export job. */
	exportJobId: string;
	/** A finished `export-verify` job to show instead of running one. */
	verifyJobId?: string;
	title?: string;
};

const POLL_MS = 400;
const NO_TARGET = 'none';

/** English labels of the checks (the rows' ids). */
const CHECK_LABELS: Record<VerifyRow['id'], string> = {
	decode: 'Decodes',
	streams: 'Streams',
	duration: 'Duration',
	'av-skew': 'Audio / video end',
	'cut-black': 'Black frames at cuts',
	'cut-flash': 'Flash frames at cuts',
	'cut-click': 'Clicks at cuts',
	'uncovered-video': 'Frames without picture',
	'offline-media': 'Media Offline frames',
	loudness: 'Loudness',
	'true-peak': 'True peak',
	silence: 'Silence',
	'target-container': 'Platform: container',
	'target-aspect': 'Platform: frame shape',
	'target-duration': 'Platform: duration',
	'target-resolution': 'Platform: frame size',
	'target-frame-rate': 'Platform: frame rate',
	'target-size': 'Platform: file size',
	'target-loudness': 'Platform: loudness',
};

const GROUPS: { status: VerifyRow['status']; label: string; tone: string }[] = [
	{ status: 'fail', label: 'Fail', tone: 'text-pr-danger' },
	{ status: 'warn', label: 'Warn', tone: 'text-pr-warning' },
	{ status: 'pass', label: 'Pass', tone: 'text-pr-success' },
	{ status: 'unverified', label: 'Not checked', tone: 'text-pr-muted' },
];

type State =
	| { kind: 'running'; stage: string | null; jobId: string | null }
	| { kind: 'done'; result: ExportVerifyResult }
	| { kind: 'error'; message: string };

const errorText = (e: unknown) =>
	e instanceof EngineError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);

/** Seeks the Program monitor to a frame of the exported sequence (opening it when another one is active). */
export function goToVerifyRow(
	session: EditorSession,
	sequenceId: string | undefined,
	frame: number,
): boolean {
	const seqId = sequenceId ?? session.getState().activeSequenceId;
	if (!seqId || !session.getState().document.sequences[seqId]) return false;
	if (session.getState().activeSequenceId !== seqId) session.openSequence(seqId);
	try {
		if (session.transport.getState().playing) session.transport.pause();
		session.transport.seek(Math.max(0, Math.floor(frame)));
	} catch {
		return false;
	}
	return true;
}

function RowView(props: { row: VerifyRow; canGoTo: boolean; onGoTo(frame: number): void }) {
	const r = props.row;
	const value = (v: VerifyRow['measured']) => (v === null ? '—' : String(v));
	return (
		<li
			className="flex flex-col gap-0.5 border-b border-pr-border-subtle px-2 py-1.5"
			data-testid="verify-row"
			data-row-id={r.id}
			data-status={r.status}
		>
			<div className="flex items-center gap-2">
				<span className="text-pr-strong">{CHECK_LABELS[r.id] ?? r.id}</span>
				<span
					className="rounded-pr-control border border-pr-border px-1 text-pr-small text-pr-muted"
					title={
						r.kind === 'format'
							? 'Format: what the file is. Export again with corrected settings to fix it.'
							: 'Judgement: what the edit does. Decide whether it is intended.'
					}
				>
					{r.kind === 'format' ? 'Format' : 'Judgement'}
				</span>
				{r.at ? <span className="font-pr-mono text-pr-small text-pr-timecode">{r.at.timecode}</span> : null}
				{r.at ? (
					<Button
						variant="quiet"
						className="ml-auto"
						data-testid="verify-goto"
						disabled={!props.canGoTo}
						disabledReason={props.canGoTo ? undefined : 'The exported sequence is not open in this project'}
						onClick={() => props.onGoTo(r.at!.frame)}
					>
						Go to
					</Button>
				) : null}
			</div>
			<p className="text-pr-small text-pr-text">{r.message}</p>
			{r.measured !== null || r.expected !== null ? (
				<p className="text-pr-small text-pr-dim">
					{r.tolerance !== null
						? `Measured ${value(r.measured)} · expected ${value(r.expected)} · tolerance ${value(r.tolerance)}`
						: `Measured ${value(r.measured)} · expected ${value(r.expected)}`}
				</p>
			) : null}
		</li>
	);
}

function VerifyDialog(props: HostedDialogProps<VerifyDialogProps>) {
	const { engine, session, exportJobId } = props;
	const [target, setTarget] = useState<string>(NO_TARGET);
	const [state, setState] = useState<State>({
		kind: 'running',
		stage: null,
		jobId: props.verifyJobId ?? null,
	});
	// the first run shows a given verification job; changing the target runs a new one
	const [given, setGiven] = useState<string | null>(props.verifyJobId ?? null);

	useEffect(() => {
		let live = true;
		let timer: ReturnType<typeof setTimeout> | null = null;
		setState({ kind: 'running', stage: null, jobId: given });
		const poll = async (jobId: string) => {
			try {
				const job = await engine.getJob(jobId);
				if (!live) return;
				if (!TERMINAL_JOB_STATES.has(job.state)) {
					setState({ kind: 'running', stage: job.stage ?? null, jobId });
					timer = setTimeout(() => void poll(jobId), POLL_MS);
					return;
				}
				if (job.state !== 'succeeded') {
					setState({ kind: 'error', message: job.error?.message ?? `The verification was ${job.state}.` });
					return;
				}
				const parsed = ExportVerifyResultSchema.safeParse(job.result);
				setState(
					parsed.success
						? { kind: 'done', result: parsed.data }
						: { kind: 'error', message: 'The engine returned an unreadable verification.' },
				);
			} catch (e) {
				if (live) setState({ kind: 'error', message: errorText(e) });
			}
		};
		void (async () => {
			try {
				const jobId =
					given ??
					(
						await engine.verifyExport(exportJobId, {
							checks: 'full',
							...(target !== NO_TARGET ? { target: target as DeliveryTargetId } : {}),
						})
					).id;
				if (live) await poll(jobId);
			} catch (e) {
				if (live) setState({ kind: 'error', message: errorText(e) });
			}
		})();
		return () => {
			live = false;
			if (timer) clearTimeout(timer);
		};
	}, [engine, exportJobId, target, given]);

	const targetOptions = useMemo(
		() => [
			{ value: NO_TARGET, label: 'No platform' },
			...DELIVERY_TARGETS.map((t) => ({ value: t.id, label: t.name })),
		],
		[],
	);
	const result = state.kind === 'done' ? state.result : null;
	// AF-EXP: platform checks are for video files; a GIF or an audio-only export has none
	const [kind, setKind] = useState<ExportVerifyResult['deliverable']>(undefined);
	useEffect(() => {
		if (result?.deliverable) setKind(result.deliverable);
	}, [result]);
	const notVideo = kind === 'gif' || kind === 'audio';
	const seqId = result?.sequenceId;
	const canGoTo = !!session && !!seqId && !!session.getState().document.sequences[seqId];
	const goTo = (frame: number) => {
		if (session && goToVerifyRow(session, seqId, frame)) props.close();
	};

	return (
		<Dialog
			open
			onOpenChange={(o) => !o && props.close()}
			title={props.title ? `Verify Export – ${props.title}` : 'Verify Export'}
			size="large"
			hideCancel
			primaryLabel="Close"
			onPrimary={() => undefined}
			data-testid="verify-dialog"
		>
			<div className="flex flex-col gap-2">
				<div className="flex items-center gap-2">
					<Select
						label="Delivery target"
						value={target}
						options={targetOptions}
						disabled={state.kind === 'running' || notVideo}
						onValueChange={(v) => {
							setGiven(null);
							setTarget(v);
						}}
						className="w-[200px]"
					/>
					{notVideo ? (
						<span className="text-pr-small text-pr-muted" data-testid="verify-no-target">
							{kind === 'gif'
								? 'A GIF has no platform checks (platform presets are video files).'
								: 'An audio file has no platform checks (platform presets are video files).'}
						</span>
					) : null}
					{result ? (
						<span
							data-testid="verify-summary"
							data-verified={result.verified ? 'true' : 'false'}
							className={cx('font-medium', result.verified ? 'text-pr-success' : 'text-pr-danger')}
						>
							{result.verified
								? `Verified · ${result.counts.pass} passed, ${result.counts.warn} to review`
								: `Not verified · ${result.counts.fail} failed, ${result.counts.warn} to review`}
						</span>
					) : null}
				</div>
				{state.kind === 'running' ? (
					<p className="text-pr-small text-pr-muted" data-testid="verify-running">
						Measuring the export… {state.stage ?? ''}
					</p>
				) : state.kind === 'error' ? (
					<p className="text-pr-small text-pr-danger" data-testid="verify-error">
						{state.message}
					</p>
				) : (
					<div className="max-h-[60vh] overflow-auto rounded-pr-control bg-pr-panel">
						{GROUPS.map((g) => {
							const rows = state.result.rows.filter((r) => r.status === g.status);
							if (!rows.length) return null;
							return (
								<section key={g.status} data-testid={`verify-group-${g.status}`}>
									<h3 className={cx('bg-pr-panel-alt px-2 py-1 text-pr-small', g.tone)}>
										{g.label} ({rows.length})
									</h3>
									<ul>
										{rows.map((r) => (
											<RowView
												key={`${r.id}:${r.at?.sec ?? ''}:${r.message}`}
												row={r}
												canGoTo={canGoTo}
												onGoTo={goTo}
											/>
										))}
									</ul>
								</section>
							);
						})}
					</div>
				)}
			</div>
		</Dialog>
	);
}

registerDialog(VERIFY_EXPORT_DIALOG, VerifyDialog);

/** Opens Verify Export for a finished export job (or shows a finished verification). */
export function openVerifyExport(props: VerifyDialogProps): void {
	void openDialog(VERIFY_EXPORT_DIALOG, props);
}
