// Sound Check panel (spec 12 §2.6 / §2.7 "Sound Check panel", P5-R3; wp-note "Phase 5 → WP5.2"): the delivery target
// (the four presets or Custom… LUFS / dBTP) with "Use as sequence target" (one undoable edit) and Run (the engine's
// `sound-check` job: progress here and in the Jobs panel, Cancel); the summary chips (integrated, true peak, LRA,
// findings by severity, the verdict) with a stale badge and Re-run when the mix changed since the stored summary; the
// findings grouped by category — severity by shape and word, the timecode (jumps the playhead and selects the clip or
// cue), the translated message, Fix (commands as one transaction, a swap through the Swap path, an engine job) — and
// Fix all safe (one transaction, the jobs after it, then the check again); sync rows expand into the sync strip (five
// frames above the waveform); Listen here: five moments with ▶ (4 s through the Program), Sounds right / Flag + note
// (user `comment` markers that MCP `sound_check` returns as humanVerdicts) and Play all. Keyboard: the findings list is
// one tab stop (↑ ↓ Home End move, Enter jumps, F fixes, → / ← open / close the sync strip, Space plays the moment);
// everything else is buttons and fields. Run progress and the verdict are announced (aria-live). Nothing animates.
import type { SoundCheckIssue } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import { type Sequence, soundCheckStatus } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useSessionOrNull, useSessionState, useStoreSelector } from '@jasper/session/react';
import { Button, Icon, Select, TextField } from '@jasper/ui';
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { createCommandContext } from '../../commands/context.ts';
import type { CommandCtx } from '../../commands/types.ts';
import { t } from '../../i18n/runtime.ts';
import { isOwnKey, runScopedKey } from '../../proposals/keys.ts';
import { useShellRuntimeOrNull } from '../../shell/context.tsx';
import {
	CUSTOM_VALUE,
	canApply,
	choiceNumbers,
	customLabel,
	type DeliveryChoice,
	deliveryOptions,
	eventOf,
	groupIssues,
	hasSyncStrip,
	isSequenceTarget,
	type ListenRow,
	listenRows,
	messageText,
	orderedIssues,
	parseCustomTarget,
	reportStatus,
	SEVERITY_ICON,
	SEVERITY_LABELS,
	SEVERITY_TONE,
	safeFixable,
	sequenceTargetCommands,
	staleText,
	summaryChips,
	VERDICT_ICON,
	VERDICT_LABELS,
	VERDICT_TONE,
	verdictStaleText,
} from '../../sound/check-model.ts';
import {
	applyCheckFix,
	type CheckEngine,
	cancelSoundCheck,
	choiceOf,
	fixAllSafe,
	jumpTo,
	jumpToIssue,
	LISTEN_KEEP_ATTR,
	loadStoredReport,
	playListen,
	recordVerdict,
	runSoundCheck,
	setChoice,
	setFindingCursor,
	setSyncStrip,
	soundCheckStore,
	stopListen,
} from '../../sound/check-run.ts';
import { seqTimecode } from '../../sound/design-model.ts';
import { type StripEngine, SyncStrip } from '../../sound/SyncStrip.tsx';
import { useEngineOrNull } from '../../state/engine.tsx';
import type { PanelProps } from '../types.ts';

export function SoundCheckPanel(props: PanelProps) {
	const session = useSessionOrNull();
	if (!session)
		return (
			<div
				className="flex h-full items-center justify-center p-4 text-center text-pr-small text-pr-muted"
				data-testid="sound-check-panel"
			>
				{t('Open a project to check its sound.')}
			</div>
		);
	return <CheckBody {...props} session={session} />;
}

