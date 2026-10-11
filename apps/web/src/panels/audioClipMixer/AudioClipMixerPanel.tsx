import type { CommandOf } from '@jasper/project';
// Audio Clip Mixer (audio-mix; Premiere Window ▸ Audio Clip Mixer, Shift+9): one strip per audio track showing the
// clip under the playhead — its Volume level (fader) and Panner balance (knob), with the track's M / S and meter.
// Moves are heard at once; while paused a release writes the clip's value (a keyframe at the playhead when the clip
// is keyframed), during playback the track's Clip Mixer automation mode records clip keyframes (`clipMixer.write`).
import { AUTOMATION_MODES, flicksPerFrame, listStrips, type Rational, type Sequence } from '@jasper/project';
import type { EditorSession, SessionState } from '@jasper/session';
import { useSessionOrNull, useStoreSelector, useTransportFrame } from '@jasper/session/react';
import { EmptyState, Select } from '@jasper/ui';
import { useEffect, useReducer } from 'react';
import {
	CLIP_LANE_PAN,
	CLIP_LANE_VOLUME,
	clipLaneValue,
	mixerControllerFor,
} from '../../audio/automation.ts';
import { dbText, Fader, Knob } from '../../audio/components/controls.tsx';
import { LevelMeter } from '../../audio/components/LevelMeter.tsx';
import { useMeterReading, useMixGraph } from '../../audio/runtime.ts';
import { MODE_LABELS } from '../mixer-labels.ts';
import { EMPTY_SESSION_STORE } from '../session-store.ts';
import type { PanelProps } from '../types.ts';

export function AudioClipMixerPanel(_props: PanelProps) {
	const session = useSessionOrNull();
	const seq = useStoreSelector(session?.store ?? EMPTY_SESSION_STORE, (s: SessionState | null) =>
		s?.activeSequenceId ? ((s.document.sequences[s.activeSequenceId] as Sequence | undefined) ?? null) : null,
	);
	if (!session) return <EmptyState icon="panel.audioClipMixer" message="Open a project to mix its clips" />;
	if (!seq) return <EmptyState icon="panel.audioClipMixer" message="Open a sequence to mix its clips" />;
	return <ClipMixer session={session} seq={seq} />;
}

function ClipMixer({ session, seq }: { session: EditorSession; seq: Sequence }) {
	const ctl = mixerControllerFor(session);
	const [, force] = useReducer((x: number) => x + 1, 0);
	useEffect(() => ctl.onChange(force), [ctl]);
	const transport = useTransportFrame(50);
	const F = flicksPerFrame(seq.settings.frameRate as Rational);
	const t = transport.playing ? ctl.now() : transport.frame * F;
	const tracks = listStrips(seq).filter((s) => s.kind === 'track');
	return (
		<div className="flex h-full min-h-0 overflow-x-auto" data-testid="audio-clip-mixer">
			{tracks.map((s) => (
				<ClipStrip
					key={s.id}
					session={session}
					seq={seq}
					trackId={s.id}
					label={s.label}
					name={s.name}
					mute={s.mute}
					solo={s.solo}
					stereo={s.format !== 'mono'}
					t={t}
				/>
			))}
		</div>
	);
}

function ClipStrip(props: {
	session: EditorSession;
	seq: Sequence;
	trackId: string;
	label: string;
	name: string;
	mute: boolean;
	solo: boolean;
	stereo: boolean;
	t: number;
}) {
	const { session, seq, trackId, t } = props;
	const ctl = mixerControllerFor(session);
	const graph = useMixGraph();
	const reading = useMeterReading(graph, trackId);
	const volUnder = clipLaneValue(seq, trackId, CLIP_LANE_VOLUME, t);
	const hasClip = volUnder !== null;
	const vol = ctl.isHeld(trackId, CLIP_LANE_VOLUME)
		? ctl.displayValue(trackId, CLIP_LANE_VOLUME, t)
		: (volUnder ?? 0);
	const pan = ctl.isHeld(trackId, CLIP_LANE_PAN)
		? ctl.displayValue(trackId, CLIP_LANE_PAN, t)
		: (clipLaneValue(seq, trackId, CLIP_LANE_PAN, t) ?? 0);
	const mode = seq.audioTracks.find((x) => x.id === trackId)?.mixer?.clipAutomation ?? 'read';
	const update = (patch: CommandOf<'mixer.updateStrip'>['patch'], label: string) =>
		session.apply({
			label,
			origin: 'user',
			commands: [{ type: 'mixer.updateStrip', sequenceId: seq.id, stripId: trackId, patch }],
		});
	return (
		<div
			className="flex h-full w-[76px] shrink-0 flex-col items-center gap-1 border-r border-pr-border-subtle px-1 py-1"
			data-testid={`clip-mixer-strip-${props.label}`}
		>
			<Select
				label={`${props.label} clip automation mode`}
				value={mode}
				onValueChange={(value) => {
					const clipAutomation = AUTOMATION_MODES.find((mode) => mode === value);
					if (clipAutomation) update({ clipAutomation }, 'Clip Mixer Mode');
				}}
				options={AUTOMATION_MODES.map((m) => ({ value: m, label: MODE_LABELS[m] }))}
			/>
			<div className="flex-1" />
			{props.stereo ? (
				<div className="flex flex-col items-center">
					<Knob
						label={`${props.label} clip balance`}
						value={pan}
						disabled={!hasClip}
						onTouch={(v) => ctl.touch(trackId, CLIP_LANE_PAN, v)}
						onRelease={() => ctl.release(trackId, CLIP_LANE_PAN)}
					/>
					<span className="text-[10px] text-pr-value pr-tabular">{Math.round(pan)}</span>
				</div>
			) : null}
			<div className="flex gap-0.5">
				<button
					type="button"
					aria-pressed={props.mute}
					className={`h-[18px] w-[18px] rounded-pr-control text-[10px] font-semibold ${props.mute ? '' : 'text-pr-muted hover:bg-pr-hover'}`}
					style={
						props.mute ? { background: 'var(--pr-track-mute)', color: 'var(--pr-on-accent)' } : undefined
					}
					onClick={() => update({ mute: !props.mute }, props.mute ? 'Unmute Track' : 'Mute Track')}
				>
					M
				</button>
				<button
					type="button"
					aria-pressed={props.solo}
					className={`h-[18px] w-[18px] rounded-pr-control text-[10px] font-semibold ${props.solo ? '' : 'text-pr-muted hover:bg-pr-hover'}`}
					style={
						props.solo
							? { background: 'var(--pr-track-solo)', color: 'var(--pr-track-solo-text)' }
							: undefined
					}
					onClick={() => update({ solo: !props.solo }, props.solo ? 'Unsolo Track' : 'Solo Track')}
				>
					S
				</button>
			</div>
			<div className="flex h-[160px] shrink-0 gap-1.5">
				<Fader
					label={`${props.label} clip volume`}
					value={vol}
					disabled={!hasClip}
					onTouch={(v) => ctl.touch(trackId, CLIP_LANE_VOLUME, v)}
					onRelease={() => ctl.release(trackId, CLIP_LANE_VOLUME)}
					data-testid="clip-mixer-fader"
				/>
				<LevelMeter reading={reading} channels={2} barWidth={4} gap={1} />
			</div>
			<div className="text-[10px] text-pr-value pr-tabular">{hasClip ? `${dbText(vol)} dB` : '—'}</div>
			<div
				className="w-full truncate rounded-[2px] bg-pr-field px-1 text-center text-[11px]"
				title={props.name}
			>
				{props.label} {props.name}
			</div>
		</div>
	);
}
