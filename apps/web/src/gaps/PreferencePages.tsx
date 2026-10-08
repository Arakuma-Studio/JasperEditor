// Edit ▸ Preferences pages of workstream gaps (docs/wp-notes/gaps.md §UI-4), Premiere's pages that mean something
// here: Appearance, Auto Save, Labels, Memory, Playback, Trim and Audio Hardware. Collaboration (Team Projects) and
// Sync Settings (Creative Cloud) are Adobe services and are not offered. Every setting is wired to behaviour:
// - Appearance: theme, contrast, density (prefsStore), reduced motion and language (UI-6).
// - Auto Save: the autosave timer (on / off, longest wait) and the engine's saved versions (interval, how many).
// - Labels: label colour names (Project panel and Timeline menus) and Label Defaults of new bins, sequences, media.
// - Memory: host memory and "Optimize rendering for" (parallel headless render pages).
// - Playback: Preroll / Postroll of Play Around, Play In to Out with Preroll/Postroll and trim-mode playback.
// - Trim: Large Trim Offset (Trim Forward / Backward Many, the Trim Monitor buttons).
// - Audio Hardware: the output device and latency of the editor's audio; the input device of voice-over.
import type { EngineGapsSettings } from '@jasper/api';
import { LABEL_COLORS, type LabelColor } from '@jasper/project';
import { Button, Checkbox, Select, TextField } from '@jasper/ui';
import { useEffect, useState } from 'react';
import { audioPrefs, useAudioPrefs } from '../audio/prefs.ts';
import { errorText, formatBytes } from '../processing/engine-jobs.ts';
import { PrefGroup, PrefRow } from '../shell/preferences/GeneralPage.tsx';
import { registerPreferencesPage } from '../shell/preferences/registry.ts';
import { prefsStore, type UiPrefs, useUiPrefs } from '../shell/prefs.ts';
import { useEngineOrNull } from '../state/engine.tsx';
import { gapsPrefs, type LabelDefaultKind, labelName, useGapsPrefs } from './app-prefs.ts';
import { canChooseOutput, listOutputDevices } from './audio-output.ts';
import { LANGUAGES } from './i18n-languages.ts';

function NumberField(props: {
	label: string;
	value: number;
	min: number;
	max: number;
	step?: number;
	onCommit(v: number): void;
	testId?: string;
}) {
	const [text, setText] = useState(String(props.value));
	useEffect(() => setText(String(props.value)), [props.value]);
	const commit = () => {
		const v = Number(text);
		if (Number.isFinite(v)) props.onCommit(Math.min(props.max, Math.max(props.min, v)));
		else setText(String(props.value));
	};
	return (
		<TextField
			aria-label={props.label}
			data-testid={props.testId}
			type="number"
			min={props.min}
			max={props.max}
			step={props.step ?? 1}
			className="w-24"
			value={text}
			onChange={(e) => setText(e.target.value)}
			onBlur={commit}
			onKeyDown={(e) => {
				if (e.key === 'Enter') commit();
			}}
		/>
	);
}

// ---------------------------------------------------------------- Appearance

function AppearancePage() {
	const ui = useUiPrefs();
	const g = useGapsPrefs();
	const set = (p: Partial<UiPrefs>) => prefsStore.set(p);
	return (
		<div data-testid="prefs-appearance">
			<PrefGroup title="Appearance">
				<PrefRow label="Brightness">
					<Select
						label="Brightness"
						className="w-40"
						value={ui.theme}
						onValueChange={(v) => set({ theme: v as UiPrefs['theme'] })}
						options={[
							{ value: 'darkest', label: 'Darkest' },
							{ value: 'dark', label: 'Dark' },
						]}
					/>
				</PrefRow>
				<PrefRow label="High contrast">
					<Checkbox
						checked={ui.contrast === 'high'}
						onCheckedChange={(c) => set({ contrast: c ? 'high' : 'normal' })}
						label="High-contrast theme (stronger text, borders and focus rings)"
					/>
				</PrefRow>
				<PrefRow label="Density">
					<Checkbox
						checked={ui.density === 'touch'}
						onCheckedChange={(c) => set({ density: c ? 'touch' : 'normal' })}
						label="Touch density"
					/>
				</PrefRow>
				<PrefRow label="Reduce motion">
					<Select
						label="Reduce motion"
						className="w-56"
						value={g.appearance.reducedMotion}
						onValueChange={(v) =>
							gapsPrefs.set({ appearance: { reducedMotion: v as 'system' | 'on' | 'off' } })
						}
						options={[
							{ value: 'system', label: 'Follow the system setting' },
							{ value: 'on', label: 'On (no animations)' },
							{ value: 'off', label: 'Off' },
						]}
					/>
				</PrefRow>
				<PrefRow label="Language">
					<Select
						label="Language"
						className="w-56"
						value={g.appearance.language}
						onValueChange={(v) => gapsPrefs.set({ appearance: { language: v } })}
						options={LANGUAGES.map((l) => ({ value: l.id, label: l.label }))}
					/>
				</PrefRow>
			</PrefGroup>
		</div>
	);
}