function CheckBody(props: PanelProps & { session: EditorSession }) {
	const { session } = props;
	const runtime = useShellRuntimeOrNull();
	const engineState = useEngineOrNull();
	const engine = (engineState?.client ?? (session.engine as EngineClient | undefined) ?? null) as
		| (CheckEngine & StripEngine)
		| null;
	const connected = !engineState || engineState.status === 'connected';
	const store = soundCheckStore(session);
	const result = useStoreSelector(store, (s) => s.result);
	const jobId = useStoreSelector(store, (s) => s.jobId);
	const running = useStoreSelector(store, (s) => s.running);
	const error = useStoreSelector(store, (s) => s.error);
	const fixing = useStoreSelector(store, (s) => s.fixing);
	const fixed = useStoreSelector(store, (s) => s.fixed);
	const playing = useStoreSelector(store, (s) => s.playing);
	const announcement = useStoreSelector(store, (s) => s.announcement);
	const storedChoice = useStoreSelector(store, (s) => s.choice);
	const readOnly = useSessionState((s) => s.readOnly);
	const seqId = useSessionState((s) => s.activeSequenceId);
	const doc = useSessionState((s) => s.document);
	const seq = seqId ? (doc.sequences[seqId] as Sequence | undefined) : undefined;
	const status = useMemo(
		() =>
			seqId
				? soundCheckStatus(doc, seqId)
				: { state: 'none' as const, summary: null, reasons: [], mixHash: '' },
		[doc, seqId],
	);
	const report = result && seqId && result.sequenceId === seqId ? result.report : null;
	const choice: DeliveryChoice = seqId
		? (storedChoice[seqId] ?? choiceOf(session, seqId))
		: { kind: 'preset', preset: 'web' };
	const reveal = (f: number) => runtime?.services.get('timelineViewport')?.scrollToFrame(f);

	// a reopened project: its stored summary's report, while the engine keeps the job
	useEffect(() => {
		if (engine && seqId && connected) void loadStoredReport(session, engine, seqId);
	}, [engine, session, seqId, connected]);

	const runDisabled = !engine || !connected || !seq;
	const runReason = !seq
		? t('Open a sequence first')
		: !connected
			? t('The engine is not connected')
			: undefined;
	const run = () => {
		if (engine && seq) void runSoundCheck(session, engine, { sequenceId: seq.id });
	};
	// the report shown is judged by its own hashes (it may be one the engine kept across a restart); without one, the
	// stored summary is
	const shownStatus = useMemo(() => (report ? reportStatus(doc, report) : status), [doc, report, status]);
	const stale = staleText(shownStatus);
	const safe = report ? safeFixable(report.issues).filter((i) => !fixed.includes(i.id)) : [];

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: keeps Enter / Space on the panel's own buttons and fields
		<div
			className="flex h-full min-h-0 flex-col bg-pr-panel text-pr-ui text-pr-text"
			data-testid="sound-check-panel"
			data-panel-kind="soundCheck"
			data-instance-id={props.instanceId}
			onKeyDown={(e) => {
				if (isOwnKey(e)) e.stopPropagation();
			}}
		>
			<div aria-live="polite" className="sr-only" data-testid="sound-check-live">
				{announcement.message ? `${announcement.message}${'​'.repeat(announcement.n % 2)}` : ''}
			</div>
			<TargetBar
				session={session}
				seq={seq}
				choice={choice}
				readOnly={readOnly}
				running={!!running}
				runDisabled={runDisabled}
				runReason={runReason}
				onRun={run}
				onCancel={() => cancelSoundCheck(session)}
				onChoice={(c) => seq && setChoice(session, seq.id, c)}
			/>
			{running && running.sequenceId === seqId ? (
				<div className="shrink-0 border-b border-pr-border px-2 py-1" data-testid="sound-check-progress">
					<div className="flex items-center justify-between text-pr-small text-pr-muted">
						<span>{running.stage ?? t('Measuring…')}</span>
						<span className="pr-tabular">
							{running.progress === null ? '' : `${Math.round(running.progress * 100)} %`}
						</span>
					</div>
					<div
						role="progressbar"
						aria-label={t('Sound Check progress')}
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={running.progress === null ? undefined : Math.round(running.progress * 100)}
						className="mt-0.5 h-1 w-full overflow-hidden rounded-pr-pill bg-pr-field"
					>
						<div
							className="h-full bg-pr-accent-fill"
							style={{ width: `${Math.round((running.progress ?? 0.02) * 100)}%` }}
						/>
					</div>
				</div>
			) : null}
			{error ? (
				<p
					role="alert"
					className="m-0 shrink-0 border-b border-pr-border px-2 py-1 text-pr-small text-pr-danger"
				>
					{t('The Sound Check failed: {0}', error)}
				</p>
			) : null}
			<div className="min-h-0 flex-1 overflow-auto">
				<Summary
					report={report}
					summary={status.summary}
					stale={stale}
					runDisabled={runDisabled || !!running}
					onRerun={run}
				/>
				{report && seq ? (
					<>
						<div className="flex items-center gap-2 border-b border-pr-border px-2 py-1">
							<Button
								variant="secondary"
								data-testid="sound-check-fix-all"
								disabled={!safe.length || readOnly || !!fixing || !!running || !engine}
								disabledReason={
									readOnly
										? t('The project is read-only')
										: !safe.length
											? t('No safe fixes left')
											: undefined
								}
								busy={fixing === 'all'}
								onClick={() => engine && void fixAllSafe(session, engine)}
							>
								{t('Fix all safe ({0})', safe.length)}
							</Button>
							<span className="text-pr-small text-pr-muted">
								{t(
									'Safe fixes change only what their finding is about, in one undo step; the check runs again after.',
								)}
							</span>
						</div>
						<Findings
							session={session}
							engine={engine}
							seq={seq}
							report={report}
							jobId={jobId}
							fixing={fixing}
							fixed={fixed}
							readOnly={readOnly}
							busy={!!running}
							instanceId={props.instanceId}
							reveal={reveal}
						/>
						<Listen
							session={session}
							seq={seq}
							rows={listenRows(report, seq, doc)}
							playing={playing && playing.sequenceId === seq.id ? playing : null}
							readOnly={readOnly}
							reveal={reveal}
						/>
					</>
				) : !running ? (
					<div className="flex flex-col items-center gap-2 p-4 text-center text-pr-small text-pr-muted">
						<p className="m-0">
							{status.summary
								? t('Run the check to see its findings and the moments to listen to.')
								: t(
										'Sound Check measures the mix as it will be delivered: sync of every placed sound, loudness, masking, music under the voice, silences, cues and licences. Choose a delivery target and run it.',
									)}
						</p>
					</div>
				) : null}
			</div>
		</div>
	);
}

