// Generated-media location belongs to the project. Preview, cache, and autosave locations are engine-owned;
// the dialog displays them without persisting them as project settings. General ▸ Agent Proposals (spec 15 EA-001):
// "Allow agents to apply <feature> proposals" per workflow feature (default on), saved with the project; sound design
// keeps its per-sequence setting (Preferences ▸ Sound Library).
import type { ScratchInfo, ScratchLocation } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import {
	AUDIO_DISPLAY_FORMATS,
	agentProposalsAllowed,
	INGEST_ACTIONS,
	PROXY_PRESETS,
	projectSettingFeatures,
	projectSettingsOf,
	VIDEO_DISPLAY_FORMATS,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import {
	Button,
	Checkbox,
	Dialog,
	type HostedDialogProps,
	registerDialog,
	Select,
	Tabs,
	TextField,
} from '@jasper/ui';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { t } from '../i18n/runtime.ts';
import { errorText, formatBytes } from '../processing/engine-jobs.ts';
import { featureName } from '../proposals/vocabulary.ts';

export const PROJECT_SETTINGS_DIALOG = 'gaps.projectSettings';

const VIDEO_LABELS: Record<(typeof VIDEO_DISPLAY_FORMATS)[number], string> = {
	timecode: 'Timecode',
	frames: 'Frames',
	feet35: 'Feet + Frames 35mm',
	feet16: 'Feet + Frames 16mm',
};
const AUDIO_LABELS: Record<(typeof AUDIO_DISPLAY_FORMATS)[number], string> = {
	samples: 'Audio Samples',
	milliseconds: 'Milliseconds',
};
const INGEST_LABELS: Record<(typeof INGEST_ACTIONS)[number], string> = {
	copy: 'Copy',
	transcode: 'Transcode',
	proxies: 'Create Proxies',
	copyAndProxies: 'Copy and Create Proxies',
};

/** The Program monitor's GPU renderer string (WebGL 2), or null. */
export function previewRendererName(): string | null {
	try {
		const c = document.createElement('canvas');
		const gl = c.getContext('webgl2') as WebGL2RenderingContext | null;
		if (!gl) return null;
		const ext = gl.getExtension('WEBGL_debug_renderer_info');
		const name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
		gl.getExtension('WEBGL_lose_context')?.loseContext();
		return typeof name === 'string' && name ? name : null;
	} catch {
		return null;
	}
}

function Row(props: { label: ReactNode; htmlFor?: string; children: ReactNode }) {
	return (
		<div className="grid min-h-[28px] grid-cols-[190px_minmax(0,1fr)] items-center gap-3">
			<label htmlFor={props.htmlFor} className="text-pr-muted">
				{props.label}
			</label>
			<div className="flex min-w-0 items-center gap-2">{props.children}</div>
		</div>
	);
}

function Group(props: { title: string; children: ReactNode }) {
	return (
		<section className="flex flex-col gap-1 pb-3">
			<h3 className="mb-1 border-b border-pr-border-subtle font-semibold text-pr-strong">{props.title}</h3>
			{props.children}
		</section>
	);
}

function Space(props: { loc: ScratchLocation | undefined }) {
	const l = props.loc;
	if (!l) return <span className="text-pr-dim">…</span>;
	return (
		<span className="min-w-0 truncate text-pr-small text-pr-muted" title={l.path ?? undefined}>
			{l.path ?? 'on the engine host'}
			{l.freeBytes !== null ? ` — ${formatBytes(l.freeBytes)} free` : ''}
			{l.exists ? '' : ' (created when needed)'}
		</span>
	);
}

type Props = {
	session: EditorSession;
	engine: EngineClient;
	/** Opens another dialog (Preferences ▸ Media Cache / Auto Save). */
	openPreferences?(page: string): void;
	initialTab?: 'general' | 'scratch' | 'ingest';
};

function ProjectSettingsDialog(props: HostedDialogProps<Props>) {
	const { session, engine } = props;
	const start = projectSettingsOf(session.getCommitted());
	const [video, setVideo] = useState(start.display.video);
	const [audio, setAudio] = useState(start.display.audio);
	const [scratchMode, setScratchMode] = useState<'project' | 'custom'>(
		start.scratch.media ? 'custom' : 'project',
	);
	const [scratchPath, setScratchPath] = useState(start.scratch.media ?? '');
	const [scratchCheck, setScratchCheck] = useState<{
		ok: boolean;
		message?: string;
		free?: number | null;
	} | null>(null);
	const [ing, setIng] = useState(start.ingest);
	// spec 15 EA-001: what the project stores now, and the dialog's choices (saved with OK, one undoable edit)
	const agentStart = () =>
		Object.fromEntries(
			projectSettingFeatures().map((f) => [
				f.id,
				agentProposalsAllowed(session.getCommitted(), f.id) === true,
			]),
		) as Record<string, boolean>;
	const [agents, setAgents] = useState<Record<string, boolean>>(agentStart);
	const [ingFolder, setIngFolder] = useState<'media' | 'custom'>(
		start.ingest.destination ? 'custom' : 'media',
	);
	const [info, setInfo] = useState<ScratchInfo | null>(null);
	const [infoError, setInfoError] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [tab, setTab] = useState(props.initialTab ?? 'general');
	const [gpu] = useState(() => previewRendererName());
	const [caps, setCaps] = useState<Awaited<ReturnType<EngineClient['capabilities']>> | null>(null);
	const ids = { v: useId(), a: useId(), s: useId(), f: useId() };

	useEffect(() => {
		let off = false;
		engine
			.call('projectScratch', { params: { projectId: session.projectId } })
			.then((i) => !off && setInfo(i))
			.catch((e) => !off && setInfoError(errorText(e)));
		engine
			.capabilities()
			.then((c) => !off && setCaps(c))
			.catch(() => undefined);
		return () => {
			off = true;
		};
	}, [engine, session.projectId]);

	const checkFolder = async (path: string) => {
		if (!path.trim()) {
			setScratchCheck(null);
			return;
		}
		try {
			const r = await engine.call('scratchCheck', { body: { path: path.trim() } });
			setScratchCheck({ ok: r.ok, ...(r.message ? { message: r.message } : {}), free: r.freeBytes });
		} catch (e) {
			setScratchCheck({ ok: false, message: errorText(e) });
		}
	};

	const encoding = caps?.media.encoding;
	const exportPaths = caps
		? [
				caps.render.native ? 'Native (FFmpeg)' : null,
				caps.render.native ? 'Hybrid layer bake' : null,
				caps.render.remotionLocal === 'ready' ? 'Remotion (headless browser)' : null,
			].filter(Boolean)
		: [];
	const proxyPresets = PROXY_PRESETS.filter((p) =>
		ing.action === 'transcode' ? p.kind === 'transcode' : p.kind === 'proxy',
	);

	const general = (
		<div className="flex flex-col gap-2" data-testid="project-settings-general">
			<Group title="Video Rendering and Playback">
				<Row label="Renderer (preview)">
					<span className="text-pr-text">
						{gpu ? `GPU: ${gpu} (WebGL 2)` : 'Software (WebGL 2 unavailable)'}
					</span>
				</Row>
				<Row label="Renderer (export)">
					<span className="text-pr-text">
						{caps ? exportPaths.join(' · ') || 'Unavailable' : 'Asking the engine…'}
						{encoding?.export ? ` — ${encoding.export.label}` : ''}
					</span>
				</Row>
			</Group>
			<Group title="Video">
				<Row label="Display Format" htmlFor={ids.v}>
					<Select
						id={ids.v}
						label="Video display format"
						className="w-56"
						value={video}
						onValueChange={(v) => setVideo(v as typeof video)}
						options={VIDEO_DISPLAY_FORMATS.map((f) => ({ value: f, label: VIDEO_LABELS[f] }))}
					/>
				</Row>
			</Group>
			<Group title="Audio">
				<Row label="Display Format" htmlFor={ids.a}>
					<Select
						id={ids.a}
						label="Audio display format"
						className="w-56"
						value={audio}
						onValueChange={(v) => setAudio(v as typeof audio)}
						options={AUDIO_DISPLAY_FORMATS.map((f) => ({ value: f, label: AUDIO_LABELS[f] }))}
					/>
				</Row>
				<p className="text-pr-small text-pr-dim">
					Audio units show in the timeline ruler with Timeline Display Settings ▸ Show Audio Time Units.
				</p>
			</Group>
			<Group title="Agent Proposals">
				{projectSettingFeatures().map((f) => (
					<Checkbox
						key={f.id}
						checked={agents[f.id] === true}
						onCheckedChange={(c) => setAgents((a) => ({ ...a, [f.id]: c }))}
						label={t('Allow agents to apply {0} proposals', featureName(f.id))}
						id={`agent-proposals-${f.id}`}
					/>
				))}
				<p className="text-pr-small text-pr-dim">
					On (the default): an agent may apply these proposals itself, each as one undoable History step;
					edits that need your approval still ask. Off: agents only propose and you apply in the Review panel.
					An agent cannot turn these on by itself. Sound design proposals have their own setting per sequence
					(Preferences ▸ Sound Library).
				</p>
			</Group>
		</div>
	);

	const scratch = (
		<div className="flex flex-col gap-2" data-testid="project-settings-scratch">
			{infoError ? (
				<p role="alert" className="text-pr-small text-pr-danger">
					{infoError}
				</p>
			) : null}
			<Group title="Captured and Generated Media">
				<p className="text-pr-small text-pr-dim">
					Proxies, exported frames, Project Manager copies and ingested media.
				</p>
				<Row label="Location" htmlFor={ids.s}>
					<Select
						id={ids.s}
						label="Captured and generated media location"
						className="w-48"
						value={scratchMode}
						onValueChange={(v) => setScratchMode(v as 'project' | 'custom')}
						options={[
							{ value: 'project', label: 'Same as Project' },
							{ value: 'custom', label: 'Folder…', disabled: info ? !info.local : false },
						]}
					/>
				</Row>
				{scratchMode === 'project' ? (
					<Row label="Path">
						<Space loc={info?.projectMedia} />
					</Row>
				) : (
					<Row label="Folder">
						<TextField
							aria-label="Generated media folder"
							data-testid="scratch-media-path"
							className="min-w-0 flex-1"
							value={scratchPath}
							placeholder={info?.home ?? '/path/to/folder'}
							onChange={(e) => {
								setScratchPath(e.target.value);
								setScratchCheck(null);
							}}
							onBlur={() => void checkFolder(scratchPath)}
						/>
						{scratchCheck ? (
							<span
								className={scratchCheck.ok ? 'text-pr-small text-pr-muted' : 'text-pr-small text-pr-danger'}
							>
								{scratchCheck.ok
									? scratchCheck.free != null
										? `${formatBytes(scratchCheck.free)} free`
										: 'OK'
									: scratchCheck.message}
							</span>
						) : null}
					</Row>
				)}
			</Group>
			<Group title="Video and Audio Previews">
				<Row label="Path">
					<Space loc={info?.previews} />
				</Row>
				<Row label="">
					<Button variant="quiet" onClick={() => props.openPreferences?.('media-cache')}>
						Change in Media Cache preferences…
					</Button>
				</Row>
			</Group>
			<Group title="Media Cache">
				<Row label="Path">
					<Space loc={info?.mediaCache} />
				</Row>
			</Group>
			<Group title="Project Auto Save">
				<Row label="Path">
					<Space loc={info?.autoSave} />
				</Row>
				<Row label="">
					<Button variant="quiet" onClick={() => props.openPreferences?.('auto-save')}>
						Auto Save preferences…
					</Button>
				</Row>
			</Group>
		</div>
	);

	const ingest = (
		<div className="flex flex-col gap-2" data-testid="project-settings-ingest">
			<Checkbox
				checked={ing.enabled}
				onCheckedChange={(c) => setIng({ ...ing, enabled: c })}
				label="Ingest (when media is imported)"
			/>
			<Row label="Action">
				<Select
					label="Ingest action"
					className="w-56"
					disabled={!ing.enabled}
					value={ing.action}
					onValueChange={(v) => setIng({ ...ing, action: v as typeof ing.action, preset: null })}
					options={INGEST_ACTIONS.map((a) => ({ value: a, label: INGEST_LABELS[a] }))}
				/>
			</Row>
			{ing.action !== 'copy' ? (
				<Row label="Preset">
					<Select
						label="Ingest preset"
						className="w-80"
						disabled={!ing.enabled}
						value={ing.preset ?? (ing.action === 'transcode' ? 'transcode-prores-422' : 'proxy-720')}
						onValueChange={(v) => setIng({ ...ing, preset: v })}
						options={proxyPresets.map((p) => ({ value: p.id, label: p.label }))}
					/>
				</Row>
			) : null}
			<Row label="Primary Destination" htmlFor={ids.f}>
				<Select
					id={ids.f}
					label="Ingest destination"
					className="w-72"
					disabled={!ing.enabled}
					value={ingFolder}
					onValueChange={(v) => setIngFolder(v as 'media' | 'custom')}
					options={[
						{ value: 'media', label: 'Next to the original media' },
						{ value: 'custom', label: 'Folder…', disabled: info ? !info.local : false },
					]}
				/>
			</Row>
			{ingFolder === 'custom' ? (
				<Row label="Folder">
					<TextField
						aria-label="Ingest folder"
						data-testid="ingest-folder"
						className="min-w-0 flex-1"
						disabled={!ing.enabled}
						value={ing.destination ?? ''}
						placeholder={info?.home ?? '/path/to/folder'}
						onChange={(e) => setIng({ ...ing, destination: e.target.value })}
					/>
				</Row>
			) : null}
			<p className="text-pr-small text-pr-dim">
				Copies replace the imported files in the project once they are verified; transcodes replace them like
				Replace Footage; proxies are attached (play them with Toggle Proxies). Each runs as a background job.
			</p>
		</div>
	);

	return (
		<Dialog
			open
			onOpenChange={(o) => !o && props.close()}
			title="Project Settings"
			size="large"
			primaryLabel="OK"
			onPrimary={() => {
				if (
					scratchMode === 'custom' &&
					!scratchPath.trim().startsWith('/') &&
					!/^[A-Za-z]:[\\/]/.test(scratchPath.trim())
				) {
					setError('The generated media folder must be an absolute path.');
					setTab('scratch');
					return false;
				}
				if (ing.enabled && ingFolder === 'custom' && !ing.destination?.trim()) {
					setError('Choose the ingest folder, or ingest next to the original media.');
					setTab('ingest');
					return false;
				}
				// only what the user changed here is written (the per-feature entries merge)
				const was = agentStart();
				const agentChanges = Object.fromEntries(
					Object.entries(agents).filter(([id, on]) => was[id] !== on),
				) as Record<string, boolean>;
				const r = session.apply({
					label: 'Project Settings',
					origin: 'user',
					commands: [
						{
							type: 'project.updateSettings',
							settings: {
								...(Object.keys(agentChanges).length ? { agentProposals: agentChanges } : {}),
								display: { video, audio },
								scratch: { media: scratchMode === 'custom' ? scratchPath.trim() : null },
								ingest: {
									enabled: ing.enabled,
									action: ing.action,
									...(ing.preset ? { preset: ing.preset } : {}),
									destination: ingFolder === 'custom' ? (ing.destination?.trim() ?? null) : null,
								},
							},
						},
					] as never[],
				});
				if (!r.ok) {
					setError(r.errors[0]?.message ?? 'The settings could not be saved.');
					return false;
				}
				props.close(true);
				return false;
			}}
			data-testid="project-settings-dialog"
		>
			<div className="flex min-h-[380px] flex-col gap-2">
				<Tabs
					value={tab}
					onValueChange={(v) => setTab(v as typeof tab)}
					items={[
						{ value: 'general', label: 'General', content: general },
						{ value: 'scratch', label: 'Scratch Disks', content: scratch },
						{ value: 'ingest', label: 'Ingest Settings', content: ingest },
					]}
				/>
				{error ? (
					<p role="alert" className="text-pr-small text-pr-danger">
						{error}
					</p>
				) : null}
			</div>
		</Dialog>
	);
}

let registered = false;
export function registerProjectSettingsDialog(): void {
	if (registered) return;
	registered = true;
	registerDialog(PROJECT_SETTINGS_DIALOG, ProjectSettingsDialog);
}
