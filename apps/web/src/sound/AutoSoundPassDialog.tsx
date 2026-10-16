// Sequence ▸ Sound Design ▸ Auto Sound Pass… (spec 12 §2.7 "Review": "its only button is Propose"; P3-R3 style
// options; WP3.3b): range (sequence, In–Out, selected clips), where cues come from (the Suggest Cues… sources, with
// "n found · k kept" counts), density, palette / kit (the sequence's palette, or prefer one sound source), the sound
// sources allowed (starter kit, packs, your folders, Jasper Synth, with their sound counts) and "respect dialogue".
// Propose runs the engine's `sound-design` plan job (progress here and in the Jobs panel; Cancel cancels it) and opens
// review on the proposal it stores — nothing is applied until the user applies it in review.
import {
	SOUND_SOURCE_TYPES,
	type SoundDesignPlanRequest,
	type SoundLibraryStatus,
	type SoundSourceType,
} from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import {
	type CueDensity,
	documentHasActiveExpressions,
	PROJECT_CUE_SOURCES,
	readSoundDesignSettings,
	SOUND_DENSITIES,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { Checkbox, Dialog, type HostedDialogProps, registerDialog, Select } from '@jasper/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ToastRequest } from '../commands/types.ts';
import { useExpressionsFor } from '../expressions/engine.ts';
import { useDialogClose } from '../extensions/dialog.ts';
import { t } from '../i18n/runtime.ts';
import { CUE_DENSITY_LABELS, CUE_SOURCE_LABELS } from './cues/SuggestCuesDialog.tsx';
import { type ProjectCueSource, planSuggestion, type SuggestRange, suggestRange } from './cues/suggest.ts';
import { PlanError, reviewPlanResult, runSoundPlan } from './plan-run.ts';

export const AUTO_SOUND_PASS_DIALOG = 'sound.autoSoundPass';

export const SOUND_SOURCE_LABELS: Record<SoundSourceType, string> = {
	starter: 'Starter kit',
	pack: 'Sound packs',
	folder: 'Your folders',
	synth: 'Jasper Synth (procedural fallback)',
};

/** Palette / kit: the sequence's palette, none, or prefer the sounds of one source. */
export type PaletteChoice = 'project' | 'none' | SoundSourceType;

let registered = false;
export function registerAutoSoundPassDialog(): void {
	if (registered) return;
	registered = true;
	registerDialog(AUTO_SOUND_PASS_DIALOG, AutoSoundPassDialog);
}

export type AutoPassChoices = {
	range: SuggestRange;
	cueSources: ReadonlySet<ProjectCueSource>;
	density: CueDensity;
	palette: PaletteChoice;
	soundSources: ReadonlySet<SoundSourceType>;
	respectDialogue: boolean;
};

/** The plan request of the dialog's choices (`kit`: the sound ids preferred for a source palette). */
export function autoPassRequest(
	session: EditorSession,
	sequenceId: string,
	c: AutoPassChoices,
	range: { start: number; end: number } | null,
	kit: string[] | null,
): SoundDesignPlanRequest {
	const allCueSources = PROJECT_CUE_SOURCES.every((s) => c.cueSources.has(s));
	const allSoundSources = SOUND_SOURCE_TYPES.every((s) => c.soundSources.has(s));
	const whole = c.range === 'sequence';
	return {
		projectId: session.projectId,
		sequenceId,
		cues: 'auto',
		...(range && !whole ? { range } : {}),
		style: {
			density: c.density,
			respectDialogue: c.respectDialogue,
			palette: c.palette === 'project' ? 'project' : c.palette === 'none' ? [] : (kit ?? []),
			...(allSoundSources ? {} : { sources: SOUND_SOURCE_TYPES.filter((s) => c.soundSources.has(s)) }),
			...(allCueSources ? {} : { cueSources: PROJECT_CUE_SOURCES.filter((s) => c.cueSources.has(s)) }),
		},
	};
}

export function AutoSoundPassDialog(
	props: HostedDialogProps<{
		session: EditorSession;
		engine: Pick<
			EngineClient,
			'planSoundDesign' | 'getJob' | 'cancelJob' | 'soundLibraryStatus' | 'searchSounds'
		>;
		sequenceId: string;
		toast?: (r: ToastRequest) => void;
		/** Called after review opened (the shell focuses the Review panel). */
		onReview?: () => void;
	}>,
) {
	const { open, finish } = useDialogClose(props.close);
	const { session, sequenceId, engine } = props;
	const doc = session.getCommitted();
	const seq = doc.sequences[sequenceId];
	const settings = readSoundDesignSettings(
		(seq as { soundDesign?: { settings?: unknown } } | undefined)?.soundDesign?.settings,
	);
	const selectedClips = session.getState().selection.timeline.clips;
	const hasInOut = !!seq && (seq.inPoint !== null || seq.outPoint !== null);
	const hasSelection = !!seq && suggestRange(seq, 'selection', selectedClips) !== null;
	const [range, setRange] = useState<SuggestRange>('sequence');
	const [cueSources, setCueSources] = useState<ReadonlySet<ProjectCueSource>>(
		() => new Set(PROJECT_CUE_SOURCES),
	);
	const [density, setDensity] = useState<CueDensity>(settings.density);
	const paletteSize = settings.palette?.length ?? 0;
	const [palette, setPalette] = useState<PaletteChoice>(paletteSize ? 'project' : 'none');
	const [soundSources, setSoundSources] = useState<ReadonlySet<SoundSourceType>>(
		() => new Set(SOUND_SOURCE_TYPES),
	);
	const [respectDialogue, setRespectDialogue] = useState(true);
	const [status, setStatus] = useState<SoundLibraryStatus | null>(null);
	const [running, setRunning] = useState<{ progress: number | null; stage: string } | null>(null);
	const [message, setMessage] = useState<string | null>(null);
	const abort = useRef<AbortController | null>(null);
	const expressionsReady = useExpressionsFor(doc);
	const waitingForExpressions = !expressionsReady && documentHasActiveExpressions(doc);

	useEffect(() => {
		let live = true;
		engine.soundLibraryStatus().then(
			(s) => live && setStatus(s),
			() => undefined,
		);
		return () => {
			live = false;
			abort.current?.abort();
		};
	}, [engine]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: expressionsReady re-plans with bound expressions
	const plan = useMemo(
		() =>
			planSuggestion(doc, sequenceId, {
				sources: cueSources,
				range,
				density,
				respectDialogue,
				replace: false,
				selectedClips,
			}),
		[doc, sequenceId, cueSources, range, density, respectDialogue, selectedClips, expressionsReady],
	);
	const readOnly = session.getState().readOnly;
	const toggle = <T,>(set: (f: (cur: ReadonlySet<T>) => ReadonlySet<T>) => void, v: T, on: boolean) =>
		set((cur) => {
			const next = new Set(cur);
			if (on) next.add(v);
			else next.delete(v);
			return next;
		});
	const soundCount = (s: SoundSourceType) => status?.bySource[s] ?? 0;
	const noSounds = !!status && SOUND_SOURCE_TYPES.every((s) => !soundSources.has(s) || soundCount(s) === 0);

	const propose = async (): Promise<boolean> => {
		if (!seq) return false;
		setMessage(null);
		const ac = new AbortController();
		abort.current = ac;
		setRunning({ progress: null, stage: t('Starting…') });
		try {
			let kit: string[] | null = null;
			if (palette !== 'project' && palette !== 'none') {
				const r = await engine.searchSounds({ sources: [palette], limit: 500 }, ac.signal);
				kit = r.results.map((x) => x.sound.id);
			}
			const req = autoPassRequest(
				session,
				sequenceId,
				{ range, cueSources, density, palette, soundSources, respectDialogue },
				plan.range,
				kit,
			);
			const result = await runSoundPlan(engine, req, {
				signal: ac.signal,
				onJob: (j) => setRunning({ progress: j.progress, stage: j.stage ?? j.title }),
			});
			const out = await reviewPlanResult(session, result);
			if (!result.proposalId) {
				setRunning(null);
				setMessage(out.message);
				return false;
			}
			props.toast?.({ kind: 'success', message: out.message });
			props.onReview?.();
			return true;
		} catch (e) {
			setRunning(null);
			if (e instanceof PlanError && e.code === 'E_CANCELLED') return false;
			setMessage(e instanceof Error ? e.message : String(e));
			return false;
		} finally {
			abort.current = null;
		}
	};

	const pct = running?.progress != null ? Math.round(running.progress * 100) : null;
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
			title="Auto Sound Pass"
			size="medium"
			primaryLabel={running ? t('Proposing…') : t('Propose')}
			primaryDisabled={readOnly || !!running || !plan.range || waitingForExpressions || noSounds}
			onPrimary={propose}
			data-testid="auto-sound-pass-dialog"
		>
			<div className="flex flex-col gap-3 text-pr-ui">
				<p className="text-pr-small text-pr-muted">
					Finds the cues of the edit and proposes a ranked sound for each. Nothing changes until you apply the
					proposal in review.
				</p>
				<div className="flex items-center gap-2" data-testid="auto-pass-range">
					<span className="w-[120px] shrink-0 text-pr-muted">Range</span>
					<Select
						label="Range"
						value={range}
						onValueChange={(v) => setRange(v as SuggestRange)}
						options={[
							{ value: 'sequence', label: t('Whole sequence') },
							{ value: 'inout', label: t('In to Out'), disabled: !hasInOut },
							{ value: 'selection', label: t('Selected clips'), disabled: !hasSelection },
						]}
					/>
				</div>
				<fieldset className="flex flex-col gap-1" data-testid="auto-pass-cue-sources">
					<legend className="mb-1 text-pr-muted">Find cues from</legend>
					{PROJECT_CUE_SOURCES.map((s) => (
						<div key={s} className="flex items-center gap-2" data-cue-source={s}>
							<Checkbox
								checked={cueSources.has(s)}
								onCheckedChange={(on) => toggle(setCueSources, s, on)}
								label={CUE_SOURCE_LABELS[s]}
							/>
							<span
								className="ml-auto shrink-0 text-pr-small text-pr-muted tabular-nums"
								data-cue-source-count={s}
							>
								{t('{0} found · {1} kept', plan.found[s], plan.kept[s])}
							</span>
						</div>
					))}
					<p className="text-pr-small text-pr-muted">
						Unfilled cues already on the Cue Seam in the range get a sound too.
					</p>
				</fieldset>
				<div className="flex items-center gap-2" data-testid="auto-pass-density">
					<span className="w-[120px] shrink-0 text-pr-muted">Density</span>
					<Select
						label="Density"
						value={density}
						onValueChange={(v) => setDensity(v as CueDensity)}
						options={SOUND_DENSITIES.map((d) => ({ value: d, label: CUE_DENSITY_LABELS[d] }))}
					/>
				</div>
				<div className="flex items-center gap-2" data-testid="auto-pass-palette">
					<span className="w-[120px] shrink-0 text-pr-muted">Palette / kit</span>
					<Select
						label="Palette / kit"
						value={palette}
						onValueChange={(v) => setPalette(v as PaletteChoice)}
						options={[
							{
								value: 'project',
								label: t('Sequence palette ({0} sounds)', paletteSize),
								disabled: paletteSize === 0,
							},
							{ value: 'none', label: t('No preference') },
							...SOUND_SOURCE_TYPES.map((s) => ({
								value: s,
								label: t('Prefer {0}', SOUND_SOURCE_LABELS[s]),
								disabled: !!status && soundCount(s) === 0,
							})),
						]}
					/>
				</div>
				<fieldset className="flex flex-col gap-1" data-testid="auto-pass-sound-sources">
					<legend className="mb-1 text-pr-muted">Sounds from</legend>
					{SOUND_SOURCE_TYPES.map((s) => (
						<div key={s} className="flex items-center gap-2" data-sound-source={s}>
							<Checkbox
								checked={soundSources.has(s)}
								onCheckedChange={(on) => toggle(setSoundSources, s, on)}
								label={SOUND_SOURCE_LABELS[s]}
							/>
							<span className="ml-auto shrink-0 text-pr-small text-pr-muted tabular-nums">
								{status ? t('{0} sounds', soundCount(s)) : '…'}
							</span>
						</div>
					))}
				</fieldset>
				<Checkbox
					checked={respectDialogue}
					onCheckedChange={setRespectDialogue}
					label={t('Respect dialogue (no cut cues and no hero sounds while someone speaks)')}
				/>
				<p className="text-pr-small text-pr-text" aria-live="polite" data-testid="auto-pass-summary">
					{running
						? `${running.stage}${pct !== null ? ` · ${pct} %` : ''}`
						: message
							? message
							: noSounds
								? t('No sounds in the chosen sources: install the starter kit or choose other sources.')
								: plan.range === null
									? t('Nothing to search in this range.')
									: t('{0} new cues found; unfilled cues in the range are included.', plan.adds.length)}
				</p>
				{running ? (
					<div
						className="h-1 w-full overflow-hidden rounded-pr-pill bg-pr-field"
						role="progressbar"
						aria-label={t('Proposing sounds')}
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={pct ?? undefined}
						data-testid="auto-pass-progress"
					>
						<div
							className="h-full bg-pr-accent-fill"
							style={{ width: `${pct ?? 100}%`, opacity: pct === null ? 0.5 : 1 }}
						/>
					</div>
				) : null}
			</div>
		</Dialog>
	);
}
