// Essential Sound ▸ Sound Design, the Phase 4 rows (spec 12 §2.7 "Essential Sound SFX additions": Auto gain with its
// reason, Room send, Stop before next; P4-R5; wp-note "Phase 4 → WP4.2b"):
// - Auto gain (masking-aware): on while the default level or the masking solver owns the gain; the level record with
//   its badge and why ("−3.0 dB · limited by dialogue A1"). Off keeps the current gain as the user's own
//   (`soundDesign.setAutoGain`); on solves the clips again (`sound.setAutoGain` → the engine's rebalance, named clips).
//   Rebalance solves the selection's automatic gains (`sound.rebalanceSfx`, a job; one undo step).
// - Room: the selected clips' tracks' sends to the "SFX Room" bus (sends are per track: the row names the tracks). On
//   creates the glue when there is none (`soundDesign.ensureBus`), else adds or unmutes each track's send; off mutes
//   them; the slider sets their level (`mixer.updateSend`, one undo step per drag). With several tracks the toggle is
//   mixed while their sends differ and the level reads "Mixed" while their levels differ; a gesture acts on every
//   track that can send, in ONE transaction. Interface-only tracks and tracks that also play bed audio cannot send:
//   they are listed with the reason and skipped.
// - Stop before next / Build: the cue the selected sounds fill, edited like Properties ▸ Cue; sounds of different cues
//   (or some of no cue) show the state over their cues, disabled, with why (a stop-before is a cue's own).
import type { AudioClip, Command, Sequence } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { Button, Checkbox, cx, Slider, toast } from '@jasper/ui';
import { runCommand } from '../commands/registry.ts';
import { t } from '../i18n/runtime.ts';
import { useInspectorOps } from '../panels/properties/lib/ops.ts';
import { useShellRuntimeOrNull } from '../shell/context.tsx';
import { BuildEditor, StopBeforeEditor } from './MixFields.tsx';
import {
	cueSelectionOf,
	fmtDb,
	levelSelectionOf,
	type RoomSelection,
	type RoomView,
	roomLevelCommands,
	roomSelectionOf,
	roomToggleEdit,
	sfxLevelView,
} from './mix-model.ts';

const ROOM_MIN_DB = -48;
const ROOM_MAX_DB = 6;

function Label({ children }: { children: string }) {
	return <span className="w-16 shrink-0 pt-[2px] text-pr-small text-pr-muted">{children}</span>;
}

