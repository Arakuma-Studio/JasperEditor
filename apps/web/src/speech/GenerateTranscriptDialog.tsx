// wp speech: "Generate Transcript…" (Premiere: Text ▸ Transcript ▸ Transcribe / "Create transcription"): model,
// language (auto-detect or one of Whisper's 99), translate to English, speaker labels (with an optional number of
// speakers), and for a sequence the audio analysis (clip media, or the sequence mix with "only In to Out"). A model
// that is not downloaded shows its size, source and licence and downloads in place (sha256-verified `model-download`
// job). Transcribe submits the jobs; the transcripts arrive through the watcher (jobs.ts).
// Spec 17 SC-074: "Names from: Off / Script / Script + glossary" carries up to 40 names (the script's proper nouns and
// English words, the personal glossary's spellings) into every window's prompt (`TranscribeOptions.glossary`).
import type { EngineJob, SpeechModel, SpeechSettings } from '@jasper/api';
import { readSequenceCleanup, transcriptForMedia } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { Button, Checkbox, Dialog, type HostedDialogProps, Select, toast } from '@jasper/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { t } from '../i18n/runtime.ts';
import { errorText, followJob, formatBytes } from '../processing/engine-jobs.ts';
import { type NamesFrom, promptTerms } from '../script-fix/model.ts';
import { useEngine } from '../state/engine.tsx';
import { transcribeMedia, transcribeSequenceMix } from './jobs.ts';
import {
	type GenerateOptions,
	languageName,
	loadOptions,
	requestOptions,
	runsOnText,
	saveOptions,
	sequenceMedia,
	sequenceName,
	speedText,
	WHISPER_LANGUAGES,
} from './model.ts';

export const GENERATE_TRANSCRIPT_DIALOG = 'speech.generateTranscript';

export type GenerateTranscriptTarget =
	| { kind: 'media'; mediaIds: string[] }
	| { kind: 'sequence'; sequenceId: string };

type Props = { session: EditorSession; target: GenerateTranscriptTarget };

/** The speech models, refreshed on demand. */
export function useSpeechModels(): { models: SpeechModel[] | null; error: string | null; reload(): void } {
	const { client } = useEngine();
	const [models, setModels] = useState<SpeechModel[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const reload = useCallback(() => {
		client
			.call('speechModels')
			.then((r) => {
				setModels(r.models as SpeechModel[]);
				setError(null);
			})
			.catch((e) => setError(errorText(e)));
	}, [client]);
	useEffect(reload, [reload]);
	return { models, error, reload };
}

/** The engine's Transcription preferences (Processor, Accuracy, NVIDIA GPU); null while loading or unavailable. */
export function useSpeechSettings(): {
	settings: SpeechSettings | null;
	save(patch: Partial<SpeechSettings>): Promise<void>;
	error: string | null;
} {
	const { client } = useEngine();
	const [settings, setSettings] = useState<SpeechSettings | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		let live = true;
		client
			.call('speechSettings')
			.then((s) => live && setSettings(s as SpeechSettings))
			.catch((e) => live && setError(errorText(e)));
		return () => {
			live = false;
		};
	}, [client]);
	const save = useCallback(
		async (patch: Partial<SpeechSettings>) => {
			try {
				setSettings((await client.call('speechSettingsUpdate', { body: patch })) as SpeechSettings);
				setError(null);
			} catch (e) {
				setError(errorText(e));
				toast({ kind: 'error', title: 'The Transcription preferences were not saved', detail: errorText(e) });
			}
		},
		[client],
	);
	return { settings, save, error };
}

/** Download one model through the engine, reporting progress text. */
export async function downloadModel(
	client: ReturnType<typeof useEngine>['client'],
	modelId: string,
	onProgress: (text: string) => void,
): Promise<EngineJob> {
	const job = (await client.call('speechModelInstall', { params: { modelId } })) as EngineJob;
	return followJob(client, job.id, {
		onUpdate: (j) =>
			onProgress(j.progress !== null ? `${Math.round(j.progress * 100)} %` : (j.stage ?? j.state)),
	});
}

export function ModelLicence({ m }: { m: SpeechModel }) {
	return (
		<div className="flex flex-col gap-0.5 text-pr-small text-pr-muted" data-testid={`speech-licence-${m.id}`}>
			<p>
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
			<p>{m.attribution}</p>
			<p className="text-pr-dim">
				Pinned revision {m.revision.slice(0, 12)}; every file is checked against its SHA-256.
			</p>
		</div>
	);
}

