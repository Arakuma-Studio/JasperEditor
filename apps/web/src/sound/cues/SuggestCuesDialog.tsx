// Sequence ▸ Sound Design ▸ Suggest Cues… (spec 12 §2.7): sources with live counts (events found · cues kept after
// merging and the density budget), range (sequence, In–Out, selected clips), density and "respect dialogue". Suggest
// adds the derived cues — each with its reason, anchor and source `derived` — in ONE transaction "Suggest Cues (n)".
// P6 (WP6.2): the engine's measured sources — shot changes inside footage, music beats, picture motion — with their
// counts, an Analyze… button where they are not measured yet, and "Snap to the beat" (EngineSources.tsx).
// P6-E10 (WP-E6): the cue grammar — personality (its excluded types leave the suggestions, it sets its default
// density), typing (one key per word above 25 typed per second) and "music carries the cuts" — starting from the
// sequence's style; what the user changed is stored with the cues (`soundDesign.setSettings {style}`, same step).

import type { EngineClient } from '@jasper/engine-client';
import {
	type CueDensity,
	documentHasActiveExpressions,
	PROJECT_CUE_SOURCES,
	type ResolvedSoundStyle,
	readSoundDesignSettings,
	resolveSoundStyle,
	SOUND_DENSITIES,
	SOUND_PERSONALITY_PROFILES,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { Checkbox, Dialog, type HostedDialogProps, registerDialog, Select } from '@jasper/ui';
import { useMemo, useState } from 'react';
import type { ToastRequest } from '../../commands/types.ts';
import { useExpressionsFor } from '../../expressions/engine.ts';
import { useDialogClose } from '../../extensions/dialog.ts';
import { t } from '../../i18n/runtime.ts';
import { SoundStyleFields } from '../StyleControls.tsx';
import { type EngineCueSource, EngineSourceRows, useEngineSources } from './EngineSources.tsx';
import { type ProjectCueSource, planSuggestion, type SuggestRange, suggestRange } from './suggest.ts';

export const SUGGEST_CUES_DIALOG = 'sound.suggestCues';

export const CUE_SOURCE_LABELS: Record<ProjectCueSource, string> = {
	edits: 'Edit points',
	transitions: 'Transitions',
	keyframes: 'Keyframed motion and opacity',
	text: 'Text animations',
	mg: 'Motion graphics (intro / outro)',
	clipEdges: 'Graphics on V2 and above (edges)',
	camera3d: '3D camera moves',
	markers: 'Markers named “sfx: …”',
};

export const CUE_DENSITY_LABELS: Record<CueDensity, string> = {
	sparse: 'Sparse (≤ 1 cue per second)',
	balanced: 'Balanced (≤ 2 cues per second)',
	rich: 'Rich (≤ 3 cues per second)',
};

let registered = false;
export function registerSuggestCuesDialog(): void {
	if (registered) return;
	registered = true;
	registerDialog(SUGGEST_CUES_DIALOG, SuggestCuesDialog);
}

export function SuggestCuesDialog(
	props: HostedDialogProps<{
		session: EditorSession;
		sequenceId: string;
		toast?: (r: ToastRequest) => void;
		/** The engine (measured sources: shot changes, beats, picture motion); without it they are unavailable. */
		engine?: Pick<EngineClient, 'soundDesignCues' | 'getJob'>;
	}>,
) {
	const { open, finish } = useDialogClose(props.close);
	const { session, sequenceId } = props;
	const doc = session.getCommitted();
	const seq = doc.sequences[sequenceId];
	const settings = readSoundDesignSettings(
		(seq as { soundDesign?: { settings?: unknown } } | undefined)?.soundDesign?.settings,
	);
	const selectedClips = session.getState().selection.timeline.clips;
	const [sources, setSources] = useState<ReadonlySet<ProjectCueSource>>(() => new Set(PROJECT_CUE_SOURCES));
	const hasInOut = !!seq && (seq.inPoint !== null || seq.outPoint !== null);
	const hasSelection = !!seq && suggestRange(seq, 'selection', selectedClips) !== null;
	const [range, setRange] = useState<SuggestRange>('sequence');
	const [density, setDensity] = useState<CueDensity>(settings.density);
	const [respectDialogue, setRespectDialogue] = useState(true);
	const [replace, setReplace] = useState(true);
	const [engineSources, setEngineSources] = useState<ReadonlySet<EngineCueSource>>(() => new Set());
	const [snapToBeats, setSnapToBeats] = useState(false);
	const stored = resolveSoundStyle(settings.style);
	const [style, setStyle] = useState<ResolvedSoundStyle>(() => stored);
	// the range the engine measures (stable by value, so it is not asked again on every render)
	const rangeNow = seq ? suggestRange(seq, range, selectedClips) : null;
	const rs = rangeNow?.start ?? -1;
	const re = rangeNow?.end ?? -1;
	const engineRange = useMemo(() => (rs >= 0 && re > rs ? { start: rs, end: re } : null), [rs, re]);
	const measured = useEngineSources(props.engine, session.projectId, sequenceId, engineRange);
	// Expression-driven motion needs the expression engine (the engine route binds expressions too): the plan is
	// recomputed once it is loaded, and Suggest waits for it.
	const expressionsReady = useExpressionsFor(doc);
	const waitingForExpressions = !expressionsReady && documentHasActiveExpressions(doc);
	// biome-ignore lint/correctness/useExhaustiveDependencies: expressionsReady re-plans with bound expressions
	const plan = useMemo(
		() =>
			planSuggestion(doc, sequenceId, {
				sources,
				range,
				density,
				respectDialogue,
				replace,
				selectedClips,
				engineSources,
				engineCues: measured.cues,
				voiceActivity: measured.voice,
				snapToBeats,
				typing: style.typing,
				musicCarriesCuts: style.musicCarriesCuts,
				personality: style.personality,
			}),
		[
			doc,
			sequenceId,
			sources,
			range,
			density,
			respectDialogue,
			replace,
			selectedClips,
			expressionsReady,
			engineSources,
			measured.cues,
			measured.voice,
			snapToBeats,
			style.typing,
			style.musicCarriesCuts,
			style.personality,
		],
	);
	const n = plan.adds.length;
	const readOnly = session.getState().readOnly;
	const toggle = (s: ProjectCueSource, on: boolean) =>
		setSources((cur) => {
			const next = new Set(cur);
			if (on) next.add(s);
			else next.delete(s);
			return next;
		});

	const suggest = () => {
		if (!seq || !plan.commands.length) return;
		const commands = [...plan.commands];
		// the choices the user changed become the sequence's (density, and the grammar: fills and passes use them)
		const styleChanges = {
			...(style.personality !== stored.personality ? { personality: style.personality } : {}),
			...(style.typing !== stored.typing ? { typing: style.typing } : {}),
			...(style.musicCarriesCuts !== stored.musicCarriesCuts ? { musicCarriesCuts: style.musicCarriesCuts } : {}),
		};
		if (density !== settings.density || Object.keys(styleChanges).length)
			commands.unshift({
				type: 'soundDesign.setSettings',
				sequenceId,
				...(density !== settings.density ? { density } : {}),
				...(Object.keys(styleChanges).length ? { style: styleChanges } : {}),
			} as never);
		const r = session.apply({
			label: t('Suggest Cues ({0})', n),
			origin: 'user',
			sequenceId,
			commands,
		});
		if (!r.ok) {
			props.toast?.({
				kind: 'warning',
				message: t('Suggest Cues: not possible'),
				detail: r.errors[0]?.message,
			});
			return;
		}
		const ids = r.results.flatMap((x) => (x as { cueIds?: string[] } | undefined)?.cueIds ?? []);
		if (ids.length) session.select('cues', ids, 'replace');
		props.toast?.({
			kind: 'success',
			message: t('Suggested {0} cues', ids.length),
			...(plan.removes.length ? { detail: t('Replaced {0} earlier suggestions', plan.removes.length) } : {}),
			action: { label: t('Undo'), command: 'history.undo' },
		});
		finish(true);
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(o) => !o && finish()}
			title="Suggest Cues"
			size="medium"
			primaryLabel={n ? t('Suggest {0} Cues', n) : t('Suggest')}
			primaryDisabled={readOnly || n === 0 || waitingForExpressions}
			onPrimary={suggest}
			data-testid="suggest-cues-dialog"
		>
			<div className="flex flex-col gap-3 text-pr-ui">
				<fieldset className="flex flex-col gap-1" data-testid="suggest-cues-sources">
					<legend className="mb-1 text-pr-muted">Find cues from</legend>
					{PROJECT_CUE_SOURCES.map((s) => (
						<div key={s} className="flex items-center gap-2" data-cue-source={s}>
							<Checkbox
								checked={sources.has(s)}
								onCheckedChange={(on) => toggle(s, on)}
								label={CUE_SOURCE_LABELS[s]}
							/>
							<span
								className="ml-auto shrink-0 text-pr-small text-pr-muted tabular-nums"
								data-cue-source-count={s}
								title={t('{0} events found, {1} cues kept', plan.found[s], plan.kept[s])}
							>
								{t('{0} found · {1} kept', plan.found[s], plan.kept[s])}
							</span>
						</div>
					))}
				</fieldset>
				<EngineSourceRows
					engine={measured}
					selected={engineSources}
					onToggle={(src, on) =>
						setEngineSources((cur) => {
							const next = new Set(cur);
							if (on) next.add(src);
							else next.delete(src);
							return next;
						})
					}
					counts={{
						scene: { found: plan.found.scene, kept: plan.kept.scene },
						beat: { found: plan.found.beat, kept: plan.kept.beat },
						pixel: { found: plan.found.pixel, kept: plan.kept.pixel },
					}}
					snapToBeats={snapToBeats}
					onSnapToBeats={setSnapToBeats}
					testId="suggest-cues-engine-sources"
				/>
				<div className="flex items-center gap-2" data-testid="suggest-cues-range">
					<span className="w-[110px] shrink-0 text-pr-muted">Range</span>
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
				<SoundStyleFields
					value={style}
					fields={['personality', 'typing', 'musicCarriesCuts']}
					onChange={(next, field) => {
						setStyle(next);
						if (field === 'personality' && next.personality)
							setDensity(SOUND_PERSONALITY_PROFILES[next.personality].density);
					}}
					testId="suggest-cues-style"
				/>
				<div className="flex items-center gap-2" data-testid="suggest-cues-density">
					<span className="w-[110px] shrink-0 text-pr-muted">Density</span>
					<Select
						label="Density"
						value={density}
						onValueChange={(v) => setDensity(v as CueDensity)}
						options={SOUND_DENSITIES.map((d) => ({ value: d, label: CUE_DENSITY_LABELS[d] }))}
					/>
				</div>
				<Checkbox
					checked={respectDialogue}
					onCheckedChange={setRespectDialogue}
					label={t('Respect dialogue (no cut cues while someone speaks)')}
				/>
				<Checkbox
					checked={replace}
					onCheckedChange={setReplace}
					label={t('Replace earlier unfilled suggestions in the range')}
				/>
				<p className="text-pr-small text-pr-text" aria-live="polite" data-testid="suggest-cues-summary">
					{plan.range === null
						? t('Nothing to search in this range.')
						: n === 0
							? t('No new cues in this range.')
							: t(
									'{0} cues: {1} hero, {2} support, {3} ambient',
									n,
									plan.byWeight.hero,
									plan.byWeight.support,
									plan.byWeight.ambient,
								)}
					{plan.removes.length ? ` ${t('Replaces {0} earlier suggestions.', plan.removes.length)}` : ''}
					{plan.duplicates ? ` ${t('{0} already have a cue.', plan.duplicates)}` : ''}
				</p>
				{plan.warnings.length ? (
					<ul className="text-pr-small text-pr-muted" data-testid="suggest-cues-warnings">
						{plan.warnings.slice(0, 5).map((w) => (
							<li key={w.code + w.message}>{w.message}</li>
						))}
					</ul>
				) : null}
			</div>
		</Dialog>
	);
}
