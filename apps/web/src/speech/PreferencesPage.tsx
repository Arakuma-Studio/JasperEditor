// wp speech / spec 16 SG-030: Edit ▸ Preferences ▸ Transcription — where speech-to-text runs (Processor: Automatic /
// CPU / GPU, with the reason when no GPU can be used; Accuracy: Standard / Best), NVIDIA GPU support on Linux (the
// downloadable CUDA provider with its status and what to install), transcription on import, and the models of the
// engine's catalogue: size, languages, "Runs on", speed (estimated until measured), "Recommended for this
// computer", licence and source; Download (after the licence is shown, with progress) and Delete.
import type { EngineJob, SpeechModel, SpeechProbe } from '@jasper/api';
import { Button, Checkbox, confirmDialog, Select, toast } from '@jasper/ui';
import { useCallback, useEffect, useState } from 'react';
import { errorText, followJob, formatBytes } from '../processing/engine-jobs.ts';
import { PrefGroup } from '../shell/preferences/GeneralPage.tsx';
import { useEngine } from '../state/engine.tsx';
import { type AutoTranscribe, loadAuto, saveAuto } from './auto.tsx';
import {
	downloadModel,
	ModelLicence,
	useSpeechModels,
	useSpeechSettings,
} from './GenerateTranscriptDialog.tsx';
import { runsOnText, speedText, WHISPER_LANGUAGES } from './model.ts';

const PROVIDER_NAMES: Record<string, string> = {
	cpu: 'CPU',
	cuda: 'CUDA',
	webgpu: 'WebGPU',
	dml: 'DirectML',
	coreml: 'Core ML',
};

/** The provider probe (`GET`; `reprobe` = `POST`, probing again). */
function useSpeechProbe(): {
	probe: SpeechProbe | null;
	error: string | null;
	reprobe(): Promise<void>;
	busy: boolean;
} {
	const { client } = useEngine();
	const [probe, setProbe] = useState<SpeechProbe | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		let live = true;
		client
			.call('speechProbe')
			.then((p) => live && setProbe(p as SpeechProbe))
			.catch((e) => live && setError(errorText(e)));
		return () => {
			live = false;
		};
	}, [client]);
	const reprobe = useCallback(async () => {
		setBusy(true);
		try {
			setProbe((await client.call('speechReprobe')) as SpeechProbe);
			setError(null);
		} catch (e) {
			setError(errorText(e));
		} finally {
			setBusy(false);
		}
	}, [client]);
	return { probe, error, reprobe, busy };
}

