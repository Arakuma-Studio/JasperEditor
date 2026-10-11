import type { Command } from '@jasper/project';
// Essential Sound panel (audio-fx; Premiere Window ▸ Essential Sound). The selected audio clips get a type —
// Dialogue, Music, SFX or Ambience — and simple controls per section; every control is an `essentialSound.*`
// command that writes ORDINARY clip effects, gain, Volume and pan (visible and keyframable in Effect Controls).
// Loudness Auto-Match and Ducking measure on the engine; Duration ▸ Remix plans on the engine (`clip.remix`).
import {
	AUDIO_TYPE_LABELS,
	AUDIO_TYPES,
	type AudioClip,
	builtinEssentialPresets,
	DEFAULT_LOUDNESS_TARGET,
	EQ_PRESETS,
	type EssentialSection,
	type EssentialSound,
	FLICKS_PER_SECOND,
	REVERB_PRESETS,
	readEssentialSound,
	SECTION_LABELS,
	type Sequence,
	type Slot,
	TYPE_SECTIONS,
} from '@jasper/project';
import type { EditorSession, SessionState } from '@jasper/session';
import { useSessionOrNull, useStoreSelector } from '@jasper/session/react';
import { Button, Checkbox, EmptyState, Select, Slider, toast } from '@jasper/ui';
import { EMPTY_SESSION_STORE } from '../session-store.ts';

const notify = {
	error: (title: string) => toast({ kind: 'error', title: title.slice(0, 120) }),
	success: (title: string) => toast({ kind: 'success', title: title.slice(0, 120) }),
};

import { type ReactNode, useState } from 'react';
import {
	autoMatchLoudness,
	deleteUserSoundPreset,
	generateDucking,
	remixClip,
	saveUserSoundPreset,
	userSoundPresets,
} from '../../audio-fx/ops.ts';
import { useEngineOrNull } from '../../state/engine.tsx';
import { useInspectorOps } from '../properties/lib/ops.ts';
import type { PanelProps } from '../types.ts';

type Selected = { seq: Sequence | null; clips: AudioClip[] };

function selectedOf(s: SessionState | null): Selected {
	if (!s?.activeSequenceId) return { seq: null, clips: [] };
	const seq = s.document.sequences[s.activeSequenceId] as Sequence | undefined;
	if (!seq) return { seq: null, clips: [] };
	const clips = s.selection.timeline.clips
		.map((id) => seq.clips[id])
		.filter((c): c is AudioClip => !!c && c.kind === 'audio');
	return { seq, clips };
}

export function EssentialSoundPanel(_props: PanelProps) {
	const session = useSessionOrNull();
	const sel = useStoreSelector(
		session?.store ?? EMPTY_SESSION_STORE,
		(s: SessionState | null) => selectedOf(s),
		(a, b) =>
			a.seq === b.seq && a.clips.length === b.clips.length && a.clips.every((c, i) => c === b.clips[i]),
	);
	if (!session)
		return <EmptyState icon="panel.essentialSound" message="Open a project to use Essential Sound" />;
	if (!sel.seq || sel.clips.length === 0)
		return (
			<EmptyState
				icon="panel.essentialSound"
				message="Select audio clips"
				detail="Then choose an audio type: Dialogue, Music, SFX or Ambience."
			/>
		);
	return <Body session={session} seq={sel.seq} clips={sel.clips} />;
}

