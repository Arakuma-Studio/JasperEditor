// Sound Library ▸ Find Moment… (spec 12 P6-E14, WP-E9; wp-note "Phase 6 → WP-E9"): searches a long recording for the
// moments that best match a description with the optional Describe-it search model (a `sound-moment` job on the
// engine), lists them best first with where they are, how well they match and whether they are cut inside a sound,
// auditions each range, and inserts one at the playhead (one undo step). Without the model it says so and opens the
// preferences. Every engine call is answered or caught.
import { type SoundEntry, type SoundMoment, SoundMomentResultSchema } from '@jasper/api';
import type { EditorSession } from '@jasper/session';
import { Button, Dialog, type HostedDialogProps, openDialog, Select, TextField } from '@jasper/ui';
import { useEffect, useRef, useState } from 'react';
import { useDialogClose } from '../extensions/dialog.ts';
import { t } from '../i18n/runtime.ts';
import { errorText, followJob } from '../processing/engine-jobs.ts';
import { PREFERENCES_DIALOG } from '../shell/preferences/index.ts';
import { useEngine } from '../state/engine.tsx';
import { auditionPlayer } from './audition.ts';
import { InsertSoundError, insertSoundMoment } from './insert.ts';
import { soundLibraryPrefs } from './prefs.ts';

export const SOUND_FIND_MOMENT_DIALOG = 'sound.findMoment';

/** Sounds shorter than this are not searched inside (the whole sound is the moment). */
export const FIND_MOMENT_MIN_SEC = 3;

const LENGTHS = ['0.5', '1', '2', '5', '10'];

/** `m:ss.cc` of a time in a sound. */
export function momentTime(sec: number): string {
	const s = Math.max(0, sec);
	const m = Math.floor(s / 60);
	const rest = s - m * 60;
	return `${m}:${rest.toFixed(2).padStart(5, '0')}`;
}

const verdictText = (v: SoundMoment['match']['verdict']): string =>
	v === 'strong'
		? t('Strong match')
		: v === 'plausible'
			? t('Plausible match')
			: v === 'weak'
				? t('Weak match')
				: t('No clear match');