export function SpeechPreferencesPage() {
	const { client, capabilities } = useEngine();
	const { models, error, reload } = useSpeechModels();
	const { settings, save } = useSpeechSettings();
	const { probe, error: probeError, reprobe, busy: probing } = useSpeechProbe();
	const [busy, setBusy] = useState<Record<string, string>>({});
	const [cudaBusy, setCudaBusy] = useState<string | null>(null);
	const [auto, setAutoState] = useState<AutoTranscribe>(loadAuto);
	const setAuto = (patch: Partial<AutoTranscribe>) =>
		setAutoState((a) => {
			const next = { ...a, ...patch };
			saveAuto(next);
			return next;
		});
	const autoModel = models?.find((m) => m.id === auto.model);
	const speech = (capabilities?.features as { speech?: { status: string; reason?: string } } | undefined)
		?.speech;

	const download = async (m: SpeechModel) => {
		const ok = await confirmDialog({
			title: `Download ${m.name}?`,
			body: `${formatBytes(m.missingBytes || m.sizeBytes)} from Hugging Face (pinned revision ${m.revision.slice(0, 12)}), checked against its SHA-256. Licence: ${m.license}. ${m.attribution}.`,
			confirmLabel: 'Accept Licence and Download',
		});
		if (!ok) return;
		setBusy((s) => ({ ...s, [m.id]: 'Queued' }));
		try {
			const end = await downloadModel(client, m.id, (t) => setBusy((s) => ({ ...s, [m.id]: t })));
			if (end.state !== 'succeeded')
				toast({
					kind: 'error',
					title: `${m.name} was not downloaded`,
					detail: end.error?.message ?? end.state,
				});
		} catch (e) {
			toast({ kind: 'error', title: `${m.name} was not downloaded`, detail: errorText(e) });
		} finally {
			setBusy(({ [m.id]: _x, ...rest }) => rest);
			reload();
		}
	};

	const remove = async (m: SpeechModel) => {
		const ok = await confirmDialog({
			title: `Delete ${m.name}?`,
			body: `Frees ${formatBytes(m.sizeBytes)}. Transcripts already made are kept; download the model again to use it.`,
			confirmLabel: 'Delete',
			danger: true,
		});
		if (!ok) return;
		try {
			await client.call('speechModelDelete', { params: { modelId: m.id } });
		} catch (e) {
			toast({ kind: 'error', title: `${m.name} was not deleted`, detail: errorText(e) });
		}
		reload();
	};

	const cuda = probe?.cuda;
	const enableNvidia = async (on: boolean) => {
		if (!on) {
			await save({ nvidiaGpu: false });
			await reprobe();
			reload();
			return;
		}
		if (cuda && cuda.state !== 'installed') {
			const ok = await confirmDialog({
				title: 'Download the NVIDIA GPU provider?',
				body: `${formatBytes(cuda.downloadBytes)} from NuGet (ONNX Runtime ${cuda.ortVersion} CUDA provider, pinned and checked against its SHA-256). Licence: ${cuda.license}. The NVIDIA driver, CUDA 13 and cuDNN 9 are not included: install them from NVIDIA.`,
				confirmLabel: 'Accept Licence and Download',
			});
			if (!ok) return;
			setCudaBusy('Queued');
			try {
				const job = (await client.call('speechCudaInstall')) as EngineJob;
				const end = await followJob(client, job.id, {
					onUpdate: (j) =>
						setCudaBusy(j.progress !== null ? `${Math.round(j.progress * 100)} %` : (j.stage ?? j.state)),
				});
				if (end.state !== 'succeeded')
					toast({
						kind: 'error',
						title: 'The NVIDIA GPU provider was not installed',
						detail: end.error?.message ?? end.state,
					});
			} catch (e) {
				toast({ kind: 'error', title: 'The NVIDIA GPU provider was not installed', detail: errorText(e) });
			} finally {
				setCudaBusy(null);
			}
		} else await save({ nvidiaGpu: true });
		await reprobe();
		reload();
	};

	const removeCuda = async () => {
		const ok = await confirmDialog({
			title: 'Remove the NVIDIA GPU provider?',
			body: 'Transcription and upscaling use the CPU (or another GPU provider) until it is downloaded again.',
			confirmLabel: 'Remove',
			danger: true,
		});
		if (!ok) return;
		try {
			await client.call('speechCudaRemove');
		} catch (e) {
			toast({ kind: 'error', title: 'The NVIDIA GPU provider was not removed', detail: errorText(e) });
		}
		await reprobe();
		reload();
	};

	const gpuProviders = (probe?.providers ?? []).filter((p) => p.id !== 'cpu');
	const usable = gpuProviders.filter((p) => p.available);
	const chosen = probe?.chosen;

	return (
		<div className="flex flex-col gap-2" data-testid="prefs-speech">
			<PrefGroup title="Speech to text" testId="prefs-speech-status">
				<p className="text-pr-small text-pr-muted">
					Transcripts are made on this computer with OpenAI Whisper (ONNX Runtime, on the GPU when it helps);
					no audio leaves the machine. Models are downloaded once, on request.
				</p>
				{speech && speech.status !== 'ready' ? (
					<p className="text-pr-small text-pr-warning" role="alert">
						Speech to text is unavailable on this engine: {speech.reason}
					</p>
				) : speech?.reason ? (
					<p className="text-pr-small text-pr-warning" role="alert">
						{speech.reason}
					</p>
				) : null}
			</PrefGroup>
			<PrefGroup
				title="Processor"
				testId="prefs-speech-processor"
				actions={
					<Button variant="quiet" busy={probing} onClick={() => void reprobe()} data-testid="speech-reprobe">
						Check the GPUs again
					</Button>
				}
			>
				<div className="flex items-center gap-2">
					<Select
						label="Processor"
						className="w-56"
						disabled={!settings}
						value={settings?.processor ?? 'auto'}
						onValueChange={(v) => void save({ processor: v as 'auto' | 'cpu' | 'gpu' }).then(reload)}
						options={[
							{ value: 'auto', label: 'Automatic' },
							{ value: 'cpu', label: 'CPU' },
							{ value: 'gpu', label: 'GPU' },
						]}
					/>
					<Select
						label="Accuracy"
						className="w-56"
						disabled={!settings}
						value={settings?.accuracy ?? 'standard'}
						onValueChange={(v) => void save({ accuracy: v as 'standard' | 'best' }).then(reload)}
						options={[
							{ value: 'standard', label: 'Standard' },
							{ value: 'best', label: 'Best (slower)' },
						]}
					/>
				</div>
				{probeError ? (
					<p className="text-pr-small text-pr-danger" role="alert">
						{probeError}
					</p>
				) : null}
				{probe ? (
					<div className="flex flex-col gap-0.5 text-pr-small text-pr-muted" data-testid="speech-probe">
						<p>
							{usable.length
								? `GPU: ${probe.gpu?.name ?? 'GPU'} (${PROVIDER_NAMES[usable[0]!.id]})`
								: 'No GPU can be used: transcription runs on the CPU.'}{' '}
							· {probe.threads} threads
							{chosen
								? ` · encoder on ${PROVIDER_NAMES[chosen.encoder] ?? chosen.encoder}, decoder on ${PROVIDER_NAMES[chosen.decoder] ?? chosen.decoder}`
								: ''}
						</p>
						{settings?.processor === 'gpu' && !usable.length ? (
							<p className="text-pr-warning" role="alert">
								GPU is selected but unavailable; jobs run on the CPU and say why.
							</p>
						) : null}
						<ul className="flex flex-col">
							{gpuProviders.map((p) => (
								<li key={p.id} data-testid={`speech-provider-${p.id}`}>
									{PROVIDER_NAMES[p.id] ?? p.id}: {p.available ? (p.device ?? 'available') : p.reason}
								</li>
							))}
						</ul>
						<p className="text-pr-dim">
							Accuracy: Standard decodes greedily (with temperature fallback); Best searches 5 beams and is
							about 1.3–3× slower. With the GPU, the encoder runs there and the decoder on the CPU unless a
							short measurement shows the GPU faster.
						</p>
					</div>
				) : !probeError ? (
					<p className="text-pr-muted">Checking the GPUs…</p>
				) : null}
			</PrefGroup>
			{cuda && cuda.state !== 'unsupported' ? (
				<PrefGroup title="NVIDIA GPU (CUDA)" testId="prefs-speech-cuda">
					<Checkbox
						checked={!!settings?.nvidiaGpu}
						disabled={!settings || !!cudaBusy}
						onCheckedChange={(v) => void enableNvidia(v)}
						label="Enable NVIDIA GPU"
					/>
					<div
						className="flex flex-col gap-0.5 pl-6 text-pr-small text-pr-muted"
						data-testid="speech-cuda-status"
					>
						<p>
							CUDA provider (ONNX Runtime {cuda.ortVersion}):{' '}
							{cudaBusy
								? `downloading ${cudaBusy}`
								: cuda.state === 'installed'
									? 'downloaded'
									: cuda.state === 'damaged'
										? 'damaged — download it again'
										: `not downloaded (${formatBytes(cuda.downloadBytes)})`}
							{cuda.state === 'installed' && !cudaBusy ? (
								<Button variant="quiet" onClick={() => void removeCuda()} data-testid="speech-cuda-remove">
									Remove
								</Button>
							) : null}
						</p>
						<p>
							NVIDIA runtime:{' '}
							{cuda.runtime.ok
								? `${cuda.runtime.gpu ?? 'GPU'}${cuda.runtime.vramMb ? ` · ${Math.round(cuda.runtime.vramMb / 1024)} GB` : ''} · driver ${cuda.runtime.driverVersion}`
								: `missing ${cuda.runtime.missing.join(', ')}`}
						</p>
						{cuda.guidance ? <p className="text-pr-warning">{cuda.guidance}</p> : null}
					</div>
				</PrefGroup>
			) : null}
			<PrefGroup title="Transcribe on import" testId="prefs-speech-auto">
				<Checkbox
					checked={auto.enabled}
					onCheckedChange={(enabled) => setAuto({ enabled })}
					label="Automatically transcribe media with sound when it is imported"
				/>
				<div className="flex items-center gap-2 pl-6">
					<Select
						label="Model for automatic transcription"
						className="w-56"
						disabled={!auto.enabled}
						value={auto.model}
						onValueChange={(model) => setAuto({ model })}
						options={(models ?? []).map((m) => ({ value: m.id, label: m.name }))}
					/>
					<Select
						label="Language for automatic transcription"
						className="w-48"
						disabled={!auto.enabled || !autoModel?.multilingual}
						value={autoModel?.multilingual ? auto.language : 'en'}
						onValueChange={(language) => setAuto({ language })}
						options={[
							{ value: 'auto', label: 'Detect automatically' },
							...WHISPER_LANGUAGES.map(([value, label]) => ({ value, label })),
						]}
					/>
				</div>
				{auto.enabled && autoModel && !autoModel.installed ? (
					<p className="pl-6 text-pr-small text-pr-warning">Download {autoModel.name} below to use it.</p>
				) : null}
			</PrefGroup>
			<PrefGroup title="Speech models" testId="prefs-speech-models">
				{error ? (
					<p className="text-pr-small text-pr-danger" role="alert">
						{error}
					</p>
				) : null}
				{models === null && !error ? <p className="text-pr-muted">Loading…</p> : null}
				<ul className="flex flex-col gap-2">
					{models?.map((m) => (
						<li
							key={m.id}
							className="flex flex-col gap-0.5 rounded-pr-control border border-pr-border-subtle p-2"
							data-testid={`speech-model-${m.id}`}
						>
							<div className="flex items-center gap-2">
								<span className="min-w-0 truncate font-semibold text-pr-strong">{m.name}</span>
								{m.recommended ? (
									<span
										className="shrink-0 rounded-pr-control border border-pr-accent px-1 text-pr-small text-pr-accent"
										data-testid={`speech-model-${m.id}-recommended`}
									>
										Recommended for this computer
									</span>
								) : null}
								<span className="shrink-0 text-pr-small text-pr-muted">
									{m.parameters} M · {m.multilingual ? '99 languages' : 'English'} ·{' '}
									{formatBytes(m.sizeBytes)}
									{m.precision === 'fp16' ? ' · half precision (GPU)' : ''}
									{m.default ? ' · default' : ''}
								</span>
								<span className="ml-auto flex shrink-0 items-center gap-2">
									{m.installed ? (
										<>
											<span
												className="text-pr-small text-pr-success"
												data-testid={`speech-model-${m.id}-state`}
											>
												Downloaded
											</span>
											<Button
												variant="quiet"
												onClick={() => void remove(m)}
												data-testid={`speech-model-${m.id}-delete`}
											>
												Delete
											</Button>
										</>
									) : (
										<Button
											busy={!!busy[m.id]}
											onClick={() => void download(m)}
											data-testid={`speech-model-${m.id}-download`}
										>
											{busy[m.id] ? `Downloading ${busy[m.id]}` : 'Download'}
										</Button>
									)}
								</span>
							</div>
							<p className="text-pr-small text-pr-muted">{m.description}</p>
							{m.runsOn || m.speed ? (
								<p className="text-pr-small text-pr-dim" data-testid={`speech-model-${m.id}-runs-on`}>
									{[runsOnText(m), speedText(m)].filter(Boolean).join(' · ')}
								</p>
							) : null}
							<ModelLicence m={m} />
						</li>
					))}
				</ul>
			</PrefGroup>
		</div>
	);
}
