// Sequence ▸ Automate ▸ Apply Style… (spec 15 EA-012, EA-040): a style recipe (built-in, library or the project's
// copy; default the project's active recipe, else the built-in for the sequence's aspect), its stages switched on or
// off for this run, the range and seed, a dry run that follows every change (per stage: what it plans, why a stage is
// skipped — a missing bin of reaction pictures or songs, no transcript —, the export cost class and whether it fits
// one proposal), and Propose: the engine's `apply-style` job stores ONE proposal and review opens on it. Accepting it
// keeps a copy of the recipe in the project and makes it the active recipe.
import type { ApplyStyleResult, StyleStageReportDto } from '@jasper/api';
import { resolveRecipeStages, STYLE_STAGE_NAMES, STYLE_STAGES, type StyleStage } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useStoreSelector } from '@jasper/session/react';
import { Checkbox, Dialog, type HostedDialogProps, registerDialog, Select } from '@jasper/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ToastRequest } from '../commands/types.ts';
import { useDialogClose } from '../extensions/dialog.ts';
import { t, translateName } from '../i18n/runtime.ts';
import { openReview } from '../proposals/actions.ts';
import { dialogParams, type RangeChoice, SeedRow } from './AutomationDialog.tsx';
import { num, Row } from './fields.tsx';
import { AutomationRunError } from './run.ts';
import { dryRunStyle, proposeStyle, type StyleEngine } from './style-run.ts';
import { defaultRecipeId, recipeChoices, useStyleLibrary } from './style-store.ts';

export const APPLY_STYLE_DIALOG = 'automation.applyStyle';

let registered = false;
export function registerApplyStyleDialog(): void {
	if (registered) return;
	registered = true;
	registerDialog(APPLY_STYLE_DIALOG, ApplyStyleDialog);
}

const name = (s: string) => translateName(s) ?? s;

const STATUS_TEXT: Record<StyleStageReportDto['status'], string> = {
	planned: 'Planned',
	empty: 'Nothing to do',
	off: 'Off',
	skipped: 'Skipped',
};
export const COST_TEXT: Record<'native' | 'hybrid' | 'remotion', string> = {
	native: 'Native export',
	hybrid: 'Native export with baked layers',
	remotion: 'Export through Remotion (slower)',
};

export type ApplyStyleDialogProps = {
	session: EditorSession;
	engine: StyleEngine;
	sequenceId: string;
	/** Start with this recipe (default: the project's active one, else the built-in for the aspect). */
	recipeId?: string;
	toast?: (r: ToastRequest) => void;
	onReview?: () => void;
};

/** One stage's line of the dry run. */
function StageLine(p: { s: StyleStageReportDto }) {
	const s = p.s;
	const tone = s.status === 'skipped' ? 'text-pr-warning' : s.status === 'planned' ? 'text-pr-text' : 'text-pr-muted';
	return (
		<li className="flex flex-col" data-testid={`apply-style-stage-${s.stage}`} data-status={s.status}>
			<span className={`flex gap-2 text-pr-small ${tone}`}>
				<span className="w-[120px] shrink-0">{name(s.name)}</span>
				<span className="w-[96px] shrink-0">{t(STATUS_TEXT[s.status])}</span>
				{s.status === 'planned' ? <span className="pr-tabular">{s.count}</span> : null}
				{s.status === 'planned' && s.cost ? <span className="text-pr-muted">· {t(COST_TEXT[s.cost])}</span> : null}
			</span>
			{s.reason && s.status !== 'off' ? (
				<span className="pl-[128px] text-pr-small text-pr-muted" data-testid={`apply-style-reason-${s.stage}`}>
					{s.reason}
				</span>
			) : null}
		</li>
	);
}

function DrySummary(p: { r: ApplyStyleResult }) {
	const r = p.r;
	const roles = r.warnings.filter((w) => w.code === 'W_ROLE_MISSING' || w.code === 'W_NO_TRANSCRIPT');
	const planned = r.stages.filter((s) => s.status === 'planned').length;
	return (
		<div className="flex flex-col gap-1" data-testid="apply-style-summary">
			<ul className="flex flex-col gap-0.5">
				{r.stages.map((s) => (
					<StageLine key={s.stage} s={s} />
				))}
			</ul>
			<span className="text-pr-small text-pr-text" data-testid="apply-style-cost">
				{planned
					? t('{0} proposal items · {1}', r.itemCount, t(COST_TEXT[r.cost]))
					: t('Nothing to propose with this recipe here')}
			</span>
			{!r.budget.fits ? (
				<span className="text-pr-small text-pr-warning" data-testid="apply-style-too-big">
					{r.budget.suggestedRange
						? t('Too big for one proposal: choose In to Out up to frame {0}, then the rest', r.budget.suggestedRange.end)
						: t('Too big for one proposal: choose a shorter range')}
				</span>
			) : null}
			{roles.map((w) => (
				<span key={w.code + w.message} className="text-pr-small text-pr-warning" data-apply-style-warning={w.code}>
					! {w.message}
				</span>
			))}
		</div>
	);
}

