// Process Clip… (S07:PRU-001): step checkboxes in the fixed order deblock → denoise → de-judder → stabilise →
// upscale with their options, the executor (Auto / This computer / Remote: <host>) with the last probe status,
// a rough time estimate and "Replace in timeline when done". Opened for clips it can process only the frames
// the clips show plus N frames of handles (S07:PRC-015, default for clip entry points): the version then holds
// that source range and the swap keeps the clips on the same source frames. Start queues
// `POST /api/media/:key/process`; the job is followed at module level (`processWatcher`), which commits
// `media.derive` when it succeeds.
import type {
	EngineCapabilities,
	EngineJob,
	M2Features,
	ProcessingModel,
	ProcessingSettings,
	ProcessRequest,
} from '@jasper/api';
import { type MediaAsset, type ProjectDocument, processRangeForClips } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { Button, Checkbox, cx, Dialog, type HostedDialogProps, Select, Slider, TextField } from '@jasper/ui';
import { type ReactNode, useEffect, useId, useMemo, useState } from 'react';
import { mediaKeyOf } from '../import/assets.ts';
import { useEngine } from '../state/engine.tsx';
import { errorText, followJob, formatAgo } from './engine-jobs.ts';
import { startProcessing } from './jobs.ts';
import {
	DENOISE_PRESETS,
	type DenoiseMethod,
	type DenoisePreset,
	defaultForm,
	estimateSeconds,
	formatDuration,
	type ProcessForm,
	processedSteps,
	recipeLabel,
	SMOOTH_PATH_DEFAULTS,
	type StabilizeMethod,
	sourceInfo,
	stepsFromForm,
} from './model.ts';

export const PROCESS_DIALOG = 'process.clip';

export type ProcessDialogProps = {
	session: EditorSession;
	/** The media to process (the clip's current media: an original or a processed version). */
	mediaId: string;
	/** Clips swapped to the result when "Replace" is on. */
	clipIds: string[];
	/** Default of "Replace in timeline when done" (on for clip entry points, off for Project items). */
	replaceDefault: boolean;
	/** Where the dialog was opened from (wording of the replace checkbox). */
	origin: 'clip' | 'project';
};

type Processing = NonNullable<M2Features['processing']>;

/** Default handles of "Clip range + handles" (frames on each side). */
const DEFAULT_PROCESS_HANDLES = 12;

/** The frames of `mediaId` the clips show (mapped across versions) plus `handles` (S07:PRC-015). */
function clipProcessRange(
	doc: ProjectDocument,
	mediaId: string,
	clipIds: readonly string[],
	handles: number,
): { startFrame: number; endFrame: number } | null {
	const uses = [];
	for (const seq of Object.values(doc.sequences))
		for (const id of clipIds) {
			const c = seq.clips[id] as
				| {
						kind: string;
						mediaId?: string;
						sourceIn: number;
						duration: number;
						speed: { rate: number; reverse: boolean };
				  }
				| undefined;
			if (c?.kind === 'video' && c.mediaId)
				uses.push({ clip: { ...c, mediaId: c.mediaId }, seqRate: seq.settings.frameRate });
		}
	return processRangeForClips(doc, uses, mediaId, handles);
}

const DENOISE_LABELS: Record<DenoiseMethod, string> = {
	atadenoise: 'Temporal (atadenoise) — fast',
	fftdnoiz: 'FFT (fftdnoiz) — medium',
	nlmeans: 'Non-local means (nlmeans) — slow, strongest',
};

/** What each stabilise method is for (S07:PRU-001), shown under the method choice. */
const STABILIZE_HELP: Record<Exclude<StabilizeMethod, 'auto'>, string> = {
	vidstab:
		'Removes handheld shake and keeps the intended camera moves. For walking or handheld shots with continuous jitter.',
	smoothpath:
		'Turns one sudden reframe or jerk, or a slow uneven drift, into a single even move, with one fixed zoom for the whole shot. Tracks the background, so people moving through the shot are ignored. For shots from a fixed position (tripod, leaning on something).',
	deshake: 'Fast one-pass fallback; removes less shake than vid.stab.',
};

