// Preferences ▸ Sound Library ▸ Describe-it search (spec 12 P6-E14, WP-E9; wp-note "Phase 6 → WP-E9"): the optional
// audio-text model — what it is, its licence, attribution and size; Accept Licence and Download (the licence first,
// then the `model-download` job's progress, then the library's embedding job); a model whose download location is
// not settled says so instead ("Not available yet"); Remove asks first. Every engine call is answered or caught: a dead
// engine shows a message, never an unhandled rejection.
import type { EngineJob, SoundSemanticModel, SoundSemanticStatus } from '@jasper/api';
import { Button, confirmDialog, toast } from '@jasper/ui';
import { useCallback, useEffect, useState } from 'react';
import { t } from '../i18n/runtime.ts';
import { errorText, followJob, formatBytes } from '../processing/engine-jobs.ts';
import { PrefGroup } from '../shell/preferences/GeneralPage.tsx';
import { useEngine } from '../state/engine.tsx';

const jobText = (j: EngineJob) =>
	j.progress !== null && j.progress !== undefined
		? `${j.stage ?? t('Working')} ${Math.round(j.progress * 100)} %`
		: (j.stage ?? j.state);

/** What the confirmation says before anything is downloaded. */
export function describeInstallBody(m: SoundSemanticModel): string {
	return [
		t(
			'{0} download from the model’s own repository (pinned revision {1}), every file checked against its SHA-256; {2} on disk.',
			formatBytes(m.missingBytes || m.sizeBytes),
			m.revision.slice(0, 12),
			formatBytes(m.sizeBytes),
		),
		t('Licence: {0} ({1}).', m.license, m.licenseUrl),
		/[.!?]$/.test(m.attribution.trim()) ? m.attribution.trim() : `${m.attribution.trim()}.`,
		t(
			'It only analyses sounds (search and Find Moment); it never makes sounds, and no audio leaves this computer.',
		),
	].join(' ');
}