function Body({ session, seq, clips }: { session: EditorSession; seq: Sequence; clips: AudioClip[] }) {
	const settings = clips.map((c) => readEssentialSound(c.essential));
	const types = new Set(settings.map((s) => s?.type ?? null));
	const ids = clips.map((c) => c.id);
	const apply = (label: string, commands: Command[]) => {
		const r = session.apply({ label, origin: 'user', commands });
		if (!r.ok) notify.error(r.errors[0]?.message ?? `${label} failed`);
	};
	if (types.size > 1)
		return (
			<div className="flex flex-col gap-2 p-3 text-pr-small" data-testid="essential-sound">
				<p className="text-pr-muted">The selected clips have different audio types.</p>
				<Button
					onClick={() => apply('Clear Audio Type', [{ type: 'essentialSound.clearType', clipIds: ids }])}
				>
					Clear Audio Type
				</Button>
			</div>
		);
	const s = settings[0];
	if (!s)
		return (
			<div className="flex flex-col gap-2 p-3" data-testid="essential-sound">
				<p className="text-pr-small text-pr-muted">Assign an audio type to the selection:</p>
				{AUDIO_TYPES.map((t) => (
					<Button
						key={t}
						data-testid={`essential-type-${t}`}
						onClick={() =>
							apply(`Set Audio Type to ${AUDIO_TYPE_LABELS[t]}`, [
								{ type: 'essentialSound.setType', clipIds: ids, audioType: t },
							])
						}
					>
						{AUDIO_TYPE_LABELS[t]}
					</Button>
				))}
			</div>
		);
	return <Editor session={session} seq={seq} clips={clips} s={s} apply={apply} />;
}

type EditorProps = {
	session: EditorSession;
	seq: Sequence;
	clips: AudioClip[];
	s: EssentialSound;
	apply(label: string, commands: Command[]): void;
};

