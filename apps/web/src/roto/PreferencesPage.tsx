// parity roto: Edit ▸ Preferences ▸ Roto & Face Tracking — the segmentation (Segment Anything 2.1) and face (MediaPipe
// Face Landmarker) models of the engine's catalogue: name, size, licence and source; Download (after the licence is
// shown, with progress) and Delete.
import type { EngineJob, VisionModel } from '@jasper/api';
import { Button, confirmDialog, toast } from '@jasper/ui';
import { useCallback, useEffect, useState } from 'react';
import { errorText, followJob, formatBytes } from '../processing/engine-jobs.ts';
import { PrefGroup } from '../shell/preferences/GeneralPage.tsx';
import { useEngine } from '../state/engine.tsx';

export function useVisionModels() {
	const { client } = useEngine();
	const [models, setModels] = useState<VisionModel[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const reload = useCallback(() => {
		client
			.call('rotoModels')
			.then((r) => {
				setModels((r as { models: VisionModel[] }).models);
				setError(null);
			})
			.catch((e) => setError(errorText(e)));
	}, [client]);
	useEffect(reload, [reload]);
	return { models, error, reload };
}

export function RotoPreferencesPage() {
	const { client, capabilities } = useEngine();
	const { models, error, reload } = useVisionModels();
	const [busy, setBusy] = useState<Record<string, string>>({});
	const roto = (capabilities?.features as { roto?: { status: string; reason?: string } } | undefined)?.roto;

	const download = async (m: VisionModel) => {
		const ok = await confirmDialog({
			title: `Download ${m.name}?`,
			body: `${formatBytes(m.missingBytes || m.sizeBytes)} from Hugging Face (pinned revision ${m.revision.slice(0, 12)}), checked against its SHA-256. Licence: ${m.license}. ${m.attribution}.`,
			confirmLabel: 'Accept Licence and Download',
		});
		if (!ok) return;
		setBusy((s) => ({ ...s, [m.id]: 'Queued' }));
		try {
			const job = (await client.call('rotoModelInstall', { params: { modelId: m.id } })) as EngineJob;
			const end = await followJob(client, job.id, {
				onUpdate: (j) =>
					setBusy((s) => ({
						...s,
						[m.id]: j.progress !== null ? `${Math.round(j.progress * 100)} %` : (j.stage ?? j.state),
					})),
			});
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

	const remove = async (m: VisionModel) => {
		const ok = await confirmDialog({
			title: `Delete ${m.name}?`,
			body: `Frees ${formatBytes(m.sizeBytes)}. Computed mattes are kept; download the model again to use it.`,
			confirmLabel: 'Delete',
			danger: true,
		});
		if (!ok) return;
		try {
			await client.call('rotoModelDelete', { params: { modelId: m.id } });
		} catch (e) {
			toast({ kind: 'error', title: `${m.name} was not deleted`, detail: errorText(e) });
		}
		reload();
	};

	return (
		<div className="flex flex-col gap-2" data-testid="prefs-roto">
			<PrefGroup title="Roto Brush and face tracking" testId="prefs-roto-status">
				<p className="text-pr-small text-pr-muted">
					Objects are segmented on this computer (ONNX Runtime, CPU). Without the segmentation model the Roto
					Brush uses colour graph cuts only; face tracking needs the face model. Models are downloaded once,
					on request.
				</p>
				{roto && roto.status !== 'ready' ? (
					<p className="text-pr-small text-pr-warning" role="alert">
						Roto is unavailable on this engine: {roto.reason}
					</p>
				) : null}
			</PrefGroup>
			<PrefGroup title="Models" testId="prefs-roto-models">
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
							data-testid={`roto-model-${m.id}`}
						>
							<div className="flex items-center gap-2">
								<span className="min-w-0 truncate font-semibold text-pr-strong">{m.name}</span>
								<span className="shrink-0 text-pr-small text-pr-muted">
									{m.task === 'face' ? 'Face tracking' : 'Segmentation'} · {formatBytes(m.sizeBytes)}
								</span>
								<span className="ml-auto flex shrink-0 items-center gap-2">
									{m.installed ? (
										<>
											<span
												className="text-pr-small text-pr-success"
												data-testid={`roto-model-${m.id}-state`}
											>
												Downloaded
											</span>
											<Button
												variant="quiet"
												onClick={() => void remove(m)}
												data-testid={`roto-model-${m.id}-delete`}
											>
												Delete
											</Button>
										</>
									) : (
										<Button
											busy={!!busy[m.id]}
											onClick={() => void download(m)}
											data-testid={`roto-model-${m.id}-download`}
										>
											{busy[m.id] ? `Downloading ${busy[m.id]}` : 'Download'}
										</Button>
									)}
								</span>
							</div>
							<p className="text-pr-small text-pr-muted">{m.description}</p>
							<p className="text-pr-small text-pr-muted">
								Licence: <span className="text-pr-text">{m.license}</span> ·{' '}
								<a
									href={m.licenseUrl}
									target="_blank"
									rel="noreferrer"
									className="text-pr-accent underline underline-offset-2"
								>
									Licence text
								</a>{' '}
								·{' '}
								<a
									href={m.sourceUrl}
									target="_blank"
									rel="noreferrer"
									className="text-pr-accent underline underline-offset-2"
								>
									Source
								</a>
							</p>
							<p className="text-pr-small text-pr-muted">{m.attribution}</p>
						</li>
					))}
				</ul>
			</PrefGroup>
		</div>
	);
}