export function ApplyStyleDialog(props: HostedDialogProps<ApplyStyleDialogProps>) {
	const { open, finish } = useDialogClose(props.close);
	const { session, sequenceId, engine } = props;
	const doc = useStoreSelector(session.store, (s) => s.document);
	const readOnly = useStoreSelector(session.store, (s) => s.readOnly);
	const seq = doc.sequences[sequenceId];
	const lib = useStyleLibrary();
	const choices = useMemo(() => recipeChoices(doc, lib), [doc, lib]);
	const vertical = !!seq && seq.settings.height > seq.settings.width;
	const [recipeId, setRecipeId] = useState(() => props.recipeId ?? defaultRecipeId(doc, vertical));
	const choice = choices.find((c) => c.id === recipeId) ?? null;
	const recipe = choice?.recipe ?? null;
	const recipeStages = useMemo(() => (recipe ? resolveRecipeStages(recipe) : []), [recipe]);
	const [switches, setSwitches] = useState<Partial<Record<StyleStage, boolean>>>({});
	const [range, setRange] = useState<RangeChoice>('sequence');
	const [seed, setSeed] = useState(1);
	const [dry, setDry] = useState<ApplyStyleResult | null>(null);
	const [dryError, setDryError] = useState<string | null>(null);
	const [running, setRunning] = useState<{ progress: number | null; stage: string } | null>(null);
	const [message, setMessage] = useState<string | null>(null);
	const abort = useRef<AbortController | null>(null);
	const hasInOut = !!seq && (seq.inPoint !== null || seq.outPoint !== null);
	const enabledOf = (s: StyleStage) => switches[s] ?? recipeStages.find((x) => x.stage === s)?.enabled ?? false;
	const request = useMemo(() => {
		if (!seq || !recipe) return null;
		const r = dialogParams(seq, {}, range).range as { start: number; end: number } | undefined;
		const passes: Partial<Record<StyleStage, boolean>> = {};
		for (const [k, v] of Object.entries(switches) as [StyleStage, boolean][])
			if (v !== recipeStages.find((x) => x.stage === k)?.enabled) passes[k] = v;
		return {
			sequenceId,
			recipeId,
			seed,
			...(r ? { range: r } : {}),
			...(Object.keys(passes).length ? { passes } : {}),
		};
	}, [seq, recipe, recipeId, seed, range, switches, recipeStages, sequenceId]);
	const key = JSON.stringify(request);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the request's identity
	useEffect(() => {
		if (!request) return;
		const ac = new AbortController();
		const timer = setTimeout(() => {
			dryRunStyle(engine, session.projectId, request, ac.signal).then(
				(r) => {
					if (ac.signal.aborted) return;
					setDry(r);
					setDryError(null);
				},
				(e) => {
					if (ac.signal.aborted) return;
					setDry(null);
					setDryError(e instanceof Error ? e.message : String(e));
				},
			);
		}, 300);
		return () => {
			clearTimeout(timer);
			ac.abort();
		};
	}, [key, engine, session.projectId]);
	useEffect(() => () => abort.current?.abort(), []);

	const propose = async (): Promise<boolean> => {
		if (!request) return false;
		setMessage(null);
		const ac = new AbortController();
		abort.current = ac;
		setRunning({ progress: null, stage: t('Starting…') });
		try {
			const r = await proposeStyle(engine, session.projectId, request, {
				signal: ac.signal,
				onJob: (j) => setRunning({ progress: j.progress, stage: j.stage ?? j.title }),
			});
			if (!r.proposalId) {
				setRunning(null);
				setMessage(t('Nothing to propose with this recipe here'));
				return false;
			}
			await openReview(session, r.proposalId);
			props.toast?.({ kind: 'success', message: t('Proposed {0} with {1} items', name(r.recipe.name), r.itemCount) });
			props.onReview?.();
			return true;
		} catch (e) {
			setRunning(null);
			if (e instanceof AutomationRunError && e.code === 'E_CANCELLED') return false;
			setMessage(
				e instanceof AutomationRunError && e.code === 'PROPOSAL_TOO_LARGE'
					? t('Too big for one proposal: choose In to Out over a part of the sequence, then the rest')
					: e instanceof Error
						? e.message
						: String(e),
			);
			return false;
		} finally {
			abort.current = null;
		}
	};

	const progress = running?.progress != null ? Math.round(running.progress * 100) : null;
	const nothing = !!dry && !dry.stages.some((s) => s.status === 'planned');
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
			title={t('Apply Style')}
			size="medium"
			primaryLabel={running ? t('Proposing…') : t('Propose')}
			primaryDisabled={readOnly || !seq || !recipe || !!running || nothing || (!!dry && !dry.budget.fits)}
			onPrimary={propose}
			data-testid="apply-style-dialog"
		>
			{seq ? (
				<div className="flex flex-col gap-3 text-pr-ui">
					<p className="text-pr-small text-pr-muted">
						{t(
							'Runs a style recipe on the sequence: voice cleanup, subtitles, then the decorations, each planned on what the earlier ones planned, as one proposal. Nothing changes until you apply it in review.',
						)}
					</p>
					<Row label={t('Recipe')} testId="apply-style-recipe">
						<Select
							label={t('Recipe')}
							value={recipeId}
							onValueChange={(v) => {
								setRecipeId(v);
								setSwitches({});
							}}
							options={choices.map((c) => ({
								value: c.id,
								label: `${name(c.name)}${c.source === 'project' ? ` · ${t('in this project')}` : c.source === 'library' ? ` · ${t('your library')}` : ''}${c.newer ? ` · ${t('newer version')}` : ''}`,
								disabled: !c.recipe,
							}))}
						/>
					</Row>
					{recipe?.description ? (
						<p className="text-pr-small text-pr-muted" data-testid="apply-style-description">
							{name(recipe.description)}
						</p>
					) : null}
					{choice?.newer ? (
						<p className="text-pr-small text-pr-warning">
							{t('This recipe was made by a newer JasperEditor: update JasperEditor to use it')}
						</p>
					) : null}
					<fieldset className="flex flex-col gap-1" data-testid="apply-style-stages">
						<legend className="mb-1 text-pr-muted">{t('Steps')}</legend>
						<div className="grid grid-cols-3 gap-x-3 gap-y-1">
							{STYLE_STAGES.map((s) => (
								<span key={s} data-testid={`apply-style-switch-${s}`}>
									<Checkbox
										disabled={!recipe}
										checked={enabledOf(s)}
										onCheckedChange={(c) => setSwitches((cur) => ({ ...cur, [s]: c }))}
										label={name(STYLE_STAGE_NAMES[s])}
									/>
								</span>
							))}
						</div>
					</fieldset>
					<Row label={t('Range')} testId="apply-style-range">
						<Select
							label={t('Range')}
							value={range}
							onValueChange={(v) => setRange(v as RangeChoice)}
							options={[
								{ value: 'sequence', label: t('Whole sequence') },
								{ value: 'inout', label: t('In to Out'), disabled: !hasInOut },
							]}
						/>
					</Row>
					<SeedRow value={num(seed, 1)} onChange={setSeed} />
					<div aria-live="polite" className="flex flex-col gap-1">
						{running ? (
							<span className="text-pr-small text-pr-text" data-testid="apply-style-progress-text">
								{running.stage}
								{progress !== null ? ` · ${progress} %` : ''}
							</span>
						) : message ? (
							<span className="text-pr-small text-pr-warning" data-testid="apply-style-message">
								{message}
							</span>
						) : null}
						{dry ? (
							<DrySummary r={dry} />
						) : dryError ? (
							<span className="text-pr-small text-pr-warning" data-testid="apply-style-dry-error">
								{dryError}
							</span>
						) : (
							<span className="text-pr-small text-pr-muted">{t('Counting…')}</span>
						)}
					</div>
					{running ? (
						<div
							className="h-1 w-full overflow-hidden rounded-pr-pill bg-pr-field"
							role="progressbar"
							aria-label={t('Proposing')}
							aria-valuemin={0}
							aria-valuemax={100}
							aria-valuenow={progress ?? undefined}
							data-testid="apply-style-progress"
						>
							<div
								className="h-full bg-pr-accent-fill"
								style={{ width: `${progress ?? 100}%`, opacity: progress === null ? 0.5 : 1 }}
							/>
						</div>
					) : null}
				</div>
			) : (
				<p className="text-pr-small text-pr-muted">{t('Open a sequence first')}</p>
			)}
		</Dialog>
	);
}