export function DescribeSearchSection() {
	const { client: engine } = useEngine();
	const [status, setStatus] = useState<SoundSemanticStatus | null>(null);
	const [models, setModels] = useState<SoundSemanticModel[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);

	const load = useCallback(
		() =>
			// an async body: a client without these calls (an older engine's) fails into `error`, never throws here
			void (async () => {
				const [st, m] = await Promise.all([engine.soundSemanticStatus(), engine.soundSemanticModels()]);
				setStatus(st);
				setModels(m.models);
				setError(null);
			})().catch((e) => setError(errorText(e))),
		[engine],
	);
	useEffect(() => load(), [load]);
	// A job someone else started (an agent, the engine after an index): follow it until it ends.
	const external = !busy && (!!status?.job || !!models?.some((m) => m.job));
	useEffect(() => {
		if (!external) return;
		const timer = setInterval(load, 1500);
		return () => clearInterval(timer);
	}, [external, load]);

	const install = async (m: SoundSemanticModel) => {
		const ok = await confirmDialog({
			title: t('Download {0}?', m.name),
			body: describeInstallBody(m),
			confirmLabel: 'Accept Licence and Download',
		});
		if (!ok) return;
		setBusy(t('Queued'));
		try {
			const job = await engine.installSoundSemanticModel(m.id);
			const end = await followJob(engine, job.id, { onUpdate: (j) => setBusy(jobText(j)) });
			if (end.state !== 'succeeded') {
				toast({
					kind: 'error',
					title: t('{0} was not downloaded', m.name),
					detail: end.error?.message ?? end.state,
				});
				return;
			}
			toast({
				kind: 'success',
				title: t('{0} is installed: the library is being prepared for Describe-it search', m.name),
			});
		} catch (e) {
			toast({ kind: 'error', title: t('{0} was not downloaded', m.name), detail: errorText(e) });
		} finally {
			setBusy(null);
			load();
		}
	};

	const prepare = async () => {
		setBusy(t('Queued'));
		try {
			const job = await engine.embedSounds({});
			const end = await followJob(engine, job.id, { onUpdate: (j) => setBusy(jobText(j)) });
			if (end.state !== 'succeeded')
				toast({
					kind: 'error',
					title: t('The library was not prepared'),
					detail: end.error?.message ?? end.state,
				});
		} catch (e) {
			toast({ kind: 'error', title: t('The library was not prepared'), detail: errorText(e) });
		} finally {
			setBusy(null);
			load();
		}
	};

	const remove = async (m: SoundSemanticModel) => {
		const ok = await confirmDialog({
			title: t('Remove {0}?', m.name),
			body: t(
				'Frees {0} and deletes the cached embeddings. Describe-it search and Find Moment stop working (search uses the words again) until you download the model again.',
				formatBytes(m.sizeBytes),
			),
			confirmLabel: 'Remove',
			danger: true,
		});
		if (!ok) return;
		setBusy(t('Removing…'));
		try {
			await engine.removeSoundSemanticModel(m.id);
			toast({ kind: 'info', title: t('Removed {0}', m.name) });
		} catch (e) {
			toast({ kind: 'error', title: t('{0} was not removed', m.name), detail: errorText(e) });
		} finally {
			setBusy(null);
			load();
		}
	};

	const progress = busy ?? (status?.job ? jobText(status.job) : null);
	return (
		<section aria-label="Describe-it search" data-testid="sound-prefs-describe">
			<PrefGroup title="Describe-it search">
				<p className="text-pr-small text-pr-muted">
					Find sounds by what they sound like (&ldquo;glass shattering on concrete&rdquo;), even in folders of
					files named SFX_0023.wav, and the best moment of a long recording. It needs an optional model (LAION
					CLAP, about 780 MB) that runs on this computer; without it, Describe searches the words.
				</p>
				{error ? (
					<p className="text-pr-small text-pr-danger" role="alert">
						{t('Describe-it search is not available: {0}', error)}
					</p>
				) : null}
				{status?.status === 'unavailable' && status.reason ? (
					<p className="text-pr-small text-pr-warning" role="alert">
						{t('Describe-it search cannot run on this engine: {0}', status.reason)}
					</p>
				) : null}
				{models === null && !error ? <p className="text-pr-muted">Loading…</p> : null}
				<ul className="flex flex-col gap-2" aria-label="Describe-it search models">
					{models?.map((m) => (
						<li
							key={m.id}
							className="flex flex-col gap-1 rounded-pr-control border border-pr-border-subtle p-2"
							data-testid={`describe-model-${m.id}`}
							data-model-state={m.installed ? 'installed' : m.available ? 'available' : 'pending'}
						>
							<div className="flex items-center gap-2">
								<span className="min-w-0 truncate font-semibold text-pr-strong">{m.name}</span>
								<span className="shrink-0 rounded-[2px] border border-pr-border-strong px-1 text-pr-small leading-[14px] text-pr-muted">
									{m.license}
								</span>
								<span className="min-w-0 flex-1 truncate text-pr-small text-pr-muted">
									{t('{0} on disk', formatBytes(m.sizeBytes))}
								</span>
								{m.installed ? (
									<>
										<span
											className="text-pr-small text-pr-success"
											data-testid={`describe-model-${m.id}-state`}
										>
											Installed
										</span>
										<Button
											variant="quiet"
											disabled={!!busy || !!m.job}
											onClick={() => void remove(m)}
											data-testid={`describe-model-${m.id}-remove`}
										>
											Remove
										</Button>
									</>
								) : m.available ? (
									<Button
										busy={!!busy || !!m.job}
										onClick={() => void install(m)}
										data-testid={`describe-model-${m.id}-install`}
									>
										Download…
									</Button>
								) : (
									<Button disabled data-testid={`describe-model-${m.id}-pending`}>
										Download…
									</Button>
								)}
							</div>
							<p className="text-pr-small text-pr-muted">{m.description}</p>
							{!m.installed && !m.available ? (
								<p
									className="text-pr-small text-pr-warning"
									data-testid={`describe-model-${m.id}-pending-text`}
								>
									{m.unavailableReason ?? 'Not available yet: the model download location is pending'}
								</p>
							) : null}
							<p className="text-pr-small text-pr-dim">
								{m.attribution}
								{' · '}
								<a
									href={m.licenseUrl}
									target="_blank"
									rel="noreferrer"
									className="text-pr-accent underline underline-offset-2"
								>
									Licence text
								</a>
								{' · '}
								<a
									href={m.sourceUrl}
									target="_blank"
									rel="noreferrer"
									className="text-pr-accent underline underline-offset-2"
								>
									Model page
								</a>
							</p>
						</li>
					))}
				</ul>
				{status?.status === 'ready' ? (
					<div className="flex items-center gap-2">
						<p className="text-pr-small text-pr-muted" data-testid="describe-embedded">
							{t('{0} of {1} sounds are ready for Describe-it search', status.embedded, status.total)}
						</p>
						{status.embedded < status.total && !status.job && !busy ? (
							<Button variant="secondary" onClick={() => void prepare()} data-testid="describe-prepare">
								Prepare now
							</Button>
						) : null}
					</div>
				) : null}
				{progress ? (
					<p className="text-pr-small text-pr-text" role="status" data-testid="describe-progress">
						{progress}
					</p>
				) : null}
			</PrefGroup>
		</section>
	);
}
