// Text panel ▸ Transcript ▸ Clean Up (spec 14 TC-040…TC-044; docs/wp-notes/transcript-cleanup.md "Clean Up UI"):
// preset picker (Fast, Natural, user presets; "edited" when the sequence overrides it), settings drawer (every
// setting with its unit, word lists, presets), script attach / paste, scope (sequence, In to Out, selected clips),
// Analyze with progress and Cancel; then the review — live statistics, Play result / Play removed / Stop, Apply (one
// undo step), Discard, the findings list grouped by kind, the transcript with the plan's marks and the retake groups.
// Failures show here, never as a crash (an error boundary wraps the mode).
import { BUILTIN_CLEANUP_PRESETS, readSequenceCleanup, type Sequence } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useStoreSelector } from '@jasper/session/react';
import { Button, PanelErrorBoundary, Select, Toggle, toast } from '@jasper/ui';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { t } from '../../../i18n/runtime.ts';
import { useEngineOrNull } from '../../../state/engine.tsx';
import { CleanupTranscript } from './CleanupTranscript.tsx';
import { type CleanupUiState, cleanupFor, type ScopeChoice } from './controller.ts';
import { FindingsList } from './FindingsList.tsx';
import { clockText, KIND_COLOR, KIND_LABELS, KIND_ORDER } from './model.ts';
import { RetakeGroups } from './RetakeGroups.tsx';
import { ScriptDrawer } from './ScriptDrawer.tsx';
import { SettingsDrawer } from './SettingsDrawer.tsx';

type Props = { session: EditorSession; seq: Sequence };

export function CleanupMode(props: Props) {
	return (
		<PanelErrorBoundary name="Clean Up">
			<CleanupModeBody {...props} />
		</PanelErrorBoundary>
	);
}

/** The narrowest panel width (px) at which the findings list and the transcript sit side by side. */
const SIDE_BY_SIDE_PX = 620;

function CleanupModeBody({ session, seq }: Props) {
	const c = cleanupFor(session);
	const engine = useEngineOrNull()?.client ?? session.engine ?? null;
	const st = useStoreSelector(c.store, (s) => s);
	const [drawer, setDrawer] = useState<null | 'settings' | 'script'>(null);
	useEffect(() => {
		c.attachEngine(engine);
		void c.refreshPresets();
	}, [c, engine]);

	const busy = st.phase === 'analyzing' || st.phase === 'loading';
	const reviewing = (st.phase === 'review' || st.phase === 'applying') && !!st.analysis;
	const otherSeq = reviewing && st.sequenceId !== seq.id;

	const analyze = async () => {
		const r = await c.analyze(engine);
		if (!r.ok && r.reason !== 'superseded' && r.reason !== t('Cancelled'))
			toast({ kind: 'warning', title: t('Clean Up Voice'), detail: r.reason });
	};

	return (
		<div className="flex h-full min-h-0 flex-col" data-testid="text.cleanup">
			<Toolbar
				session={session}
				seq={seq}
				st={st}
				busy={busy}
				drawer={drawer}
				setDrawer={setDrawer}
				onAnalyze={() => void analyze()}
				canAnalyze={!!engine}
			/>
			{drawer === 'settings' ? <SettingsDrawer session={session} seq={seq} /> : null}
			{drawer === 'script' ? <ScriptDrawer session={session} seq={seq} /> : null}
			{st.error ? (
				<div
					role="alert"
					className="flex shrink-0 items-start gap-2 border-b border-pr-border-subtle bg-pr-panel-alt px-2 py-1 text-pr-small text-pr-danger"
					data-testid="text.cleanup.error"
				>
					<span className="min-w-0 flex-1">
						{st.error.message}
						<span className="text-pr-muted"> ({st.error.code})</span>
					</span>
					<Button variant="quiet" onClick={() => c.clearError()} aria-label="Dismiss the error">
						×
					</Button>
				</div>
			) : null}
			{busy ? <Progress st={st} onCancel={() => void c.cancel()} /> : null}
			{reviewing && !otherSeq ? (
				<Review session={session} seq={seq} st={st} />
			) : (
				<Intro busy={busy} otherSeq={otherSeq} />
			)}
		</div>
	);
}

