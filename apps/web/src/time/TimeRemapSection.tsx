import type { CommandInput } from '@jasper/project';
// Time Remapping changes the picture while linked audio remains unchanged.
import {
	activeRemap,
	type Clip,
	clipSpeedAt,
	type Rational,
	remapKeyViews,
	type Sequence,
	type TimedClip,
	type TimeInterpolation,
	timeInterpolationOf,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useDocument } from '@jasper/session/react';
import { Button, ScrubbyNumber, Select, Toggle } from '@jasper/ui';
import { isBandShown, setBandShown, useBandVersion } from './store.ts';

export const INTERPOLATION_OPTIONS: { value: TimeInterpolation; label: string }[] = [
	{ value: 'frame-sampling', label: 'Frame Sampling' },
	{ value: 'frame-blending', label: 'Frame Blending' },
	{ value: 'optical-flow', label: 'Optical Flow' },
];

function seqOf(session: EditorSession, clipId: string): Sequence | null {
	for (const s of Object.values(session.getCommitted().sequences)) if (s.clips[clipId]) return s as Sequence;
	return null;
}

export function TimeRemapSection(props: { session: EditorSession; clipId: string; frame: number }) {
	const { session, clipId, frame } = props;
	useBandVersion();
	const clip = useDocument((d) => {
		for (const s of Object.values(d.sequences)) if (s.clips[clipId]) return s.clips[clipId] as Clip;
		return null;
	});
	const seq = seqOf(session, clipId);
	if (!clip || !seq) return null;
	const c = clip as Clip & TimedClip;
	const rate = seq.settings.frameRate as Rational;
	const readOnly = session.getState().readOnly;
	const remap = activeRemap(c);
	const inside = frame >= c.start && frame < c.start + c.duration;
	const speed = clipSpeedAt(c, inside ? frame : c.start, rate);
	const keys = remapKeyViews(c, rate);
	const apply = (label: string, commands: CommandInput[]) =>
		session.apply({ label, origin: 'user', sequenceId: seq.id, commands });
	const seek = (f: number) => session.transport.seek(Math.round(f));
	const prev = [...keys].reverse().find((k) => k.frame < frame - 0.5);
	const next = keys.find((k) => k.frame > frame + 0.5);
	const atKey = keys.find((k) => Math.abs(k.frame - frame) < 0.5);
	const linkedAudio = c.linkId
		? (seq.links[c.linkId]?.members ?? [])
				.map((id) => seq.clips[id])
				.filter((x): x is Clip => !!x && x.kind === 'audio')
		: [];
	const fps = rate.num / rate.den;
	return (
		<div className="flex flex-col gap-1 px-2 py-1 text-pr-ui" data-testid="time-remap-section">
			<div className="flex items-center gap-2">
				<Toggle
					checked={!!remap}
					label="Time Remapping"
					disabled={readOnly || c.speed.reverse}
					onCheckedChange={(on) => {
						apply(on ? 'Time Remapping' : 'Remove Time Remapping', [
							{ type: 'timeRemap.enable', clipIds: [c.id], enabled: on },
						]);
						setBandShown([c.id], on);
					}}
				/>
				<span className="w-[56px] text-pr-muted">Speed</span>
				<ScrubbyNumber
					label="Speed"
					unit="%"
					value={Math.round(speed * 10000) / 100}
					precision={2}
					min={0.01}
					max={20000}
					disabled={readOnly || !inside || speed === 0 || c.speed.reverse}
					onCommit={(v) =>
						apply('Change Speed', [
							{ type: 'timeRemap.setSpeed', clipId: c.id, at: frame, speedPercent: Math.abs(v) },
						])
					}
				/>
			</div>
			<div className="flex items-center gap-1">
				<Button
					variant="quiet"
					disabled={!prev}
					onClick={() => prev && seek(prev.frame)}
					data-testid="speed-key-prev"
				>
					◀
				</Button>
				<Button
					variant="quiet"
					disabled={readOnly || !inside || c.speed.reverse}
					onClick={() =>
						atKey
							? apply('Delete Speed Keyframes', [
									{ type: 'timeRemap.removeKeyframes', clipId: c.id, keyframeIds: [atKey.id] },
								])
							: apply('Add Speed Keyframe', [{ type: 'timeRemap.addKeyframe', clipId: c.id, at: frame }])
					}
					data-testid="speed-key-toggle"
				>
					{atKey ? 'Remove Keyframe' : 'Add Keyframe'}
				</Button>
				<Button
					variant="quiet"
					disabled={!next}
					onClick={() => next && seek(next.frame)}
					data-testid="speed-key-next"
				>
					▶
				</Button>
				<span className="flex-1" />
				<Toggle
					checked={isBandShown(c.id) || !!remap}
					label="Show speed band"
					disabled={!!remap}
					onCheckedChange={(on) => setBandShown([c.id], on)}
				/>
			</div>
			{keys.length > 0 ? (
				<table className="w-full text-pr-small" data-testid="speed-keys">
					<thead>
						<tr className="text-pr-muted">
							<th className="text-left font-normal">Keyframe</th>
							<th className="text-left font-normal">Source</th>
							<th className="text-left font-normal">Transition</th>
							<th />
						</tr>
					</thead>
					<tbody>
						{keys.map((k) => (
							<tr key={k.id}>
								<td>
									<button type="button" className="text-pr-value" onClick={() => seek(k.frame)}>
										{Math.round(k.frame - c.start)} f
									</button>
								</td>
								<td>{(Math.round(k.mediaSeconds * fps * 100) / 100).toFixed(2)} f</td>
								<td>
									<ScrubbyNumber
										label="Speed transition frames"
										value={Math.round(k.rampFrames * 2 * 100) / 100}
										precision={0}
										min={0}
										max={10000}
										unit="f"
										disabled={readOnly}
										onCommit={(v) =>
											apply('Speed Transition', [
												{ type: 'timeRemap.setTransition', clipId: c.id, keyframeId: k.id, frames: v },
											])
										}
									/>
								</td>
								<td>
									<Button
										variant="quiet"
										disabled={readOnly}
										onClick={() =>
											apply('Delete Speed Keyframes', [
												{ type: 'timeRemap.removeKeyframes', clipId: c.id, keyframeIds: [k.id] },
											])
										}
									>
										✕
									</Button>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			) : null}
			{c.kind === 'video' ? (
				<div className="flex items-center gap-2">
					<span className="w-[120px] text-pr-muted">Time Interpolation</span>
					<Select
						value={timeInterpolationOf(c)}
						options={INTERPOLATION_OPTIONS}
						label="Time Interpolation"
						disabled={readOnly}
						onValueChange={(v) =>
							apply('Time Interpolation', [
								{ type: 'clip.setTimeInterpolation', clipIds: [c.id], mode: v as TimeInterpolation },
							])
						}
					/>
				</div>
			) : null}
			{remap && linkedAudio.length > 0 ? (
				<div className="flex items-center gap-2 text-pr-small text-pr-warning" data-testid="remap-audio-note">
					<span className="flex-1">
						The linked audio is not time-remapped: it plays at 100 % and drifts out of sync.
					</span>
					<Button
						variant="quiet"
						disabled={readOnly}
						onClick={() =>
							apply('Mute Linked Audio', [
								{ type: 'clip.update', clipIds: linkedAudio.map((x) => x.id), patch: { enabled: false } },
							])
						}
					>
						Mute
					</Button>
					<Button
						variant="quiet"
						disabled={readOnly}
						onClick={() => apply('Unlink', [{ type: 'clip.unlink', clipIds: [c.id] }])}
					>
						Unlink
					</Button>
				</div>
			) : null}
			{c.speed.reverse ? (
				<p className="text-pr-small text-pr-muted">
					Reverse Speed is on (Speed/Duration): turn it off to use Time Remapping (reverse segments play
					backward).
				</p>
			) : null}
			{remap && keys.length === 0 ? (
				<p className="text-pr-small text-pr-muted">
					Drag the speed band on the clip to change the speed; Ctrl/Cmd-click it to add a keyframe.
				</p>
			) : null}
		</div>
	);
}