function Segmented<T extends string>(props: {
	value: T;
	options: readonly { value: T; label: string }[];
	onChange(v: T): void;
	label: string;
	disabled?: boolean;
}) {
	return (
		<fieldset
			aria-label={props.label}
			className="m-0 inline-flex min-w-0 overflow-hidden p-0 rounded-pr-control border border-pr-border-strong"
		>
			{props.options.map((o) => (
				<button
					key={o.value}
					type="button"
					aria-pressed={props.value === o.value}
					disabled={props.disabled}
					onClick={() => props.onChange(o.value)}
					className={cx(
						'h-[22px] px-2.5 text-pr-ui outline-none focus-visible:bg-pr-hover disabled:opacity-40',
						props.value === o.value ? 'bg-pr-pressed text-pr-strong' : 'text-pr-muted hover:bg-pr-hover',
					)}
				>
					{o.label}
				</button>
			))}
		</fieldset>
	);
}

function Opt(props: { label: string; children: ReactNode; htmlFor?: string }) {
	return (
		<div className="grid min-h-[26px] grid-cols-[96px_minmax(0,1fr)] items-center gap-2">
			<label htmlFor={props.htmlFor} className="text-pr-muted">
				{props.label}
			</label>
			<div className="flex min-w-0 items-center gap-2">{props.children}</div>
		</div>
	);
}

function StepBlock(props: {
	id: string;
	title: string;
	hint: string;
	on: boolean;
	onToggle(on: boolean): void;
	unavailable?: string | null;
	children?: ReactNode;
}) {
	return (
		<section
			className="border-b border-pr-border-subtle py-2 last:border-b-0"
			data-testid={`step-${props.id}`}
		>
			<div className="flex items-center gap-2">
				<Checkbox
					checked={props.on && !props.unavailable}
					disabled={!!props.unavailable}
					onCheckedChange={props.onToggle}
					label={<span className="font-semibold text-pr-strong">{props.title}</span>}
					aria-label={props.title}
				/>
				<span className="min-w-0 truncate text-pr-small text-pr-dim">{props.unavailable ?? props.hint}</span>
			</div>
			{props.on && !props.unavailable ? (
				<div className="mt-1 flex flex-col gap-0.5 pl-[22px]">{props.children}</div>
			) : null}
		</section>
	);
}

/** Effective executor of `auto` (S07:PRM-007): remote when enabled, last probe OK and a step is in `useFor`. */
function autoTarget(
	settings: ProcessingSettings | null,
	proc: Processing | undefined,
	ops: readonly string[],
): 'local' | 'remote' {
	const r = settings?.remote;
	if (!r?.enabled || !proc?.remote.lastProbe?.ok) return 'local';
	const useFor = r.useFor.length ? r.useFor : ['upscale', 'dejudder'];
	return ops.some((o) => (useFor as string[]).includes(o)) ? 'remote' : 'local';
}