function Toolbar(p: {
	session: EditorSession;
	seq: Sequence;
	st: CleanupUiState;
	busy: boolean;
	drawer: null | 'settings' | 'script';
	setDrawer(d: null | 'settings' | 'script'): void;
	onAnalyze(): void;
	canAnalyze: boolean;
}) {
	const c = cleanupFor(p.session);
	const stored = readSequenceCleanup(p.seq);
	const presetId = stored.settings?.presetId ?? 'builtin.fast';
	const edited = !!stored.settings?.overrides && Object.keys(stored.settings.overrides).length > 0;
	const presets = [
		...BUILTIN_CLEANUP_PRESETS.map((x) => ({
			id: x.id,
			name: x.id === 'builtin.fast' ? t('Fast') : t('Natural'),
		})),
		...p.st.userPresets.map((x) => ({ id: x.id, name: x.name })),
	];
	if (!presets.some((x) => x.id === presetId)) presets.push({ id: presetId, name: t('Missing preset') });
	const script = stored.script;
	return (
		<div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-pr-border-subtle px-2 py-1">
			<Select
				label="Preset"
				className="w-36"
				value={presetId}
				onValueChange={(id) => c.configure({ settings: { presetId: id } }, t('Clean Up Preset'))}
				options={presets.map((x) => ({
					value: x.id,
					label: x.id === presetId && edited ? t('{0} (edited)', x.name) : x.name,
				}))}
				disabled={p.busy}
			/>
			<Button
				variant={p.drawer === 'settings' ? 'secondary' : 'quiet'}
				onClick={() => p.setDrawer(p.drawer === 'settings' ? null : 'settings')}
				aria-expanded={p.drawer === 'settings'}
				data-testid="text.cleanup.settings"
			>
				Settings…
			</Button>
			<Button
				variant={p.drawer === 'script' ? 'secondary' : 'quiet'}
				onClick={() => p.setDrawer(p.drawer === 'script' ? null : 'script')}
				aria-expanded={p.drawer === 'script'}
				title={script ? t('Script: {0}', script.name) : t('Attach or paste the video script')}
				data-testid="text.cleanup.script"
			>
				{script ? t('Script ✓') : t('Script…')}
			</Button>
			<Select
				label="Scope"
				className="w-32"
				value={p.st.scopeChoice}
				onValueChange={(v) => c.setScopeChoice(v as ScopeChoice)}
				options={[
					{ value: 'sequence', label: 'Whole sequence' },
					{ value: 'inout', label: 'In to Out' },
					{ value: 'clips', label: 'Selected clips' },
				]}
				disabled={p.busy}
			/>
			<span className="flex-1" />
			<Button
				variant="primary"
				onClick={p.onAnalyze}
				disabled={p.busy || !p.canAnalyze}
				disabledReason={p.busy ? t('An analysis is running') : t('Clean Up needs the engine')}
				data-testid="text.cleanup.analyze"
			>
				{p.st.phase === 'review' ? t('Analyze Again') : t('Analyze')}
			</Button>
		</div>
	);
}

function Progress({ st, onCancel }: { st: CleanupUiState; onCancel(): void }) {
	const pct = st.progress === null ? null : Math.round(st.progress * 100);
	return (
		<div
			className="flex shrink-0 items-center gap-2 border-b border-pr-border-subtle px-2 py-1 text-pr-small text-pr-muted"
			role="status"
			aria-live="polite"
			data-testid="text.cleanup.progress"
		>
			<div
				className="h-1 min-w-16 flex-1 overflow-hidden rounded-pr-pill bg-pr-field"
				role="progressbar"
				aria-label="Clean Up analysis"
				aria-valuemin={0}
				aria-valuemax={100}
				{...(pct === null ? {} : { 'aria-valuenow': pct })}
			>
				<div
					className={`h-full bg-pr-accent-fill ${pct === null ? 'w-1/3 animate-pulse' : ''}`}
					style={pct === null ? undefined : { width: `${pct}%` }}
				/>
			</div>
			<span className="shrink-0">
				{st.stage ?? t('Analyzing')}
				{pct === null ? '' : ` · ${pct} %`}
			</span>
			<Button variant="quiet" onClick={onCancel} data-testid="text.cleanup.cancel">
				Cancel
			</Button>
		</div>
	);
}

function Intro({ busy, otherSeq }: { busy: boolean; otherSeq: boolean }) {
	return (
		<div
			className="min-h-0 flex-1 overflow-auto px-3 py-2 text-pr-small text-pr-muted"
			data-testid="text.cleanup.intro"
		>
			{otherSeq ? (
				<p className="m-0 mb-2 text-pr-text">
					The review in progress belongs to another sequence: open it to continue, or Analyze this one.
				</p>
			) : null}
			<p className="m-0 mb-2">
				{busy
					? t('Measuring the voice and looking for what to cut. The editor stays usable meanwhile.')
					: t(
							'Clean Up finds retakes, restarts, false starts, fillers, off-script talk, pauses and breaths in the transcribed speech, and cuts them at the audio level so no dead air is left. Nothing changes until you Apply, and Apply is one undo step.',
						)}
			</p>
			{busy ? null : (
				<p className="m-0">
					Choose a preset (Fast = tight jump cuts, Natural = calmer pacing), attach the script if you have
					one, then Analyze.
				</p>
			)}
		</div>
	);
}

