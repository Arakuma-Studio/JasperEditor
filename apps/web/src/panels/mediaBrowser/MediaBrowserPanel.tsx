import type { BrowseCategory, BrowseEntry, BrowseInfo, BrowseList, BrowseRoots } from '@jasper/api';
import { EngineError } from '@jasper/engine-client';
import { useSessionOrNull, useStoreSelector } from '@jasper/session/react';
import {
	Button,
	Checkbox,
	cx,
	EmptyState,
	Icon,
	IconButton,
	type IconId,
	SearchField,
	Select,
	TextField,
	toast,
} from '@jasper/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../../i18n/runtime.ts';
import { EngineImportService } from '../../import/service.ts';
import { useEngine } from '../../state/engine.tsx';
import { getImportService, writeHostPathsDrag } from '../../state/services.ts';
import { activeProjectBin } from '../project/instances.ts';
import type { PanelProps } from '../types.ts';
import { type MediaBrowserHandle, registerMediaBrowser } from './instances.ts';

const PREFS_KEY = 'jasper:media-browser';
type View = 'list' | 'thumbnails';
type Filter = 'supported' | BrowseCategory;
type Prefs = { path?: string; view?: View; filter?: Filter; all?: boolean };

function loadPrefs(): Prefs {
	try {
		const v = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Prefs;
		return v && typeof v === 'object' ? v : {};
	} catch {
		return {};
	}
}
function savePrefs(p: Prefs): void {
	try {
		localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadPrefs(), ...p }));
	} catch {
		// storage unavailable: the panel starts at Home next time
	}
}

const FILTERS: { value: Filter; label: string }[] = [
	{ value: 'supported', label: 'All Supported Files' },
	{ value: 'video', label: 'Video' },
	{ value: 'audio', label: 'Audio' },
	{ value: 'image', label: 'Images' },
	{ value: 'graphics', label: 'Graphics' },
	{ value: 'captions', label: 'Captions' },
	{ value: 'timeline', label: 'Timelines' },
	{ value: 'lut', label: 'LUTs' },
	{ value: 'model', label: '3D Models' },
];

const TYPE_LABELS: Record<BrowseCategory, string> = {
	video: 'Video',
	audio: 'Audio',
	image: 'Image',
	graphics: 'Graphics',
	captions: 'Captions',
	timeline: 'Timeline',
	lut: 'LUT',
	model: '3D Model',
	project: 'Project',
};

/** The engine names its own two places in English (Home, File System); folders and volumes keep their names. */
function placeLabel(r: { label: string; kind: string }): string {
	if (r.kind === 'home') return t('Home');
	if (r.kind === 'root' && r.label === 'File System') return t('File System');
	return r.label;
}

function iconFor(e: Pick<BrowseEntry, 'kind' | 'category'>): IconId {
	if (e.kind === 'folder') return 'media.folder';
	switch (e.category) {
		case 'video':
			return 'media.video';
		case 'audio':
			return 'media.audio';
		case 'image':
		case 'graphics':
			return 'media.image';
		case 'captions':
			return 'media.captions';
		case 'lut':
			return 'media.lut';
		case 'model':
			return 'media.model';
		case 'timeline':
			return 'panel.timeline';
		default:
			return 'media.file';
	}
}

