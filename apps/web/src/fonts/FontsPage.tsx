// wp fonts: Edit ▸ Preferences ▸ Fonts — the font manager. Fonts installed here live on the engine (`<appdir>/fonts`)
// and are available in every project, like fonts installed on the computer: Add Fonts… (or drop files on the page),
// each face with a sample in its own font and its details, and Remove (after a confirmation that names the saved
// projects using it). Repairs the engine made when it opened the library are listed; a library written by a newer
// version is read-only.
import type { LibraryFont } from '@jasper/api';
import { Button, confirmDialog, cx, SearchField, toast } from '@jasper/ui';
import { TriangleAlert } from 'lucide-react';
import { type DragEvent, useMemo, useState } from 'react';
import { t } from '../i18n/runtime.ts';
import { errorText, formatBytes } from '../processing/engine-jobs.ts';
import { PrefGroup } from '../shell/preferences/GeneralPage.tsx';
import { addFontsWithFeedback } from './actions.ts';
import { useFonts } from './hooks.ts';
import { usePreviewFamily } from './preview.ts';
import { libraryFontUsage, removeLibraryFont } from './store.ts';

const SAMPLE = 'The quick brown fox jumps over the lazy dog 0123456789';

function Sample(props: { url: string; text: string }) {
	const [el, setEl] = useState<HTMLDivElement | null>(null);
	const family = usePreviewFamily(props.url, el);
	return (
		<div
			ref={setEl}
			className="truncate text-[18px] leading-[26px] text-pr-strong"
			style={family ? { fontFamily: `"${family}", var(--pr-font-ui, sans-serif)` } : undefined}
		>
			{family ? props.text : '\u00a0'}
		</div>
	);
}

async function removeFace(face: LibraryFont): Promise<void> {
	let usedBy = '';
	try {
		const usage = await libraryFontUsage(face.id);
		const n = usage.projects.length;
		const names = `${usage.projects
			.slice(0, 5)
			.map((p) => p.name)
			.join(', ')}${n > 5 ? ', …' : ''}`;
		if (n === 1)
			usedBy = t(
				'A saved project uses it ({0}): its text falls back to the default font until it is installed again.',
				names,
			);
		else if (n > 1)
			usedBy = t(
				'{0} saved projects use it ({1}): their text falls back to the default font until it is installed again.',
				n,
				names,
			);
	} catch {
		usedBy = '';
	}
	const ok = await confirmDialog({
		title: `Remove ${face.fullName}?`,
		body: (
			<div className="flex flex-col gap-2">
				<p>
					The font is removed from your font library and from every project on this computer. This cannot be
					undone.
				</p>
				{usedBy ? <p className="text-pr-warning">{usedBy}</p> : null}
			</div>
		),
		confirmLabel: 'Remove Font',
		danger: true,
	});
	if (!ok) return;
	try {
		await removeLibraryFont(face.id);
	} catch (e) {
		toast({ kind: 'error', title: 'Could not remove the font', detail: errorText(e), durationMs: 'sticky' });
	}
}

function FaceRow(props: { face: LibraryFont; readOnly: boolean }) {
	const f = props.face;
	const style = `${f.subfamily}${f.axes ? ' (variable)' : ''}`;
	return (
		<li
			className="flex items-start gap-3 border-b border-pr-border-subtle py-2"
			data-testid="fonts-face"
			data-font-id={f.id}
		>
			<div className="min-w-0 flex-1">
				<Sample url={`/fonts/library/${f.id}.${f.format}`} text={SAMPLE} />
				<div className="flex flex-wrap gap-x-3 text-pr-small text-pr-muted">
					<span className="text-pr-text">{style}</span>
					<span>Weight {f.weight}</span>
					{f.italic ? <span>Italic</span> : null}
					<span title="PostScript name">{f.postscriptName}</span>
					<span>{f.format.toUpperCase()}</span>
					<span>{formatBytes(f.sizeBytes)}</span>
					<span className="truncate" title={f.originalName}>
						{f.originalName}
						{f.collectionIndex !== undefined ? ` #${f.collectionIndex + 1}` : ''}
					</span>
				</div>
			</div>
			<Button
				variant="quiet"
				disabled={props.readOnly}
				onClick={() => void removeFace(f)}
				aria-label={`Remove ${f.fullName}`}
				data-testid="fonts-remove"
			>
				Remove
			</Button>
		</li>
	);
}