function Review({ session, seq, st }: { session: EditorSession; seq: Sequence; st: CleanupUiState }) {
	const c = cleanupFor(session);
	const a = st.analysis!;
	const box = useRef<HTMLDivElement>(null);
	const [wide, setWide] = useState(false);
	const [view, setView] = useState<'findings' | 'transcript' | 'retakes'>('findings');
	const [right, setRight] = useState<'transcript' | 'retakes'>('transcript');
	useLayoutEffect(() => {
		const el = box.current;
		if (!el || typeof ResizeObserver === 'undefined') return;
		const ro = new ResizeObserver(() => setWide(el.clientWidth >= SIDE_BY_SIDE_PX));
		ro.observe(el);
		setWide(el.clientWidth >= SIDE_BY_SIDE_PX);
		return () => ro.disconnect();
	}, []);
	const blocker = c.applyBlocker();
	const apply = () => {
		const r = c.apply();
		if (r.ok)
			toast({
				kind: 'success',
				title: t('Clean Up applied'),
				detail: t('Edit ▸ Undo reverts it in one step.'),
			});
		else toast({ kind: 'warning', title: t('Clean Up Voice'), detail: r.reason });
	};
	const play = (which: 'result' | 'removed') => {
		const r = which === 'result' ? c.playResult() : c.playRemoved();
		if (!r.ok) toast({ kind: 'info', title: r.reason });
	};
	const tabs = (
		items: Array<{ id: 'findings' | 'transcript' | 'retakes'; label: string }>,
		value: string,
		set: (v: never) => void,
	) => (
		<div className="flex shrink-0 gap-1 border-b border-pr-border-subtle px-2 py-[2px]" role="tablist">
			{items.map((it) => (
				<button
					key={it.id}
					type="button"
					role="tab"
					aria-selected={value === it.id}
					className={`rounded-pr-control px-2 py-[1px] text-pr-small ${value === it.id ? 'bg-pr-selected text-pr-strong' : 'text-pr-muted hover:text-pr-text'}`}
					onClick={() => set(it.id as never)}
					data-testid={`text.cleanup.view.${it.id}`}
				>
					{it.label}
				</button>
			))}
		</div>
	);
	const findings = <FindingsList session={session} seq={seq} st={st} />;
	const transcript = <CleanupTranscript session={session} st={st} />;
	const retakes = <RetakeGroups session={session} st={st} />;
	const retakeLabel = t('Retakes ({0})', a.groups.length);
	return (
		<div ref={box} className="flex min-h-0 flex-1 flex-col" data-testid="text.cleanup.review">
			<Stats st={st} />
			<div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-pr-border-subtle px-2 py-1">
				{st.preview ? (
					<Button variant="secondary" onClick={() => c.stopPreview()} data-testid="text.cleanup.stop">
						Stop
					</Button>
				) : (
					<>
						<Button
							variant="quiet"
							onClick={() => play('result')}
							disabled={st.stale}
							disabledReason={t('The sequence changed since the analysis: Analyze again')}
							title={t('Play the timeline with the cuts applied (nothing is changed)')}
							data-testid="text.cleanup.playResult"
						>
							▶ Play result
						</Button>
						<Button
							variant="quiet"
							onClick={() => play('removed')}
							disabled={st.stale}
							disabledReason={t('The sequence changed since the analysis: Analyze again')}
							title={t('Play only what will be removed')}
							data-testid="text.cleanup.playRemoved"
						>
							▶ Play removed
						</Button>
					</>
				)}
				<Toggle checked={st.autoAdvance} onCheckedChange={(v) => c.setAutoAdvance(v)} label="Auto-advance" />
				<span className="flex-1" />
				<Button variant="quiet" onClick={() => c.discard()} data-testid="text.cleanup.discard">
					Discard
				</Button>
				<Button
					variant="primary"
					onClick={apply}
					disabled={!!blocker}
					disabledReason={blocker ?? undefined}
					data-testid="text.cleanup.apply"
				>
					{a.plan.extend?.length === 1
						? t('Apply {0} cuts and 1 edge repair', a.plan.ranges.length)
						: a.plan.extend?.length
							? t('Apply {0} cuts and {1} edge repairs', a.plan.ranges.length, a.plan.extend.length)
							: t('Apply {0} cuts', a.plan.ranges.length)}
				</Button>
			</div>
			{st.stale ? (
				<p
					className="m-0 shrink-0 border-b border-pr-border-subtle bg-pr-panel-alt px-2 py-1 text-pr-small text-pr-warning"
					role="status"
					data-testid="text.cleanup.stale"
				>
					The sequence changed since the analysis: Analyze again before applying.
				</p>
			) : null}
			<Notes st={st} />
			{wide ? (
				<div className="flex min-h-0 flex-1">
					<div className="flex min-h-0 w-[45%] min-w-0 flex-col border-r border-pr-border-subtle">
						{findings}
					</div>
					<div className="flex min-h-0 min-w-0 flex-1 flex-col">
						{tabs(
							[
								{ id: 'transcript', label: t('Transcript') },
								{ id: 'retakes', label: retakeLabel },
							],
							right,
							setRight,
						)}
						{right === 'transcript' ? transcript : retakes}
					</div>
				</div>
			) : (
				<div className="flex min-h-0 flex-1 flex-col">
					{tabs(
						[
							{ id: 'findings', label: t('Findings ({0})', a.findings.length) },
							{ id: 'transcript', label: t('Transcript') },
							{ id: 'retakes', label: retakeLabel },
						],
						view,
						setView,
					)}
					{view === 'findings' ? findings : view === 'transcript' ? transcript : retakes}
				</div>
			)}
		</div>
	);
}

