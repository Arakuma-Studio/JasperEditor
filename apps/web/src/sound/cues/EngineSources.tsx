// The engine's cue sources in Suggest Cues… and Auto Sound Pass… (spec 12 §2.2, §2.7 "sources (with counts)", P6-R2;
// wp-note "Phase 6 → WP6.2"): shot changes inside footage, the beats of Essential music clips and the picture's motion
// are measured by the engine, not derived from the edit. When a dialog opens it asks the engine what is already
// measured (`POST /api/sound-design/cues` with `analyze: false`: nothing starts); a source not analysed yet shows
// "Analyze…", which starts its analysis (jobs: progress here and in the Jobs panel) and asks again when they finish.
// The measured cues (`engineCues`) go into the dialog's own `deriveCues` as `extraCues`, so the counts, merging and
// budgets are the same as everywhere else. "Snap to the beat" moves moves and transitions onto the music's beats.
import type { EngineCue, EngineJob, SoundCuesResponse } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import { ENGINE_CUE_SOURCES, type ExtraCue, type VoiceActivity } from '@jasper/project';
import { Button, Checkbox } from '@jasper/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../../i18n/runtime.ts';

export type EngineCueSource = (typeof ENGINE_CUE_SOURCES)[number];

export const ENGINE_SOURCE_LABELS: Record<EngineCueSource, string> = {
	scene: 'Shot changes inside footage',
	beat: 'Music beats (Essential Sound music clips)',
	pixel: 'Picture motion in footage',
};

export type EngineSourceStatus = {
	state: 'loading' | 'ready' | 'pending' | 'missing' | 'none' | 'failed';
	/** Cues the source measured. */
	found: number;
	/** 0…1 while its analysis runs (null: indeterminate). */
	progress?: number | null;
	message?: string;
};

export type EngineSourcesState = {
	status: Record<EngineCueSource, EngineSourceStatus>;
	/** The measured cues of every source (merged into the dialog's derivation as `extraCues`). */
	cues: ExtraCue[];
	/** Starts the analyses of these sources and refreshes when they finish. */
	analyze(sources: readonly EngineCueSource[]): void;
	busy: boolean;
	error: string | null;
	/**
	 * Voice activity of the Essential Sound dialogue clips the engine measured (the cue route's `voiceActivity`, P6-R3):
	 * the dialog derives with it so "Respect dialogue" uses the engine's dialogue ranges; null until it answers.
	 */
	voice: VoiceActivity | null;
};

const initial = (): Record<EngineCueSource, EngineSourceStatus> =>
	Object.fromEntries(ENGINE_CUE_SOURCES.map((s) => [s, { state: 'loading', found: 0 }])) as Record<
		EngineCueSource,
		EngineSourceStatus
	>;

/** Engine cues as `ExtraCue`s (the route already validated them; `deriveCues` validates again). */
function toExtra(c: EngineCue): ExtraCue {
	return {
		key: c.key,
		frame: c.frame,
		kind: c.kind as ExtraCue['kind'],
		weight: c.weight,
		types: c.types as ExtraCue['types'],
		align: c.align,
		...(c.pan !== undefined ? { pan: c.pan } : {}),
		...(c.panSweep ? { panSweep: { ...c.panSweep } } : {}),
		anchor: c.anchor as ExtraCue['anchor'],
		confidence: c.confidence,
		reason: c.reason,
		...(c.window ? { window: { ...c.window } } : {}),
		from: c.from,
		...(c.size !== undefined ? { size: c.size } : {}),
	};
}

/**
 * What the engine measured for a sequence range, refreshed when the range changes; `analyze` starts the missing
 * analyses. Never throws: an engine error shows as `error` and the sources stay usable without engine cues.
 */