/** "1.2 MB" (decimal units, like the OS file browsers). */
function formatBytes(n: number | null): string {
	if (n === null || !Number.isFinite(n) || n < 0) return '';
	if (n < 1000) return `${n} B`;
	const units = ['KB', 'MB', 'GB', 'TB'];
	let v = n;
	let u = -1;
	while (v >= 1000 && u < units.length - 1) {
		v /= 1000;
		u++;
	}
	return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

function formatDuration(sec: number | null): string {
	if (sec === null || !Number.isFinite(sec)) return '';
	const s = Math.max(0, sec);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const r = s % 60;
	const ss = r.toFixed(2).padStart(5, '0');
	return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Filters a listing by the type filter and the search text (folders always stay, unless the search excludes them). */
function visibleEntries(entries: readonly BrowseEntry[], filter: Filter, query: string): BrowseEntry[] {
	const q = query.trim().toLowerCase();
	return entries.filter(
		(e) =>
			(!q || e.name.toLowerCase().includes(q)) &&
			(e.kind === 'folder' || filter === 'supported' || e.category === filter),
	);
}

function errorMessage(e: unknown): { code: string; message: string } {
	if (e instanceof EngineError) return { code: e.code, message: e.message };
	return { code: 'ERROR', message: e instanceof Error ? e.message : String(e) };
}

export function MediaBrowserPanel(_props: PanelProps) {
	const engine = useEngine();
	const client = engine.client;
	const session = useSessionOrNull();
	const readOnly = useStoreSelector(
		session?.store ?? { getState: () => null, subscribe: () => () => {} },
		(s: { readOnly: boolean } | null) => s?.readOnly ?? true,
	);
	const prefs = useMemo(loadPrefs, []);
	const [roots, setRoots] = useState<BrowseRoots | null>(null);
	const [path, setPath] = useState<string | null>(prefs.path ?? null);
	const [pathText, setPathText] = useState(prefs.path ?? '');
	const [listing, setListing] = useState<BrowseList | null>(null);
	const [error, setError] = useState<{ code: string; message: string } | null>(null);
	const [loading, setLoading] = useState(false);
	const [view, setView] = useState<View>(prefs.view ?? 'list');
	const [filter, setFilter] = useState<Filter>(prefs.filter ?? 'supported');
	const [all, setAll] = useState(!!prefs.all);
	const [query, setQuery] = useState('');
	const [selected, setSelected] = useState<string[]>([]);
	const [anchor, setAnchor] = useState<string | null>(null);
	const [info, setInfo] = useState<BrowseInfo | null>(null);
	const [importing, setImporting] = useState(false);
	const [reload, setReload] = useState(0);
	const back = useRef<string[]>([]);
	const forward = useRef<string[]>([]);
	const listRef = useRef<HTMLDivElement>(null);

	// Places, and the start folder (the last one, else Home).
	useEffect(() => {
		if (engine.status !== 'connected') return;
		let live = true;
		client
			.browseRoots()
			.then((r) => {
				if (!live) return;
				setRoots(r);
				setPath((p) => p ?? r.home);
			})
			.catch((e) => live && setError(errorMessage(e)));
		return () => {
			live = false;
		};
	}, [client, engine.status]);

	// The folder listing (`reload` re-reads the same folder).
	// biome-ignore lint/correctness/useExhaustiveDependencies: `reload` is the refresh trigger
	useEffect(() => {
		if (!path || engine.status !== 'connected') return;
		let live = true;
		setLoading(true);
		setPathText(path);
		client
			.browseList(path, { all })
			.then((r) => {
				if (!live) return;
				setListing(r);
				setError(null);
				savePrefs({ path: r.path });
			})
			.catch((e) => {
				if (!live) return;
				setListing(null);
				setError(errorMessage(e));
			})
			.finally(() => live && setLoading(false));
		return () => {
			live = false;
		};
	}, [client, engine.status, path, all, reload]);

	const entries = useMemo(
		() => visibleEntries(listing?.entries ?? [], filter, query),
		[listing, filter, query],
	);
	const byPath = useMemo(() => new Map(entries.map((e) => [e.path, e])), [entries]);
	const selectedFiles = useMemo(
		() => selected.filter((p) => byPath.get(p)?.kind === 'file'),
		[selected, byPath],
	);
	const primary = selected.length ? byPath.get(selected[selected.length - 1]!) : undefined;

	// Preview info of the primary selected file.
	useEffect(() => {
		setInfo(null);
		if (primary?.kind !== 'file') return;
		let live = true;
		client
			.browseInfo(primary.path)
			.then((r) => live && setInfo(r))
			.catch(
				(e) =>
					live &&
					setInfo({
						path: primary.path,
						name: primary.name,
						size: primary.size ?? 0,
						modifiedAt: primary.modifiedAt ?? '',
						category: primary.category,
						media: null,
						error: errorMessage(e).message,
					}),
			);
		return () => {
			live = false;
		};
	}, [client, primary]);

	const go = useCallback(
		(next: string, how: 'push' | 'back' | 'forward' = 'push') => {
			if (!next || next === path) return;
			if (how === 'push') {
				if (path) back.current.push(path);
				forward.current = [];
			}
			setSelected([]);
			setAnchor(null);
			setQuery('');
			setPath(next);
		},
		[path],
	);
	const goBack = () => {
		const p = back.current.pop();
		if (p && path) forward.current.push(path);
		if (p) go(p, 'back');
	};
	const goForward = () => {
		const p = forward.current.pop();
		if (p && path) back.current.push(path);
		if (p) go(p, 'forward');
	};
	const goUp = useCallback(() => {
		if (listing?.parent) go(listing.parent);
	}, [listing, go]);

	const canImport = !!session && !readOnly;
	const importPaths = useCallback(
		async (paths: string[]): Promise<number> => {
			if (!session || !paths.length) return 0;
			if (readOnly) {
				toast({ kind: 'warning', title: 'The project is open read-only' });
				return 0;
			}
			const service =
				(getImportService() as EngineImportService | null) ??
				new EngineImportService({ engine: client, session });
			const binId = activeProjectBin();
			setImporting(true);
			try {
				const r = await service.importFiles({ paths }, { kind: 'bin', binId });
				if (r.mediaIds.length) toast({ kind: 'success', title: service.describe(r, { kind: 'bin', binId }) });
				return r.mediaIds.length;
			} catch (e) {
				toast({ kind: 'error', title: 'Import failed', detail: errorMessage(e).message });
				return 0;
			} finally {
				setImporting(false);
			}
		},
		[client, session, readOnly],
	);

	// The handle for File ▸ Import from Media Browser and the panel menu.
	const state = useRef({ selectedFiles, importPaths, goUp, all });
	state.current = { selectedFiles, importPaths, goUp, all };
	useEffect(() => {
		const handle: MediaBrowserHandle = {
			selectedFiles: () => state.current.selectedFiles,
			importSelected: () => state.current.importPaths(state.current.selectedFiles),
			goUp: () => state.current.goUp(),
			refresh: () => setReload((n) => n + 1),
			toggleAllFiles: () => {
				const next = !state.current.all;
				setAll(next);
				savePrefs({ all: next });
			},
			showsAllFiles: () => state.current.all,
		};
		return registerMediaBrowser(handle);
	}, []);

	const select = (entry: BrowseEntry, e: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }) => {
		if (e.shiftKey && anchor) {
			const ids = entries.map((x) => x.path);
			const a = ids.indexOf(anchor);
			const b = ids.indexOf(entry.path);
			if (a >= 0 && b >= 0) {
				const range = ids.slice(Math.min(a, b), Math.max(a, b) + 1);
				// keep the clicked entry last: it is the one previewed
				setSelected([...range.filter((p) => p !== entry.path), entry.path]);
				return;
			}
		}
		if (e.ctrlKey || e.metaKey) {
			setSelected((s) => (s.includes(entry.path) ? s.filter((p) => p !== entry.path) : [...s, entry.path]));
			setAnchor(entry.path);
			return;
		}
		setSelected([entry.path]);
		setAnchor(entry.path);
	};
	const activate = (entry: BrowseEntry) => {
		if (entry.kind === 'folder') go(entry.path);
		else void importPaths(selectedFiles.includes(entry.path) ? selectedFiles : [entry.path]);
	};
	const onKeyDown = (e: React.KeyboardEvent) => {
		if ((e.target as HTMLElement).closest('input,select,textarea')) return;
		const ids = entries.map((x) => x.path);
		const cur = primary ? ids.indexOf(primary.path) : -1;
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
			if (!ids.length) return;
			e.preventDefault();
			const cols =
				view === 'thumbnails' && listRef.current
					? Math.max(1, Math.floor(listRef.current.clientWidth / 132))
					: 1;
			const step =
				e.key === 'ArrowDown' ? cols : e.key === 'ArrowUp' ? -cols : e.key === 'ArrowRight' ? 1 : -1;
			if (view === 'list' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
			const next = entries[Math.max(0, Math.min(ids.length - 1, cur < 0 ? 0 : cur + step))]!;
			select(next, e);
			document
				.querySelector(`[data-browse-path="${CSS.escape(next.path)}"]`)
				?.scrollIntoView({ block: 'nearest' });
		} else if (e.key === 'Enter' && primary) {
			e.preventDefault();
			activate(primary);
		} else if (e.key === 'Backspace') {
			e.preventDefault();
			goUp();
		} else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
			e.preventDefault();
			setSelected(ids);
		}
	};
	const onDragStart = (entry: BrowseEntry, e: React.DragEvent) => {
		if (entry.kind !== 'file') {
			e.preventDefault();
			return;
		}
		const paths = selectedFiles.includes(entry.path) ? selectedFiles : [entry.path];
		writeHostPathsDrag(e.dataTransfer, paths);
	};

	if (engine.status !== 'connected')
		return <EmptyState icon="panel.mediaBrowser" message="Connect the engine to browse media" />;
	if (error?.code === 'LOCAL_MODE_ONLY')
		return (
			<EmptyState
				icon="panel.mediaBrowser"
				message="The Media Browser needs a local engine"
				detail="This engine runs on another computer; use File ▸ Import to upload files."
			/>
		);

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: panel-level keyboard navigation (rows are focusable)
		<div
			className="@container flex h-full min-h-0 flex-col font-pr text-pr-ui"
			data-testid="media-browser"
			onKeyDown={onKeyDown}
		>
			<div className="flex h-8 shrink-0 items-center gap-1 border-b border-pr-border-subtle px-1.5">
				<IconButton
					icon="app.chevronLeft"
					label="Back"
					size="small"
					disabled={!back.current.length}
					onClick={goBack}
				/>
				<IconButton
					icon="app.chevronRight"
					label="Forward"
					size="small"
					disabled={!forward.current.length}
					onClick={goForward}
				/>
				<IconButton
					icon="app.up"
					label="Go Up"
					size="small"
					disabled={!listing?.parent}
					onClick={goUp}
					data-testid="media-browser-up"
				/>
				<form
					className="min-w-0 flex-1"
					onSubmit={(e) => {
						e.preventDefault();
						const p = pathText.trim();
						if (p) go(p);
					}}
				>
					<TextField
						value={pathText}
						onChange={(e) => setPathText(e.currentTarget.value)}
						aria-label="Folder path"
						spellCheck={false}
						className="w-full font-pr-mono"
						data-testid="media-browser-path"
						data-no-i18n=""
					/>
				</form>
				<IconButton
					icon="app.refresh"
					label="Refresh"
					size="small"
					busy={loading}
					onClick={() => setReload((n) => n + 1)}
				/>
			</div>
			<div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-pr-border-subtle px-1.5">
				<Select
					value={roots?.roots.some((r) => r.path === path) ? (path ?? '') : ''}
					onValueChange={(v) => go(v)}
					options={(roots?.roots ?? []).map((r) => ({ value: r.path, label: placeLabel(r) }))}
					label="Places"
					placeholder="Places"
					className="w-[104px] @[480px]:hidden"
				/>
				<Select
					value={filter}
					onValueChange={(v) => {
						setFilter(v as Filter);
						savePrefs({ filter: v as Filter });
					}}
					options={FILTERS}
					label="File types displayed"
					className="w-[150px] shrink-0"
				/>
				<SearchField
					value={query}
					onValueChange={setQuery}
					placeholder="Search this folder"
					aria-label="Search this folder"
					className="min-w-0 flex-1"
				/>
				<Checkbox
					checked={all}
					onCheckedChange={(v) => {
						setAll(v === true);
						savePrefs({ all: v === true });
					}}
					label="All files"
				/>
				<IconButton
					icon="project.listView"
					label="List View"
					size="small"
					toggled={view === 'list' ? 'on' : 'off'}
					onClick={() => {
						setView('list');
						savePrefs({ view: 'list' });
					}}
				/>
				<IconButton
					icon="project.iconView"
					label="Thumbnail View"
					size="small"
					toggled={view === 'thumbnails' ? 'on' : 'off'}
					onClick={() => {
						setView('thumbnails');
						savePrefs({ view: 'thumbnails' });
					}}
				/>
			</div>
			<div className="flex min-h-0 flex-1">
				<nav
					aria-label="Places"
					className="hidden w-[140px] shrink-0 overflow-auto border-r border-pr-border-subtle py-1 @[480px]:block"
					data-testid="media-browser-places"
				>
					{(roots?.roots ?? []).map((r) => (
						<button
							key={r.path}
							type="button"
							title={r.path}
							onClick={() => go(r.path)}
							className={cx(
								'flex h-[22px] w-full items-center gap-1.5 truncate px-2 text-left hover:bg-pr-hover',
								path === r.path && 'bg-pr-selected',
							)}
						>
							<Icon
								id={r.kind === 'volume' || r.kind === 'root' ? 'media.drive' : 'media.folder'}
								size={14}
							/>
							<span className="truncate" data-no-i18n={r.kind === 'volume' ? '' : undefined}>
								{placeLabel(r)}
							</span>
						</button>
					))}
				</nav>
				<div className="flex min-w-0 flex-1 flex-col">
					<div
						ref={listRef}
						className="min-h-0 flex-1 overflow-auto"
						role="listbox"
						aria-label="Folder contents"
						aria-multiselectable="true"
						tabIndex={0}
						data-testid="media-browser-list"
					>
						{error ? (
							<EmptyState
								icon="panel.mediaBrowser"
								message="This folder cannot be shown"
								detail={error.message}
							/>
						) : entries.length === 0 && !loading ? (
							<EmptyState
								icon="media.folder"
								message={query ? 'Nothing matches the search' : 'No importable files in this folder'}
								detail={all || query ? undefined : 'Turn on “All files” to see everything.'}
							/>
						) : view === 'list' ? (
							<ListView
								entries={entries}
								selected={selected}
								onSelect={select}
								onActivate={activate}
								onDragStart={onDragStart}
							/>
						) : (
							<ThumbView
								entries={entries}
								selected={selected}
								onSelect={select}
								onActivate={activate}
								onDragStart={onDragStart}
								thumbUrl={(p) => client.browseThumbnailUrl(p, 240)}
							/>
						)}
					</div>
					<div
						className="flex h-6 shrink-0 items-center gap-2 border-t border-pr-border-subtle px-2 text-pr-small text-pr-muted"
						role="status"
					>
						<span data-testid="media-browser-count">
							{entries.length === 1 ? '1 item' : `${entries.length} items`}
							{selectedFiles.length ? ` · ${selectedFiles.length} selected` : ''}
						</span>
						{listing?.truncated ? (
							<span className="text-pr-warning">Only the first 2,000 entries are listed</span>
						) : null}
					</div>
				</div>
			</div>
			{primary?.kind === 'file' ? (
				<Preview
					entry={primary}
					info={info}
					fileUrl={client.browseFileUrl(primary.path)}
					thumbUrl={client.browseThumbnailUrl(primary.path, 480)}
				/>
			) : null}
			<div className="flex h-9 shrink-0 items-center justify-end gap-2 border-t border-pr-border-subtle px-2">
				{!canImport ? (
					<span className="mr-auto text-pr-small text-pr-muted">
						{session ? 'The project is open read-only' : 'Open a project to import'}
					</span>
				) : null}
				<Button
					variant="primary"
					disabled={!canImport || !selectedFiles.length || importing}
					onClick={() => void importPaths(selectedFiles)}
					data-testid="media-browser-import"
				>
					{selectedFiles.length > 1 ? `Import ${selectedFiles.length} Files` : 'Import'}
				</Button>
			</div>
		</div>
	);
}