// ── header: target and run ────────────────────────────────────────────────────────────────────────────────────────

function TargetBar(props: {
	session: EditorSession;
	seq: Sequence | undefined;
	choice: DeliveryChoice;
	readOnly: boolean;
	running: boolean;
	runDisabled: boolean;
	runReason: string | undefined;
	onRun(): void;
	onCancel(): void;
	onChoice(c: DeliveryChoice): void;
}) {
	const { seq, choice } = props;
	const options = useMemo(() => deliveryOptions(), []);
	const numbers = choiceNumbers(choice);
	const [lufs, setLufs] = useState(String(numbers.integratedLufs));
	const [tp, setTp] = useState(String(numbers.truePeakDb));
	const [invalid, setInvalid] = useState<{ field: 'lufs' | 'tp'; message: string } | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the fields follow the chosen target, not every render
	useEffect(() => {
		setLufs(String(numbers.integratedLufs));
		setTp(String(numbers.truePeakDb));
		setInvalid(null);
	}, [choice.kind, numbers.integratedLufs, numbers.truePeakDb]);
	const commitCustom = () => {
		const r = parseCustomTarget(lufs, tp);
		if (!r.ok) {
			setInvalid({ field: r.field, message: r.message });
			return false;
		}
		setInvalid(null);
		props.onChoice({ kind: 'custom', target: r.target });
		return true;
	};
	const already = isSequenceTarget(choice, seq);
	const useAsTarget = () => {
		if (!seq) return;
		if (choice.kind === 'custom' && !commitCustom()) return;
		const label =
			choice.kind === 'preset'
				? t(
						'Use Delivery Target: {0}',
						options.find((o) => o.value === choice.preset)?.label ?? choice.preset,
					)
				: t('Use Delivery Target: {0}', customLabel(choice.target));
		const r = props.session.apply({
			label,
			origin: 'user',
			sequenceId: seq.id,
			commands: sequenceTargetCommands(choice, seq.id),
		});
		soundCheckStore(props.session).setState((s) => ({
			announcement: {
				message: r.ok
					? t('The sequence now delivers to {0}', label)
					: r.errors.map((e) => e.message).join('; '),
				n: s.announcement.n + 1,
			},
		}));
	};
	return (
		<div className="flex shrink-0 flex-col gap-1 border-b border-pr-border px-2 py-1.5">
			<div className="flex flex-wrap items-center gap-2">
				<span className="text-pr-small text-pr-muted" id="sound-check-target-label">
					{t('Delivery target')}
				</span>
				<Select
					label={t('Delivery target')}
					value={choice.kind === 'custom' ? CUSTOM_VALUE : choice.preset}
					options={options}
					disabled={props.running}
					onValueChange={(v) => {
						if (v === CUSTOM_VALUE)
							props.onChoice({
								kind: 'custom',
								target: { integratedLufs: numbers.integratedLufs, truePeakDb: numbers.truePeakDb },
							});
						else props.onChoice({ kind: 'preset', preset: v as never });
					}}
					className="min-w-0 max-w-[260px] flex-1"
				/>
				<Button
					variant="quiet"
					data-testid="sound-check-use-target"
					disabled={!seq || props.readOnly || already || props.running}
					disabledReason={
						already
							? t('The sequence already delivers to this target')
							: props.readOnly
								? t('The project is read-only')
								: undefined
					}
					title={t('Make this the sequence’s delivery target: the Mix normalises to it (one undo step)')}
					onClick={useAsTarget}
				>
					{t('Use as sequence target')}
				</Button>
				<div className="ml-auto flex items-center gap-1">
					{props.running ? (
						<Button variant="secondary" data-testid="sound-check-cancel" onClick={props.onCancel}>
							{t('Cancel')}
						</Button>
					) : (
						<Button
							variant="primary"
							data-testid="sound-check-run"
							disabled={props.runDisabled || !!invalid}
							disabledReason={props.runReason ?? invalid?.message}
							onClick={() => {
								if (choice.kind === 'custom' && !commitCustom()) return;
								props.onRun();
							}}
						>
							<Icon id="transport.play" size={12} />
							{t('Run')}
						</Button>
					)}
				</div>
			</div>
			{choice.kind === 'custom' ? (
				<div className="flex flex-wrap items-center gap-2 text-pr-small" data-testid="sound-check-custom">
					<span className="flex items-center gap-1">
						<span className="text-pr-muted" aria-hidden="true">
							{t('Integrated (LUFS)')}
						</span>
						<TextField
							aria-label={t('Integrated (LUFS)')}
							className="w-16"
							value={lufs}
							invalid={invalid?.field === 'lufs'}
							aria-invalid={invalid?.field === 'lufs' || undefined}
							data-testid="sound-check-custom-lufs"
							onChange={(e) => setLufs(e.target.value)}
							onBlur={commitCustom}
							onKeyDown={(e) => {
								if (e.key === 'Enter') commitCustom();
							}}
						/>
					</span>
					<span className="flex items-center gap-1">
						<span className="text-pr-muted" aria-hidden="true">
							{t('True peak (dBTP)')}
						</span>
						<TextField
							aria-label={t('True peak (dBTP)')}
							className="w-16"
							value={tp}
							invalid={invalid?.field === 'tp'}
							aria-invalid={invalid?.field === 'tp' || undefined}
							data-testid="sound-check-custom-tp"
							onChange={(e) => setTp(e.target.value)}
							onBlur={commitCustom}
							onKeyDown={(e) => {
								if (e.key === 'Enter') commitCustom();
							}}
						/>
					</span>
					{invalid ? (
						<span role="alert" className="text-pr-danger">
							{invalid.message}
						</span>
					) : null}
				</div>
			) : null}
		</div>
	);
}

