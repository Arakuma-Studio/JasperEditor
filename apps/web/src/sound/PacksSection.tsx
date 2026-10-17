// Preferences ▸ Sound Library ▸ Packs (spec 12 §2.7 "packs", P6-R1; wp-note "Phase 6 → WP6.1 sound packs"): the
// engine's pack catalogue with what is installed — name, author, licence badge and links, sizes, sound count and state.
// Install shows the licence first ("Accept Licence and Download"), then follows the `sound-pack-install` job (also in
// the Jobs panel) and the index job after it; Remove asks first. A pack an agent is installing shows its progress here
// too. Every engine call is answered or caught: a dead engine shows a message, never an unhandled rejection.
import type { EngineJob, SoundPackInfo, SoundPacksResponse } from '@jasper/api';
import { SoundPackInstallResultSchema } from '@jasper/api';
import { Button, confirmDialog, toast } from '@jasper/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../i18n/runtime.ts';
import { errorText, followJob, formatBytes } from '../processing/engine-jobs.ts';
import { PrefGroup } from '../shell/preferences/GeneralPage.tsx';
import { useEngine } from '../state/engine.tsx';
import { licenseBadge } from './model.ts';

let focusOnOpen = false;
/** The next Packs section to mount scrolls into view and takes focus (Library ▸ Install Sound Packs…). */
export function requestPacksFocus(): void {
	focusOnOpen = true;
}

/** The host of a URL, for "from kenney.nl" (the URL itself when it does not parse). */
export function hostOf(url: string | null): string {
	if (!url) return '';
	try {
		return new URL(url).host || url;
	} catch {
		return url;
	}
}

/** What the confirmation says before anything is downloaded: size, origin, checks, licence, credit, evidence. */
export function installConfirmBody(p: SoundPackInfo): string {
	const parts = [
		t(
			'{0} download from {1}, checked against its pinned SHA-256; {2} sounds, {3} on disk.',
			formatBytes(p.downloadBytes),
			hostOf(p.downloadUrl ?? p.pageUrl),
			p.sounds,
			formatBytes(p.installBytes),
		),
		t('Licence: {0} ({1}).', p.license, p.licenseUrl ?? ''),
		p.attribution ? t('Credit required: {0}', p.attribution) : t('No credit is required.'),
	];
	// one mention per site and day (a pack page and its archive's licence file are both on the author's site)
	const checked = [...new Set(p.licenseEvidence.map((e) => `${hostOf(e.url)} (${e.checkedAt})`))];
	if (checked.length) parts.push(t('Licence checked on {0}.', checked.join(', ')));
	return parts.join(' ');
}

export function packStateLabel(p: SoundPackInfo): string {
	if (p.job) return t('Installing…');
	switch (p.state) {
		case 'installed':
			return t('Installed');
		case 'outdated':
			return t('Update available');
		case 'damaged':
			return t('Damaged: install it again or remove it');
		default:
			return t('Not installed');
	}
}

const jobText = (j: EngineJob) =>
	j.progress !== null && j.progress !== undefined
		? `${j.stage ?? t('Downloading')} ${Math.round(j.progress * 100)} %`
		: (j.stage ?? j.state);