type ViewProps = {
	entries: BrowseEntry[];
	selected: string[];
	onSelect(e: BrowseEntry, ev: React.MouseEvent): void;
	onActivate(e: BrowseEntry): void;
	onDragStart(e: BrowseEntry, ev: React.DragEvent): void;
};

function ListView({ entries, selected, onSelect, onActivate, onDragStart }: ViewProps) {
	return (
		<table className="w-full table-fixed border-collapse text-left">
			<thead className="sticky top-0 z-[1] bg-pr-panel text-pr-small text-pr-muted">
				<tr className="h-[22px]">
					<th className="pl-2 font-normal">Name</th>
					<th className="w-[80px] font-normal">Type</th>
					<th className="w-[72px] pr-2 text-right font-normal">Size</th>
					<th className="hidden w-[132px] font-normal @[560px]:table-cell">Modified</th>
				</tr>
			</thead>
			<tbody>
				{entries.map((e, i) => {
					const on = selected.includes(e.path);
					return (
						<tr
							key={e.path}
							role="option"
							aria-selected={on}
							draggable={e.kind === 'file'}
							onDragStart={(ev) => onDragStart(e, ev)}
							onClick={(ev) => onSelect(e, ev)}
							onDoubleClick={() => onActivate(e)}
							data-browse-path={e.path}
							data-testid="media-browser-entry"
							className={cx(
								'h-[22px] cursor-default',
								on ? 'bg-pr-selected' : cx('hover:bg-pr-hover', i % 2 ? 'bg-pr-panel-alt' : ''),
								e.hidden && 'text-pr-muted',
							)}
						>
							<td className="truncate pl-2" title={e.name}>
								<span className="inline-flex max-w-full items-center gap-1.5 align-middle">
									<Icon id={iconFor(e)} size={14} />
									<span className="truncate" data-no-i18n="">
										{e.name}
									</span>
								</span>
							</td>
							<td className="truncate text-pr-muted">
								{e.kind === 'folder' ? 'Folder' : e.category ? TYPE_LABELS[e.category] : 'File'}
							</td>
							<td className="pr-2 text-right pr-tabular text-pr-muted">{formatBytes(e.size)}</td>
							<td className="hidden truncate pr-tabular text-pr-muted @[560px]:table-cell">
								{e.modifiedAt ? new Date(e.modifiedAt).toLocaleString() : ''}
							</td>
						</tr>
					);
				})}
			</tbody>
		</table>
	);
}

