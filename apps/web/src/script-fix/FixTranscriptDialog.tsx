// Fix Transcript… (spec 17 SC-081; Text panel ▸ Transcript ▸ Fix Transcript…, Text ▸ Fix Transcript…, Sequence ▸ Fix
// Transcript from Script…): the sources (Script, Personal glossary), the scope (whole recordings / what the sequence
// uses / In–Out), the strictness (Careful / Standard / Generous) and "Show fixes I rejected before", saved with the
// sequence (`scriptFix.configure`, one coalesced undo step); a dry run that follows every change (aligned and
// off-script share, candidates by group and category, the subtitles a fix could not update, an estimated time for the
// audio check on this machine); Run (the `transcript-fix` job with progress, Cancel cancels it) opens the proposal in
// Review. Disabled with the reason when there is no transcript, no script and no glossary, or no speech model.
// Every failure (a refusal, a job error, an unreadable result) is shown in the dialog; nothing is ever blank.
import type { EngineJob } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import type { EditorSession } from '@jasper/session';
import { useStoreSelector } from '@jasper/session/react';
import { Checkbox, Dialog, type HostedDialogProps, registerDialog, Select, toast } from '@jasper/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useDialogClose } from '../extensions/dialog.ts';
import { t } from '../i18n/runtime.ts';
import { openReview } from '../proposals/actions.ts';
import { sequenceName } from '../speech/model.ts';
import {
	dryRunFix,
	type FixEngine,
	type FixResult,
	FixRunError,
	fixErrorText,
	proposeFix,
} from './engine.ts';
import {
	alignmentShares,
	categoryCountsText,
	estimateText,
	type FixScope,
	type FixSettings,
	type FixSource,
	type FixStrictness,
	fixBlocker,
	fixInputs,
	groupCountsText,
	pct,
	requestSources,
	type SpeechModelLite,
	scriptSummary,
	scriptSummaryText,
	skipReasonsText,
} from './model.ts';

export const FIX_TRANSCRIPT_DIALOG = 'scriptFix.fixTranscript';

let registered = false;
export function registerFixTranscriptDialog(): void {
	if (registered) return;
	registered = true;
	registerDialog(FIX_TRANSCRIPT_DIALOG, FixTranscriptDialog);
}

/** What the dialog reads besides the fix routes (the speech models and the glossary size). */
export type FixDialogEngine = FixEngine & Pick<EngineClient, 'call' | 'listGlossary'>;

export type FixTranscriptDialogProps = {
	session: EditorSession;
	/** Null: the engine is not connected or has no Fix Transcript (said in the dialog). */
	engine: FixDialogEngine | null;
	sequenceId: string;
	onReview?: () => void;
};

const STRICTNESS_TEXT: Record<FixStrictness, string> = {
	careful: 'Careful: only fixes the audio clearly supports',
	standard: 'Standard: the measured default',
	generous: 'Generous: more fixes, a few more to check',
};
const SCOPE_LABELS: Record<FixScope, string> = {
	recordings: 'Whole recordings',
	used: 'Only what the sequence uses',
	inOut: 'In to Out',
};

function Row(p: { label: string; children: React.ReactNode; testId?: string }) {
	return (
		<div
			className="grid min-h-[28px] grid-cols-[120px_minmax(0,1fr)] items-center gap-3"
			data-testid={p.testId}
		>
			<span className="text-pr-muted">{p.label}</span>
			<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">{p.children}</div>
		</div>
	);
}

function useSpeechModelList(engine: FixDialogEngine | null): {
	models: SpeechModelLite[] | null;
	error: string | null;
} {
	const [state, setState] = useState<{ models: SpeechModelLite[] | null; error: string | null }>({
		models: null,
		error: null,
	});
	useEffect(() => {
		let live = true;
		if (!engine) return;
		engine
			.call('speechModels')
			.then((r) => {
				const list = (r as { models?: unknown })?.models;
				if (!live) return;
				setState({
					models: Array.isArray(list)
						? list
								.filter((m): m is SpeechModelLite => !!m && typeof (m as SpeechModelLite).id === 'string')
								.map((m) => ({ id: m.id, installed: !!m.installed, multilingual: !!m.multilingual }))
						: [],
					error: null,
				});
			})
			.catch((e) => live && setState({ models: null, error: fixErrorText(e) }));
		return () => {
			live = false;
		};
	}, [engine]);
	return state;
}

function useGlossarySize(engine: FixDialogEngine | null): { entries: number | null; error: string | null } {
	const [state, setState] = useState<{ entries: number | null; error: string | null }>({
		entries: null,
		error: null,
	});
	useEffect(() => {
		let live = true;
		if (!engine) {
			setState({ entries: 0, error: null });
			return;
		}
		engine
			.listGlossary()
			.then(
				(r) => live && setState({ entries: Array.isArray(r?.entries) ? r.entries.length : 0, error: null }),
			)
			.catch((e) => live && setState({ entries: null, error: fixErrorText(e) }));
		return () => {
			live = false;
		};
	}, [engine]);
	return state;
}

