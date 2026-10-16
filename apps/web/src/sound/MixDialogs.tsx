// Sequence ▸ Sound Design ▸ Room Glue… and Delivery Target… (spec 12 §2.4 "Room glue" / "Delivery presets", P4-R3 /
// P4-R4; wp-note "Phase 4 → WP4.2b").
// - Room Glue…: on / off, send level, reverb decay, mix and pre-delay; shows which tracks send and which stay dry (and
//   why: interface sounds only, bed audio on the track). Apply = ONE command: `soundDesign.ensureBus` (creates or updates
//   the "SFX Room" bus, its Studio Reverb and the sends) or `soundDesign.removeBus`.
// - Delivery Target…: the presets with their numbers (integrated LUFS, true peak, the bed under the voice), what to
//   apply (loudness normalisation, Auto-Match by type, ducking, re-solving the sound effects), Apply runs the engine's
//   delivery job in apply mode (progress here and in the Jobs panel; Cancel cancels it) — ONE undoable transaction —
//   then shows what it measured (LUFS, true peak, music and ambience under the voice) with Undo in the toast.
import type { EngineClient } from '@jasper/engine-client';
import {
	DELIVERY_PRESETS,
	DELIVERY_RELATIVE_LU,
	ROOM_GLUE_DEFAULT,
	readSoundDesignMix,
	roomSendPlan,
	type Sequence,
	type SoundDelivery,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import {
	Checkbox,
	cx,
	Dialog,
	type HostedDialogProps,
	registerDialog,
	Select,
	Slider,
	toast as uiToast,
} from '@jasper/ui';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { ToastRequest } from '../commands/types.ts';
import { useDialogClose } from '../extensions/dialog.ts';
import { t } from '../i18n/runtime.ts';
import { trackLabelOf } from './design-model.ts';
import {
	deliveryNotes,
	deliverySummary,
	entryOfRevision,
	runDelivery,
	SoundJobError,
	undoIfTop,
} from './mix-jobs.ts';
import {
	DELIVERY_IDS,
	deliveryOptionLabel,
	fmtDb,
	roomBusOf,
	type SoundNote,
	sequenceDelivery,
} from './mix-model.ts';

export const ROOM_GLUE_DIALOG = 'sound.roomGlue';
export const DELIVERY_DIALOG = 'sound.deliveryTarget';
export const SOUND_NOTES_DIALOG = 'sound.mixNotes';

let registered = false;
export function registerMixDialogs(): void {
	if (registered) return;
	registered = true;
	registerDialog(ROOM_GLUE_DIALOG, RoomGlueDialog);
	registerDialog(DELIVERY_DIALOG, DeliveryDialog);
	registerDialog(SOUND_NOTES_DIALOG, SoundNotesDialog);
}

// ---------------------------------------------------------------------------------------------------------------
// Notes: a mixing job's conflicts and warnings (Rebalance's Details…, Delivery Target…, Auto Sound Pass…)

/** The notes of a job, the ones to act on marked "!" (text and colour, not colour alone). */
export function SoundNotesList(props: { notes: readonly SoundNote[]; testId?: string; max?: number }) {
	const max = props.max ?? 50;
	if (!props.notes.length) return null;
	const shown = props.notes.slice(0, max);
	return (
		<ul className="flex flex-col gap-1 text-pr-small" data-testid={props.testId ?? 'sound-notes'}>
			{shown.map((n) => (
				<li
					key={`${n.code}|${n.text}`}
					className={cx(
						'flex items-start gap-1',
						n.severity === 'warning' ? 'text-pr-warning' : 'text-pr-muted',
					)}
					data-kind={n.kind}
					data-severity={n.severity}
					data-code={n.code}
				>
					<span aria-hidden="true" className="w-2 shrink-0">
						{n.severity === 'warning' ? '!' : n.kind === 'conflict' ? '⇄' : '·'}
					</span>
					<span className="min-w-0 break-words">{n.text}</span>
				</li>
			))}
			{props.notes.length > shown.length ? (
				<li className="text-pr-dim">{t('{0} more', props.notes.length - shown.length)}</li>
			) : null}
		</ul>
	);
}

/** Details… of a Rebalance: every conflict and warning of the solve. */
export function SoundNotesDialog(
	props: HostedDialogProps<{ title?: string; summary?: string; notes?: SoundNote[] }>,
) {
	const { open, finish } = useDialogClose(props.close);
	const notes = Array.isArray(props.notes) ? props.notes : [];
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => {
				if (!o) finish();
			}}
			title={props.title ?? t('Rebalance Details')}
			size="medium"
			primaryLabel={t('Close')}
			onPrimary={() => true}
			data-testid="sound-notes-dialog"
		>
			<div className="flex flex-col gap-2 text-pr-ui">
				{props.summary ? <p className="text-pr-small text-pr-text">{props.summary}</p> : null}
				<p className="text-pr-small text-pr-muted">
					A conflict means two of the solver's rules could not both hold: the earlier, safer one was kept.
				</p>
				{notes.length ? (
					<SoundNotesList notes={notes} max={200} testId="sound-notes-dialog-list" />
				) : (
					<p className="text-pr-small text-pr-muted">{t('No conflicts or warnings')}</p>
				)}
			</div>
		</Dialog>
	);
}