export function useEngineSources(
	engine: Pick<EngineClient, 'soundDesignCues' | 'getJob'> | undefined,
	projectId: string,
	sequenceId: string,
	range: { start: number; end: number } | null,
): EngineSourcesState {
	const [status, setStatus] = useState(initial);
	const [cues, setCues] = useState<ExtraCue[]>([]);
	const [voice, setVoice] = useState<VoiceActivity | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const live = useRef(true);
	const generation = useRef(0);
	useEffect(
		() => () => {
			live.current = false;
		},
		[],
	);

	const ask = useCallback(
		async (analyze: boolean, sources: readonly EngineCueSource[]): Promise<SoundCuesResponse | null> => {
			if (!engine || !range) return null;
			return engine.soundDesignCues({
				projectId,
				sequenceId,
				opts: { sources: [...sources], range, analyze, density: 'rich' },
			});
		},
		[engine, projectId, sequenceId, range],
	);

	const apply = useCallback((r: SoundCuesResponse, sources: readonly EngineCueSource[]) => {
		setVoice(r.voiceActivity ?? null);
		setCues((cur) => [
			...cur.filter((c) => !sources.includes(c.from as EngineCueSource)),
			...(r.engineCues ?? []).map(toExtra),
		]);
		setStatus((cur) => {
			const next = { ...cur };
			for (const s of sources) {
				const a = r.analysis?.[s];
				next[s] = a
					? { state: a.state, found: a.found, ...(a.message ? { message: a.message } : {}) }
					: { state: 'none', found: 0 };
			}
			return next;
		});
	}, []);

	// what is already measured, when the dialog opens or the range changes
	useEffect(() => {
		const gen = ++generation.current;
		if (!engine || !range) {
			setStatus(
				Object.fromEntries(ENGINE_CUE_SOURCES.map((s) => [s, { state: 'none', found: 0 }])) as Record<
					EngineCueSource,
					EngineSourceStatus
				>,
			);
			setCues([]);
			return;
		}
		setStatus(initial());
		ask(false, ENGINE_CUE_SOURCES).then(
			(r) => {
				if (!live.current || gen !== generation.current || !r) return;
				setError(null);
				apply(r, ENGINE_CUE_SOURCES);
			},
			(e: unknown) => {
				if (!live.current || gen !== generation.current) return;
				setError(e instanceof Error ? e.message : String(e));
				setStatus(
					Object.fromEntries(
						ENGINE_CUE_SOURCES.map((s) => [
							s,
							{ state: 'failed', found: 0, message: t('The engine is not available') },
						]),
					) as Record<EngineCueSource, EngineSourceStatus>,
				);
			},
		);
	}, [engine, range, ask, apply]);

	const analyze = useCallback(
		(sources: readonly EngineCueSource[]) => {
			if (!engine || !range || !sources.length) return;
			const gen = generation.current;
			setBusy(true);
			setStatus((cur) => {
				const next = { ...cur };
				for (const s of sources) next[s] = { ...cur[s], state: 'pending', progress: null };
				return next;
			});
			void (async () => {
				try {
					const first = await ask(true, sources);
					if (!first || !live.current || gen !== generation.current) return;
					const pending = sources.filter((s) => first.analysis?.[s]?.state === 'pending');
					if (!pending.length) {
						apply(first, sources);
						return;
					}
					apply(
						first,
						sources.filter((s) => !pending.includes(s)),
					);
					const jobs = new Map<string, EngineCueSource>();
					for (const s of pending) for (const id of first.analysis?.[s]?.jobIds ?? []) jobs.set(id, s);
					// poll the jobs (the Jobs panel shows them too) until every one has ended
					const done = new Map<string, EngineJob>();
					while (done.size < jobs.size) {
						await new Promise((r) => setTimeout(r, 400));
						if (!live.current || gen !== generation.current) return;
						const perSource = new Map<EngineCueSource, number[]>();
						for (const [id, s] of jobs) {
							if (done.has(id)) {
								perSource.set(s, [...(perSource.get(s) ?? []), 1]);
								continue;
							}
							const j = await engine.getJob(id);
							if (j.state === 'succeeded' || j.state === 'failed' || j.state === 'cancelled') done.set(id, j);
							perSource.set(s, [...(perSource.get(s) ?? []), done.has(id) ? 1 : (j.progress ?? 0)]);
						}
						if (!live.current || gen !== generation.current) return;
						setStatus((cur) => {
							const next = { ...cur };
							for (const [s, ps] of perSource)
								next[s] = {
									...cur[s],
									state: 'pending',
									progress: ps.reduce((a, b) => a + b, 0) / ps.length,
								};
							return next;
						});
					}
					const failed = [...done.values()].find((j) => j.state !== 'succeeded');
					const again = await ask(false, pending);
					if (!again || !live.current || gen !== generation.current) return;
					apply(again, pending);
					if (failed)
						setError(
							`${failed.title}: ${failed.error?.message ?? (failed.state === 'cancelled' ? t('Cancelled') : t('Failed'))}`,
						);
				} catch (e) {
					if (live.current && gen === generation.current)
						setError(e instanceof Error ? e.message : String(e));
				} finally {
					if (live.current && gen === generation.current) setBusy(false);
				}
			})();
		},
		[engine, range, ask, apply],
	);

	return { status, cues, analyze, busy, error, voice };
}