/** The dry run's summary lines (SC-081). */
function DrySummary(p: { r: FixResult; scriptSourced: boolean }) {
	const rep = p.r.report;
	const shares = alignmentShares(rep);
	const est = estimateText(rep.estimate);
	const total = rep.candidates.total;
	const unscored = rep.perMedia.filter((m) => m.unscored);
	return (
		<div className="flex flex-col gap-0.5 text-pr-small" data-testid="fix-dry-summary">
			{shares ? (
				<span className="text-pr-text pr-tabular" data-testid="fix-dry-alignment">
					{t(
						'{0} of the transcript follows the script · {1} off-script ({2})',
						pct(shares.aligned),
						pct(shares.offScript),
						rep.perMedia.length === 1 ? t('1 recording') : t('{0} recordings', rep.perMedia.length),
					)}
				</span>
			) : p.scriptSourced ? null : (
				<span className="text-pr-muted">{t('Glossary only: no alignment with a script')}</span>
			)}
			<span className="text-pr-text pr-tabular" data-testid="fix-dry-candidates">
				{total
					? t('{0} possible fixes: {1}', total, groupCountsText(rep.candidates.byGroup))
					: t('No disagreements with the script or the glossary: nothing to fix')}
			</span>
			{total ? (
				<span className="text-pr-muted pr-tabular" data-testid="fix-dry-categories">
					{categoryCountsText(rep.candidates.byCategory)}
				</span>
			) : null}
			{est && total ? (
				<span className="text-pr-muted" data-testid="fix-dry-estimate">
					{est}
				</span>
			) : null}
			{rep.patch.skipped.length ? (
				<span className="text-pr-warning" data-testid="fix-dry-skipped">
					{t(
						'{0} subtitles could not be updated by these fixes: {1}',
						rep.patch.skipped.length,
						skipReasonsText(rep.patch.skipped),
					)}
				</span>
			) : null}
			{unscored.map((m) => (
				<span key={m.name} className="text-pr-warning" data-fix-unscored>
					{t('{0}: not checked against the audio ({1})', m.name, m.unscored!.message)}
				</span>
			))}
			{rep.speech.problem ? (
				<span className="text-pr-warning" data-testid="fix-dry-speech">
					{rep.speech.problem}
				</span>
			) : null}
			{rep.warnings.slice(0, 5).map((w) => (
				<span key={w.code + w.message} className="text-pr-muted" data-fix-warning={w.code}>
					! {w.message}
				</span>
			))}
		</div>
	);
}