function Field(props: { label: string; value: string; children: ReactNode; testId?: string }) {
	return (
		<div className="flex items-center gap-2" data-testid={props.testId}>
			<span className="w-[120px] shrink-0 text-pr-muted">{props.label}</span>
			<div className="min-w-0 flex-1">{props.children}</div>
			<span className="w-[64px] shrink-0 text-right text-pr-small pr-tabular">{props.value}</span>
		</div>
	);
}

// ---------------------------------------------------------------------------------------------------------------
// Room Glue…

/** Which tracks send to the room and which stay dry (with why), as the glue would set them now. */
export function roomTrackSummary(
	session: EditorSession,
	seq: Sequence,
): { sends: string[]; dry: { track: string; reason: string }[] } {
	const plan = roomSendPlan(session.getCommitted(), seq);
	return {
		sends: plan.filter((d) => d.send).map((d) => trackLabelOf(seq, d.trackId)),
		dry: plan.filter((d) => !d.send).map((d) => ({ track: trackLabelOf(seq, d.trackId), reason: d.reason })),
	};
}

export function RoomGlueDialog(
	props: HostedDialogProps<{ session: EditorSession; sequenceId: string; toast?: (r: ToastRequest) => void }>,
) {
	const { open, finish } = useDialogClose(props.close);
	const { session, sequenceId } = props;
	const seq = session.getCommitted().sequences[sequenceId];
	const glue = seq ? (readSoundDesignMix(seq.soundDesign?.mix)?.room ?? null) : null;
	const bus = seq ? roomBusOf(seq) : null;
	const [on, setOn] = useState(!!glue);
	const [sendDb, setSendDb] = useState<number>(glue?.sendDb ?? ROOM_GLUE_DEFAULT.sendDb);
	const [decay, setDecay] = useState<number>(glue?.decay ?? ROOM_GLUE_DEFAULT.decay);
	const [mix, setMix] = useState<number>(glue?.mix ?? ROOM_GLUE_DEFAULT.mix);
	const [preDelay, setPreDelay] = useState<number>(glue?.preDelayMs ?? ROOM_GLUE_DEFAULT.preDelayMs);
	const readOnly = session.getState().readOnly;
	if (!seq) return null;
	const summary = roomTrackSummary(session, seq);
	const apply = (): boolean => {
		const commands = on
			? [
					{
						type: 'soundDesign.ensureBus',
						sequenceId,
						roomGlue: { sendDb, decay, mix, preDelayMs: preDelay },
					},
				]
			: glue || bus
				? [{ type: 'soundDesign.removeBus', sequenceId }]
				: [];
		if (!commands.length) return true;
		const label = on ? t('SFX Room Glue') : t('Remove SFX Room Glue');
		const r = session.apply({ label, origin: 'user', sequenceId, commands: commands as never[] });
		if (!r.ok) {
			props.toast?.({ kind: 'warning', message: r.errors[0]?.message ?? t('{0} failed', label) });
			return false;
		}
		const res = r.results[0] as { sends?: unknown[]; removedSends?: number } | undefined;
		props.toast?.({
			kind: 'success',
			message: on
				? t('SFX Room on: {0} tracks send to it', res?.sends?.length ?? 0)
				: t('SFX Room removed ({0} sends)', res?.removedSends ?? 0),
			action: { label: t('Undo'), command: 'history.undo' },
		});
		return true;
	};
	const unchanged =
		(!on && !glue && !bus) ||
		(on &&
			!!glue &&
			glue.sendDb === sendDb &&
			glue.decay === decay &&
			glue.mix === mix &&
			glue.preDelayMs === preDelay &&
			summary.sends.length === glue.sends.length);
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => {
				if (!o) finish();
			}}
			title="Room Glue"
			size="medium"
			primaryLabel={t('Apply')}
			primaryDisabled={readOnly || unchanged}
			onPrimary={apply}
			data-testid="room-glue-dialog"
		>
			<div className="flex flex-col gap-3 text-pr-ui">
				<p className="text-pr-small text-pr-muted">
					A shared short room reverb (an "SFX Room" submix with a Studio Reverb) that the sound-effect tracks
					send to, so the sounds sit in one space. Sends are post-fader and per track.
				</p>
				<Checkbox
					checked={on}
					onCheckedChange={setOn}
					label={t('Glue the sound effects with a shared room')}
					disabled={readOnly}
				/>
				<Field label={t('Send level')} value={t('{0} dB', fmtDb(sendDb))} testId="room-glue-send">
					<Slider
						label={t('Send level')}
						value={sendDb}
						min={-48}
						max={6}
						step={0.5}
						defaultValue={ROOM_GLUE_DEFAULT.sendDb}
						disabled={!on || readOnly}
						onChange={setSendDb}
					/>
				</Field>
				<Field label={t('Decay')} value={t('{0} s', decay.toFixed(2))} testId="room-glue-decay">
					<Slider
						label={t('Decay')}
						value={decay}
						min={0.1}
						max={4}
						step={0.05}
						defaultValue={ROOM_GLUE_DEFAULT.decay}
						disabled={!on || readOnly}
						onChange={setDecay}
					/>
				</Field>
				<Field label={t('Mix')} value={`${Math.round(mix)} %`} testId="room-glue-mix">
					<Slider
						label={t('Mix')}
						value={mix}
						min={0}
						max={100}
						step={1}
						defaultValue={ROOM_GLUE_DEFAULT.mix}
						disabled={!on || readOnly}
						onChange={setMix}
					/>
				</Field>
				<Field label={t('Pre-delay')} value={t('{0} ms', Math.round(preDelay))} testId="room-glue-predelay">
					<Slider
						label={t('Pre-delay')}
						value={preDelay}
						min={0}
						max={100}
						step={1}
						defaultValue={ROOM_GLUE_DEFAULT.preDelayMs}
						disabled={!on || readOnly}
						onChange={setPreDelay}
					/>
				</Field>
				<div className="flex flex-col gap-1 text-pr-small" data-testid="room-glue-tracks">
					<span className="text-pr-text">
						{summary.sends.length
							? t('Sends from: {0}', summary.sends.join(', '))
							: t('No track sends yet: place sound effects first')}
					</span>
					{summary.dry.map((d) => (
						<span key={d.track} className="text-pr-dim">
							{t('Dry: {0}', d.reason)}
						</span>
					))}
					{bus ? (
						<span className="text-pr-dim">
							{glue
								? t('Bus: {0} (made by sound design)', bus.name)
								: t('Bus: {0} (an existing submix, adopted)', bus.name)}
						</span>
					) : null}
				</div>
			</div>
		</Dialog>
	);
}

