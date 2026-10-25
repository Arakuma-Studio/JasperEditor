// Sequence ▸ Sound Design ▸ Lay Ambience Bed… (spec 12 §4 P6-E12; wp-note "Phase 6 → WP-E8"). The bed (a library
// ambience; the palette's first by default), where scenes change (cuts to other footage, scene markers, measured shot
// changes), the crossfades, fades and ducking; the engine measures the plan (`POST /api/sound-design/beds/plan`) and
// the dialog lists every scene with its timecodes, why it starts there and what was measured (the clean window, the
// loop points, the crossfade, the gain). Each scene may take another bed or join the scene before. Lay Beds applies ONE
// undoable edit (the engine's job in apply mode: the user's own History entry); Propose for Review stores a proposal
// and opens it in the Review panel.
import type { SoundBedsPlan, SoundBedsRequest } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import { dialogueSpans, type Sequence } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import {
	Button,
	Checkbox,
	Dialog,
	type HostedDialogProps,
	registerDialog,
	Select,
	Slider,
	toast as uiToast,
} from '@jasper/ui';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import type { ToastRequest } from '../commands/types.ts';
import { useDialogClose } from '../extensions/dialog.ts';
import { t } from '../i18n/runtime.ts';
import { openReview } from '../proposals/actions.ts';
import { bedSceneLine, bedSceneReason, bedsSummary, runBeds } from './bed-jobs.ts';
import { entryOfRevision, SoundJobError, undoIfTop } from './mix-jobs.ts';

export const AMBIENCE_BED_DIALOG = 'sound.layAmbienceBed';

let registered = false;
export function registerAmbienceBedDialog(): void {
	if (registered) return;
	registered = true;
	registerDialog(AMBIENCE_BED_DIALOG, AmbienceBedDialog);
}

type Engine = Pick<
	EngineClient,
	'planAmbienceBeds' | 'layAmbienceBeds' | 'getJob' | 'cancelJob' | 'searchSounds'
>;
/** A bed choice: a library sound (`snd_…`) or a project media (`media:<id>`). */
type Bed = { id: string; title: string };
type SceneEdit = { soundId: string | null; join: boolean };

const MEDIA_KEY = 'media:';
/** The request fields of a bed choice. */
export function bedRef(key: string): { soundId: string } | { mediaId: string } {
	return key.startsWith(MEDIA_KEY) ? { mediaId: key.slice(MEDIA_KEY.length) } : { soundId: key };
}

function Field(props: { label: string; value: string; children: ReactNode; testId?: string }) {
	return (
		<div className="flex items-center gap-2" data-testid={props.testId}>
			<span className="w-[140px] shrink-0 text-pr-muted">{props.label}</span>
			<div className="min-w-0 flex-1">{props.children}</div>
			<span className="w-[56px] shrink-0 text-right text-pr-small pr-tabular">{props.value}</span>
		</div>
	);
}

/** The scenes to lay after the user's edits: joined rows go into the scene before; a row's own bed when it differs. */
function editedScenes(
	plan: SoundBedsPlan,
	edits: readonly SceneEdit[],
	defaultSoundId: string,
): NonNullable<Exclude<SoundBedsRequest['scenes'], 'auto'>> {
	const out: { start: number; end: number; soundId?: string; mediaId?: string }[] = [];
	plan.scenes.forEach((s, i) => {
		const e = edits[i];
		const last = out[out.length - 1];
		if (i > 0 && e?.join && last) {
			last.end = s.end;
			return;
		}
		const own = e?.soundId && e.soundId !== defaultSoundId ? e.soundId : undefined;
		out.push({ start: s.start, end: s.end, ...(own ? bedRef(own) : {}) });
	});
	return out;
}