/** Why a source has nothing to measure. */
const nothing = (source: EngineCueSource): string =>
	source === 'beat' ? t('No music clip in the range') : t('No footage in the range');

/** Status text of a source: counts, "not analysed", progress, why there is nothing. */
export function engineStatusText(
	source: EngineCueSource,
	s: EngineSourceStatus,
	counts: { found: number; kept: number },
): string {
	switch (s.state) {
		case 'loading':
			return '…';
		case 'ready':
			return t('{0} found · {1} kept', counts.found, counts.kept);
		case 'pending':
			return s.progress != null ? t('Analysing… {0} %', Math.round(s.progress * 100)) : t('Analysing…');
		case 'missing':
			return s.found ? t('{0} found · partly analysed', s.found) : t('Not analysed yet');
		case 'none':
			return nothing(source);
		default:
			return t('Analysis failed');
	}
}

/**
 * The "Measured in the media" rows of the dialogs: a checkbox per engine source with its status, an Analyze… button
 * where it is not analysed yet, and "Snap to the beat".
 */
export function EngineSourceRows(props: {
	engine: EngineSourcesState;
	selected: ReadonlySet<EngineCueSource>;
	onToggle: (s: EngineCueSource, on: boolean) => void;
	counts: Record<EngineCueSource, { found: number; kept: number }>;
	snapToBeats: boolean;
	onSnapToBeats: (on: boolean) => void;
	testId: string;
	/** A line under the rows (e.g. what happens to sources not analysed yet). */
	hint?: string;
}) {
	const { engine, selected, counts } = props;
	// beats are analysed on the spot (no job): ticking "Snap" analyses them when they are not yet
	const beat = engine.status.beat.state;
	const snapPossible = beat === 'ready' || beat === 'missing' || beat === 'pending';
	return (
		<fieldset className="flex flex-col gap-1" data-testid={props.testId}>
			<legend className="mb-1 text-pr-muted">Measured in the media</legend>
			{ENGINE_CUE_SOURCES.map((s) => {
				const st = engine.status[s];
				const canAnalyze = st.state === 'missing' || st.state === 'failed';
				return (
					<div key={s} className="flex items-center gap-2" data-cue-source={s} data-engine-state={st.state}>
						<Checkbox
							checked={selected.has(s)}
							onCheckedChange={(on) => props.onToggle(s, on)}
							label={ENGINE_SOURCE_LABELS[s]}
							disabled={st.state === 'none'}
						/>
						<span
							className="ml-auto shrink-0 text-pr-small text-pr-muted tabular-nums"
							data-cue-source-count={s}
							aria-live="polite"
							title={st.message}
						>
							{engineStatusText(s, st, counts[s])}
						</span>
						{canAnalyze ? (
							<Button
								variant="secondary"
								className="shrink-0"
								busy={engine.busy && st.state === 'pending'}
								disabled={engine.busy}
								aria-label={t('Analyze {0}', t(ENGINE_SOURCE_LABELS[s]))}
								onClick={() => engine.analyze([s])}
								data-testid={`analyze-${s}`}
							>
								{t('Analyze…')}
							</Button>
						) : null}
					</div>
				);
			})}
			<Checkbox
				checked={props.snapToBeats}
				onCheckedChange={(on) => {
					props.onSnapToBeats(on);
					if (on && beat === 'missing' && !engine.busy) engine.analyze(['beat']);
				}}
				disabled={!snapPossible}
				label={t('Snap moves and transitions to the beat (within 2 frames)')}
			/>
			{props.hint ? <p className="text-pr-small text-pr-muted">{props.hint}</p> : null}
			{engine.error ? (
				<p className="text-pr-small text-pr-warning" role="status" data-testid={`${props.testId}-error`}>
					{engine.error}
				</p>
			) : null}
		</fieldset>
	);
}