export function EssentialSfxMix(props: { session: EditorSession; seq: Sequence; clips: AudioClip[] }) {
	const { session, seq, clips } = props;
	const runtime = useShellRuntimeOrNull();
	const ops = useInspectorOps(session);
	const doc = session.getCommitted();
	const readOnly = session.getState().readOnly;
	const first = clips[0];
	if (!first) return null;
	const run = (id: string, args?: unknown) => {
		const ctx = runtime?.getCtx();
		if (ctx) void runCommand(id, ctx, args);
		else toast({ kind: 'warning', title: t('The editor is not ready') });
	};
	const apply = (label: string, commands: Command[]) => {
		const r = session.apply({ label, origin: 'user', sequenceId: seq.id, commands });
		if (!r.ok) toast({ kind: 'warning', title: r.errors[0]?.message ?? t('Edit failed') });
		return r.ok;
	};

	// ---- Auto gain
	const level = levelSelectionOf(clips);
	const views = level?.views ?? [];
	const autoCount = views.filter((v) => v.auto).length;
	const autoState: boolean | 'mixed' = autoCount === 0 ? false : autoCount === views.length ? true : 'mixed';
	const autoIds = clips.filter((c) => sfxLevelView(c)?.auto).map((c) => c.id);

	// ---- Room (sends are per track: every selected clip's track that can send)
	const room = roomSelectionOf(doc, seq, clips);
	const roomDb = room?.levelDb ?? room?.levels[0] ?? room?.glue?.sendDb ?? -16;
	const roomMixedLevel = !!room && room.levels.length > 1;
	const levelTargets = room ? room.on.filter((v) => v.levelDb !== null).length : 0;
	const setRoom = (on: boolean) => {
		if (!room) return;
		const edit = roomToggleEdit(seq, room, on);
		if (!edit) return;
		if (apply(edit.label, edit.commands) && edit.commands[0]?.type === 'soundDesign.ensureBus') {
			// the glue sends from the tracks that qualify: say so when a selected one still does not
			const after = session.getCommitted().sequences[seq.id];
			const now = after ? roomSelectionOf(session.getCommitted(), after, clips) : null;
			const dry = now ? now.targets.filter((v) => !v.send) : [];
			if (dry.length)
				toast({
					kind: 'info',
					title: t('The room was created; {0} does not send to it', dry.map((v) => v.trackLabel).join(', ')),
				});
		}
	};

	// ---- Stop before / build (the cue the selected sounds fill)
	const cueSel = cueSelectionOf(seq, clips);

	return (
		<div className="flex flex-col gap-2" data-testid="essential-sfx-mix">
			<div className="flex items-start gap-2" data-testid="essential-auto-gain">
				<Label>{t('Gain')}</Label>
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<Checkbox
						checked={autoState}
						disabled={readOnly || views.length === 0}
						label={t('Auto gain (masking-aware)')}
						onCheckedChange={(on) => run('sound.setAutoGain', { clipIds: clips.map((c) => c.id), auto: on })}
					/>
					{level ? (
						<div
							className="flex min-w-0 items-start gap-1 text-pr-small"
							data-testid="essential-auto-gain-level"
						>
							<span
								className={cx(
									'shrink-0 rounded-[2px] border px-1 leading-[14px]',
									level.owner === 'default' || level.owner === 'solver'
										? 'border-pr-accent text-pr-accent'
										: 'border-pr-border-strong text-pr-muted',
								)}
								data-owner={level.owner}
							>
								{level.badge}
							</span>
							<span
								className="min-w-0 break-words text-pr-text"
								title={level.text}
								data-testid="essential-auto-gain-text"
							>
								{level.text}
							</span>
						</div>
					) : null}
					{level?.lift ? (
						<span className="text-pr-small text-pr-dim" data-testid="essential-auto-gain-lift">
							{t(
								'Lift over the bed {0} dB of {1} dB',
								fmtDb(level.lift.achievedDb),
								fmtDb(level.lift.targetDb),
							)}
						</span>
					) : null}
					{clips.length > 1 ? (
						<span className="text-pr-small text-pr-dim">
							{t('{0} of {1} selected sounds on auto gain', autoCount, views.length)}
						</span>
					) : null}
					<div>
						<Button
							variant="secondary"
							disabled={readOnly || autoIds.length === 0}
							title={
								autoIds.length === 0
									? t('Turn Auto gain on to rebalance these sounds')
									: t('Solve the selected sounds against the bed again')
							}
							onClick={() => run('sound.rebalanceSfx', { clipIds: autoIds })}
							data-testid="essential-rebalance"
						>
							Rebalance
						</Button>
					</div>
				</div>
			</div>
			<div className="flex items-start gap-2" data-testid="essential-room">
				<Label>{t('Room')}</Label>
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					{room ? (
						<>
							<Checkbox
								checked={room.state}
								disabled={readOnly || room.targets.length === 0}
								label={t('Send {0} to the SFX Room', room.label)}
								onCheckedChange={setRoom}
							/>
							<div className="flex items-center gap-2">
								<Slider
									className="min-w-0 flex-1"
									label={t('Room send level of {0}', room.label)}
									valueText={
										roomMixedLevel
											? t('Mixed: {0} to {1} dB', fmtDb(room.levels[0]!), fmtDb(room.levels.at(-1)!))
											: t('{0} dB', fmtDb(roomDb))
									}
									value={Math.max(ROOM_MIN_DB, Math.min(ROOM_MAX_DB, roomDb))}
									min={ROOM_MIN_DB}
									max={ROOM_MAX_DB}
									step={0.5}
									defaultValue={-16}
									disabled={readOnly || levelTargets === 0}
									onChangeStart={() => ops.scrub.start(t('Room Send Level'))}
									onChange={(db) => {
										const cmds = roomLevelCommands(seq, room, db);
										if (cmds.length && !ops.scrub.update(cmds)) apply(t('Room Send Level'), cmds);
									}}
									onCommit={() => ops.scrub.end(false)}
								/>
								<span
									className="w-14 text-right text-pr-small pr-tabular"
									data-testid="essential-room-db"
									data-mixed={roomMixedLevel || room.state === 'mixed' ? 'true' : undefined}
								>
									{room.on.length === 0
										? t('Off')
										: roomMixedLevel
											? t('Mixed')
											: room.levelDb === null
												? '–'
												: t('{0} dB', fmtDb(room.levelDb))}
								</span>
							</div>
							{room.targets.length > 1 && (room.state === 'mixed' || roomMixedLevel) ? (
								<span className="text-pr-small text-pr-muted" data-testid="essential-room-tracks">
									{room.targets.map((v) => roomTrackState(v)).join(' · ')}
								</span>
							) : null}
							<span className="text-pr-small text-pr-dim" data-testid="essential-room-note">
								{roomNote(room)}
							</span>
							{room.targets.length > 0
								? room.blocked.map((v) => (
										<span
											key={v.trackId}
											className="text-pr-small text-pr-dim"
											data-testid="essential-room-skipped"
										>
											{t('Skipped: {0}', v.blocked ?? '')}
										</span>
									))
								: null}
							{room.automated.map((v) => (
								<span
									key={v.trackId}
									className="text-pr-small text-pr-dim"
									data-testid="essential-room-automated"
								>
									{t('{0}: automated in the Audio Track Mixer', v.trackLabel)}
								</span>
							))}
						</>
					) : (
						<span className="text-pr-small text-pr-dim">{t('Not on an audio track')}</span>
					)}
				</div>
			</div>
			<div className="flex items-start gap-2" data-testid="essential-stop-before">
				<Label>{t('Stop')}</Label>
				<div className="min-w-0 flex-1">
					{cueSel.kind === 'one' ? (
						<StopBeforeEditor
							session={session}
							seq={seq}
							cue={cueSel.cue}
							readOnly={readOnly}
							testId="essential-stop"
						/>
					) : cueSel.kind === 'mixed' ? (
						<MixedCues
							state={cueSel.state.stopBefore}
							label={t('Stop before next (dip the music before the cue)')}
							reason={cueSel.reason}
							testId="essential-stop-mixed"
						/>
					) : (
						<NoCue />
					)}
				</div>
			</div>
			<div className="flex items-start gap-2" data-testid="essential-build-row">
				<Label>{t('Build')}</Label>
				<div className="min-w-0 flex-1">
					{cueSel.kind === 'one' ? (
						<BuildEditor
							session={session}
							seq={seq}
							cue={cueSel.cue}
							readOnly={readOnly}
							testId="essential-build"
						/>
					) : cueSel.kind === 'mixed' ? (
						<MixedCues
							state={cueSel.state.build}
							label={t('Build (a rising high-pass on the music into the cue)')}
							reason={cueSel.reason}
							testId="essential-build-mixed"
						/>
					) : (
						<NoCue />
					)}
				</div>
			</div>
		</div>
	);
}