export function GenerateTranscriptDialog(props: HostedDialogProps<Props>) {
	const { session, target } = props;
	const { client } = useEngine();
	const { models, error, reload } = useSpeechModels();
	const { settings } = useSpeechSettings();
	const defaultModel = models?.find((m) => m.default)?.id ?? 'whisper-small';
	const [opts, setOpts] = useState<GenerateOptions | null>(null);
	const [downloading, setDownloading] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		if (models && !opts) {
			const o = loadOptions(defaultModel);
			if (!models.some((m) => m.id === o.model)) o.model = defaultModel;
			setOpts(o);
		}
	}, [models, opts, defaultModel]);
	const doc = session.getCommitted();
	const seq = target.kind === 'sequence' ? doc.sequences[target.sequenceId] : undefined;
	// A hundred entries: one array for the life of the dialog, so the list is not rebuilt whenever an option changes.
	const languageOptions = useMemo(
		() => [
			{ value: 'auto', label: 'Detect automatically' },
			...WHISPER_LANGUAGES.map(([value, label]) => ({ value, label })),
		],
		[],
	);
	const media = useMemo(
		() =>
			target.kind === 'media'
				? { all: target.mediaIds, transcribed: [] as string[] }
				: seq
					? sequenceMedia(doc, seq)
					: { all: [], transcribed: [] },
		[target, seq, doc],
	);
	const model = models?.find((m) => m.id === opts?.model);
	const set = (patch: Partial<GenerateOptions>) => setOpts((o) => (o ? { ...o, ...patch } : o));
	const hasInOut = !!seq && seq.inPoint !== null && seq.outPoint !== null;
	// SC-074: the script of the sequence (for media: the active sequence's), the glossary when asked for
	const scriptSeq = seq ?? (session.getState().activeSequenceId ? doc.sequences[session.getState().activeSequenceId!] : undefined);
	const script = useMemo(() => {
		try {
			return scriptSeq ? (readSequenceCleanup(scriptSeq).script ?? null) : null;
		} catch {
			return null;
		}
	}, [scriptSeq]);
	const namesFrom: NamesFrom = opts?.namesFrom ?? 'off';
	const [glossary, setGlossary] = useState<{ entries: { to: string; lang?: string; count?: number }[] | null; error: string | null }>({ entries: null, error: null });
	useEffect(() => {
		if (namesFrom !== 'script+glossary' || glossary.entries || glossary.error) return;
		let live = true;
		client
			.listGlossary()
			.then((r) => live && setGlossary({ entries: r.entries, error: null }))
			.catch((e) => live && setGlossary({ entries: null, error: errorText(e) }));
		return () => {
			live = false;
		};
	}, [namesFrom, client, glossary.entries, glossary.error]);
	const termLanguage = useMemo(() => {
		if (opts && model?.multilingual && opts.language !== 'auto') return opts.language;
		if (model && !model.multilingual) return 'en';
		for (const id of media.all) {
			const tr = transcriptForMedia(doc, id);
			if (tr?.language) return tr.language;
		}
		return null;
	}, [opts, model, media.all, doc]);
	const terms = useMemo(
		() => promptTerms(script?.text ?? null, termLanguage, namesFrom, glossary.entries ?? []),
		[script, termLanguage, namesFrom, glossary.entries],
	);

	const download = async () => {
		if (!model) return;
		setDownloading('Queued');
		try {
			const end = await downloadModel(client, model.id, setDownloading);
			if (end.state !== 'succeeded')
				toast({
					kind: 'error',
					title: `${model.name} was not downloaded`,
					detail: end.error?.message ?? end.state,
				});
		} catch (e) {
			toast({ kind: 'error', title: `${model.name} was not downloaded`, detail: errorText(e) });
		} finally {
			setDownloading(null);
			reload();
		}
	};

	const title =
		target.kind === 'sequence'
			? `Generate Transcript — ${sequenceName(doc, target.sequenceId)}`
			: target.mediaIds.length === 1
				? `Generate Transcript — ${doc.media[target.mediaIds[0]!]?.originalName ?? 'Media'}`
				: `Generate Transcripts — ${target.mediaIds.length} media`;

	const mediaToRun =
		target.kind === 'media'
			? media.all
			: opts?.replace
				? media.all
				: media.all.filter((id) => !media.transcribed.includes(id));
	const nothing = target.kind === 'sequence' && opts?.analysis === 'media' && mediaToRun.length === 0;

	const run = async () => {
		if (!opts || !model) return false;
		saveOptions(opts);
		const options = requestOptions(opts, model.multilingual, terms);
		setBusy(true);
		try {
			if (target.kind === 'sequence' && opts.analysis === 'mix') {
				await transcribeSequenceMix({
					engine: client,
					session,
					sequenceId: target.sequenceId,
					options,
					inOutOnly: opts.inOutOnly && hasInOut,
					replace: opts.replace,
				});
			} else {
				const r = await transcribeMedia({
					engine: client,
					session,
					mediaIds: mediaToRun,
					options,
					replace: opts.replace,
				});
				for (const f of r.failed)
					toast({ kind: 'warning', title: `${f.name}: not transcribed`, detail: f.message });
				if (!r.jobs.length) return false;
			}
			toast({
				kind: 'info',
				title: 'Transcribing…',
				detail:
					'Follow the progress in the Jobs panel; the transcript appears in Text ▸ Transcript when it is done.',
			});
			return true;
		} catch (e) {
			toast({ kind: 'error', title: 'Transcription not started', detail: errorText(e) });
			return false;
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog
			open
			onOpenChange={(o) => !o && props.close()}
			title={title}
			size="medium"
			primaryLabel="Transcribe"
			primaryDisabled={!opts || !model?.installed || busy || nothing || !!downloading}
			onPrimary={async () => {
				// the dialog closes itself (with a result) only when the jobs were submitted
				if (await run()) props.close(true);
				return false;
			}}
			data-testid="speech-dialog"
		>
			<div className="flex flex-col gap-3">
				{error ? (
					<p className="text-pr-small text-pr-danger" role="alert">
						{error}
					</p>
				) : null}
				{!opts || !models ? (
					<p className="text-pr-muted">Loading the speech models…</p>
				) : (
					<>
						<Row label="Model">
							<Select
								label="Model"
								className="w-96"
								value={opts.model}
								onValueChange={(model) => set({ model })}
								options={models.map((m) => ({
									value: m.id,
									label: `${m.name} · ${formatBytes(m.sizeBytes)}${m.installed ? '' : ' · download'}`,
								}))}
							/>
						</Row>
						{model && !model.installed ? (
							<div
								className="flex flex-col gap-1 rounded-pr-control border border-pr-border-subtle bg-pr-field-deep p-2"
								data-testid="speech-download"
							>
								<p className="text-pr-text">
									{model.name} is not on this computer yet (
									{formatBytes(model.missingBytes || model.sizeBytes)} to download). {model.description}
								</p>
								<ModelLicence m={model} />
								<div>
									<Button
										variant="primary"
										busy={!!downloading}
										onClick={() => void download()}
										data-testid="speech-download-button"
									>
										{downloading ? `Downloading ${downloading}` : 'Accept Licence and Download'}
									</Button>
								</div>
							</div>
						) : model ? (
							<p className="text-pr-small text-pr-muted">{model.description}</p>
						) : null}
						{model && (model.runsOn || model.speed) ? (
							<p className="text-pr-small text-pr-dim" data-testid="speech-runs-on">
								{[runsOnText(model), speedText(model)].filter(Boolean).join(' · ')}
							</p>
						) : null}
						<Row label="Accuracy">
							<Select
								label="Accuracy"
								className="w-56"
								value={opts.accuracy ?? settings?.accuracy ?? 'standard'}
								onValueChange={(v) => set({ accuracy: v as 'standard' | 'best' })}
								options={[
									{ value: 'standard', label: 'Standard' },
									{ value: 'best', label: 'Best (slower)' },
								]}
							/>
						</Row>
						<Row label="Language">
							<Select
								label="Language"
								className="w-56"
								disabled={!model?.multilingual}
								value={model?.multilingual ? opts.language : 'en'}
								onValueChange={(language) => set({ language })}
								options={languageOptions}
							/>
							{!model?.multilingual ? (
								<span className="text-pr-small text-pr-muted">English-only model</span>
							) : null}
						</Row>
						<Row label="">
							<Checkbox
								checked={!!model?.multilingual && opts.task === 'translate'}
								disabled={!model?.multilingual}
								onCheckedChange={(v) => set({ task: v ? 'translate' : 'transcribe' })}
								label="Translate to English"
							/>
						</Row>
						<Row label="">
							<Checkbox
								checked={opts.verbatim}
								onCheckedChange={(v) => set({ verbatim: v })}
								label="Keep filler words (verbatim: eh, um, so…)"
							/>
						</Row>
						<Row label={t('Names from')}>
							<span data-testid="speech-names-from">
								<Select
									label={t('Names from')}
									className="w-56"
									value={namesFrom}
									onValueChange={(v) => set({ namesFrom: v as NamesFrom })}
									options={[
										{ value: 'off', label: 'Off' },
										{ value: 'script', label: 'Script' },
										{ value: 'script+glossary', label: 'Script + glossary' },
									]}
								/>
							</span>
						</Row>
						{namesFrom !== 'off' ? (
							<p className="-mt-2 pl-[132px] text-pr-small text-pr-muted" data-testid="speech-names">
								{!script && namesFrom === 'script'
									? t('No script is attached to the sequence: attach one with Script… in Text ▸ Transcript')
									: glossary.error && namesFrom === 'script+glossary'
										? t('The speech glossary could not be read ({0}); only the script’s names are carried', glossary.error)
										: terms.length
											? t(
													'{0} names carried into the recognition prompt: {1}',
													terms.length,
													`${terms.slice(0, 8).join(', ')}${terms.length > 8 ? ', …' : ''}`,
												)
											: t('No names found to carry')}
							</p>
						) : null}
						<Row label="Speaker labels">
							<Select
								label="Speaker labels"
								className="w-56"
								value={opts.speakerLabels ? 'yes' : 'no'}
								onValueChange={(v) => set({ speakerLabels: v === 'yes' })}
								options={[
									{ value: 'no', label: "No, don't separate speakers" },
									{ value: 'yes', label: 'Yes, separate speakers' },
								]}
							/>
							{opts.speakerLabels ? (
								<Select
									label="Number of speakers"
									className="w-32"
									value={String(opts.speakerCount)}
									onValueChange={(v) => set({ speakerCount: Number(v) })}
									options={[
										{ value: '0', label: 'Automatic' },
										...Array.from({ length: 9 }, (_, i) => ({
											value: String(i + 2),
											label: `${i + 2} speakers`,
										})),
									]}
								/>
							) : null}
						</Row>
						{target.kind === 'sequence' ? (
							<>
								<Row label="Audio analysis">
									<Select
										label="Audio analysis"
										className="w-72"
										value={opts.analysis}
										onValueChange={(v) => set({ analysis: v as GenerateOptions['analysis'] })}
										options={[
											{ value: 'media', label: 'Clip media (a transcript per media)' },
											{ value: 'mix', label: 'Sequence mix (only what the sequence plays)' },
										]}
									/>
								</Row>
								{opts.analysis === 'mix' ? (
									<Row label="">
										<Checkbox
											checked={opts.inOutOnly && hasInOut}
											disabled={!hasInOut}
											onCheckedChange={(v) => set({ inOutOnly: v })}
											label="Transcribe only from In to Out"
										/>
									</Row>
								) : null}
							</>
						) : null}
						<Row label="">
							<Checkbox
								checked={opts.replace}
								onCheckedChange={(v) => set({ replace: v })}
								label={
									target.kind === 'sequence' && opts.analysis === 'media'
										? 'Transcribe media that already have a transcript again'
										: 'Replace existing transcripts'
								}
							/>
						</Row>
						<p className="text-pr-small text-pr-muted" data-testid="speech-summary">
							{target.kind === 'sequence' && opts.analysis === 'mix'
								? `The mix of ${seq ? sequenceName(doc, seq.id) : 'the sequence'} is transcribed; its words go to the media of the clips they are heard through.`
								: nothing
									? media.all.length
										? 'Every clip media already has a transcript.'
										: 'The sequence has no audio clips to transcribe.'
									: `${mediaToRun.length} media will be transcribed${
											opts.language !== 'auto' && model?.multilingual
												? ` in ${languageName(opts.language)}`
												: ''
										}. Runs on this computer; nothing is uploaded.`}
						</p>
					</>
				)}
			</div>
		</Dialog>
	);
}

function Row(props: { label: string; children: React.ReactNode }) {
	return (
		<div className="grid min-h-[28px] grid-cols-[120px_minmax(0,1fr)] items-center gap-3">
			<span className="text-pr-muted">{props.label}</span>
			<div className="flex min-w-0 items-center gap-2">{props.children}</div>
		</div>
	);
}
