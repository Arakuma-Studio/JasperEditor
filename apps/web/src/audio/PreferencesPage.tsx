// Preferences ▸ Audio (audio-mix; Premiere Preferences ▸ Audio, Audio Hardware and Voice-Over Record Settings):
// scrubbing, the 5.1 mixdown of the monitor, automation keyframe options, and the voice-over input device, channel,
// file name, countdown cues and pre-/post-roll.
import { Checkbox, ScrubbyNumber, Select, TextField } from '@jasper/ui';
import { useEffect, useState } from 'react';
import { PrefGroup, PrefRow } from '../shell/preferences/GeneralPage.tsx';
import { audioPrefs, type MixdownType, useAudioPrefs } from './prefs.ts';

function useInputDevices(): { devices: MediaDeviceInfo[]; error: string | null; refresh(): void } {
	const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [nonce, setNonce] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `nonce` re-lists the devices on demand
	useEffect(() => {
		let off = false;
		const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
		if (!md?.enumerateDevices) {
			setError('This browser cannot list audio inputs');
			return;
		}
		void md
			.enumerateDevices()
			.then((list) => {
				if (!off) setDevices(list.filter((d) => d.kind === 'audioinput'));
			})
			.catch((e: Error) => !off && setError(e.message));
		const onChange = () => setNonce((n) => n + 1);
		md.addEventListener?.('devicechange', onChange);
		return () => {
			off = true;
			md.removeEventListener?.('devicechange', onChange);
		};
	}, [nonce]);
	return { devices, error, refresh: () => setNonce((n) => n + 1) };
}