// ---------------------------------------------------------------------------------------------------------------
// Delivery Target…

type DeliveryOptions = { loudness: boolean; autoMatch: boolean; ducking: boolean; rebalance: boolean };

export function DeliveryDialog(
	props: HostedDialogProps<{
		session: EditorSession;
		engine: Pick<EngineClient, 'applyDelivery' | 'getJob' | 'cancelJob'>;
		sequenceId: string;
		toast?: (r: ToastRequest) => void;
	}>,
) {
	const { open, finish } = useDialogClose(props.close);
	const { session, sequenceId, engine } = props;
	const seq = session.getCommitted().sequences[sequenceId];
	const [preset, setPreset] = useState<SoundDelivery>(sequenceDelivery(seq));
	const [opts, setOpts] = useState<DeliveryOptions>({
		loudness: true,
		autoMatch: true,
		ducking: true,
		rebalance: true,
	});
	const [running, setRunning] = useState<{ progress: number | null; stage: string } | null>(null);
	const [message, setMessage] = useState<string | null>(null);
	const [result, setResult] = useState<
		(ReturnType<typeof deliverySummary> & { lines: string[]; notes: SoundNote[] }) | null
	>(null);
	const abort = useRef<AbortController | null>(null);
	useEffect(() => () => abort.current?.abort(), []);
	const readOnly = session.getState().readOnly;
	const p = DELIVERY_PRESETS[preset];

	const apply = async (): Promise<boolean> => {
		if (result) return true; // "Close" after a run
		if (!seq) return false;
		setMessage(null);
		const ac = new AbortController();
		abort.current = ac;
		setRunning({ progress: null, stage: t('Measuring the mix…') });
		try {
			const r = await runDelivery(
				engine,
				{ projectId: session.projectId, sequenceId, delivery: preset, ...opts },
				{ signal: ac.signal, onJob: (j) => setRunning({ progress: j.progress, stage: j.stage ?? j.title }) },
			);
			setRunning(null);
			const sum = deliverySummary(r);
			const m = r.report.measure;
			const lines: string[] = [];
			if (m) {
				if (m.mixLufs !== null)
					lines.push(
						t(
							'Mix before normalisation: {0} LUFS, {1} dBTP',
							fmtDb(m.mixLufs),
							m.mixTruePeakDb !== null ? fmtDb(m.mixTruePeakDb) : '–',
						),
					);
				if (m.expectedLufs !== null)
					lines.push(
						t(
							'Export: {0} LUFS, {1} dBTP',
							fmtDb(m.expectedLufs),
							m.expectedTruePeakDb !== null ? fmtDb(m.expectedTruePeakDb) : '–',
						),
					);
				lines.push(
					m.musicUnderVoiceLu !== null
						? t(
								'Music under the voice: {0} LU (at least {1})',
								m.musicUnderVoiceLu.toFixed(1),
								DELIVERY_RELATIVE_LU.music,
							)
						: t('Music under the voice: no speech or no music'),
				);
				if (m.ambienceUnderVoiceLu !== null)
					lines.push(
						t(
							'Ambience under the voice: {0} LU (at least {1})',
							m.ambienceUnderVoiceLu.toFixed(1),
							DELIVERY_RELATIVE_LU.ambience,
						),
					);
				lines.push(t('Speech found: {0} s', m.speechSeconds.toFixed(1)));
			}
			const matched = r.report.clips.filter((c) => c.gainDb !== null).length;
			lines.push(t('Auto-Matched clips: {0}; ducked groups: {1}', matched, r.report.ducking.length));
			if (r.report.sfx)
				lines.push(
					t('Sound effects re-solved: {0} changed, {1} limited', r.report.sfx.changed, r.report.sfx.limited),
				);
			// warnings in the UI language and, once the report carries them, the re-solved effects' conflicts
			const now = session.getCommitted();
			const notes = deliveryNotes(r, now, now.sequences[sequenceId]);
			setResult({ ...sum, lines, notes });
			const entry = entryOfRevision(session, r.revision);
			uiToast({
				kind: 'success',
				title: sum.title,
				...(sum.detail ? { detail: sum.detail } : {}),
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
			return false; // stay open with the report; the button becomes Close
		} catch (e) {
			setRunning(null);
			if (e instanceof SoundJobError && e.code === 'E_CANCELLED') return false;
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
			title="Delivery Target"
			size="medium"
			primaryLabel={result ? t('Close') : running ? t('Applying…') : t('Apply')}
			primaryDisabled={!result && (readOnly || !!running || !seq)}
			onPrimary={async () => {
				if (result) {
					finish();
					return true;
				}
				return apply();
			}}
			data-testid="delivery-dialog"
		>
			<div className="flex flex-col gap-3 text-pr-ui">
				<p className="text-pr-small text-pr-muted">
					Mixes the sequence to a loudness target: normalises the Mix, Auto-Matches dialogue, music and
					ambience by type, ducks the music under the voice and solves the sound effects again. One undo step.
				</p>
				<div className="flex items-center gap-2" data-testid="delivery-preset">
					<span className="w-[120px] shrink-0 text-pr-muted">Preset</span>
					<Select
						label="Preset"
						value={preset}
						disabled={!!running || !!result}
						onValueChange={(v) => setPreset(v as SoundDelivery)}
						options={DELIVERY_IDS.map((id) => ({
							value: id,
							label: deliveryOptionLabel(DELIVERY_PRESETS[id]),
						}))}
					/>
				</div>
				<dl
					className="grid grid-cols-[120px_1fr] gap-x-2 gap-y-1 text-pr-small"
					data-testid="delivery-numbers"
				>
					<dt className="text-pr-muted">{t('Integrated')}</dt>
					<dd className="pr-tabular">{t('{0} LUFS', fmtDb(p.integratedLufs))}</dd>
					<dt className="text-pr-muted">{t('True peak')}</dt>
					<dd className="pr-tabular">{t('{0} dBTP max', fmtDb(p.truePeakDb))}</dd>
					<dt className="text-pr-muted">{t('Under the voice')}</dt>
					<dd>
						{t(
							'music ≥ {0} LU, ambience ≥ {1} LU',
							DELIVERY_RELATIVE_LU.music,
							DELIVERY_RELATIVE_LU.ambience,
						)}
					</dd>
					<dt className="text-pr-muted">{t('Source')}</dt>
					<dd className="text-pr-dim">{t(p.source)}</dd>
				</dl>
				<fieldset className="flex flex-col gap-1" data-testid="delivery-options">
					<legend className="mb-1 text-pr-muted">Apply</legend>
					<Checkbox
						checked={opts.loudness}
						disabled={!!running || !!result}
						onCheckedChange={(v) => setOpts((o) => ({ ...o, loudness: v }))}
						label={t('Loudness normalisation of the Mix (preview and export)')}
					/>
					<Checkbox
						checked={opts.autoMatch}
						disabled={!!running || !!result}
						onCheckedChange={(v) => setOpts((o) => ({ ...o, autoMatch: v }))}
						label={t('Auto-Match dialogue, music and ambience by type')}
					/>
					<Checkbox
						checked={opts.ducking}
						disabled={!!running || !!result}
						onCheckedChange={(v) => setOpts((o) => ({ ...o, ducking: v }))}
						label={t('Duck music and ambience under the voice')}
					/>
					<Checkbox
						checked={opts.rebalance}
						disabled={!!running || !!result}
						onCheckedChange={(v) => setOpts((o) => ({ ...o, rebalance: v }))}
						label={t('Solve the sound effects again against the new bed')}
					/>
				</fieldset>
				<div aria-live="polite" className="flex flex-col gap-1 text-pr-small" data-testid="delivery-summary">
					{running ? (
						<span>{`${running.stage}${pct !== null ? ` · ${pct} %` : ''}`}</span>
					) : result ? (
						<>
							<span className="text-pr-text">{result.title}</span>
							{result.lines.map((l) => (
								<span key={l} className="text-pr-muted">
									{l}
								</span>
							))}
							<SoundNotesList notes={result.notes} testId="delivery-notes" />
						</>
					) : message ? (
						<span className="text-pr-warning">{message}</span>
					) : null}
				</div>
				{running ? (
					<div
						className="h-1 w-full overflow-hidden rounded-pr-pill bg-pr-field"
						role="progressbar"
						aria-label={t('Applying the delivery target')}
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={pct ?? undefined}
						data-testid="delivery-progress"
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