// ---------------------------------------------------------------- engine settings hook

function useEngineGaps() {
	const engine = useEngineOrNull()?.client ?? null;
	const [info, setInfo] = useState<
		| (EngineGapsSettings & {
				memory?: { totalBytes: number; freeBytes: number; engineRssBytes: number; cpuCount: number };
		  })
		| null
	>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		if (!engine) return;
		let off = false;
		engine
			.call('gapsSettingsGet')
			.then((r) => !off && setInfo(r))
			.catch((e) => !off && setError(errorText(e)));
		return () => {
			off = true;
		};
	}, [engine]);
	const save = async (patch: Partial<EngineGapsSettings>) => {
		if (!engine) return;
		try {
			setInfo(await engine.call('gapsSettingsPut', { body: patch }));
			setError(null);
		} catch (e) {
			setError(errorText(e));
		}
	};
	return { info, error, save, connected: !!engine };
}

// ---------------------------------------------------------------- Auto Save

function AutoSavePage() {
	const g = useGapsPrefs();
	const eng = useEngineGaps();
	return (
		<div data-testid="prefs-auto-save">
			<PrefGroup title="Auto Save">
				<PrefRow label="Automatically save">
					<Checkbox
						checked={g.autoSave.enabled}
						onCheckedChange={(c) => gapsPrefs.set({ autoSave: { enabled: c } })}
						label="Automatically save projects"
					/>
				</PrefRow>
				<PrefRow label="Save at the latest after">
					<NumberField
						label="Longest wait before saving (seconds)"
						testId="autosave-interval"
						value={g.autoSave.maxIntervalSeconds}
						min={2}
						max={3600}
						onCommit={(v) => gapsPrefs.set({ autoSave: { maxIntervalSeconds: v } })}
					/>
					<span className="text-pr-muted">seconds of editing</span>
				</PrefRow>
				<p className="text-pr-small text-pr-dim">
					With automatic saving off, the project file is written by Save (Ctrl+S) and when the project is
					closed; unsaved edits are kept in the crash-recovery journal and offered on the next open.
				</p>
			</PrefGroup>
			<PrefGroup title="Saved Versions">
				{eng.info ? (
					<>
						<PrefRow label="Keep a version every">
							<NumberField
								label="Minutes between saved versions"
								value={eng.info.versionIntervalMinutes}
								min={1}
								max={240}
								onCommit={(v) => void eng.save({ versionIntervalMinutes: v })}
							/>
							<span className="text-pr-muted">minutes</span>
						</PrefRow>
						<PrefRow label="Maximum project versions">
							<NumberField
								label="Maximum project versions"
								value={eng.info.keepVersions}
								min={1}
								max={500}
								onCommit={(v) => void eng.save({ keepVersions: Math.round(v) })}
							/>
						</PrefRow>
						<p className="text-pr-small text-pr-dim">Versions are restored from File ▸ Project Versions….</p>
					</>
				) : (
					<p className="text-pr-muted">
						{eng.error ?? (eng.connected ? 'Asking the engine…' : 'Needs the engine.')}
					</p>
				)}
			</PrefGroup>
		</div>
	);
}

// ---------------------------------------------------------------- Labels

const DEFAULT_KINDS: { kind: LabelDefaultKind; label: string }[] = [
	{ kind: 'bin', label: 'Bin' },
	{ kind: 'sequence', label: 'Sequence' },
	{ kind: 'video', label: 'Video' },
	{ kind: 'movie', label: 'Movie (video with audio)' },
	{ kind: 'audio', label: 'Audio' },
	{ kind: 'still', label: 'Still' },
];