export function AudioPreferencesPage() {
	const p = useAudioPrefs();
	const { devices, error, refresh } = useInputDevices();
	// Device labels are empty until the page has had microphone permission once.
	const unlabeled = devices.length > 0 && devices.every((d) => !d.label);
	return (
		<div className="flex flex-col" data-testid="prefs-audio">
			<PrefGroup title="Playback">
				<Checkbox
					checked={p.scrub}
					onCheckedChange={(v) => audioPrefs.set({ scrub: v })}
					label="Play audio while scrubbing"
				/>
				<PrefRow label="5.1 Mixdown Type">
					<Select
						label="5.1 Mixdown Type"
						value={p.mixdown}
						onValueChange={(v) => audioPrefs.set({ mixdown: v as MixdownType })}
						options={[
							{ value: 'front', label: 'Front Only' },
							{ value: 'frontRear', label: 'Front + Rear' },
							{ value: 'frontLfe', label: 'Front + LFE' },
							{ value: 'frontRearLfe', label: 'Front + Rear + LFE' },
						]}
					/>
				</PrefRow>
			</PrefGroup>
			<PrefGroup title="Automation">
				<PrefRow label="Automatch Time">
					<ScrubbyNumber
						label="Automatch time"
						value={p.automatchSeconds}
						min={0}
						max={10}
						step={0.1}
						precision={1}
						unit="s"
						onCommit={(v) => audioPrefs.set({ automatchSeconds: v })}
						onScrubEnd={(v) => audioPrefs.set({ automatchSeconds: v })}
					/>
				</PrefRow>
				<Checkbox
					checked={p.switchToTouchAfterWrite}
					onCheckedChange={(v) => audioPrefs.set({ switchToTouchAfterWrite: v })}
					label="Switch to Touch after Write"
				/>
				<Checkbox
					checked={p.linearThinning}
					onCheckedChange={(v) => audioPrefs.set({ linearThinning: v })}
					label="Linear keyframe thinning"
				/>
				<div className="flex items-center gap-2">
					<Checkbox
						checked={p.minIntervalThinning}
						onCheckedChange={(v) => audioPrefs.set({ minIntervalThinning: v })}
						label="Minimum time interval thinning"
					/>
					<ScrubbyNumber
						label="Minimum time"
						value={p.minIntervalMs}
						min={1}
						max={2000}
						step={1}
						precision={0}
						unit="ms"
						disabled={!p.minIntervalThinning}
						onCommit={(v) => audioPrefs.set({ minIntervalMs: v })}
						onScrubEnd={(v) => audioPrefs.set({ minIntervalMs: v })}
					/>
				</div>
			</PrefGroup>
			<PrefGroup title="Essential Sound">
				<Checkbox
					checked={p.autoTagInTimeline}
					onCheckedChange={(v) => audioPrefs.set({ autoTagInTimeline: v })}
					label="Auto-tag audio types in the timeline"
				/>
				<p className="text-pr-small text-pr-dim">
					Audio clips you add to a sequence are listened to on the engine and tagged Dialogue, Music, SFX or
					Ambience, marked auto until you confirm them in Essential Sound. Types you set are kept; each
					tagging is its own undo step.
				</p>
			</PrefGroup>
			<PrefGroup title="Voice-Over Record">
				<PrefRow label="Source">
					<Select
						label="Voice-over input device"
						value={p.voiceOver.deviceId}
						onValueChange={(v) => audioPrefs.set({ voiceOver: { deviceId: v } })}
						options={[
							{ value: '', label: 'Default input' },
							...devices
								.filter((d) => d.deviceId && d.deviceId !== 'default')
								.map((d, i) => ({ value: d.deviceId, label: d.label || `Input ${i + 1}` })),
						]}
					/>
					{unlabeled ? (
						<button
							type="button"
							className="text-pr-accent underline"
							onClick={() =>
								void navigator.mediaDevices
									.getUserMedia({ audio: true })
									.then((s) => {
										for (const t of s.getTracks()) t.stop();
										refresh();
									})
									.catch(() => undefined)
							}
						>
							Show names
						</button>
					) : null}
				</PrefRow>
				{error ? <div className="text-pr-small text-pr-danger">{error}</div> : null}
				<PrefRow label="Input Channel">
					<ScrubbyNumber
						label="Input channel"
						value={p.voiceOver.inputChannel + 1}
						min={1}
						max={64}
						step={1}
						precision={0}
						onCommit={(v) => audioPrefs.set({ voiceOver: { inputChannel: v - 1 } })}
						onScrubEnd={(v) => audioPrefs.set({ voiceOver: { inputChannel: v - 1 } })}
					/>
				</PrefRow>
				<PrefRow label="Name">
					<TextField
						aria-label="Voice-over name"
						value={p.voiceOver.name}
						onChange={(e) => audioPrefs.set({ voiceOver: { name: e.target.value } })}
					/>
				</PrefRow>
				<Checkbox
					checked={p.voiceOver.countdownCues}
					onCheckedChange={(v) => audioPrefs.set({ voiceOver: { countdownCues: v } })}
					label="Countdown sound cues"
				/>
				<PrefRow label="Pre-roll">
					<ScrubbyNumber
						label="Pre-roll"
						value={p.voiceOver.prerollSeconds}
						min={0}
						max={60}
						step={1}
						precision={0}
						unit="s"
						onCommit={(v) => audioPrefs.set({ voiceOver: { prerollSeconds: v } })}
						onScrubEnd={(v) => audioPrefs.set({ voiceOver: { prerollSeconds: v } })}
					/>
				</PrefRow>
				<PrefRow label="Post-roll">
					<ScrubbyNumber
						label="Post-roll"
						value={p.voiceOver.postrollSeconds}
						min={0}
						max={60}
						step={1}
						precision={0}
						unit="s"
						onCommit={(v) => audioPrefs.set({ voiceOver: { postrollSeconds: v } })}
						onScrubEnd={(v) => audioPrefs.set({ voiceOver: { postrollSeconds: v } })}
					/>
				</PrefRow>
				<PrefRow label="Latency Offset">
					<ScrubbyNumber
						label="Voice-over latency offset"
						value={p.voiceOver.latencyOffsetMs}
						min={-500}
						max={500}
						step={1}
						precision={0}
						unit="ms"
						onCommit={(v) => audioPrefs.set({ voiceOver: { latencyOffsetMs: v } })}
						onScrubEnd={(v) => audioPrefs.set({ voiceOver: { latencyOffsetMs: v } })}
					/>
				</PrefRow>
				<div className="text-pr-small text-pr-muted">
					Takes are placed compensating the measured output and input latency; the offset corrects devices the
					browser does not report.
				</div>
			</PrefGroup>
		</div>
	);
}
