// Sequence ▸ Sound Design ▸ Auto Sound Pass… (spec 12 §2.7 "Review": "its only button is Propose"; P3-R3 style
// options; WP3.3b): range (sequence, In–Out, selected clips), where cues come from (the Suggest Cues… sources, with
// "n found · k kept" counts), density, palette / kit (the sequence's palette, or prefer one sound source), the sound
// sources allowed (starter kit, packs, your folders, Jasper Synth, with their sound counts), "respect dialogue" and the
// Phase 4 mix options (room glue with its send level, stop before heroes, build into heroes, a delivery preset).
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
	DELIVERY_PRESETS,
	documentHasActiveExpressions,
	PROJECT_CUE_SOURCES,
	ROOM_GLUE_DEFAULT,
	readSoundDesignSettings,
	SOUND_DENSITIES,
	type SoundDelivery,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { Checkbox, Dialog, type HostedDialogProps, registerDialog, Select, Slider } from '@jasper/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ToastRequest } from '../commands/types.ts';
import { useExpressionsFor } from '../expressions/engine.ts';
import { useDialogClose } from '../extensions/dialog.ts';
import { t } from '../i18n/runtime.ts';
import { type EngineCueSource, EngineSourceRows, useEngineSources } from './cues/EngineSources.tsx';
import { CUE_DENSITY_LABELS, CUE_SOURCE_LABELS } from './cues/SuggestCuesDialog.tsx';
import { type ProjectCueSource, planSuggestion, type SuggestRange, suggestRange } from './cues/suggest.ts';
import { SoundNotesList } from './MixDialogs.tsx';
import { notesCount, planNotes } from './mix-jobs.ts';
import { DELIVERY_IDS, deliveryOptionLabel, fmtDb, type SoundNote } from './mix-model.ts';
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
	/** P6: engine sources measured inside the plan job (shot changes, beats, picture motion). */
	engineSources?: ReadonlySet<EngineCueSource>;
	/** P6: snap moves and transitions to the music's beats. */
	snapToBeats?: boolean;
	density: CueDensity;
	palette: PaletteChoice;
	soundSources: ReadonlySet<SoundSourceType>;
	respectDialogue: boolean;
	/** Phase 4 mixing items of the proposal (absent = none). */
	mix?: AutoPassMix;
};

/**
 * Phase 4 (WP4.2b): room glue (`roomGlue`: the send level in dB, null = off), a stop-before dip before each hero with
 * music under it, a build into each hero after ≥ 2 s of music, and a delivery preset (null = none) — setup items and
 * `stop:` / `build:` items of the proposal (WP4.2a plan style).
 */
export type AutoPassMix = {
	roomGlue: number | null;
	stopBefore: boolean;
	build: boolean;
	delivery: SoundDelivery | null;
};

export const NO_MIX: AutoPassMix = { roomGlue: null, stopBefore: false, build: false, delivery: null };

/** The plan request of the dialog's choices (`kit`: the sound ids preferred for a source palette). */
export function autoPassRequest(
	session: EditorSession,
	sequenceId: string,
	c: AutoPassChoices,
	range: { start: number; end: number } | null,
	kit: string[] | null,
): SoundDesignPlanRequest {
	const engineOn = [...(c.engineSources ?? [])];
	const allCueSources = PROJECT_CUE_SOURCES.every((s) => c.cueSources.has(s)) && engineOn.length === 0;
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
			...(allCueSources
				? {}
				: { cueSources: [...PROJECT_CUE_SOURCES.filter((s) => c.cueSources.has(s)), ...engineOn] }),
			...(c.snapToBeats ? { snapToBeats: true } : {}),
			...(c.mix?.roomGlue != null ? { roomGlue: { sendDb: c.mix.roomGlue } } : {}),
			...(c.mix?.stopBefore ? { stopBefore: true } : {}),
			...(c.mix?.build ? { build: true } : {}),
			...(c.mix?.delivery ? { delivery: c.mix.delivery } : {}),
		},
	};
}