function LabelsPage() {
	const g = useGapsPrefs();
	const colors = LABEL_COLORS as readonly LabelColor[];
	return (
		<div data-testid="prefs-labels">
			<PrefGroup title="Label Colors">
				{colors.map((c) => (
					<PrefRow
						key={c}
						label={
							<span className="inline-flex items-center gap-2">
								<span
									className="inline-block size-3 rounded-[2px]"
									style={{ background: `var(--pr-label-${c})` }}
								/>
								{c}
							</span>
						}
					>
						<TextField
							aria-label={`Name of the ${c} label`}
							className="w-48"
							value={g.labels.names[c] ?? ''}
							placeholder={labelName(c)}
							maxLength={40}
							onChange={(e) =>
								gapsPrefs.set({ labels: { names: { ...g.labels.names, [c]: e.target.value } } })
							}
						/>
					</PrefRow>
				))}
			</PrefGroup>
			<PrefGroup title="Label Defaults">
				{DEFAULT_KINDS.map((k) => (
					<PrefRow key={k.kind} label={k.label}>
						<Select
							label={`${k.label} label`}
							className="w-48"
							value={g.labels.defaults[k.kind] ?? 'default'}
							onValueChange={(v) => {
								const d = { ...g.labels.defaults };
								if (v === 'default') delete d[k.kind];
								else d[k.kind] = v as LabelColor;
								gapsPrefs.set({ labels: { defaults: d } });
							}}
							options={[
								{ value: 'default', label: 'Built-in default' },
								...colors.map((c) => ({ value: c, label: labelName(c) })),
							]}
						/>
					</PrefRow>
				))}
			</PrefGroup>
		</div>
	);
}

// ---------------------------------------------------------------- Memory

function MemoryPage() {
	const eng = useEngineGaps();
	const heap = (performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } })
		.memory;
	const m = eng.info?.memory;
	return (
		<div data-testid="prefs-memory">
			<PrefGroup title="Memory">
				<PrefRow label="Installed (engine host)">
					<span>{m ? formatBytes(m.totalBytes) : '…'}</span>
				</PrefRow>
				<PrefRow label="Free">
					<span>{m ? formatBytes(m.freeBytes) : '…'}</span>
				</PrefRow>
				<PrefRow label="Used by the engine">
					<span>{m ? formatBytes(m.engineRssBytes) : '…'}</span>
				</PrefRow>
				<PrefRow label="Used by this window">
					<span>
						{heap
							? `${formatBytes(heap.usedJSHeapSize)} of ${formatBytes(heap.jsHeapSizeLimit)}`
							: 'not reported by this browser'}
					</span>
				</PrefRow>
			</PrefGroup>
			<PrefGroup title="Rendering">
				<PrefRow label="Optimize rendering for">
					<Select
						label="Optimize rendering for"
						className="w-48"
						value={eng.info?.optimizeFor ?? 'performance'}
						onValueChange={(v) => void eng.save({ optimizeFor: v as 'performance' | 'memory' })}
						options={[
							{ value: 'performance', label: 'Performance' },
							{ value: 'memory', label: 'Memory' },
						]}
					/>
				</PrefRow>
				<p className="text-pr-small text-pr-dim">
					Memory renders exports, previews and graphics bakes with half as many headless pages
					{m
						? ` (${Math.max(1, Math.floor(m.cpuCount / 4))} instead of ${Math.max(1, Math.floor(m.cpuCount / 2))})`
						: ''}
					: slower, lighter.
				</p>
				{eng.error ? (
					<p role="alert" className="text-pr-small text-pr-danger">
						{eng.error}
					</p>
				) : null}
			</PrefGroup>
		</div>
	);
}

// ---------------------------------------------------------------- Playback / Trim

function PlaybackPage() {
	const g = useGapsPrefs();
	return (
		<div data-testid="prefs-playback">
			<PrefGroup title="Playback">
				<PrefRow label="Preroll">
					<NumberField
						label="Preroll (seconds)"
						testId="pref-preroll"
						value={g.playback.prerollSeconds}
						min={0}
						max={30}
						step={0.5}
						onCommit={(v) => gapsPrefs.set({ playback: { prerollSeconds: v } })}
					/>
					<span className="text-pr-muted">seconds</span>
				</PrefRow>
				<PrefRow label="Postroll">
					<NumberField
						label="Postroll (seconds)"
						value={g.playback.postrollSeconds}
						min={0}
						max={30}
						step={0.5}
						onCommit={(v) => gapsPrefs.set({ playback: { postrollSeconds: v } })}
					/>
					<span className="text-pr-muted">seconds</span>
				</PrefRow>
				<p className="text-pr-small text-pr-dim">
					Used by Play Around (Shift+K), Play In to Out with Preroll/Postroll and playback in trim mode.
				</p>
			</PrefGroup>
		</div>
	);
}