export function ProcessDialog(props: HostedDialogProps<ProcessDialogProps>) {
	const { session } = props;
	const engine = useEngine();
	const client = engine.client;
	const ids = { w: useId(), h: useId(), model: useId() };
	const doc = session.getCommitted();
	const asset = doc.media[props.mediaId] as MediaAsset | undefined;
	const src = sourceInfo(asset);
	const already = processedSteps(asset);
	const key = mediaKeyOf(asset);

	const [caps, setCaps] = useState<EngineCapabilities | null>(engine.capabilities);
	const proc = caps?.features?.processing;
	const [models, setModels] = useState<ProcessingModel[] | null>(null);
	const [settings, setSettings] = useState<ProcessingSettings | null>(null);
	const [form, setForm] = useState<ProcessForm>(() => defaultForm({ denoiseMethod: proc?.denoise[0] }));
	const [executor, setExecutor] = useState<ProcessRequest['executor']>('auto');
	const [replace, setReplace] = useState(props.replaceDefault && props.clipIds.length > 0);
	const [scope, setScope] = useState<'whole' | 'clips'>(
		props.origin === 'clip' && props.clipIds.length > 0 ? 'clips' : 'whole',
	);
	const [handles, setHandles] = useState(DEFAULT_PROCESS_HANDLES);
	const [error, setError] = useState<string | null>(null);
	const [installing, setInstalling] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		client
			.capabilities()
			.then((c) => !cancelled && setCaps(c))
			.catch(() => undefined);
		client
			.call('processingSettingsGet')
			.then((s) => !cancelled && setSettings(s))
			.catch(() => undefined);
		const loadModels = () =>
			client
				.call('processingModels')
				.then((r) => {
					if (cancelled) return;
					setModels(r.models);
					setForm((f) => {
						if (f.upscale.model) return f;
						const m = r.models.find((x) => x.installed) ?? r.models[0];
						return m ? { ...f, upscale: { ...f.upscale, model: m.id, scale: m.scale } } : f;
					});
				})
				.catch(() => !cancelled && setModels([]));
		void loadModels();
		return () => {
			cancelled = true;
		};
	}, [client]);

	// Keep the denoise method valid for this engine's FFmpeg.
	useEffect(() => {
		if (proc?.denoise.length && !proc.denoise.includes(form.denoise.method))
			setForm((f) => ({ ...f, denoise: { ...f.denoise, method: proc.denoise[0] as DenoiseMethod } }));
	}, [proc, form.denoise.method]);

	const set = <K extends keyof ProcessForm>(k: K, patch: Partial<ProcessForm[K]>) => {
		setForm((f) => ({ ...f, [k]: { ...f[k], ...patch } }));
		setError(null);
	};

	const clipRange = useMemo(
		() => (scope === 'clips' ? clipProcessRange(doc, props.mediaId, props.clipIds, handles) : null),
		[scope, doc, props.mediaId, props.clipIds, handles],
	);
	// A range that is the whole file is processed as the whole file (same result, reusable by every clip).
	const range =
		clipRange && !(clipRange.startFrame === 0 && src && clipRange.endFrame >= src.frames) ? clipRange : null;
	const frames = range ? range.endFrame - range.startFrame : (src?.frames ?? 0);
	const model = models?.find((m) => m.id === form.upscale.model) ?? null;
	const smoothPath = form.stabilize.method === 'smoothpath';
	const autoStabilize: Exclude<StabilizeMethod, 'auto'> =
		proc?.stabilize === 'deshake' ? 'deshake' : 'vidstab';
	const steps = useMemo(() => stepsFromForm(form), [form]);
	const ops = steps.map((s) => s.op);
	const remote = settings?.remote ?? null;
	const lastProbe = proc?.remote.lastProbe ?? null;
	const target = executor === 'auto' ? autoTarget(settings, proc, ops) : executor;
	const gpu = target === 'remote' && !!lastProbe?.gpu;
	const estimate =
		src && steps.length
			? estimateSeconds(
					steps,
					{ ...src, frames },
					{
						gpu,
						stabilizeEngine: proc?.stabilize === 'deshake' ? 'deshake' : 'vidstab',
					},
				)
			: null;

	const unavailable = {
		deblock: proc && !proc.deblock ? 'Not available: this FFmpeg has no deblock filter' : null,
		denoise: proc && !proc.denoise.length ? 'Not available: no LGPL denoise filter in this FFmpeg' : null,
		stabilize: proc?.stabilize === 'none' ? 'Not available: neither vid.stab nor deshake is available' : null,
		dejudder: proc?.dejudder === 'unavailable' ? 'Not available in this engine' : null,
		upscale:
			proc?.upscale.runtime === 'none'
				? 'Not available: ONNX Runtime is missing'
				: models && !models.length
					? 'No super-resolution model in the catalogue'
					: null,
	};

	const blockers: string[] = [];
	if (!proc) blockers.push('This engine does not support clip processing');
	if (asset?.kind !== 'video') blockers.push('Only video media can be processed');
	else if (!key) blockers.push('This media is not stored by the engine');
	if (!steps.length) blockers.push('Choose at least one step');
	if (form.upscale.on && model && !model.installed) blockers.push(`Install ${model.name} first`);
	if (executor === 'remote' && !remote) blockers.push('No remote host is configured');
	if (scope === 'clips' && !clipRange) blockers.push('The clips’ frames cannot be located in this media');

	const install = async () => {
		if (!model) return;
		setInstalling('Queued');
		try {
			const job = (await client.call('processingModelInstall', {
				params: { modelId: model.id },
			})) as EngineJob;
			const end = await followJob(client, job.id, {
				onUpdate: (j) =>
					setInstalling(j.progress !== null ? `${Math.round(j.progress * 100)} %` : 'Installing'),
			});
			if (end.state !== 'succeeded') setError(`Install failed: ${end.error?.message ?? end.state}`);
			const r = await client.call('processingModels');
			setModels(r.models);
		} catch (e) {
			setError(errorText(e));
		} finally {
			setInstalling(null);
		}
	};

	const start = async (): Promise<boolean> => {
		if (blockers.length) return false;
		setError(null);
		try {
			await startProcessing({
				engine: client,
				session,
				mediaId: props.mediaId,
				steps,
				executor,
				replaceInClips: replace ? props.clipIds : [],
				...(range ? { range } : {}),
			});
			props.close(true);
			return false;
		} catch (e) {
			setError(errorText(e));
			return false;
		}
	};

	const outW = src ? src.width * form.upscale.scale : null;
	const outH = src ? src.height * form.upscale.scale : null;
	const remoteLabel = remote ? `Remote: ${remote.user}@${remote.host}` : 'Remote (not configured)';
	const probeLine = !remote
		? 'Set up a remote host in Preferences ▸ Processing'
		: !remote.enabled
			? 'The remote executor is turned off in Preferences ▸ Processing'
			: lastProbe
				? `${lastProbe.ok ? 'Ready' : 'Not ready'}${lastProbe.gpu ? ` · ${lastProbe.gpu}` : ''} · tested ${formatAgo(lastProbe.at)}${!lastProbe.ok && lastProbe.message ? ` — ${lastProbe.message}` : ''}`
				: 'Never tested — use Test Connection in Preferences ▸ Processing';

	return (
		<Dialog
			open
			onOpenChange={(o) => !o && props.close()}
			title="Process Clip"
			size="medium"
			primaryLabel="Start"
			primaryDisabled={blockers.length > 0}
			onPrimary={start}
			footerExtra={
				<span className="min-w-0 truncate text-pr-small text-pr-muted" data-testid="process-estimate">
					{estimate !== null
						? `≈ ${formatDuration(estimate)} (rough estimate${target === 'remote' ? ', remote' : ', this computer'})`
						: ''}
				</span>
			}
			data-testid="process-dialog"
		>
			<div className="flex flex-col gap-2">
				<p className="text-pr-small text-pr-muted" data-testid="process-source">
					<span className="text-pr-text">{asset?.originalName ?? props.mediaId}</span>
					{src ? ` · ${src.width}×${src.height} · ${src.frames} frames` : ''}
					{already ? ` · already ${recipeLabel(already)}` : ''}. The result is a new ProRes file; the original
					is never changed.
				</p>

				{props.clipIds.length ? (
					<div
						className="grid grid-cols-[96px_minmax(0,1fr)] items-center gap-x-2 gap-y-1"
						data-testid="process-range"
					>
						<span className="text-pr-muted">Frames</span>
						<div className="flex min-w-0 items-center gap-2">
							<Segmented
								label="Frames to process"
								value={scope}
								onChange={(v) => {
									setScope(v);
									setError(null);
								}}
								options={[
									{ value: 'clips', label: 'Clip range + handles' },
									{ value: 'whole', label: 'Whole media' },
								]}
							/>
							{scope === 'clips' ? (
								<>
									<TextField
										aria-label="Handle frames"
										className="w-14"
										inputMode="numeric"
										value={String(handles)}
										onChange={(e) =>
											setHandles(Math.min(10_000, Number(e.target.value.replace(/\D/g, '')) || 0))
										}
										data-testid="process-handles"
									/>
									<span className="text-pr-muted">frames each side</span>
								</>
							) : null}
						</div>
						<span />
						<span className="text-pr-small text-pr-dim" data-testid="process-range-info">
							{range
								? `Source frames ${range.startFrame}–${range.endFrame - 1} (${frames} frames): the clip${props.clipIds.length > 1 ? 's' : ''} plus up to ${handles} frames of handles for trims and transitions`
								: scope === 'whole' || clipRange
									? `All ${src?.frames ?? ''} frames; any clip of this media can use the result`
									: ''}
						</span>
					</div>
				) : null}

				<div className="rounded-pr-control border border-pr-border-subtle px-2">
					<StepBlock
						id="deblock"
						title="Deblock"
						hint="Removes 8×8 compression blocks"
						on={form.deblock.on}
						onToggle={(on) => set('deblock', { on })}
						unavailable={unavailable.deblock}
					>
						<Opt label="Filter">
							<Segmented
								label="Deblock filter"
								value={form.deblock.filter}
								onChange={(v) => set('deblock', { filter: v })}
								options={[
									{ value: 'weak', label: 'Weak' },
									{ value: 'strong', label: 'Strong' },
								]}
							/>
						</Opt>
					</StepBlock>

					<StepBlock
						id="denoise"
						title="Denoise"
						hint="Reduces sensor and compression noise"
						on={form.denoise.on}
						onToggle={(on) => set('denoise', { on })}
						unavailable={unavailable.denoise}
					>
						<Opt label="Method">
							<Select
								label="Denoise method"
								className="w-72"
								value={form.denoise.method}
								onValueChange={(v) => set('denoise', { method: v as DenoiseMethod })}
								options={(proc?.denoise ?? ['atadenoise', 'fftdnoiz', 'nlmeans']).map((m) => ({
									value: m,
									label: DENOISE_LABELS[m],
								}))}
							/>
						</Opt>
						<Opt label="Strength">
							<Segmented
								label="Denoise strength"
								value={form.denoise.preset}
								onChange={(v) => set('denoise', { preset: v as DenoisePreset })}
								options={(Object.keys(DENOISE_PRESETS) as DenoisePreset[]).map((p) => ({
									value: p,
									label: p[0]!.toUpperCase() + p.slice(1),
								}))}
							/>
						</Opt>
					</StepBlock>

					<StepBlock
						id="dejudder"
						title="De-judder"
						hint="Evens out a 2-2-1 frame cadence without changing the frame count"
						on={form.dejudder.on}
						onToggle={(on) => set('dejudder', { on })}
						unavailable={unavailable.dejudder}
					>
						<Opt label="Mode">
							<Segmented
								label="De-judder mode"
								value={form.dejudder.mode}
								onChange={(v) => set('dejudder', { mode: v })}
								options={[
									{ value: 'auto', label: 'Auto (only when detected)' },
									{ value: 'force', label: 'Force' },
								]}
							/>
						</Opt>
					</StepBlock>

					<StepBlock
						id="stabilize"
						title="Stabilize"
						hint="Smooths camera shake or an uneven camera move"
						on={form.stabilize.on}
						onToggle={(on) => set('stabilize', { on })}
						unavailable={unavailable.stabilize}
					>
						<Opt label="Method">
							<Select
								label="Stabilize method"
								className="w-72"
								value={form.stabilize.method}
								onValueChange={(v) => set('stabilize', { method: v as StabilizeMethod })}
								options={[
									{
										value: 'auto',
										label: `Auto (${proc?.stabilize === 'deshake' ? 'deshake' : 'vid.stab'})`,
									},
									{ value: 'vidstab', label: 'vid.stab', disabled: proc?.stabilize !== 'vidstab' },
									{
										value: 'smoothpath',
										label: 'Smooth path (one even move)',
										disabled: proc?.smoothPath !== 'ready',
									},
									{ value: 'deshake', label: 'deshake (one pass)' },
								]}
							/>
						</Opt>
						<p
							className="m-0 pb-1 pl-[104px] text-pr-small leading-snug text-pr-dim"
							data-testid="stabilize-method-help"
						>
							{STABILIZE_HELP[form.stabilize.method === 'auto' ? autoStabilize : form.stabilize.method]}
						</p>
						{smoothPath ? (
							<>
								<Opt label="Smoothing">
									<div className="w-44 shrink-0">
										<Slider
											label="Path smoothing"
											min={1}
											max={120}
											value={form.stabilize.pathSmoothing}
											defaultValue={SMOOTH_PATH_DEFAULTS.pathSmoothing}
											valueText={`${form.stabilize.pathSmoothing} frames`}
											onChange={(v) => set('stabilize', { pathSmoothing: v })}
										/>
									</div>
									<span
										className="shrink-0 whitespace-nowrap text-pr-value pr-tabular"
										data-testid="stabilize-path-smoothing"
										title="Gaussian sigma of the camera path: higher = slower, more even move (and more zoom)"
									>
										{form.stabilize.pathSmoothing} frames
									</span>
								</Opt>
								<Opt label="Lock">
									<Checkbox
										checked={form.stabilize.lockVertical}
										onCheckedChange={(c) => set('stabilize', { lockVertical: c })}
										label="Vertical (no tilt)"
									/>
									<Checkbox
										checked={form.stabilize.lockRotation}
										onCheckedChange={(c) => set('stabilize', { lockRotation: c })}
										label="Rotation (level horizon)"
									/>
								</Opt>
							</>
						) : (
							<Opt label="Smoothing">
								<div className="w-44 shrink-0">
									<Slider
										label="Smoothing"
										min={1}
										max={60}
										value={form.stabilize.smoothing}
										defaultValue={15}
										valueText={`${form.stabilize.smoothing} frames`}
										onChange={(v) => set('stabilize', { smoothing: v })}
									/>
								</div>
								<span
									className="shrink-0 whitespace-nowrap text-pr-value pr-tabular"
									data-testid="stabilize-smoothing"
								>
									{form.stabilize.smoothing} frames
								</span>
							</Opt>
						)}
						<Opt label="Borders">
							<Segmented
								label="Borders"
								value={form.stabilize.borders}
								onChange={(v) => set('stabilize', { borders: v })}
								options={[
									{ value: 'crop', label: smoothPath ? 'Crop (one fixed zoom)' : 'Crop (zoom in)' },
									{ value: 'keep', label: 'Keep (black edges)' },
								]}
							/>
						</Opt>
						{smoothPath && form.stabilize.borders === 'crop' ? (
							<Opt label="Max zoom">
								<div className="w-44 shrink-0">
									<Slider
										label="Max zoom"
										min={101}
										max={150}
										value={form.stabilize.maxZoom}
										defaultValue={SMOOTH_PATH_DEFAULTS.maxZoom}
										valueText={`${form.stabilize.maxZoom} %`}
										onChange={(v) => set('stabilize', { maxZoom: v })}
									/>
								</div>
								<span
									className="shrink-0 whitespace-nowrap text-pr-value pr-tabular"
									data-testid="stabilize-max-zoom"
									title="When the smoothing needs more zoom than this, the largest smoothing that fits is used (the job says so)"
								>
									{form.stabilize.maxZoom} %
								</span>
							</Opt>
						) : null}
						{smoothPath ? null : (
							<Opt label="Rotation">
								<Checkbox
									checked={form.stabilize.rotation}
									disabled={form.stabilize.method === 'deshake'}
									onCheckedChange={(c) => set('stabilize', { rotation: c })}
									label="Also stabilize rotation (vid.stab)"
								/>
							</Opt>
						)}
					</StepBlock>

					<StepBlock
						id="upscale"
						title="Upscale"
						hint="Super-resolution with an ONNX model"
						on={form.upscale.on}
						onToggle={(on) => set('upscale', { on })}
						unavailable={unavailable.upscale}
					>
						<Opt label="Model" htmlFor={ids.model}>
							<Select
								id={ids.model}
								label="Model"
								className="min-w-0 flex-1"
								value={form.upscale.model}
								placeholder={models ? 'No model' : 'Loading…'}
								onValueChange={(v) => {
									const m = models?.find((x) => x.id === v);
									set('upscale', { model: v, ...(m ? { scale: m.scale } : {}) });
								}}
								options={(models ?? []).map((m) => ({
									value: m.id,
									label: `${m.name}${m.installed ? '' : ' (not installed)'}`,
								}))}
							/>
							{model && !model.installed ? (
								<Button
									busy={!!installing}
									disabled={!model.downloadUrl}
									disabledReason={!model.downloadUrl ? 'This model has no download' : undefined}
									onClick={() => void install()}
									data-testid="process-install-model"
								>
									{installing ? `Installing ${installing}` : 'Install'}
								</Button>
							) : null}
						</Opt>
						{model ? (
							<p className="pb-1 pl-[104px] text-pr-small text-pr-dim" data-testid="process-model-license">
								{model.scale}× · weights {model.license}
								{model.attribution ? ` — ${model.attribution}` : ''}
							</p>
						) : null}
						<Opt label="Output size">
							<Select
								label="Output size"
								className="w-52"
								value={form.upscale.size}
								onValueChange={(v) => set('upscale', { size: v as ProcessForm['upscale']['size'] })}
								options={[
									{ value: 'model', label: `${form.upscale.scale}×${outW ? ` (${outW} × ${outH})` : ''}` },
									{ value: 'fhd', label: '1920 × 1080' },
									{ value: 'custom', label: 'Custom…' },
								]}
							/>
							{form.upscale.size === 'custom' ? (
								<>
									<TextField
										id={ids.w}
										aria-label="Width"
										className="w-16"
										inputMode="numeric"
										value={String(form.upscale.width)}
										onChange={(e) =>
											set('upscale', { width: Number(e.target.value.replace(/\D/g, '')) || 0 })
										}
									/>
									<span className="text-pr-muted">×</span>
									<TextField
										id={ids.h}
										aria-label="Height"
										className="w-16"
										inputMode="numeric"
										value={String(form.upscale.height)}
										onChange={(e) =>
											set('upscale', { height: Number(e.target.value.replace(/\D/g, '')) || 0 })
										}
									/>
								</>
							) : null}
						</Opt>
						<Opt label="Detail mix">
							<div className="w-44 shrink-0">
								<Slider
									label="Blend with a Lanczos upscale"
									min={0}
									max={100}
									value={Math.round(form.upscale.mix * 100)}
									defaultValue={0}
									valueText={`${Math.round(form.upscale.mix * 100)} percent Lanczos`}
									onChange={(v) => set('upscale', { mix: v / 100 })}
								/>
							</div>
							<span className="shrink-0 whitespace-nowrap text-pr-value pr-tabular">
								{Math.round(form.upscale.mix * 100)} % Lanczos
							</span>
						</Opt>
					</StepBlock>
				</div>

				<div className="grid grid-cols-[96px_minmax(0,1fr)] items-center gap-x-2 gap-y-1 pt-1">
					<span className="text-pr-muted">Run on</span>
					<Select
						label="Run on"
						className="w-64"
						value={executor}
						onValueChange={(v) => setExecutor(v as ProcessRequest['executor'])}
						options={[
							{
								value: 'auto',
								label: `Auto (${target === 'remote' && executor === 'auto' ? 'remote' : 'this computer'})`,
							},
							{ value: 'local', label: 'This computer' },
							{ value: 'remote', label: remoteLabel, disabled: !remote },
						]}
					/>
					<span />
					<span
						className={cx(
							'text-pr-small',
							lastProbe?.ok && remote?.enabled ? 'text-pr-muted' : 'text-pr-dim',
						)}
						data-testid="process-remote-status"
					>
						{probeLine}
					</span>
				</div>

				{props.clipIds.length ? (
					<Checkbox
						checked={replace}
						onCheckedChange={setReplace}
						label={
							props.origin === 'clip'
								? `Replace in timeline when done (${props.clipIds.length} clip${props.clipIds.length > 1 ? 's' : ''})`
								: `Replace in the ${props.clipIds.length} clip${props.clipIds.length > 1 ? 's' : ''} using this media when done`
						}
					/>
				) : null}
				<p className="text-pr-small text-pr-dim">
					Progress appears in the Jobs panel.{' '}
					{replace
						? 'When it finishes the clip switches to the processed version (one undo step).'
						: 'When it finishes the processed version appears in the Processed bin.'}
				</p>

				{error || (blockers.length && steps.length) ? (
					<p className="text-pr-small text-pr-danger" role="alert" data-testid="process-error">
						{error ?? blockers[0]}
					</p>
				) : null}
			</div>
		</Dialog>
	);
}