export function AutoSoundPassDialog(
	props: HostedDialogProps<{
		session: EditorSession;
		engine: Pick<
			EngineClient,
			'planSoundDesign' | 'getJob' | 'cancelJob' | 'soundLibraryStatus' | 'searchSounds' | 'soundDesignCues'
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
	const [roomOn, setRoomOn] = useState(false);
	const [roomDb, setRoomDb] = useState<number>(ROOM_GLUE_DEFAULT.sendDb);
	const [stopBefore, setStopBefore] = useState(false);
	const [build, setBuild] = useState(false);
	const [delivery, setDelivery] = useState<SoundDelivery | 'none'>('none');
	const [engineSources, setEngineSources] = useState<ReadonlySet<EngineCueSource>>(() => new Set());
	const [snapToBeats, setSnapToBeats] = useState(false);
	const rangeNow = seq ? suggestRange(seq, range, selectedClips) : null;
	const rs = rangeNow?.start ?? -1;
	const re = rangeNow?.end ?? -1;
	const engineRange = useMemo(() => (rs >= 0 && re > rs ? { start: rs, end: re } : null), [rs, re]);
	const measured = useEngineSources(engine, session.projectId, sequenceId, engineRange);
	const [status, setStatus] = useState<SoundLibraryStatus | null>(null);
	const [running, setRunning] = useState<{ progress: number | null; stage: string } | null>(null);
	const [message, setMessage] = useState<string | null>(null);
	/**
	 * The last run's warnings and conflicts, listed under the summary; `proposed`: review opened on its proposal (the
	 * button becomes Close).
	 */
	const [done, setDone] = useState<{ notes: SoundNote[]; proposed: boolean } | null>(null);
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
				engineSources,
				engineCues: measured.cues,
				snapToBeats,
			}),
		[
			doc,
			sequenceId,
			cueSources,
			range,
			density,
			respectDialogue,
			selectedClips,
			expressionsReady,
			engineSources,
			measured.cues,
			snapToBeats,
		],
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
				{
					range,
					cueSources,
					engineSources,
					snapToBeats,
					density,
					palette,
					soundSources,
					respectDialogue,
					mix: {
						roomGlue: roomOn ? roomDb : null,
						stopBefore,
						build,
						delivery: delivery === 'none' ? null : delivery,
					},
				},
				plan.range,
				kit,
			);
			const result = await runSoundPlan(engine, req, {
				signal: ac.signal,
				onJob: (j) => setRunning({ progress: j.progress, stage: j.stage ?? j.title }),
			});
			const out = await reviewPlanResult(session, result);
			const notes = planNotes(result.report);
			if (!result.proposalId) {
				setRunning(null);
				setMessage(out.message);
				setDone(notes.length ? { notes, proposed: false } : null);
				return false;
			}
			props.toast?.({
				kind: 'success',
				message: out.message,
				...(notes.length ? { detail: notesCount(notes) } : {}),
			});
			props.onReview?.();
			if (!notes.length) return true;
			// the plan's warnings and the conflicts of its levels: listed until the user closes (review is open)
			setRunning(null);
			setMessage(out.message);
			setDone({ notes, proposed: true });
			return false;
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
			primaryLabel={done?.proposed ? t('Close') : running ? t('Proposing…') : t('Propose')}
			hideCancel={!!done?.proposed}
			primaryDisabled={
				!done?.proposed && (readOnly || !!running || !plan.range || waitingForExpressions || noSounds)
			}
			onPrimary={async () => {
				if (done?.proposed) {
					finish();
					return true;
				}
				setDone(null);
				return propose();
			}}
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
				<EngineSourceRows
					engine={measured}
					selected={engineSources}
					onToggle={(src, on) => toggle(setEngineSources, src, on)}
					counts={{
						scene: { found: plan.found.scene, kept: plan.kept.scene },
						beat: { found: plan.found.beat, kept: plan.kept.beat },
						pixel: { found: plan.found.pixel, kept: plan.kept.pixel },
					}}
					snapToBeats={snapToBeats}
					onSnapToBeats={setSnapToBeats}
					testId="auto-pass-engine-sources"
					hint={t('Sources not analysed yet are measured while proposing (slower the first time).')}
				/>
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
				<fieldset className="flex flex-col gap-1" data-testid="auto-pass-mix">
					<legend className="mb-1 text-pr-muted">Mix</legend>
					<div className="flex flex-col gap-1" data-testid="auto-pass-room">
						<Checkbox
							checked={roomOn}
							onCheckedChange={setRoomOn}
							label={t('Room glue (a shared short reverb for the sound effects)')}
						/>
						<div className="flex items-center gap-2 pl-6">
							<span className="w-[96px] shrink-0 text-pr-small text-pr-muted">{t('Send level')}</span>
							<Slider
								className="min-w-0 flex-1"
								label={t('Room send level')}
								valueText={t('{0} dB', fmtDb(roomDb))}
								value={roomDb}
								min={-48}
								max={6}
								step={0.5}
								defaultValue={ROOM_GLUE_DEFAULT.sendDb}
								disabled={!roomOn}
								onChange={setRoomDb}
							/>
							<span className="w-[64px] shrink-0 text-right text-pr-small pr-tabular">
								{t('{0} dB', fmtDb(roomDb))}
							</span>
						</div>
					</div>
					<Checkbox
						checked={stopBefore}
						onCheckedChange={setStopBefore}
						label={t('Stop before heroes (dip the music 0.25 s, −24 dB, before each hero)')}
					/>
					<Checkbox
						checked={build}
						onCheckedChange={setBuild}
						label={t('Build into heroes (a 2 s high-pass rise, 150 Hz → 2 kHz, after 2 s of music)')}
					/>
					<div className="flex items-center gap-2" data-testid="auto-pass-delivery">
						<span className="w-[120px] shrink-0 text-pr-muted">Delivery</span>
						<Select
							label="Delivery"
							value={delivery}
							onValueChange={(v) => setDelivery(v as SoundDelivery | 'none')}
							options={[
								{ value: 'none', label: t('Keep the current mix') },
								...DELIVERY_IDS.map((id) => ({
									value: id,
									label: deliveryOptionLabel(DELIVERY_PRESETS[id]),
								})),
							]}
						/>
					</div>
					<p className="text-pr-small text-pr-muted">
						These become items of the proposal: you review and apply them with the sounds.
					</p>
				</fieldset>
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
				{done && !running ? (
					<div className="flex flex-col gap-1" aria-live="polite" data-testid="auto-pass-notes">
						<span className="text-pr-small text-pr-text">{t('Plan notes: {0}', notesCount(done.notes))}</span>
						<SoundNotesList notes={done.notes} testId="auto-pass-notes-list" />
					</div>
				) : null}
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