// ── summary ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function Summary(props: {
	report: import('@jasper/api').SoundCheckReport | null;
	summary: ReturnType<typeof soundCheckStatus>['summary'];
	stale: string | null;
	runDisabled: boolean;
	onRerun(): void;
}) {
	const { report, summary, stale } = props;
	const verdict = (report?.verdict ?? summary?.verdict) as keyof typeof VERDICT_LABELS | undefined;
	if (!verdict || !Object.hasOwn(VERDICT_LABELS, verdict)) return null;
	const counts = report?.counts ?? summary?.counts ?? {};
	const chips = report
		? summaryChips(report)
		: [
				{ id: 'errors', label: t('Errors'), value: String(counts.error ?? 0) },
				{ id: 'warnings', label: t('Warnings'), value: String(counts.warning ?? 0) },
				{ id: 'infos', label: t('Info'), value: String(counts.info ?? 0) },
			];
	return (
		<div
			className="flex flex-col gap-1 border-b border-pr-border px-2 py-1.5"
			data-testid="sound-check-summary"
		>
			<div className="flex flex-wrap items-center gap-1.5">
				<span
					className={`inline-flex items-center gap-1 rounded-pr-pill border border-current px-2 py-0.5 font-semibold ${VERDICT_TONE[verdict]}`}
					data-testid="sound-check-verdict"
					data-verdict={verdict}
				>
					<Icon id={VERDICT_ICON[verdict]} size={14} />
					{t(VERDICT_LABELS[verdict])}
				</span>
				{chips.map((c) => (
					<span
						key={c.id}
						className="inline-flex items-baseline gap-1 rounded-pr-pill bg-pr-field px-2 py-0.5 text-pr-small"
						title={c.title}
						data-testid={`sound-check-chip-${c.id}`}
					>
						<span className="text-pr-muted">{c.label}</span>
						<span className="pr-tabular text-pr-strong">{c.value}</span>
					</span>
				))}
				{report?.preset ? (
					<span className="text-pr-small text-pr-muted">
						{report.preset.custom ? customLabel(report.preset) : t('vs {0}', t(report.preset.label))}
					</span>
				) : null}
			</div>
			{stale ? (
				<div
					className="flex items-center gap-2 text-pr-small text-pr-warning"
					data-testid="sound-check-stale"
					role="status"
				>
					<Icon id="status.warning" size={14} />
					<span>{stale}</span>
					<Button
						variant="quiet"
						disabled={props.runDisabled}
						onClick={props.onRerun}
						data-testid="sound-check-rerun"
					>
						{t('Re-run')}
					</Button>
				</div>
			) : summary && !report ? (
				<p className="m-0 text-pr-small text-pr-muted">
					{t('Stored summary of {0}', new Date(summary.at).toLocaleString())}
				</p>
			) : null}
		</div>
	);
}

