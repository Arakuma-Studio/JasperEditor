// wp speech: Edit ▸ Preferences ▸ Speech — the speech-to-text models of the engine's model catalogue: name, size,
// languages, licence and source; Download (after the licence is shown, with progress) and Delete.
import type { SpeechModel } from '@jasper/api';
import { Button, confirmDialog, toast } from '@jasper/ui';
import { useState } from 'react';
import { errorText, formatBytes } from '../processing/engine-jobs.ts';
import { PrefGroup } from '../shell/preferences/GeneralPage.tsx';
import { useEngine } from '../state/engine.tsx';
import { downloadModel, ModelLicence, useSpeechModels } from './GenerateTranscriptDialog.tsx';

export function SpeechPreferencesPage() {
	const { client, capabilities } = useEngine();
	const { models, error, reload } = useSpeechModels();
	const [busy, setBusy] = useState<Record<string, string>>({});
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

	return (
		<div className="flex flex-col gap-2" data-testid="prefs-speech">
			<PrefGroup title="Speech to text" testId="prefs-speech-status">
				<p className="text-pr-small text-pr-muted">
					Transcripts are made on this computer with OpenAI Whisper (ONNX Runtime, CPU); no audio leaves the
					machine. Models are downloaded once, on request.
				</p>
				{speech && speech.status !== 'ready' ? (
					<p className="text-pr-small text-pr-warning" role="alert">
						Speech to text is unavailable on this engine: {speech.reason}
					</p>
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
								<span className="shrink-0 text-pr-small text-pr-muted">
									{m.parameters} M · {m.multilingual ? '99 languages' : 'English'} ·{' '}
									{formatBytes(m.sizeBytes)}
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
							<ModelLicence m={m} />
						</li>
					))}
				</ul>
			</PrefGroup>
		</div>
	);
}