export function AmbienceBedDialog(
	props: HostedDialogProps<{
		session: EditorSession;
		engine: Engine;
		sequenceId: string;
		toast?: (r: ToastRequest) => void;
		/** Called after review opened on the proposal (the shell focuses the Review panel). */
		onReview?: () => void;
	}>,
) {
	const { open, finish } = useDialogClose(props.close);
	const { session, sequenceId, engine } = props;
	const doc = session.getCommitted();
	const seq = doc.sequences[sequenceId] as Sequence | undefined;
	const hasDialogue = useMemo(() => !!seq && dialogueSpans(doc, seq).length > 0, [doc, seq]);
	const readOnly = session.getState().readOnly;
	const [beds, setBeds] = useState<Bed[] | null>(null);
	const [soundId, setSoundId] = useState('');
	const [sources, setSources] = useState({ edits: true, markers: true, shots: false });
	const [duck, setDuck] = useState(hasDialogue);
	const [crossfadeSec, setCrossfade] = useState(1.5);
	const [sceneSec, setSceneSec] = useState(0.5);
	const [fadeSec, setFadeSec] = useState(1);
	const [plan, setPlan] = useState<SoundBedsPlan | null>(null);
	const [planning, setPlanning] = useState(false);
	const [edits, setEdits] = useState<SceneEdit[]>([]);
	const [message, setMessage] = useState<string | null>(null);
	const [running, setRunning] = useState<{ progress: number | null; stage: string } | null>(null);
	const abort = useRef<AbortController | null>(null);
	useEffect(() => () => abort.current?.abort(), []);

	// the library's ambiences (the palette's first is the default)
	useEffect(() => {
		const ac = new AbortController();
		void (async () => {
			try {
				const r = await engine.searchSounds({ types: ['ambience'], limit: 200 }, ac.signal);
				const list = (r.results ?? [])
					.filter((x) => !(x.sound.types as readonly string[]).includes('roomtone'))
					.map((x) => ({ id: x.sound.id, title: x.sound.title }));
				// the project's own audio (a location recording the user imported) after the library's
				const own: Bed[] = Object.values(doc.media ?? {})
					.filter((m) => m.kind === 'audio' && !m.derivation)
					.map((m) => ({ id: `${MEDIA_KEY}${m.id}`, title: t('{0} (project)', m.originalName) }));
				const palette = (seq?.soundDesign?.settings?.palette ?? []) as string[];
				const first = palette.find((id) => list.some((b) => b.id === id)) ?? list[0]?.id ?? '';
				setBeds([...list, ...own]);
				setSoundId((s) => s || first);
			} catch (e) {
				if (!ac.signal.aborted) {
					setBeds([]);
					setMessage(e instanceof Error ? e.message : String(e));
				}
			}
		})();
		return () => ac.abort();
	}, [engine, seq, doc]);

	const base = useMemo(
		(): Omit<SoundBedsRequest, 'mode'> => ({
			projectId: session.projectId,
			sequenceId,
			...(soundId ? bedRef(soundId) : {}),
			crossfadeSec,
			sceneCrossfadeSec: sceneSec,
			fadeSec,
			...(duck ? { duckUnder: 'dialogue' as const } : {}),
		}),
		[session.projectId, sequenceId, soundId, crossfadeSec, sceneSec, fadeSec, duck],
	);

	// the measured plan (debounced): scenes, windows, loop points
	useEffect(() => {
		if (!soundId || !seq) return;
		const ac = new AbortController();
		const h = setTimeout(() => {
			setPlanning(true);
			setMessage(null);
			engine
				.planAmbienceBeds(
					{
						...base,
						sources: (['edits', 'markers', 'shots'] as const).filter((k) => sources[k]),
					},
					ac.signal,
				)
				.then((p) => {
					setPlan(p);
					setEdits(p.scenes.map(() => ({ soundId: null, join: false })));
				})
				.catch((e) => {
					if (!ac.signal.aborted) {
						setPlan(null);
						setMessage(e instanceof Error ? e.message : String(e));
					}
				})
				.finally(() => {
					if (!ac.signal.aborted) setPlanning(false);
				});
		}, 250);
		return () => {
			clearTimeout(h);
			ac.abort();
		};
	}, [base, soundId, sources, engine, seq]);

	const run = async (mode: 'apply' | 'propose'): Promise<boolean> => {
		if (!plan || !soundId) return false;
		const edited = edits.some((e) => e.join || e.soundId);
		const ac = new AbortController();
		abort.current = ac;
		setRunning({ progress: null, stage: t('Measuring the beds…') });
		setMessage(null);
		try {
			const r = await runBeds(
				engine,
				{
					...base,
					mode,
					...(edited
						? { scenes: editedScenes(plan, edits, soundId) }
						: { sources: (['edits', 'markers', 'shots'] as const).filter((k) => sources[k]) }),
				},
				{ signal: ac.signal, onJob: (j) => setRunning({ progress: j.progress, stage: j.stage ?? j.title }) },
			);
			setRunning(null);
			const sum = bedsSummary(r);
			if (mode === 'propose' && r.proposalId) {
				const ok = await openReview(session, r.proposalId);
				if (ok) props.onReview?.();
				uiToast({ kind: 'success', title: sum.title, detail: sum.detail });
				finish();
				return true;
			}
			const entry = entryOfRevision(session, r.revision);
			uiToast({
				kind: r.applied ? 'success' : 'info',
				title: sum.title,
				detail: sum.detail,
				durationMs: 15_000,
				...(r.applied
					? {
							actions: [
								{
									label: t('Undo'),
									run: () => {
										if (!undoIfTop(session, entry))
											uiToast({ kind: 'info', title: t('Newer edits came after it; use the History panel') });
									},
								},
							],
						}
					: {}),
			});
			finish();
			return true;
		} catch (e) {
			setRunning(null);
			if (e instanceof SoundJobError && e.code === 'E_CANCELLED') return false;
			setMessage(e instanceof Error ? e.message : String(e));
			return false;
		} finally {
			abort.current = null;
		}
	};

	const bedOptions = (beds ?? []).map((b) => ({ value: b.id, label: b.title }));
	const pct = running?.progress != null ? Math.round(running.progress * 100) : null;
	const busy = !!running;
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
			title="Lay Ambience Bed"
			size="large"
			primaryLabel={busy ? t('Laying…') : t('Lay Beds')}
			primaryDisabled={readOnly || busy || !plan || planning || !soundId}
			onPrimary={() => run('apply')}
			footerExtra={
				<Button
					variant="secondary"
					disabled={readOnly || busy || !plan || planning || !soundId}
					onClick={() => void run('propose')}
					data-testid="ambience-bed-propose"
				>
					{t('Propose for Review')}
				</Button>
			}
			data-testid="ambience-bed-dialog"
		>
			<div className="flex flex-col gap-3 text-pr-ui">
				<p className="text-pr-small text-pr-muted">
					One ambience per scene, looped at the recording’s measured clean window and loop points, crossfaded
					between scenes. One undo step.
				</p>
				<div className="flex items-center gap-2" data-testid="ambience-bed-sound">
					<span className="w-[140px] shrink-0 text-pr-muted">{t('Bed')}</span>
					{beds && beds.length === 0 ? (
						<span className="text-pr-small text-pr-muted">
							{t('No ambience in the Sound Library: install the BigSoundBank Ambience & Room Tone pack')}
						</span>
					) : (
						<Select
							label={t('Bed')}
							value={soundId}
							disabled={busy || !beds}
							onValueChange={setSoundId}
							options={bedOptions}
						/>
					)}
				</div>
				<div className="flex flex-wrap items-center gap-x-4 gap-y-1" data-testid="ambience-bed-sources">
					<span className="w-[140px] shrink-0 text-pr-muted">{t('Scenes change at')}</span>
					<Checkbox
						checked={sources.edits}
						disabled={busy}
						onCheckedChange={(v) => setSources((s) => ({ ...s, edits: v }))}
						label={t('Cuts to other footage')}
					/>
					<Checkbox
						checked={sources.markers}
						disabled={busy}
						onCheckedChange={(v) => setSources((s) => ({ ...s, markers: v }))}
						label={t('Scene markers')}
					/>
					<Checkbox
						checked={sources.shots}
						disabled={busy}
						onCheckedChange={(v) => setSources((s) => ({ ...s, shots: v }))}
						label={t('Shot changes (measured)')}
					/>
				</div>
				<Field
					label={t('Loop crossfade')}
					value={t('{0} s', crossfadeSec.toFixed(1))}
					testId="ambience-bed-crossfade"
				>
					<Slider
						label={t('Loop crossfade')}
						value={crossfadeSec}
						min={0.5}
						max={4}
						step={0.1}
						defaultValue={1.5}
						disabled={busy}
						onChange={setCrossfade}
					/>
				</Field>
				<Field label={t('Scene crossfade')} value={t('{0} s', sceneSec.toFixed(1))}>
					<Slider
						label={t('Scene crossfade')}
						value={sceneSec}
						min={0}
						max={2}
						step={0.1}
						defaultValue={0.5}
						disabled={busy}
						onChange={setSceneSec}
					/>
				</Field>
				<Field label={t('Fade in and out')} value={t('{0} s', fadeSec.toFixed(1))}>
					<Slider
						label={t('Fade in and out')}
						value={fadeSec}
						min={0}
						max={3}
						step={0.1}
						defaultValue={1}
						disabled={busy}
						onChange={setFadeSec}
					/>
				</Field>
				<Checkbox
					checked={duck}
					disabled={busy}
					onCheckedChange={setDuck}
					label={t('Duck under the dialogue (−10 dB)')}
				/>
				<div className="flex flex-col gap-1" data-testid="ambience-bed-scenes" aria-busy={planning}>
					<span className="text-pr-muted">
						{planning ? t('Measuring the scenes…') : plan ? t('{0} scenes', plan.scenes.length) : t('Scenes')}
					</span>
					<ol className="flex max-h-[260px] flex-col gap-1 overflow-y-auto rounded border border-pr-border p-1">
						{(plan?.scenes ?? []).map((s, i) => (
							<li
								key={`${s.start}-${s.end}`}
								className="flex flex-col gap-0.5 rounded px-1 py-0.5 hover:bg-pr-hover"
								data-testid="ambience-bed-scene"
							>
								<div className="flex items-center gap-2">
									<span className="w-[20px] shrink-0 text-right pr-tabular">{i + 1}</span>
									<span className="shrink-0 pr-tabular">
										{s.timecode}–{s.endTimecode}
									</span>
									<span className="min-w-0 flex-1 truncate text-pr-small text-pr-muted">
										{bedSceneReason(s.reason)}
										{s.label ? ` · ${s.label}` : ''}
									</span>
									<div className="w-[180px] shrink-0">
										<Select
											label={t('Bed of scene {0}', i + 1)}
											value={edits[i]?.soundId ?? soundId}
											disabled={busy || !!edits[i]?.join}
											onValueChange={(v) =>
												setEdits((list) => list.map((e, k) => (k === i ? { ...e, soundId: v } : e)))
											}
											options={bedOptions}
										/>
									</div>
									{/* a fixed column: the beds line up whether a row can join the one before or not */}
									<div className="w-[190px] shrink-0">
										{i > 0 ? (
											<Checkbox
												checked={!!edits[i]?.join}
												disabled={busy}
												onCheckedChange={(v) =>
													setEdits((list) => list.map((e, k) => (k === i ? { ...e, join: v } : e)))
												}
												label={t('Join the scene before')}
											/>
										) : null}
									</div>
								</div>
								<span className="pl-[28px] text-pr-small text-pr-muted pr-tabular">{bedSceneLine(s)}</span>
							</li>
						))}
					</ol>
				</div>
				{(plan?.warnings ?? []).map((w) => (
					<p key={w.code} className="text-pr-small text-pr-warning" role="status">
						{w.message}
					</p>
				))}
				{running ? (
					<p className="text-pr-small" role="status">
						{running.stage}
						{pct !== null ? ` · ${pct} %` : ''}
					</p>
				) : null}
				{message ? (
					<p className="text-pr-small text-pr-danger" role="alert">
						{message}
					</p>
				) : null}
			</div>
		</Dialog>
	);
}