function ThumbView({
	entries,
	selected,
	onSelect,
	onActivate,
	onDragStart,
	thumbUrl,
}: ViewProps & { thumbUrl(p: string): string }) {
	return (
		<div className="grid grid-cols-[repeat(auto-fill,minmax(124px,1fr))] gap-2 p-2">
			{entries.map((e) => {
				const on = selected.includes(e.path);
				const thumb = e.kind === 'file' && (e.category === 'video' || e.category === 'image');
				return (
					// biome-ignore lint/a11y/useKeyWithClickEvents: arrows / Enter are handled by the panel (onKeyDown above)
					<div
						key={e.path}
						role="option"
						tabIndex={-1}
						aria-selected={on}
						draggable={e.kind === 'file'}
						onDragStart={(ev) => onDragStart(e, ev)}
						onClick={(ev) => onSelect(e, ev)}
						onDoubleClick={() => onActivate(e)}
						data-browse-path={e.path}
						data-testid="media-browser-entry"
						title={e.name}
						className={cx(
							'flex cursor-default flex-col gap-1 rounded-pr-control p-1',
							on ? 'bg-pr-selected' : 'hover:bg-pr-hover',
						)}
					>
						<div className="flex aspect-video items-center justify-center overflow-hidden rounded-pr-control bg-pr-field text-pr-muted">
							{thumb ? (
								<ThumbImage src={thumbUrl(e.path)} fallback={iconFor(e)} />
							) : (
								<Icon id={iconFor(e)} size={28} />
							)}
						</div>
						<span className="truncate text-pr-small" data-no-i18n="">
							{e.name}
						</span>
					</div>
				);
			})}
		</div>
	);
}