function Editor({ session, seq, clips, s, apply }: EditorProps) {
	const ids = clips.map((c) => c.id);
	const ops = useInspectorOps(session);
	const engine = useEngineOrNull();
	const [busy, setBusy] = useState<string | null>(null);
	const [closed, setClosed] = useState<Record<string, boolean>>({});
	const [, bump] = useState(0);
	const frame = session.transport.getState().frame;
	const set = (values: Record<string, boolean | number | string | string[]>) =>
		apply('Essential Sound', [{ type: 'essentialSound.set', clipIds: ids, values, at: frame }]);
	const scrubCmd = (values: Record<string, boolean | number | string | string[]>): Command[] => [
		{ type: 'essentialSound.set', clipIds: ids, values, at: frame },
	];
	const builtins = builtinEssentialPresets().filter((p) => p.type === s.type);
	const users = userSoundPresets().filter((p) => p.settings.type === s.type);
	const run = async (what: string, f: () => Promise<string | undefined>) => {
		if (!engine) return notify.error('The engine is not connected');
		setBusy(what);
		try {
			const msg = await f();
			if (msg) notify.success(msg);
		} catch (e) {
			notify.error((e as Error).message);
		} finally {
			setBusy(null);
		}
	};
	const slider = (
		key: string,
		label: string,
		value: number,
		opts: { min?: number; max?: number; step?: number; disabled?: boolean } = {},
	) => (
		<div className="flex items-center gap-2">
			<span className="w-24 shrink-0 truncate text-pr-small text-pr-muted">{label}</span>
			<Slider
				className="min-w-0 flex-1"
				label={label}
				value={value}
				min={opts.min ?? 0}
				max={opts.max ?? 10}
				step={opts.step ?? 0.1}
				disabled={opts.disabled}
				onChangeStart={() => ops.scrub.start('Essential Sound')}
				onChange={(v) => {
					if (!ops.scrub.update(scrubCmd({ [key]: v }))) set({ [key]: v });
				}}
				onCommit={() => ops.scrub.end(false)}
			/>
			<span className="w-10 text-right text-pr-small pr-tabular" data-testid={`essential-value-${key}`}>
				{value.toFixed(1)}
			</span>
		</div>
	);
	const slot = (path: string, label: string, sl: Slot, extra?: ReactNode) => (
		<div className="flex flex-col gap-1" data-testid={`essential-slot-${path}`}>
			<Checkbox checked={sl.on} label={label} onCheckedChange={(v) => set({ [`${path}.on`]: v })} />
			{sl.on ? slider(`${path}.amount`, 'Amount', sl.amount) : null}
			{sl.on ? extra : null}
		</div>
	);
	const section = (id: EssentialSection, body: ReactNode, enabledKey?: string, enabled?: boolean) => (
		<section key={id} className="border-b border-pr-border-subtle" data-testid={`essential-section-${id}`}>
			<div className="flex h-7 items-center gap-2 px-2">
				<button
					type="button"
					className="flex-1 text-left text-pr-ui text-pr-text"
					aria-expanded={!closed[id]}
					onClick={() => setClosed((c) => ({ ...c, [id]: !c[id] }))}
				>
					{closed[id] ? '▸' : '▾'} {SECTION_LABELS[id]}
				</button>
				{enabledKey ? (
					<Checkbox
						aria-label={`${SECTION_LABELS[id]} on`}
						checked={!!enabled}
						onCheckedChange={(v) => set({ [enabledKey]: v })}
					/>
				) : null}
			</div>
			{closed[id] ? null : <div className="flex flex-col gap-2 px-3 pb-2">{body}</div>}
		</section>
	);
	const target = s.loudness.targetLufs ?? DEFAULT_LOUDNESS_TARGET;
	const remixed = clips.find((c) => c.remix);
	const music = clips[0]!;
	const durSec =
		(remixed?.remix?.targetFrames ?? music.duration) *
		(seq.settings.frameRate.den / seq.settings.frameRate.num);
	const sections: Record<EssentialSection, () => ReactNode> = {
		loudness: () =>
			section(
				'loudness',
				<>
					<div className="flex items-center gap-2">
						<Button
							data-testid="essential-auto-match"
							busy={busy === 'match'}
							onClick={() =>
								run('match', async () => {
									const m = await autoMatchLoudness(session, engine!.client, seq.id, ids, target);
									const v = Object.values(m).find((x) => x !== null);
									return v === undefined || v === null ? 'The clips are silent' : `Matched to ${target} LUFS`;
								})
							}
						>
							Auto-Match
						</Button>
						<span className="text-pr-small text-pr-muted">
							{s.loudness.measuredLufs !== null
								? `${s.loudness.measuredLufs.toFixed(1)} LUFS → ${target} LUFS (${s.loudness.gainDb >= 0 ? '+' : ''}${s.loudness.gainDb.toFixed(1)} dB)`
								: `Target ${target} LUFS`}
						</span>
					</div>
					{slider('loudness.targetLufs', 'Target (LUFS)', target, { min: -40, max: -5, step: 0.5 })}
				</>,
				'loudness.enabled',
				s.loudness.enabled,
			),
		repair: () =>
			section(
				'repair',
				<>
					{slot('repair.noise', 'Reduce Noise', s.repair.noise)}
					{slot('repair.rumble', 'Reduce Rumble', s.repair.rumble)}
					{slot(
						'repair.dehum',
						'DeHum',
						s.repair.dehum,
						<Select
							label="Hum frequency"
							value={String(s.repair.humHz)}
							options={[
								{ value: '50', label: '50 Hz' },
								{ value: '60', label: '60 Hz' },
							]}
							onValueChange={(v) => set({ 'repair.humHz': Number(v) })}
						/>,
					)}
					{slot('repair.deess', 'DeEss', s.repair.deess)}
					{slot('repair.reverb', 'Reduce Reverb', s.repair.reverb)}
				</>,
				'repair.enabled',
				s.repair.enabled,
			),
		clarity: () =>
			section(
				'clarity',
				<>
					{slot('clarity.dynamics', 'Dynamics', s.clarity.dynamics)}
					{slot(
						'clarity.eq',
						'EQ',
						s.clarity.eq,
						<Select
							label="EQ preset"
							value={s.clarity.eqPreset}
							options={EQ_PRESETS.map((p) => ({ value: p.name, label: p.name }))}
							onValueChange={(v) => set({ 'clarity.eqPreset': v })}
						/>,
					)}
					{slot(
						'clarity.enhance',
						'Enhance Speech',
						s.clarity.enhance,
						<Select
							label="Voice"
							value={s.clarity.enhanceTone}
							options={[
								{ value: 'low', label: 'Low Tone' },
								{ value: 'high', label: 'High Tone' },
							]}
							onValueChange={(v) => set({ 'clarity.enhanceTone': v })}
						/>,
					)}
				</>,
				'clarity.enabled',
				s.clarity.enabled,
			),
		creative: () =>
			section(
				'creative',
				<>
					{slot(
						'creative.reverb',
						'Reverb',
						s.creative.reverb,
						<Select
							label="Reverb preset"
							value={s.creative.reverbPreset}
							options={REVERB_PRESETS.map((p) => ({ value: p.name, label: p.name }))}
							onValueChange={(v) => set({ 'creative.reverbPreset': v })}
						/>,
					)}
					{s.type === 'ambience' ? slot('creative.width', 'Stereo Width', s.creative.width) : null}
				</>,
				'creative.enabled',
				s.creative.enabled,
			),
		duration: () =>
			section(
				'duration',
				<>
					<Select
						label="Method"
						value={s.duration.method}
						options={[
							{ value: 'remix', label: 'Remix' },
							{ value: 'stretch', label: 'Stretch' },
						]}
						onValueChange={(v) => set({ 'duration.method': v })}
					/>
					{slider(
						'duration.targetSeconds',
						'Target (s)',
						s.duration.targetSeconds ?? Math.round(durSec * 10) / 10,
						{
							min: 1,
							max: Math.max(600, Math.ceil(durSec * 3)),
							step: 0.1,
						},
					)}
					{s.duration.method === 'remix' ? (
						<>
							{slider('duration.segments', 'Segments', s.duration.segments, { min: 0, max: 100, step: 1 })}
							{slider('duration.variations', 'Variations', s.duration.variations, {
								min: 0,
								max: 100,
								step: 1,
							})}
						</>
					) : null}
					<div className="flex gap-2">
						<Button
							data-testid="essential-duration-apply"
							disabled={clips.length !== 1}
							disabledReason="Select one music clip"
							busy={busy === 'remix'}
							onClick={() =>
								run('remix', async () => {
									const t = s.duration.targetSeconds ?? durSec;
									if (s.duration.method === 'stretch') {
										const frames = Math.max(
											1,
											Math.round((t * seq.settings.frameRate.num) / seq.settings.frameRate.den),
										);
										apply('Stretch', [
											{
												type: 'clip.setSpeed',
												clipIds: ids,
												duration: frames,
												maintainPitch: true,
												ripple: false,
											},
										]);
										return `Stretched to ${t.toFixed(1)} s`;
									}
									const r = await remixClip(session, engine!.client, seq.id, music.id, t, {
										segments: s.duration.segments,
										variations: s.duration.variations,
									});
									return `Remixed to ${r.lengthSeconds.toFixed(2)} s (${r.pieces} segments, ${r.bpm.toFixed(0)} BPM)`;
								})
							}
						>
							{s.duration.method === 'remix' ? 'Remix' : 'Stretch'}
						</Button>
						{remixed ? (
							<Button
								onClick={() => apply('Revert Remix', [{ type: 'clip.remixRevert', clipId: remixed.id }])}
							>
								Revert
							</Button>
						) : null}
					</div>
				</>,
			),
		ducking: () =>
			section(
				'ducking',
				<>
					<span className="text-pr-small text-pr-muted">Duck against</span>
					<div className="flex flex-wrap gap-2">
						{AUDIO_TYPES.map((t) => (
							<Checkbox
								key={t}
								label={AUDIO_TYPE_LABELS[t]}
								checked={s.ducking.against.includes(t)}
								onCheckedChange={(v) =>
									set({
										'ducking.against': v
											? [...s.ducking.against, t]
											: s.ducking.against.filter((x) => x !== t),
									})
								}
							/>
						))}
						<Checkbox
							label="Untyped clips"
							checked={s.ducking.againstUntyped}
							onCheckedChange={(v) => set({ 'ducking.againstUntyped': v })}
						/>
					</div>
					{slider('ducking.sensitivity', 'Sensitivity', s.ducking.sensitivity)}
					{slider('ducking.reduceDb', 'Reduce By (dB)', s.ducking.reduceDb, { min: -40, max: 0, step: 0.5 })}
					{slider('ducking.fadeSeconds', 'Fades (s)', s.ducking.fadeSeconds, { min: 0, max: 5, step: 0.05 })}
					<Button
						data-testid="essential-generate-ducking"
						busy={busy === 'duck'}
						disabled={!s.ducking.enabled}
						disabledReason="Turn Ducking on"
						onClick={() =>
							run('duck', async () => {
								const n = await generateDucking(session, engine!.client, seq.id, ids);
								return `Ducked under ${n} region${n === 1 ? '' : 's'}`;
							})
						}
					>
						Generate Keyframes
					</Button>
				</>,
				'ducking.enabled',
				s.ducking.enabled,
			),
		pan: () =>
			section(
				'pan',
				slider('pan.value', 'Pan', s.pan.value, { min: -100, max: 100, step: 1 }),
				'pan.enabled',
				s.pan.enabled,
			),
	};
	const presetValue = s.preset || '';
	return (
		<div
			className="flex h-full min-h-0 flex-col overflow-y-auto font-pr text-pr-ui"
			data-testid="essential-sound"
		>
			<div className="flex flex-col gap-1.5 border-b border-pr-border-subtle p-2">
				<div className="flex items-center gap-2">
					<span className="font-semibold text-pr-text" data-testid="essential-current-type">
						{AUDIO_TYPE_LABELS[s.type]}
					</span>
					<span className="text-pr-small text-pr-muted">
						{clips.length} clip{clips.length === 1 ? '' : 's'}
					</span>
					<span className="flex-1" />
					<Button
						variant="quiet"
						data-testid="essential-clear"
						onClick={() => apply('Clear Audio Type', [{ type: 'essentialSound.clearType', clipIds: ids }])}
					>
						Clear Audio Type
					</Button>
				</div>
				<div className="flex items-center gap-1">
					<Select
						className="min-w-0 flex-1"
						label="Preset"
						placeholder="(Custom)"
						value={presetValue}
						options={[
							...builtins.map((p) => ({ value: p.name, label: p.name })),
							...users.map((p) => ({ value: `user:${p.name}`, label: `${p.name} (mine)` })),
						]}
						onValueChange={(v) => {
							if (v.startsWith('user:')) {
								const u = users.find((p) => `user:${p.name}` === v);
								if (u)
									apply(`Apply Sound Preset ${u.name}`, [
										{ type: 'essentialSound.applyPreset', clipIds: ids, settings: u.settings },
									]);
							} else
								apply(`Apply Sound Preset ${v}`, [
									{ type: 'essentialSound.applyPreset', clipIds: ids, preset: v },
								]);
						}}
					/>
					<Button
						variant="quiet"
						title="Save the settings as a preset"
						onClick={() => {
							const name = window.prompt('Preset name');
							if (!name?.trim()) return;
							if (builtins.some((p) => p.name.toLowerCase() === name.trim().toLowerCase()))
								return notify.error('That is a built-in preset name');
							saveUserSoundPreset(name.trim(), s);
							bump((x) => x + 1);
							notify.success(`Saved preset "${name.trim()}"`);
						}}
					>
						Save
					</Button>
					{users.some((p) => p.name === s.preset) ? (
						<Button
							variant="quiet"
							onClick={() => {
								deleteUserSoundPreset(s.preset, s.type);
								bump((x) => x + 1);
							}}
						>
							Delete
						</Button>
					) : null}
				</div>
			</div>
			{TYPE_SECTIONS[s.type].map((id) => sections[id]())}
			<div className="flex flex-col gap-1.5 p-2" data-testid="essential-footer">
				<Checkbox
					label="Clip Volume"
					checked={s.volume.on}
					onCheckedChange={(v) => set({ 'volume.on': v })}
				/>
				{s.volume.on
					? slider('volume.levelDb', 'Level (dB)', s.volume.levelDb, { min: -96, max: 15, step: 0.1 })
					: null}
				<Checkbox label="Mute" checked={s.mute} onCheckedChange={(v) => set({ mute: v })} />
				<p className="text-pr-small text-pr-muted">
					Every control writes ordinary clip effects and levels — adjust or keyframe them in Effect Controls.
				</p>
			</div>
		</div>
	);
}

/** Seconds of a flick count (UI). */
export const secondsOf = (flicks: number) => flicks / FLICKS_PER_SECOND;