export function PacksSection() {
	const { client: engine, subscribe } = useEngine();
	const [data, setData] = useState<SoundPacksResponse | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState<Record<string, string>>({});
	const ref = useRef<HTMLElement | null>(null);

	const load = useCallback(
		() =>
			void engine
				.listSoundPacks()
				.then((r) => {
					setData(r);
					setError(null);
				})
				.catch((e) => setError(errorText(e))),
		[engine],
	);
	useEffect(() => load(), [load]);
	useEffect(
		() =>
			subscribe((e) => {
				if (e?.type === 'sounds.changed') load();
			}),
		[subscribe, load],
	);
	// A job someone else started (an agent, another window): follow it until it ends.
	const external = data?.packs.some((p) => p.job && !busy[p.id]) ?? false;
	useEffect(() => {
		if (!external) return;
		const timer = setInterval(load, 1500);
		return () => clearInterval(timer);
	}, [external, load]);
	useEffect(() => {
		if (!focusOnOpen || !data) return;
		focusOnOpen = false;
		ref.current?.scrollIntoView?.({ block: 'start' });
		ref.current?.focus();
	}, [data]);

	const install = async (p: SoundPackInfo) => {
		const ok = await confirmDialog({
			title: t('Install “{0}”?', p.title),
			body: installConfirmBody(p),
			confirmLabel: 'Accept Licence and Download',
		});
		if (!ok) return;
		setBusy((s) => ({ ...s, [p.id]: t('Queued') }));
		try {
			const job = await engine.installSoundPack(p.id);
			const end = await followJob(engine, job.id, {
				onUpdate: (j) => setBusy((s) => ({ ...s, [p.id]: jobText(j) })),
			});
			if (end.state !== 'succeeded') {
				toast({
					kind: 'error',
					title: t('“{0}” was not installed', p.title),
					detail: end.error?.message ?? end.state,
				});
				return;
			}
			load();
			const r = SoundPackInstallResultSchema.safeParse(end.result);
			if (r.success && r.data.indexJobId) {
				setBusy((s) => ({ ...s, [p.id]: t('Adding its sounds to the library…') }));
				await followJob(engine, r.data.indexJobId);
			}
			toast({ kind: 'success', title: t('Installed “{0}”: {1} sounds', p.title, p.sounds) });
		} catch (e) {
			toast({ kind: 'error', title: t('“{0}” was not installed', p.title), detail: errorText(e) });
		} finally {
			setBusy(({ [p.id]: _x, ...rest }) => rest);
			load();
		}
	};

	const remove = async (p: SoundPackInfo) => {
		const ok = await confirmDialog({
			title: t('Remove “{0}”?', p.title),
			body: t(
				'Its {0} sounds leave the sound library and {1} are freed. Projects that already use them keep their own copies; install the pack again to get them back.',
				p.sounds,
				formatBytes(p.installedBytes ?? p.installBytes),
			),
			confirmLabel: 'Remove',
			danger: true,
		});
		if (!ok) return;
		setBusy((s) => ({ ...s, [p.id]: t('Removing…') }));
		try {
			const r = await engine.removeSoundPack(p.id);
			toast({
				kind: 'info',
				title: t('Removed “{0}”: {1} sounds left the library', p.title, r.removedSounds),
			});
		} catch (e) {
			toast({ kind: 'error', title: t('“{0}” was not removed', p.title), detail: errorText(e) });
		} finally {
			setBusy(({ [p.id]: _x, ...rest }) => rest);
			load();
		}
	};

	return (
		<section
			ref={ref}
			tabIndex={-1}
			aria-label="Sound packs"
			className="outline-none"
			data-testid="sound-prefs-packs"
		>
			<PrefGroup title="Packs">
				<p className="text-pr-small text-pr-muted">
					Downloadable sound packs, installed on this computer from their authors&rsquo; sites (nothing is
					downloaded until you install one). Every file is checked against its pinned SHA-256.
				</p>
				{error ? (
					<p className="text-pr-small text-pr-danger" role="alert">
						{t('The packs are not available: {0}', error)}
					</p>
				) : null}
				{data === null && !error ? <p className="text-pr-muted">Loading…</p> : null}
				{data && data.packs.length === 0 ? (
					<p className="text-pr-muted">This engine offers no sound packs.</p>
				) : null}
				<ul className="flex flex-col gap-2" aria-label="Sound packs">
					{data?.packs.map((p) => {
						const badge = licenseBadge({ license: p.license, source: { type: 'pack' } });
						const progress = busy[p.id] ?? (p.job ? jobText(p.job) : null);
						const working = !!busy[p.id] || !!p.job;
						const installedState = p.state !== 'available';
						return (
							<li
								key={p.id}
								className="flex flex-col gap-1 rounded-pr-control border border-pr-border-subtle p-2"
								data-sound-pack={p.id}
								data-pack-state={p.state}
							>
								<div className="flex items-center gap-2">
									<span className="min-w-0 truncate font-semibold text-pr-strong">{p.title}</span>
									<span
										className={
											badge.warn
												? 'shrink-0 rounded-[2px] border border-pr-warning px-1 text-pr-small leading-[14px] text-pr-warning'
												: 'shrink-0 rounded-[2px] border border-pr-border-strong px-1 text-pr-small leading-[14px] text-pr-muted'
										}
										title={badge.title}
										data-license-badge={badge.text}
									>
										{badge.text}
									</span>
									<span className="min-w-0 flex-1 truncate text-pr-small text-pr-muted">{p.author}</span>
									{p.inCatalog && p.state !== 'installed' ? (
										<Button
											variant={p.state === 'available' ? 'secondary' : 'primary'}
											disabled={working}
											aria-label={t('Install {0}', p.title)}
											onClick={() => void install(p)}
											data-testid={`sound-pack-install-${p.id}`}
										>
											{p.state === 'available'
												? t('Install…')
												: p.state === 'outdated'
													? t('Update…')
													: t('Repair…')}
										</Button>
									) : null}
									{installedState ? (
										<Button
											variant="quiet"
											disabled={working}
											aria-label={t('Remove {0}', p.title)}
											onClick={() => void remove(p)}
											data-testid={`sound-pack-remove-${p.id}`}
										>
											Remove
										</Button>
									) : null}
								</div>
								<p className="text-pr-small text-pr-muted">
									{t(
										'{0} sounds · {1} download · {2} on disk',
										p.sounds,
										formatBytes(p.downloadBytes),
										formatBytes(p.installBytes),
									)}
									{' · '}
									<span data-testid={`sound-pack-state-${p.id}`}>{packStateLabel(p)}</span>
									{p.state === 'installed' ? ` · ${t('{0} in the library', p.indexedSounds)}` : ''}
								</p>
								{p.description ? <p className="text-pr-small text-pr-dim">{p.description}</p> : null}
								<p className="text-pr-small text-pr-muted">
									{t('Licence: {0}', p.license)}
									{p.licenseUrl ? (
										<>
											{' · '}
											<a
												href={p.licenseUrl}
												target="_blank"
												rel="noreferrer"
												className="text-pr-accent underline underline-offset-2"
											>
												Licence text
											</a>
										</>
									) : null}
									{p.pageUrl ? (
										<>
											{' · '}
											<a
												href={p.pageUrl}
												target="_blank"
												rel="noreferrer"
												className="text-pr-accent underline underline-offset-2"
											>
												Pack page
											</a>
										</>
									) : null}
									{' · '}
									{p.attribution ? t('Credit: {0}', p.attribution) : t('No credit required')}
								</p>
								{progress ? (
									<p
										className="text-pr-small text-pr-text"
										role="status"
										data-testid={`sound-pack-progress-${p.id}`}
									>
										{progress}
									</p>
								) : null}
							</li>
						);
					})}
				</ul>
				{data?.catalogErrors.length ? (
					<p className="text-pr-small text-pr-warning">
						{t(
							'{0} catalogue entries were skipped: {1}',
							data.catalogErrors.length,
							data.catalogErrors.slice(0, 3).join('; '),
						)}
					</p>
				) : null}
			</PrefGroup>
		</section>
	);
}