function TrimPage() {
	const g = useGapsPrefs();
	return (
		<div data-testid="prefs-trim">
			<PrefGroup title="Trim">
				<PrefRow label="Large Trim Offset">
					<NumberField
						label="Large trim offset (frames)"
						testId="pref-large-trim"
						value={g.trim.largeTrimOffset}
						min={2}
						max={100}
						onCommit={(v) => gapsPrefs.set({ trim: { largeTrimOffset: Math.round(v) } })}
					/>
					<span className="text-pr-muted">frames</span>
				</PrefRow>
				<p className="text-pr-small text-pr-dim">
					Trim Forward / Backward Many (Shift+Ctrl+→ / ←) and the Trim Monitor's ±N buttons.
				</p>
			</PrefGroup>
		</div>
	);
}

// ---------------------------------------------------------------- Audio Hardware

function AudioHardwarePage() {
	const g = useGapsPrefs();
	const audio = useAudioPrefs();
	const [outputs, setOutputs] = useState<{ id: string; label: string }[]>([]);
	const [inputs, setInputs] = useState<{ id: string; label: string }[]>([]);
	const refresh = () => {
		void listOutputDevices().then(setOutputs);
		void navigator.mediaDevices
			?.enumerateDevices?.()
			.then((all) =>
				setInputs(
					all
						.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default')
						.map((d, i) => ({ id: d.deviceId, label: d.label || `Input ${i + 1}` })),
				),
			)
			.catch(() => setInputs([]));
	};
	useEffect(refresh, []);
	return (
		<div data-testid="prefs-audio-hardware">
			<PrefGroup
				title="Audio Hardware"
				actions={
					<Button variant="quiet" onClick={refresh}>
						Refresh
					</Button>
				}
			>
				<PrefRow label="Default Output">
					<Select
						label="Default output"
						className="w-72"
						disabled={!canChooseOutput()}
						value={g.audioHardware.outputDeviceId || 'system'}
						onValueChange={(v) =>
							gapsPrefs.set({ audioHardware: { outputDeviceId: v === 'system' ? '' : v } })
						}
						options={[
							{ value: 'system', label: 'System default' },
							...outputs.map((o) => ({ value: o.id, label: o.label })),
						]}
					/>
					{canChooseOutput() ? null : (
						<span className="text-pr-small text-pr-dim">this browser always uses the system output</span>
					)}
				</PrefRow>
				<PrefRow label="Default Input">
					<Select
						label="Default input"
						className="w-72"
						value={audio.voiceOver.deviceId || 'system'}
						onValueChange={(v) => audioPrefs.set({ voiceOver: { deviceId: v === 'system' ? '' : v } })}
						options={[
							{ value: 'system', label: 'System default' },
							...inputs.map((o) => ({ value: o.id, label: o.label })),
						]}
					/>
				</PrefRow>
				<PrefRow label="Latency">
					<Select
						label="Audio latency"
						className="w-72"
						value={g.audioHardware.latency}
						onValueChange={(v) =>
							gapsPrefs.set({ audioHardware: { latency: v as 'interactive' | 'balanced' | 'playback' } })
						}
						options={[
							{ value: 'interactive', label: 'Low (interactive, smaller buffer)' },
							{ value: 'balanced', label: 'Balanced' },
							{ value: 'playback', label: 'High (playback, larger buffer, fewer dropouts)' },
						]}
					/>
				</PrefRow>
				<p className="text-pr-small text-pr-dim">
					The output applies to the monitors, scrubbing and the meters right away; the latency to audio
					started after the change.
				</p>
			</PrefGroup>
		</div>
	);
}

let registered = false;
/** Registers the gaps Preferences pages (idempotent). */
export function registerGapsPreferencePages(): void {
	if (registered) return;
	registered = true;
	registerPreferencesPage({ id: 'appearance', title: 'Appearance', order: 1, component: AppearancePage });
	registerPreferencesPage({
		id: 'audio-hardware',
		title: 'Audio Hardware',
		order: 31,
		component: AudioHardwarePage,
	});
	registerPreferencesPage({ id: 'auto-save', title: 'Auto Save', order: 32, component: AutoSavePage });
	registerPreferencesPage({ id: 'labels', title: 'Labels', order: 33, component: LabelsPage });
	registerPreferencesPage({ id: 'memory', title: 'Memory', order: 41, component: MemoryPage });
	registerPreferencesPage({ id: 'playback', title: 'Playback', order: 42, component: PlaybackPage });
	registerPreferencesPage({ id: 'trim', title: 'Trim', order: 57, component: TrimPage });
}
