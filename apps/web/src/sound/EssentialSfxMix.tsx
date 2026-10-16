// Essential Sound ▸ Sound Design, the Phase 4 rows (spec 12 §2.7 "Essential Sound SFX additions": Auto gain with its
// reason, Room send, Stop before next; P4-R5; wp-note "Phase 4 → WP4.2b"):
// - Auto gain (masking-aware): on while the default level or the masking solver owns the gain; the level record with
//   its badge and why ("−3.0 dB · limited by dialogue A1"). Off keeps the current gain as the user's own
//   (`soundDesign.setAutoGain`); on solves the clips again (`sound.setAutoGain` → the engine's rebalance, named clips).
//   Rebalance solves the selection's automatic gains (`sound.rebalanceSfx`, a job; one undo step).
// - Room: the clip's track send to the "SFX Room" bus (sends are per track: the row names the track). On creates the
//   glue when there is none (`soundDesign.ensureBus`), else adds or unmutes the track's send; off mutes it; the slider
//   sets its level (`mixer.updateSend`, one undo step per drag). Interface-only tracks and tracks that also play bed
//   audio cannot send (the reason is shown).
// - Stop before next / Build: the linked cue's (the cue the clip fills), edited like Properties ▸ Cue.
import type { AudioClip, Command, Sequence } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { Button, Checkbox, cx, Slider, toast } from '@jasper/ui';
import { runCommand } from '../commands/registry.ts';
import { t } from '../i18n/runtime.ts';
import { useInspectorOps } from '../panels/properties/lib/ops.ts';
import { useShellRuntimeOrNull } from '../shell/context.tsx';
import { cueOfClip } from './design-model.ts';
import { BuildEditor, StopBeforeEditor } from './MixFields.tsx';
import { fmtDb, roomViewOf, sfxLevelView } from './mix-model.ts';

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
	const views = clips.map((c) => sfxLevelView(c)).filter((v) => !!v);
	const autoCount = views.filter((v) => v.auto).length;
	const autoState: boolean | 'mixed' = autoCount === 0 ? false : autoCount === views.length ? true : 'mixed';
	const v0 = sfxLevelView(first);
	const autoIds = clips.filter((c) => sfxLevelView(c)?.auto).map((c) => c.id);

	// ---- Room
	const room = roomViewOf(doc, seq, first);
	const roomOn = !!room?.send && !room.send.mute;
	const roomDb = room?.levelDb ?? room?.glue?.sendDb ?? -16;
	const setRoom = (on: boolean) => {
		if (!room) return;
		if (!on) {
			if (room.send)
				apply(t('Room Send Off'), [
					{
						type: 'mixer.updateSend',
						sequenceId: seq.id,
						stripId: room.trackId,
						sendId: room.send.id,
						patch: { mute: true },
					} as Command,
				]);
			return;
		}
		if (room.send) {
			apply(t('Room Send On'), [
				{
					type: 'mixer.updateSend',
					sequenceId: seq.id,
					stripId: room.trackId,
					sendId: room.send.id,
					patch: { mute: false },
				} as Command,
			]);
			return;
		}
		if (!room.bus) {
			// no room yet: the glue (bus, reverb, sends from every sound-effect track that qualifies)
			if (apply(t('SFX Room Glue'), [{ type: 'soundDesign.ensureBus', sequenceId: seq.id } as Command])) {
				const after = session.getCommitted().sequences[seq.id];
				const now = after?.clips[first.id];
				if (after && now && !roomViewOf(session.getCommitted(), after, now)?.send)
					toast({ kind: 'info', title: t('The room was created; {0} does not send to it', room.trackLabel) });
			}
			return;
		}
		apply(t('Room Send On'), [
			{
				type: 'mixer.addSend',
				sequenceId: seq.id,
				stripId: room.trackId,
				target: room.bus.id,
				levelDb: room.glue?.sendDb ?? -16,
			} as Command,
		]);
	};
	const sendCmd = (db: number): Command[] =>
		room?.send
			? [
					{
						type: 'mixer.updateSend',
						sequenceId: seq.id,
						stripId: room.trackId,
						sendId: room.send.id,
						patch: { levelDb: db },
					} as Command,
				]
			: [];

	// ---- Stop before / build (the linked cue)
	const cue = cueOfClip(seq, first);

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
					{v0 ? (
						<div
							className="flex min-w-0 items-start gap-1 text-pr-small"
							data-testid="essential-auto-gain-level"
						>
							<span
								className={cx(
									'shrink-0 rounded-[2px] border px-1 leading-[14px]',
									v0.auto ? 'border-pr-accent text-pr-accent' : 'border-pr-border-strong text-pr-muted',
								)}
								data-owner={v0.owner}
							>
								{v0.badge}
							</span>
							<span
								className="min-w-0 break-words text-pr-text"
								title={v0.text}
								data-testid="essential-auto-gain-text"
							>
								{v0.text}
							</span>
						</div>
					) : null}
					{v0 && v0.targetLiftDb !== null && v0.achievedLiftDb !== null ? (
						<span className="text-pr-small text-pr-dim" data-testid="essential-auto-gain-lift">
							{t('Lift over the bed {0} dB of {1} dB', fmtDb(v0.achievedLiftDb), fmtDb(v0.targetLiftDb))}
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
								checked={roomOn}
								disabled={readOnly || (!room.send && !!room.blocked)}
								label={t('Send {0} to the SFX Room', room.trackLabel)}
								onCheckedChange={setRoom}
							/>
							<div className="flex items-center gap-2">
								<Slider
									className="min-w-0 flex-1"
									label={t('Room send level of {0}', room.trackLabel)}
									valueText={t('{0} dB', fmtDb(roomDb))}
									value={Math.max(ROOM_MIN_DB, Math.min(ROOM_MAX_DB, roomDb))}
									min={ROOM_MIN_DB}
									max={ROOM_MAX_DB}
									step={0.5}
									defaultValue={-16}
									disabled={readOnly || !roomOn || room.levelDb === null}
									onChangeStart={() => ops.scrub.start(t('Room Send Level'))}
									onChange={(db) => {
										const cmds = sendCmd(db);
										if (cmds.length && !ops.scrub.update(cmds)) apply(t('Room Send Level'), cmds);
									}}
									onCommit={() => ops.scrub.end(false)}
								/>
								<span className="w-14 text-right text-pr-small pr-tabular" data-testid="essential-room-db">
									{roomOn ? t('{0} dB', fmtDb(roomDb)) : t('Off')}
								</span>
							</div>
							<span className="text-pr-small text-pr-dim" data-testid="essential-room-note">
								{room.send || !room.blocked
									? room.levelDb === null && room.send
										? t('{0}: automated in the Audio Track Mixer', room.trackLabel)
										: t('Applies to the whole track {0}, not only this clip', room.trackLabel)
									: room.blocked}
							</span>
						</>
					) : (
						<span className="text-pr-small text-pr-dim">{t('Not on an audio track')}</span>
					)}
				</div>
			</div>
			<div className="flex items-start gap-2" data-testid="essential-stop-before">
				<Label>{t('Stop')}</Label>
				<div className="min-w-0 flex-1">
					{cue ? (
						<StopBeforeEditor
							session={session}
							seq={seq}
							cue={cue}
							readOnly={readOnly}
							testId="essential-stop"
						/>
					) : (
						<NoCue />
					)}
				</div>
			</div>
			<div className="flex items-start gap-2" data-testid="essential-build-row">
				<Label>{t('Build')}</Label>
				<div className="min-w-0 flex-1">
					{cue ? (
						<BuildEditor session={session} seq={seq} cue={cue} readOnly={readOnly} testId="essential-build" />
					) : (
						<NoCue />
					)}
				</div>
			</div>
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