export function FontsPreferencesPage() {
	const { status, library, catalog, error } = useFonts();
	const [query, setQuery] = useState('');
	const [dragging, setDragging] = useState(false);
	const [busy, setBusy] = useState(false);
	const families = useMemo(() => {
		const q = query.trim().toLowerCase();
		const by = new Map<string, LibraryFont[]>();
		for (const f of library?.fonts ?? []) {
			if (q && ![f.family, f.fullName, f.postscriptName].some((n) => n.toLowerCase().includes(q))) continue;
			const list = by.get(f.family) ?? [];
			list.push(f);
			by.set(f.family, list);
		}
		return [...by.entries()]
			.sort((a, b) => a[0].localeCompare(b[0]))
			.map(([family, faces]) => ({
				family,
				faces: faces.sort((a, b) => a.weight - b.weight || Number(a.italic) - Number(b.italic)),
			}));
	}, [library, query]);
	// remote platform fonts (social-comment templates) are not text fonts: not listed
	const bundled = (catalog?.fonts ?? [])
		.filter((f) => f.source !== 'custom' && f.source !== 'remote')
		.map((f) => f.family);
	const bundledSet = new Set(bundled.map((f) => f.toLowerCase()));
	const readOnly = library?.readOnly ?? false;
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
		if (!readOnly) void add(files);
	};
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: drop zone for font files (Add Fonts… is the keyboard path)
		<div
			className={cx(
				'flex min-h-full flex-col gap-2 rounded-pr-control',
				dragging && 'outline outline-2 outline-pr-focus',
			)}
			data-testid="fonts-page"
			onDragOver={(e) => {
				if (!readOnly && Array.from(e.dataTransfer.items ?? []).some((i) => i.kind === 'file')) {
					e.preventDefault();
					setDragging(true);
				}
			}}
			onDragLeave={() => setDragging(false)}
			onDrop={onDrop}
		>
			<p className="text-pr-muted">
				Fonts you add here are available in every project, like fonts installed on your computer. Text whose
				font is not installed uses the default font until you add it. You can also drop font files (TTF, OTF,
				TTC, WOFF, WOFF2) on this page.
			</p>
			{status === 'offline' || status === 'error' ? (
				<p className="text-pr-warning">
					{status === 'offline'
						? 'The engine is not connected: fonts cannot be listed or added.'
						: `Fonts could not be loaded: ${error}`}
				</p>
			) : null}
			{readOnly ? (
				<p className="flex items-center gap-1 text-pr-warning">
					<TriangleAlert size={12} aria-hidden />
					This font library was written by a newer version of JasperEditor: it is read-only here.
				</p>
			) : null}
			{library?.repairs.length ? (
				<div
					className="rounded-pr-control border border-pr-border-subtle p-2 text-pr-small"
					data-testid="fonts-repairs"
				>
					<p className="font-semibold text-pr-strong">
						The font library was repaired when the engine started:
					</p>
					<ul className="list-disc pl-4 text-pr-muted">
						{library.repairs.map((r) => (
							<li key={r}>{r}</li>
						))}
					</ul>
				</div>
			) : null}
			<PrefGroup
				title="Installed Fonts"
				testId="fonts-installed"
				actions={
					<>
						{library ? (
							<span className="pr-tabular text-pr-small text-pr-muted">
								{library.fonts.length} / {library.limits.maxFonts} · {formatBytes(library.totalBytes)}
							</span>
						) : null}
						<Button
							variant="secondary"
							disabled={busy || readOnly || status !== 'ready'}
							onClick={() => void add()}
							data-testid="fonts-add"
						>
							{busy ? 'Adding…' : 'Add Fonts…'}
						</Button>
					</>
				}
			>
				{library && library.fonts.length > 0 ? (
					<SearchField
						value={query}
						onValueChange={setQuery}
						placeholder="Search installed fonts"
						aria-label="Search installed fonts"
						className="mb-1 w-64"
					/>
				) : null}
				{library && library.fonts.length === 0 ? (
					<p className="py-4 text-center text-pr-muted">
						No fonts installed yet. Add font files, or drop them here.
					</p>
				) : null}
				{families.map((fam) => (
					<section key={fam.family} className="pt-2" data-testid="fonts-family">
						<h4 className="flex items-center gap-2 font-semibold text-pr-strong">
							{fam.family}
							<span className="font-normal text-pr-small text-pr-muted">
								{fam.faces.length} {fam.faces.length === 1 ? 'style' : 'styles'}
							</span>
						</h4>
						{bundledSet.has(fam.family.toLowerCase()) ? (
							<p className="text-pr-small text-pr-muted">
								{t(
									'A bundled family has this name: text set in “{0}” uses the bundled faces; projects reach these files by their PostScript or full names.',
									fam.family,
								)}
							</p>
						) : null}
						<ul>
							{fam.faces.map((f) => (
								<FaceRow key={f.id} face={f} readOnly={readOnly} />
							))}
						</ul>
					</section>
				))}
			</PrefGroup>
			<PrefGroup title="Bundled Fonts" testId="fonts-bundled">
				<p className="text-pr-small text-pr-muted">Always available: {bundled.join(', ') || '—'}.</p>
			</PrefGroup>
		</div>
	);
}