// ── findings ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A finding over the whole checked range (integrated loudness, credits) has no moment to go to. */
function wholeRange(r: { start: number; end: number }, all: { start: number; end: number }): boolean {
	return r.start <= all.start && r.end >= all.end;
}

function issueName(i: SoundCheckIssue, fixedNow: boolean): string {
	const parts = [t(SEVERITY_LABELS[i.severity]), i.timecode ?? '', messageText(i.message)];
	if (fixedNow) parts.push(t('fixed, run again to confirm'));
	else if (i.fix && canApply(i))
		parts.push(
			i.fix.safe ? t('safe fix: {0}', messageText(i.fix.label)) : t('fix: {0}', messageText(i.fix.label)),
		);
	return parts.filter(Boolean).join('. ');
}

function Findings(props: {
	session: EditorSession;
	engine: (CheckEngine & StripEngine) | null;
	seq: Sequence;
	report: import('@jasper/api').SoundCheckReport;
	jobId: string | null;
	fixing: string | null;
	fixed: readonly string[];
	readOnly: boolean;
	busy: boolean;
	instanceId: string;
	reveal(f: number): void;
}) {
	const { session, engine, report, seq } = props;
	const groups = useMemo(() => groupIssues(report.issues), [report]);
	const order = useMemo(() => orderedIssues(report.issues), [report]);
	const store = soundCheckStore(session);
	const current = useStoreSelector(store, (s) => s.cursor);
	const openList = useStoreSelector(store, (s) => s.openStrips);
	const open = useMemo(() => new Set(openList), [openList]);
	const runtime = useShellRuntimeOrNull();
	const engineState = useEngineOrNull();
	const engineStatus = engineState?.status;
	const listRef = useRef<HTMLDivElement>(null);
	const idPrefix = `sound-check-${props.instanceId}-`;
	const cur = current && order.some((i) => i.id === current) ? current : null;
	const toggle = (i: SoundCheckIssue, to?: boolean) => setSyncStrip(session, i, to);
	const fix = (i: SoundCheckIssue) => {
		if (engine) void applyCheckFix(session, engine, i);
	};
	const ctx = (): CommandCtx =>
		runtime?.getCtx() ??
		createCommandContext({
			engine: engine as unknown as EngineClient,
			session,
			capabilities: engineStatus === 'connected' || !engineState ? ['engine'] : [],
		});
	// keep the current row in view
	useEffect(() => {
		if (!cur) return;
		document.getElementById(`${idPrefix}${cur}`)?.scrollIntoView?.({ block: 'nearest' });
	}, [cur, idPrefix]);
	// the list's keys are the Sound Check scope's commands (Keyboard Shortcuts lists them; remappable)
	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		runScopedKey(e, 'soundCheck', ctx(), runtime ?? {});
	};
	if (!report.issues.length)
		return (
			<p
				className="m-0 border-b border-pr-border px-2 py-2 text-pr-small text-pr-muted"
				data-testid="sound-check-none"
			>
				{t('No findings: every check passed.')}
			</p>
		);
	return (
		<div
			ref={listRef}
			role="listbox"
			tabIndex={0}
			data-keymap-local
			aria-label={t('Sound Check findings')}
			aria-activedescendant={cur ? `${idPrefix}${cur}` : undefined}
			className="border-b border-pr-border outline-none focus-visible:ring-1 focus-visible:ring-pr-focus"
			data-testid="sound-check-findings"
			onKeyDown={onKeyDown}
			onFocus={() => {
				if (!cur && order[0]) setFindingCursor(session, order[0].id);
			}}
		>
			{groups.map((g) => (
				// biome-ignore lint/a11y/useSemanticElements: a group of options inside the listbox
				<div key={g.category} role="group" aria-label={t(g.label)} data-category={g.category}>
					<div className="sticky top-0 z-[1] flex items-center gap-2 bg-pr-header px-2 py-0.5 text-pr-small text-pr-muted">
						<span className="font-semibold text-pr-strong">{t(g.label)}</span>
						{(['error', 'warning', 'info'] as const).map((s) =>
							g.counts[s] ? (
								<span key={s} className={`inline-flex items-center gap-0.5 ${SEVERITY_TONE[s]}`}>
									<Icon id={SEVERITY_ICON[s]} size={12} />
									{g.counts[s]} {t(SEVERITY_LABELS[s])}
								</span>
							) : null,
						)}
					</div>
					{g.issues.map((i) => {
						const fixedNow = props.fixed.includes(i.id);
						const strip = hasSyncStrip(i);
						const expanded = strip && open.has(i.id);
						return (
							// biome-ignore lint/a11y/useFocusableInteractive: listbox options are reached with aria-activedescendant
							<div
								key={i.id}
								id={`${idPrefix}${i.id}`}
								role="option"
								aria-selected={cur === i.id}
								aria-label={`${issueName(i, fixedNow)}${strip ? `. ${expanded ? t('sync strip open') : t('sync strip: press the right arrow')}` : ''}`}
								data-issue-id={i.id}
								data-code={i.code}
								data-frame={i.frame ?? i.range?.start ?? ''}
								className={`border-t border-pr-border-subtle px-2 py-1 ${cur === i.id ? 'bg-pr-selected' : ''}`}
								onPointerDown={() => setFindingCursor(session, i.id)}
							>
								<div className="flex items-start gap-1.5">
									<span
										className={`mt-0.5 inline-flex shrink-0 items-center gap-0.5 text-pr-small ${SEVERITY_TONE[i.severity]}`}
									>
										<Icon id={SEVERITY_ICON[i.severity]} size={14} />
										<span className="w-12">{t(SEVERITY_LABELS[i.severity])}</span>
									</span>
									{i.frame !== undefined || (i.range && !wholeRange(i.range, report.range)) ? (
										<button
											type="button"
											tabIndex={-1}
											className="shrink-0 font-pr-mono text-pr-small text-pr-timecode underline-offset-2 hover:underline"
											data-testid="sound-check-timecode"
											title={t('Go to {0} and select it', i.timecode ?? '')}
											onClick={() => jumpToIssue(session, i, props.reveal)}
										>
											{i.timecode ?? (i.range ? seqTimecode(seq, i.range.start) : '')}
										</button>
									) : (
										<span className="w-[78px] shrink-0 text-pr-small text-pr-dim">{t('whole mix')}</span>
									)}
									<span className="min-w-0 flex-1 text-pr-small" data-testid="sound-check-message">
										<span className="mr-1 font-pr-mono text-pr-dim">{i.code}</span>
										{messageText(i.message)}
										{fixedNow ? (
											<span className="ml-1 text-pr-success" data-testid="sound-check-fixed">
												✓ {t('Fixed — run again to confirm')}
											</span>
										) : null}
									</span>
									{strip ? (
										<button
											type="button"
											tabIndex={-1}
											aria-label={expanded ? t('Hide the sync strip') : t('Show the sync strip')}
											className="shrink-0 text-pr-muted hover:text-pr-text"
											data-testid="sound-check-strip-toggle"
											onClick={() => toggle(i)}
										>
											<Icon id={expanded ? 'app.chevronDown' : 'app.chevronRight'} size={14} />
										</button>
									) : null}
									{i.fix && canApply(i) && !fixedNow ? (
										<Button
											variant={i.fix.safe ? 'secondary' : 'quiet'}
											tabIndex={-1}
											className="shrink-0"
											data-testid="sound-check-fix"
											busy={props.fixing === i.id}
											disabled={props.readOnly || !!props.fixing || props.busy || !engine}
											title={
												i.fix.safe
													? t('Safe: {0}', messageText(i.fix.label))
													: t('{0} — {1}', messageText(i.fix.label), i.fix.why ?? t('listen to the result'))
											}
											onClick={() => fix(i)}
										>
											{i.fix.safe ? t('Fix') : t('Fix…')}
										</Button>
									) : null}
								</div>
								{i.fix && canApply(i) && !fixedNow ? (
									<div className="ml-[68px] text-pr-small text-pr-muted">
										{i.fix.safe ? '✓ ' : '! '}
										{messageText(i.fix.label)}
										{i.fix.safe ? ` · ${t('safe')}` : ` · ${t('needs your judgement')}`}
									</div>
								) : null}
								{expanded ? (
									<SyncStrip
										session={session}
										engine={engine}
										sequenceId={report.sequenceId}
										issue={i}
										event={eventOf(report, i)}
										checkJobId={props.jobId}
									/>
								) : null}
							</div>
						);
					})}
				</div>
			))}
		</div>
	);
}