function ThumbImage({ src, fallback }: { src: string; fallback: IconId }) {
	const [failed, setFailed] = useState(false);
	if (failed) return <Icon id={fallback} size={28} />;
	return (
		<img
			src={src}
			alt=""
			loading="lazy"
			draggable={false}
			className="size-full object-contain"
			onError={() => setFailed(true)}
		/>
	);
}

function Preview(props: { entry: BrowseEntry; info: BrowseInfo | null; fileUrl: string; thumbUrl: string }) {
	const { entry, info } = props;
	const m = info?.media ?? null;
	const playable = m?.browserPlayable !== 'no';
	const facts = [
		entry.category ? TYPE_LABELS[entry.category] : 'File',
		m?.width && m.height ? `${m.width} × ${m.height}` : null,
		m?.fps ? `${m.fps} fps` : null,
		m?.durationSec && entry.category !== 'image' ? formatDuration(m.durationSec) : null,
		m?.videoCodec && entry.category === 'video' ? m.videoCodec : null,
		m?.sampleRate ? `${m.sampleRate} Hz` : null,
		m?.channels ? (m.channels === 1 ? 'mono' : m.channels === 2 ? 'stereo' : `${m.channels} ch`) : null,
		formatBytes(entry.size),
	].filter((x): x is string => !!x);
	return (
		<div
			className="flex h-[112px] shrink-0 gap-2 border-t border-pr-border-subtle p-2"
			data-testid="media-browser-preview"
		>
			<div className="flex aspect-video h-full items-center justify-center overflow-hidden rounded-pr-control bg-pr-field">
				{entry.category === 'video' && playable ? (
					// biome-ignore lint/a11y/useMediaCaption: previews of the user's own files have no captions
					<video
						key={props.fileUrl}
						src={props.fileUrl}
						poster={props.thumbUrl}
						controls
						preload="metadata"
						className="size-full object-contain"
						data-testid="media-browser-video"
					/>
				) : entry.category === 'audio' && playable ? (
					// biome-ignore lint/a11y/useMediaCaption: previews of the user's own files have no captions
					<audio key={props.fileUrl} src={props.fileUrl} controls preload="metadata" className="w-[90%]" />
				) : entry.category === 'image' && playable ? (
					<ThumbImage src={props.fileUrl} fallback="media.image" />
				) : entry.category === 'video' || entry.category === 'image' ? (
					<ThumbImage src={props.thumbUrl} fallback={iconFor(entry)} />
				) : (
					<Icon id={iconFor(entry)} size={32} />
				)}
			</div>
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<span className="truncate text-pr-strong" data-no-i18n="" title={entry.path}>
					{entry.name}
				</span>
				<span className="text-pr-small text-pr-muted" data-testid="media-browser-facts">
					{facts.join(' · ')}
				</span>
				{entry.modifiedAt ? (
					<span className="text-pr-small text-pr-muted">{new Date(entry.modifiedAt).toLocaleString()}</span>
				) : null}
				{info?.error ? <span className="text-pr-small text-pr-warning">{info.error}</span> : null}
				{m && !playable ? (
					<span className="text-pr-small text-pr-muted">
						The browser cannot play this file; import it to play it from its preview copy.
					</span>
				) : null}
			</div>
		</div>
	);
}
