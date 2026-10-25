// wp fonts: Graphics ▸ Resolve Fonts… (Premiere's Resolve Fonts dialog, docs/wp-notes/fonts.md): the fonts this
// project's text and captions use that are neither bundled nor installed, with how many layers use each. "Install
// Font File…" (or dropping files on the dialog) adds fonts to the user library; the list follows at once, and the
// project's text renders with them without editing the project (documents name fonts by family / PostScript name).
import type { EditorSession } from '@jasper/session';
import { SessionProvider, useSessionState } from '@jasper/session/react';
import { Button, cx, Dialog, type HostedDialogProps } from '@jasper/ui';
import { Check, TriangleAlert } from 'lucide-react';
import { type DragEvent, useState } from 'react';
import { t } from '../i18n/runtime.ts';
import { addFontsWithFeedback, openFontPreferences, projectFontStatus } from './actions.ts';
import { useFonts } from './hooks.ts';

const layersText = (n: number) => (n === 1 ? t('1 layer') : t('{0} layers', n));
const tracksText = (n: number) => (n === 1 ? t('1 caption track') : t('{0} caption tracks', n));

function ResolveFontsBody(props: { session: EditorSession; close(): void }) {
	const doc = useSessionState((s) => s.document);
	const { catalog, status } = useFonts();
	const [busy, setBusy] = useState(false);
	const [dragging, setDragging] = useState(false);
	const used = projectFontStatus(doc, catalog).filter((s) => s.use.clips + s.use.tracks > 0);
	const missing = used.filter((s) => !s.available);
	const layers = layersText(missing.reduce((n, s) => n + s.use.clips, 0));
	const add = async (files?: File[]) => {
		setBusy(true);
		try {
			await addFontsWithFeedback(files);
		} finally {
			setBusy(false);
		}
	};
	const onDrop = (e: DragEvent) => {
		setDragging(false);
		const files = Array.from(e.dataTransfer.files ?? []);
		if (!files.length) return;
		e.preventDefault();
		void add(files);
	};
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: drop zone for font files (Add Fonts… is the keyboard path)
		<div
			className={cx(
				'flex flex-col gap-3 rounded-pr-control',
				dragging && 'outline outline-2 outline-pr-focus',
			)}
			data-testid="resolve-fonts"
			onDragOver={(e) => {
				if (Array.from(e.dataTransfer.items ?? []).some((i) => i.kind === 'file')) {
					e.preventDefault();
					setDragging(true);
				}
			}}
			onDragLeave={() => setDragging(false)}
			onDrop={onDrop}
		>
			{status !== 'ready' ? (
				<p className="text-pr-muted">
					{status === 'loading' ? 'Checking fonts…' : 'The engine is not connected: fonts cannot be checked.'}
				</p>
			) : missing.length === 0 ? (
				<p className="flex items-center gap-1 text-pr-text" data-testid="resolve-fonts-none">
					<Check size={14} className="text-pr-success" aria-hidden />
					Every font this project uses is available.
				</p>
			) : (
				<p className="text-pr-text">
					{missing.length === 1
						? t(
								'A font this project uses is not installed; {0} use the default font instead. Install the font files (TTF, OTF, TTC, WOFF, WOFF2) — or drop them here — and the project renders with them, in the editor and in exports.',
								layers,
							)
						: t(
								'{0} fonts this project uses are not installed; {1} use the default font instead. Install the font files (TTF, OTF, TTC, WOFF, WOFF2) — or drop them here — and the project renders with them, in the editor and in exports.',
								missing.length,
								layers,
							)}
				</p>
			)}
			<ul className="flex flex-col" aria-label="Fonts used by this project">
				{used.map((s) => (
					<li
						key={s.font.id}
						className="flex min-h-[32px] items-center gap-2 border-b border-pr-border-subtle py-1"
						data-testid="resolve-fonts-row"
						data-family={s.font.family}
						data-missing={s.available ? undefined : 'true'}
					>
						{s.available ? (
							<Check size={14} className="shrink-0 text-pr-success" aria-label="Available" />
						) : (
							<TriangleAlert size={14} className="shrink-0 text-pr-warning" aria-label="Missing" />
						)}
						<div className="min-w-0 flex-1">
							<div className="truncate font-semibold text-pr-strong">{s.font.family}</div>
							<div className="text-pr-small text-pr-muted">
								{s.use.clips > 0 ? layersText(s.use.clips) : null}
								{s.use.clips > 0 && s.use.tracks > 0 ? ' · ' : null}
								{s.use.tracks > 0 ? tracksText(s.use.tracks) : null}
								{' · '}
								{s.available
									? s.source === 'custom'
										? `Installed (${s.resolvedFamily})`
										: `Bundled (${s.resolvedFamily})`
									: 'Missing: uses the default font'}
							</div>
						</div>
						{s.available ? null : (
							<Button
								variant="secondary"
								disabled={busy || status !== 'ready'}
								onClick={() => void add()}
								data-testid="resolve-fonts-install"
							>
								Install Font File…
							</Button>
						)}
					</li>
				))}
			</ul>
			<div className="flex items-center gap-2">
				<Button
					variant="quiet"
					onClick={() => {
						props.close();
						openFontPreferences(props.session);
					}}
				>
					Manage Fonts…
				</Button>
			</div>
		</div>
	);
}

export function ResolveFontsDialog(props: HostedDialogProps<{ session: EditorSession }>) {
	return (
		<Dialog
			open
			onOpenChange={(o) => !o && props.close()}
			title="Resolve Fonts"
			size="medium"
			primaryLabel="Close"
			hideCancel
			onPrimary={() => {
				props.close();
			}}
			data-testid="resolve-fonts-dialog"
		>
			<SessionProvider session={props.session}>
				<ResolveFontsBody session={props.session} close={() => props.close()} />
			</SessionProvider>
		</Dialog>
	);
}