// ── listen here ─────────────────────────────────────────────────────────────────────────────────────────────────────

function Listen(props: {
	session: EditorSession;
	seq: Sequence;
	rows: ListenRow[];
	playing: { index: number; all: boolean } | null;
	readOnly: boolean;
	reveal(f: number): void;
}) {
	const { session, seq, rows } = props;
	const [noteFor, setNoteFor] = useState<string | null>(null);
	const keyOf = (row: ListenRow) => `${row.slot}:${row.frame}`;
	const [note, setNote] = useState('');
	if (!rows.length) return null;
	const openNote = (row: ListenRow) => {
		setNoteFor(keyOf(row));
		setNote(row.verdict?.note ?? '');
	};
	const save = (row: ListenRow, verdict: 'ok' | 'flag', text: string) => {
		recordVerdict(session, seq.id, row, verdict, text);
		setNoteFor(null);
	};
	return (
		<section
			className="px-2 py-1.5"
			aria-labelledby="sound-check-listen-title"
			data-testid="sound-check-listen"
		>
			<div className="flex items-center gap-2">
				<h3 id="sound-check-listen-title" className="m-0 text-pr-small font-semibold text-pr-strong">
					{t('Listen here')}
				</h3>
				<Button
					variant="secondary"
					className="ml-auto"
					data-testid="sound-check-play-all"
					// its own click starts / stops Play all (a press here must not stop the window first: it would restart)
					{...{ [LISTEN_KEEP_ATTR]: '' }}
					onClick={() =>
						props.playing?.all ? stopListen(session) : playListen(session, seq.id, rows, 0, { all: true })
					}
				>
					<Icon id={props.playing?.all ? 'transport.pause' : 'transport.play'} size={12} />
					{props.playing?.all ? t('Stop') : t('Play all')}
				</Button>
			</div>
			<p className="m-0 mb-1 text-pr-small text-pr-muted">
				{t('Measurements cannot hear: listen to these moments and say whether they sound right.')}
			</p>
			<ol className="m-0 flex list-none flex-col gap-1 p-0">
				{rows.map((row, idx) => {
					const v = row.verdict?.verdict ?? null;
					const stale = verdictStaleText(row.verdict);
					const isPlaying = props.playing?.index === idx;
					return (
						<li
							key={`${row.slot}:${row.frame}`}
							className={`rounded-pr-control border px-1.5 py-1 ${isPlaying ? 'border-pr-text' : 'border-pr-border-subtle'}`}
							data-testid="sound-check-listen-row"
							data-slot={row.slot}
							data-frame={row.frame}
							data-verdict={v ?? ''}
							data-verdict-stale={stale ? 'true' : undefined}
						>
							<div className="flex items-center gap-1.5">
								<Button
									variant="quiet"
									aria-label={
										isPlaying ? t('Stop {0}', row.timecode) : t('Play 4 s around {0}', row.timecode)
									}
									aria-pressed={isPlaying}
									data-testid="sound-check-listen-play"
									{...{ [LISTEN_KEEP_ATTR]: '' }}
									onClick={() => (isPlaying ? stopListen(session) : playListen(session, seq.id, rows, idx))}
								>
									<Icon id={isPlaying ? 'transport.pause' : 'transport.play'} size={12} />
								</Button>
								<button
									type="button"
									className="font-pr-mono text-pr-small text-pr-timecode underline-offset-2 hover:underline"
									title={t('Go to {0}', row.timecode)}
									onClick={() =>
										jumpTo(
											session,
											{
												frame: row.frame,
												...(row.clipId ? { clipIds: [row.clipId] } : {}),
												...(row.cueId ? { cueId: row.cueId } : {}),
											},
											props.reveal,
										)
									}
								>
									{row.timecode}
								</button>
								<span className="min-w-0 flex-1 text-pr-small" title={t(row.slotLabel)}>
									{row.text}
								</span>
								<span className="flex items-center gap-1.5" {...{ [LISTEN_KEEP_ATTR]: '' }}>
									<Button
										variant={v === 'ok' ? 'primary' : 'quiet'}
										aria-pressed={v === 'ok'}
										disabled={props.readOnly}
										data-testid="sound-check-sounds-right"
										onClick={() => save(row, 'ok', row.verdict?.note ?? '')}
									>
										✓ {t('Sounds right')}
									</Button>
									<Button
										variant={v === 'flag' ? 'danger' : 'quiet'}
										aria-pressed={v === 'flag'}
										disabled={props.readOnly}
										data-testid="sound-check-flag"
										onClick={() => openNote(row)}
									>
										✕ {t('Flag')}
									</Button>
								</span>
							</div>
							{stale ? (
								<p
									className="m-0 ml-8 flex items-center gap-1 text-pr-small text-pr-warning"
									data-testid="sound-check-verdict-stale"
								>
									<Icon id="status.warning" size={12} />
									{stale}
								</p>
							) : null}
							{row.verdict?.note && noteFor !== keyOf(row) ? (
								<p className="m-0 ml-8 text-pr-small text-pr-muted" data-testid="sound-check-note">
									{t('Note: {0}', row.verdict.note)}
								</p>
							) : null}
							{noteFor === keyOf(row) ? (
								<div className="ml-8 mt-1 flex items-center gap-1" {...{ [LISTEN_KEEP_ATTR]: '' }}>
									<TextField
										autoFocus
										className="min-w-0 flex-1"
										aria-label={t('What is wrong at {0}?', row.timecode)}
										placeholder={t('What is wrong? (optional)')}
										value={note}
										maxLength={2000}
										data-testid="sound-check-note-input"
										onChange={(e) => setNote(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === 'Enter') {
												e.preventDefault();
												save(row, 'flag', note);
											} else if (e.key === 'Escape') {
												e.stopPropagation();
												setNoteFor(null);
											}
										}}
									/>
									<Button
										variant="primary"
										data-testid="sound-check-note-save"
										onClick={() => save(row, 'flag', note)}
									>
										{t('Flag')}
									</Button>
									<Button variant="quiet" onClick={() => setNoteFor(null)}>
										{t('Cancel')}
									</Button>
								</div>
							) : null}
						</li>
					);
				})}
			</ol>
		</section>
	);
}