function Stat({ label, value, testId }: { label: string; value: ReactNode; testId: string }) {
	return (
		<span className="flex items-baseline gap-1 whitespace-nowrap">
			<span className="text-pr-muted">{label}</span>
			<span className="pr-tabular text-pr-text" data-testid={testId}>
				{value}
			</span>
		</span>
	);
}

/** Live statistics (TC-042, TC-026): they follow every decision. */
function Stats({ st }: { st: CleanupUiState }) {
	const s = st.analysis!.plan.stats;
	const removed = KIND_ORDER.filter((k) => (s.removedByKind[k] ?? 0) > 0.005)
		.sort((x, y) => (s.removedByKind[y] ?? 0) - (s.removedByKind[x] ?? 0))
		.slice(0, 4);
	return (
		<div
			className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-[2px] border-b border-pr-border-subtle bg-pr-panel-alt px-2 py-1 text-pr-small"
			aria-live="polite"
			data-testid="text.cleanup.stats"
			data-planning={st.planning ? 'true' : undefined}
		>
			<Stat
				label={t('Length')}
				value={`${clockText(s.inputDuration)} → ${clockText(s.outputDuration)}`}
				testId="text.cleanup.stat.length"
			/>
			<Stat label={t('Cuts')} value={st.analysis!.plan.ranges.length} testId="text.cleanup.stat.cuts" />
			<Stat label={t('Cuts / min')} value={s.cutsPerMinute.toFixed(1)} testId="text.cleanup.stat.cpm" />
			<Stat
				label={t('Dead air / min')}
				value={s.deadAirPerMinute === null ? '—' : `${s.deadAirPerMinute.toFixed(2)} s`}
				testId="text.cleanup.stat.deadAir"
			/>
			<Stat
				label={t('Longest silence left')}
				value={s.largestSilenceLeft === null ? '—' : `${s.largestSilenceLeft.toFixed(2)} s`}
				testId="text.cleanup.stat.silence"
			/>
			{removed.map((k) => (
				<span key={k} className="flex items-center gap-1 whitespace-nowrap text-pr-muted">
					<span
						className="inline-block h-2 w-2 rounded-pr-pill"
						style={{ background: KIND_COLOR[k] }}
						aria-hidden="true"
					/>
					{KIND_LABELS[k]} {(s.removedByKind[k] ?? 0).toFixed(1)} s
				</span>
			))}
			{st.planning ? <span className="text-pr-muted">{t('Updating…')}</span> : null}
		</div>
	);
}

function Notes({ st }: { st: CleanupUiState }) {
	const a = st.analysis!;
	const lines: string[] = [];
	if (st.voice?.missing.length)
		lines.push(
			t(
				'{0} media without a voice analysis are cut at word timings: {1}',
				st.voice.missing.length,
				st.voice.missing.map((m) => m.reason).join('; '),
			),
		);
	if (a.plan.skipped.length)
		lines.push(
			t(
				'{0} fillers are kept because their cut would land on loud sound (avoid harsh cuts)',
				a.plan.skipped.length,
			),
		);
	if (a.script) {
		const unsaid = a.script.filter((l) => !l.said).length;
		lines.push(t('Script: {0} of {1} lines said', a.script.length - unsaid, a.script.length));
	}
	if (!lines.length) return null;
	return (
		<ul
			className="m-0 shrink-0 list-none border-b border-pr-border-subtle px-2 py-[2px] text-pr-small text-pr-muted"
			data-testid="text.cleanup.notes"
		>
			{lines.map((l) => (
				<li key={l}>{l}</li>
			))}
		</ul>
	);
}