/** One track of a mixed Room row: "A2 −16.0 dB", "A3 off", "A4 automated". */
function roomTrackState(v: RoomView): string {
	if (!v.send || v.send.mute) return t('{0} off', v.trackLabel);
	return v.levelDb === null
		? t('{0} automated', v.trackLabel)
		: t('{0} {1} dB', v.trackLabel, fmtDb(v.levelDb));
}

/** What the Room row says under the slider: where the sends apply, or why none can be made. */
function roomNote(room: RoomSelection): string {
	if (room.targets.length === 0)
		return room.blocked.map((v) => v.blocked).join(' · ') || t('Not on an audio track');
	const names = room.targets.map((v) => v.trackLabel);
	return names.length === 1
		? t('Applies to the whole track {0}, not only this clip', names[0]!)
		: t('Applies to the whole tracks {0}, not only these clips', names.join(', '));
}

/** Stop / Build for sounds of different cues: the state over their cues, disabled, with why. */
function MixedCues(props: { state: boolean | 'mixed'; label: string; reason: string; testId: string }) {
	return (
		<div className="flex flex-col gap-1" data-testid={props.testId}>
			<Checkbox checked={props.state} disabled label={props.label} onCheckedChange={() => {}} />
			<span className="pl-5 text-pr-small text-pr-dim" data-testid={`${props.testId}-reason`}>
				{props.reason}
			</span>
		</div>
	);
}

function NoCue() {
	return (
		<div className="flex flex-col gap-1">
			<Checkbox checked={false} disabled label={t('Off')} onCheckedChange={() => {}} />
			<span className="text-pr-small text-pr-dim" data-testid="essential-no-cue">
				{t('This sound fills no cue: stop-before and build belong to a cue (fill a cue or add one)')}
			</span>
		</div>
	);
}