export function FindMomentDialog(
	props: HostedDialogProps<{ entry: SoundEntry; session: EditorSession | null }>,
) {
	const { open, finish } = useDialogClose(props.close);
	const { client: engine } = useEngine();
	const e = props.entry;
	const session = props.session;
	const [description, setDescription] = useState('');
	const [length, setLength] = useState('2');
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<{ code: string | null; message: string } | null>(null);
	const [moments, setMoments] = useState<SoundMoment[] | null>(null);
	const [playing, setPlaying] = useState<number | null>(null);
	const ac = useRef<AbortController | null>(null);
	useEffect(
		() => () => {
			ac.current?.abort();
			auditionPlayer().stop();
		},
		[],
	);
	const canInsert = !!session && !!session.getState().activeSequenceId && !session.getState().readOnly;

	const find = async (): Promise<boolean> => {
		const text = description.trim();
		if (!text) {
			setError({ code: null, message: t('Describe the moment first') });
			return false;
		}
		ac.current?.abort();
		const ctl = new AbortController();
		ac.current = ctl;
		setBusy(t('Queued'));
		setError(null);
		setMoments(null);
		try {
			const job = await engine.findSoundMoments(e.id, {
				description: text,
				lengthSec: Number(length),
				count: 5,
			});
			const end = await followJob(engine, job.id, {
				signal: ctl.signal,
				onUpdate: (j) =>
					setBusy(
						j.progress !== null && j.progress !== undefined
							? `${j.stage ?? t('Listening')} ${Math.round(j.progress * 100)} %`
							: (j.stage ?? j.state),
					),
			});
			if (ctl.signal.aborted) return false;
			if (end.state !== 'succeeded') {
				setError({ code: end.error?.code ?? null, message: end.error?.message ?? end.state });
				return false;
			}
			const r = SoundMomentResultSchema.safeParse(end.result);
			if (!r.success) {
				setError({ code: null, message: t('The engine answered something unexpected') });
				return false;
			}
			setMoments(r.data.moments);
		} catch (err) {
			const code = (err as { code?: unknown }).code;
			setError({ code: typeof code === 'string' ? code : null, message: errorText(err) });
		} finally {
			if (ac.current === ctl) setBusy(null);
		}
		return false;
	};

	const audition = (m: SoundMoment, i: number) => {
		const p = auditionPlayer();
		if (playing === i && p.state.phase !== 'idle') {
			p.stop();
			setPlaying(null);
			return;
		}
		p.setVolumeDb(soundLibraryPrefs.get().volumeDb);
		setPlaying(i);
		void p.play(
			{
				id: `${e.id}@${m.startSec}-${m.endSec}`,
				cacheId: e.id,
				title: `${e.title} ${momentTime(m.startSec)}`,
				url: engine.soundAudioUrl(e.id),
				format: e.format,
				range: { startSec: m.startSec, endSec: m.endSec },
			},
			{ loop: false },
		);
	};

	const insert = async (m: SoundMoment) => {
		if (!session) return;
		try {
			const r = await insertSoundMoment(session, engine, e, { startSec: m.startSec, endSec: m.endSec });
			setError(null);
			setBusy(r.message);
		} catch (err) {
			setError({
				code: null,
				message: err instanceof InsertSoundError || err instanceof Error ? err.message : String(err),
			});
		}
	};

	const needsModel = error?.code === 'MODEL_NOT_INSTALLED' || error?.code === 'DESCRIBE_UNAVAILABLE';
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => !o && finish()}
			title={t('Find Moment — {0}', e.title || e.id)}
			size="medium"
			primaryLabel="Find"
			primaryDisabled={!!busy && busy === t('Queued')}
			onPrimary={find}
			cancelLabel="Close"
			data-testid="sound-find-moment-dialog"
		>
			<div className="flex flex-col gap-2 text-pr-ui">
				<p className="text-pr-small text-pr-muted">
					Describe what you are looking for as source, material, action and character, in English: &ldquo;a
					single clean key press on a mechanical keyboard&rdquo;, &ldquo;a glass bottle clinking&rdquo;. The
					recording is compared window by window with the Describe-it search model.
				</p>
				<div className="flex flex-col gap-0.5">
					<span className="text-pr-small text-pr-muted" aria-hidden="true">
						Description
					</span>
					<TextField
						value={description}
						maxLength={300}
						placeholder="Describe the moment"
						aria-label="Description"
						onChange={(ev) => setDescription(ev.currentTarget.value)}
						onKeyDown={(ev) => {
							if (ev.key === 'Enter') {
								ev.preventDefault();
								void find();
							}
						}}
						data-testid="sound-find-moment-description"
					/>
				</div>
				<Select
					label="Window length"
					className="w-40"
					value={length}
					onValueChange={setLength}
					options={LENGTHS.map((v) => ({ value: v, label: t('{0} s', v) }))}
				/>
				{busy ? (
					<p className="text-pr-small text-pr-text" role="status" data-testid="sound-find-moment-status">
						{busy}
					</p>
				) : null}
				{error ? (
					<div className="flex items-center gap-2">
						<p className="text-pr-small text-pr-warning" role="alert" data-testid="sound-find-moment-error">
							{needsModel
								? t('Find Moment needs the optional Describe-it search model: {0}', error.message)
								: error.message}
						</p>
						{needsModel ? (
							<Button
								variant="secondary"
								onClick={() => void openDialog(PREFERENCES_DIALOG, { page: 'sound-library', session })}
							>
								Open Preferences
							</Button>
						) : null}
					</div>
				) : null}
				{moments ? (
					moments.length ? (
						<ol className="flex flex-col gap-1" aria-label="Moments" data-testid="sound-find-moment-results">
							{moments.map((m, i) => (
								<li
									key={`${m.startSec}-${m.endSec}`}
									className="flex items-center gap-2 rounded-pr-control border border-pr-border-subtle px-2 py-1"
									data-moment-start={m.startSec}
								>
									<span className="w-4 shrink-0 text-pr-muted pr-tabular">{i + 1}</span>
									<span className="min-w-0 flex-1">
										<span className="pr-tabular">
											{momentTime(m.startSec)} – {momentTime(m.endSec)}
										</span>
										<span className="block text-pr-small text-pr-muted">
											{verdictText(m.match.verdict)}
											{` · z ${m.match.z.toFixed(1)}`}
											{m.headDb > -15 ? ` · ${t('starts inside a sound')}` : ''}
											{m.tailDb > -30 ? ` · ${t('cut before it fades')}` : ''}
										</span>
									</span>
									<Button
										variant="quiet"
										onClick={() => audition(m, i)}
										data-testid={`sound-find-moment-play-${i}`}
									>
										{playing === i ? t('Stop') : t('Audition')}
									</Button>
									<Button
										variant="secondary"
										disabled={!canInsert}
										onClick={() => void insert(m)}
										data-testid={`sound-find-moment-insert-${i}`}
									>
										Insert at Playhead
									</Button>
								</li>
							))}
						</ol>
					) : (
						<p className="text-pr-small text-pr-muted">Nothing matched: try other words.</p>
					)
				) : null}
			</div>
		</Dialog>
	);
}