export function FixTranscriptDialog(props: HostedDialogProps<FixTranscriptDialogProps>) {
	const { open, finish } = useDialogClose(props.close);
	const { session, sequenceId, engine } = props;
	const doc = useStoreSelector(session.store, (s) => s.document);
	const readOnly = useStoreSelector(session.store, (s) => s.readOnly);
	const seq = doc.sequences[sequenceId];
	const inputs = useMemo(() => (seq ? fixInputs(doc, seq) : null), [doc, seq]);
	const { models, error: modelsError } = useSpeechModelList(engine);
	const glossary = useGlossarySize(engine);
	const [settings, setSettings] = useState<FixSettings | null>(() => inputs?.settings ?? null);
	const [showRejected, setShowRejected] = useState(false);
	const [dry, setDry] = useState<FixResult | null>(null);
	const [dryError, setDryError] = useState<string | null>(null);
	const [running, setRunning] = useState<{ progress: number | null; stage: string } | null>(null);
	const [message, setMessage] = useState<{ text: string; tone: 'warning' | 'info' } | null>(null);
	const abort = useRef<AbortController | null>(null);
	const summary = useMemo(
		() => (inputs?.script ? scriptSummary(inputs.script.text, inputs.languages[0] ?? null) : null),
		[inputs?.script, inputs?.languages],
	);

	const sources = settings?.sources ?? [];
	const blocker = inputs ? fixBlocker(inputs, sources, glossary.entries, models, { forRun: false }) : null;
	const runBlocker = !engine
		? t('The engine is not connected')
		: readOnly
			? t('The project is read-only')
			: inputs
				? (fixBlocker(inputs, sources, glossary.entries, models, { forRun: true }) ??
					(dry?.report.speech.problem ? dry.report.speech.problem : null))
				: t('Open a sequence first');
	const request = useMemo(
		() =>
			settings && inputs
				? {
						sources: requestSources(settings.sources, inputs, glossary.entries),
						scope: settings.scope === 'inOut' && !inputs.hasInOut ? ('recordings' as const) : settings.scope,
						strictness: settings.strictness,
						showRejected,
					}
				: null,
		[settings, inputs, glossary.entries, showRejected],
	);
	const key = JSON.stringify(request);

	// the dry run follows every change (debounced; an older run is aborted)
	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the request's identity
	useEffect(() => {
		if (!request || !engine || blocker || (glossary.entries === null && !glossary.error)) {
			setDry(null);
			return;
		}
		const ac = new AbortController();
		setDryError(null);
		const timer = setTimeout(() => {
			dryRunFix(engine, session.projectId, sequenceId, request, ac.signal).then(
				(r) => {
					if (ac.signal.aborted) return;
					setDry(r);
					setDryError(null);
				},
				(e) => {
					if (ac.signal.aborted) return;
					setDry(null);
					setDryError(fixErrorText(e));
				},
			);
		}, 300);
		return () => {
			clearTimeout(timer);
			ac.abort();
		};
	}, [key, engine, session.projectId, sequenceId, blocker, glossary.entries, glossary.error]);
	useEffect(() => () => abort.current?.abort(), []);

	/** A setting changed: kept with the sequence (one coalesced undo step per dialog). */
	const change = (patch: Partial<FixSettings>) => {
		if (!settings) return;
		const next = { ...settings, ...patch };
		setSettings(next);
		setMessage(null);
		if (readOnly) return;
		const r = session.apply({
			label: t('Fix Transcript Settings'),
			origin: 'user',
			sequenceId,
			commands: [{ type: 'scriptFix.configure', sequenceId, settings: next }] as never[],
			coalesceKey: `scriptfix:${sequenceId}:settings`,
		});
		if (!r.ok)
			setMessage({
				text: t('The settings were not saved: {0}', r.errors[0]?.message ?? t('refused')),
				tone: 'warning',
			});
	};
	const toggleSource = (s: FixSource, on: boolean) => {
		if (!settings) return;
		const list = on ? [...new Set([...settings.sources, s])] : settings.sources.filter((x) => x !== s);
		if (!list.length) return; // at least one source stays on
		change({ sources: (['script', 'glossary'] as const).filter((x) => list.includes(x)) });
	};

	const run = async (): Promise<boolean> => {
		if (!request || !engine || runBlocker) return false;
		setMessage(null);
		const ac = new AbortController();
		abort.current = ac;
		setRunning({ progress: null, stage: t('Starting…') });
		try {
			const r = await proposeFix(engine, session.projectId, sequenceId, request, {
				signal: ac.signal,
				onJob: (j: EngineJob) => setRunning({ progress: j.progress, stage: j.stage ?? j.title }),
			});
			setRunning(null);
			if (!r.proposalId) {
				setMessage({
					text: r.report.candidates.total
						? t('The audio check kept the transcript everywhere: nothing to fix')
						: t('No disagreements with the script or the glossary: nothing to fix'),
					tone: 'info',
				});
				return false;
			}
			await openReview(session, r.proposalId);
			toast({
				kind: 'success',
				title: r.itemCount === 1 ? t('1 fix to review') : t('{0} fixes to review', r.itemCount),
			});
			props.onReview?.();
			return true;
		} catch (e) {
			setRunning(null);
			if (e instanceof FixRunError && e.code === 'E_CANCELLED') {
				setMessage({ text: t('Cancelled: nothing was proposed'), tone: 'info' });
				return false;
			}
			setMessage({ text: fixErrorText(e), tone: 'warning' });
			return false;
		} finally {
			abort.current = null;
		}
	};

	const progress = running?.progress != null ? Math.round(running.progress * 100) : null;
	const nothing = !!dry && dry.report.candidates.total === 0;
	const title = seq ? t('Fix Transcript — {0}', sequenceName(doc, sequenceId)) : t('Fix Transcript');
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => {
				if (!o) {
					abort.current?.abort();
					finish();
				}
			}}
			onCancel={() => abort.current?.abort()}
			title={title}
			size="medium"
			primaryLabel={running ? t('Fixing…') : t('Fix Transcript')}
			primaryDisabled={!!running || !!runBlocker || !request || nothing}
			onPrimary={async () => {
				if (await run()) finish(true);
				return false;
			}}
			data-testid="fix-transcript-dialog"
		>
			{!seq || !inputs || !settings ? (
				<p className="text-pr-small text-pr-muted">{t('Open a sequence first')}</p>
			) : (
				<div className="flex flex-col gap-3 text-pr-ui">
					<p className="text-pr-small text-pr-muted">
						{t(
							'Fixes recognition errors in the transcript — and in the subtitles made from it — from the video script and your speech glossary. The audio decides each fix, so words you really said differently stay. Nothing changes until you accept the fixes in Review.',
						)}
					</p>
					<Row label={t('Fix from')} testId="fix-sources">
						<span data-testid="fix-source-script">
							<Checkbox
								checked={settings.sources.includes('script')}
								disabled={!inputs.script || !!running}
								onCheckedChange={(c) => toggleSource('script', c)}
								label={
									inputs.script
										? t('Script: {0}', inputs.script.name)
										: t('Script (none attached: use Script… in the Transcript tab)')
								}
							/>
						</span>
						<span data-testid="fix-source-glossary">
							<Checkbox
								checked={settings.sources.includes('glossary')}
								disabled={!glossary.entries || !!running}
								onCheckedChange={(c) => toggleSource('glossary', c)}
								label={
									glossary.entries === null
										? t('Personal glossary')
										: t('Personal glossary ({0} entries)', glossary.entries)
								}
							/>
						</span>
					</Row>
					{summary ? (
						<p className="-mt-2 pl-[132px] text-pr-small text-pr-muted" data-testid="fix-script-summary">
							{scriptSummaryText(summary)}
						</p>
					) : null}
					{glossary.error ? (
						<p className="-mt-2 pl-[132px] text-pr-small text-pr-warning" role="alert">
							{t('The speech glossary could not be read: {0}', glossary.error)}
						</p>
					) : null}
					<Row label={t('Scope')} testId="fix-scope">
						<Select
							label={t('Scope')}
							className="w-72"
							disabled={!!running}
							value={settings.scope === 'inOut' && !inputs.hasInOut ? 'recordings' : settings.scope}
							onValueChange={(v) => change({ scope: v as FixScope })}
							options={(['recordings', 'used', 'inOut'] as const).map((s) => ({
								value: s,
								label: SCOPE_LABELS[s],
								disabled: s === 'inOut' && !inputs.hasInOut,
							}))}
						/>
					</Row>
					<Row label={t('Strictness')} testId="fix-strictness">
						<Select
							label={t('Strictness')}
							className="w-72"
							disabled={!!running}
							value={settings.strictness}
							onValueChange={(v) => change({ strictness: v as FixStrictness })}
							options={(['careful', 'standard', 'generous'] as const).map((s) => ({
								value: s,
								label: STRICTNESS_TEXT[s],
							}))}
						/>
					</Row>
					<Row label="" testId="fix-show-rejected">
						<Checkbox
							checked={showRejected}
							disabled={!inputs.rejected || !!running}
							onCheckedChange={setShowRejected}
							label={
								inputs.rejected
									? t('Show fixes I rejected before ({0}, offered unselected)', inputs.rejected)
									: t('Show fixes I rejected before (none yet)')
							}
						/>
					</Row>
					<div aria-live="polite" className="flex flex-col gap-1">
						{blocker ? (
							<span className="text-pr-small text-pr-warning" data-testid="fix-blocker">
								{blocker}
							</span>
						) : runBlocker && !running ? (
							<span className="text-pr-small text-pr-warning" data-testid="fix-blocker">
								{runBlocker}
							</span>
						) : null}
						{modelsError ? (
							<span className="text-pr-small text-pr-warning" role="alert">
								{t('The speech models could not be listed: {0}', modelsError)}
							</span>
						) : null}
						{running ? (
							<span className="text-pr-small text-pr-text" data-testid="fix-progress-text">
								{running.stage}
								{progress !== null ? ` · ${progress} %` : ''}
							</span>
						) : message ? (
							<span
								className={`text-pr-small ${message.tone === 'warning' ? 'text-pr-warning' : 'text-pr-text'}`}
								role={message.tone === 'warning' ? 'alert' : undefined}
								data-testid="fix-message"
							>
								{message.text}
							</span>
						) : null}
						{blocker ? null : dry ? (
							<DrySummary r={dry} scriptSourced={!!request?.sources.includes('script')} />
						) : dryError ? (
							<span className="text-pr-small text-pr-warning" data-testid="fix-dry-error">
								{dryError}
							</span>
						) : engine ? (
							<span className="text-pr-small text-pr-muted">{t('Counting…')}</span>
						) : null}
					</div>
					{running ? (
						<div
							className="h-1 w-full overflow-hidden rounded-pr-pill bg-pr-field"
							role="progressbar"
							aria-label={t('Fixing the transcript')}
							aria-valuemin={0}
							aria-valuemax={100}
							aria-valuenow={progress ?? undefined}
							data-testid="fix-progress"
						>
							<div
								className="h-full bg-pr-accent-fill"
								style={{ width: `${progress ?? 100}%`, opacity: progress === null ? 0.5 : 1 }}
							/>
						</div>
					) : null}
				</div>
			)}
		</Dialog>
	);
}
