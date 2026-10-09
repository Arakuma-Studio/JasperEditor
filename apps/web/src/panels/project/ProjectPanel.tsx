// Project panel (S05:PRJ-001…010, R-PUI §7): breadcrumb, search + filter, List and Icon views, bins,
// drag in/out, rename, labels, delete with in-use warning, New Item ▸, status visualization.

import type { LabelColor, ProjectItem } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useSession, useSessionState } from '@jasper/session/react';
import {
	Button,
	cx,
	Icon,
	IconButton,
	type IconId,
	LABEL_DISPLAY_NAMES,
	LABEL_NAMES,
	PointMenu,
} from '@jasper/ui';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { collectMenuItems, type MenuItemSpec, projectItemMenuExtensions } from '../../extensions/index.ts';
import { labelName } from '../../gaps/app-prefs.ts';
import { runIfRegistered, useLocalCommandCtx } from '../../home/ui-bridge.ts';
import { mediaKeyOf } from '../../import/assets.ts';
import { type ClientJob, useClientJobs } from '../../import/client-jobs.ts';
import { pickFilesInBrowser } from '../../import/desktop.ts';
import { EngineImportService, readDataTransfer, writeProjectItemsDrag } from '../../import/service.ts';
import { useEngine } from '../../state/engine.tsx';
import { getImportService, PROJECT_ITEMS_MIME } from '../../state/services.ts';
import type { PanelProps } from '../types.ts';
import { createBin, createText, deleteItems, moveItems, openItem, renameItem, setLabel } from './actions.ts';
import { projectDialogs } from './dialogs.tsx';
import { type ProjectViewMode, registerProjectPanel, touchProjectPanel } from './instances.ts';
import {
	breadcrumb,
	durationSeconds,
	FILTERS,
	type ProjectFilter,
	type ProjectRow,
	parentBinOf,
	projectRows,
	type SortKey,
} from './model.ts';
import { loadSpriteIndex, spriteTileAt, spriteTileStyle } from './sprites.ts';
import { useRowWindow, VIRTUALIZE_MIN_ROWS } from './virtual.ts';

// ------------------------------------------------------------ persisted per-instance view state (PN-002)

type ViewState = {
	view: ProjectViewMode;
	tile: number;
	hoverScrub: boolean;
	sort: { key: SortKey; dir: 1 | -1 };
};
const DEFAULT_VIEW: ViewState = { view: 'list', tile: 128, hoverScrub: true, sort: { key: 'user', dir: 1 } };
const TILE_MIN = 80;
const TILE_MAX = 256;

function loadView(instanceId: string): ViewState {
	try {
		const raw = globalThis.localStorage?.getItem(`jasper.projectPanel.${instanceId}`);
		return raw ? { ...DEFAULT_VIEW, ...(JSON.parse(raw) as Partial<ViewState>) } : DEFAULT_VIEW;
	} catch {
		return DEFAULT_VIEW;
	}
}
function saveView(instanceId: string, v: ViewState) {
	try {
		globalThis.localStorage?.setItem(`jasper.projectPanel.${instanceId}`, JSON.stringify(v));
	} catch {
		// not persisted
	}
}

const TYPE_ICON: Record<ProjectRow['type'], IconId> = {
	bin: 'panel.project',
	'search-bin': 'app.search',
	video: 'media.video',
	audio: 'track.audio',
	image: 'media.image',
	'animated-image': 'media.image',
	sequence: 'panel.timeline',
	synthetic: 'media.image',
	font: 'tool.type',
	lut: 'media.lut',
	'mg-bundle': 'panel.motionTemplates',
	'color-config': 'media.lut',
	model: 'tool.camera',
};

const labelVar = (l: LabelColor) => `var(--pr-label-${l})`;

const STATUS_TEXT: Record<string, string> = {
	online: 'Online',
	offline: 'Media Offline',
	error: 'Error',
	resolving: 'Resolving…',
	analyzing: 'Analyzing…',
	'needs-engine': 'Needs engine',
};

// ------------------------------------------------------------ panel

export function ProjectPanel(props: PanelProps) {
	const session = useSession();
	const engine = useEngine();
	const ctx = useLocalCommandCtx(
		useMemo(() => ({ panel: 'project' as const, instanceId: props.instanceId }), [props.instanceId]),
	);
	const doc = useSessionState((s) => s.document);
	const runtime = useSessionState((s) => s.media);
	const readOnly = useSessionState((s) => s.readOnly);
	const selection = useSessionState((s) => s.selection.project);
	const uploads = useClientJobs().filter(
		(j) => j.kind === 'upload' && (j.state === 'running' || j.state === 'queued'),
	);

	const [binId, setBinId] = useState<string | null>(null);
	const [search, setSearch] = useState('');
	const [filter, setFilter] = useState<ProjectFilter>('all');
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
	const [view, setViewState] = useState<ViewState>(() => loadView(props.instanceId));
	const [renaming, setRenaming] = useState<string | null>(null);
	const [menu, setMenu] = useState<{ x: number; y: number; itemId: string | null } | null>(null);
	const [dropTarget, setDropTarget] = useState<string | 'panel' | null>(null);
	const [showNewItem, setShowNewItem] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);

	// A bin that was deleted (or undone away) falls back to the root.
	useEffect(() => {
		if (binId && doc.items[binId]?.kind !== 'bin') setBinId(null);
	}, [binId, doc.items]);

	const updateView = useCallback(
		(patch: Partial<ViewState>) =>
			setViewState((v) => {
				const next = { ...v, ...patch };
				saveView(props.instanceId, next);
				return next;
			}),
		[props.instanceId],
	);

	const rows = useMemo(
		() => projectRows(doc, runtime, { binId, search, filter, expanded, sort: view.sort }),
		[doc, runtime, binId, search, filter, expanded, view.sort],
	);
	const selected = selection.items;
	const selectedSet = useMemo(() => new Set(selected), [selected]);

	const select = useCallback(
		(id: string, e?: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }) => {
			if (e?.shiftKey && selection.primary) {
				const ids = rows.map((r) => r.id);
				const a = ids.indexOf(selection.primary);
				const b = ids.indexOf(id);
				if (a >= 0 && b >= 0) {
					session.select('project', ids.slice(Math.min(a, b), Math.max(a, b) + 1), 'replace');
					return;
				}
			}
			session.select('project', [id], e?.ctrlKey || e?.metaKey ? 'toggle' : 'replace');
		},
		[rows, selection.primary, session],
	);

	const importInto = useCallback(
		async (files: File[] | null, paths: string[] | null) => {
			const service =
				(getImportService() as EngineImportService | null) ??
				new EngineImportService({ engine: engine.client, session });
			await service.importFiles(
				{ files: files ?? undefined, paths: paths ?? undefined },
				{ kind: 'bin', binId },
			);
		},
		[binId, engine.client, session],
	);
	const importDialog = useCallback(async () => {
		const service = getImportService() as EngineImportService | null;
		const paths = service?.isDesktop ? await service.pickDesktopPaths() : null;
		if (paths?.length) return importInto(null, paths);
		if (paths) return;
		const files = await pickFilesInBrowser();
		if (files.length) await importInto(files, null);
	}, [importInto]);

	// Handle for project-scope UI commands (Ctrl+B, Ctrl+PgUp/PgDn, Shift+\, Shift+H, …)
	useEffect(
		() =>
			registerProjectPanel({
				instanceId: props.instanceId,
				getBinId: () => binId,
				setView: (mode) => updateView({ view: mode }),
				toggleView: () => updateView({ view: view.view === 'list' ? 'icon' : 'list' }),
				zoom: (delta) => updateView({ tile: Math.max(TILE_MIN, Math.min(TILE_MAX, view.tile + delta)) }),
				toggleHoverScrub: () => updateView({ hoverScrub: !view.hoverScrub }),
				newBin: () => {
					const id = createBin(session, binId);
					if (id) setRenaming(id);
				},
				newSequence: () => projectDialogs.open({ kind: 'newSequence', binId }),
				renameSelection: () => selection.primary && setRenaming(selection.primary),
				deleteSelection: () => deleteItems(session, selected),
				openSelection: () => {
					if (selection.primary) void openItem(session, selection.primary, ctx, setBinId);
				},
				importIntoBin: () => void importDialog(),
				reveal: (itemId) => {
					// wp-clipboard-2 (S03:XF-050 Reveal in Project): show the item's bin, unfiltered, scrolled to it.
					setBinId(parentBinOf(session.getCommitted(), itemId));
					setSearch('');
					setFilter('all');
					setRevealId(itemId);
				},
			}),
		[props.instanceId, binId, view, updateView, session, selection.primary, selected, ctx, importDialog],
	);
	const [revealId, setRevealId] = useState<string | null>(null);
	const bodyRef = useRef<HTMLElement>(null);
	useEffect(() => {
		if (!revealId) return;
		// The bin switch renders first: look for the row for a few frames.
		let tries = 0;
		let raf = 0;
		const find = () => {
			const el = Array.from(rootRef.current?.querySelectorAll('[data-item-id]') ?? []).find(
				(x) => x.getAttribute('data-item-id') === revealId,
			);
			if (el) (el as HTMLElement).scrollIntoView?.({ block: 'nearest' });
			if (el || ++tries > 30) setRevealId(null);
			else raf = requestAnimationFrame(find);
		};
		find();
		return () => cancelAnimationFrame(raf);
	}, [revealId]);

	// ---------------------------------------------------------------- drag and drop (S05:PRJ-007)

	const onDragOver = (e: React.DragEvent, key: string) => {
		const types = Array.from(e.dataTransfer.types);
		if (readOnly || (!types.includes(PROJECT_ITEMS_MIME) && !types.includes('Files'))) return;
		e.preventDefault();
		e.stopPropagation();
		e.dataTransfer.dropEffect = types.includes('Files') ? 'copy' : 'move';
		if (dropTarget !== key) setDropTarget(key);
	};
	const onDrop = (e: React.DragEvent, targetBin: string | null) => {
		setDropTarget(null);
		const payload = readDataTransfer(e.dataTransfer);
		if (!payload || readOnly) return;
		e.preventDefault();
		e.stopPropagation();
		if (payload.type === 'jasper/project-items') moveItems(session, payload.itemIds, targetBin);
		else void importInto(payload.files, payload.paths ?? null);
	};

	// ---------------------------------------------------------------- keyboard (panel-local)

	const onKeyDown = (e: React.KeyboardEvent) => {
		if (renaming || (e.target as HTMLElement).closest('input,select,textarea')) return;
		const ids = rows.map((r) => r.id);
		const i = selection.primary ? ids.indexOf(selection.primary) : -1;
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			const next = ids[Math.max(0, Math.min(ids.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
			if (next) {
				e.preventDefault();
				select(next, { shiftKey: e.shiftKey });
			}
		} else if (e.key === 'Enter' && selection.primary && !readOnly) {
			e.preventDefault();
			setRenaming(selection.primary);
		} else if ((e.key === 'Delete' || e.key === 'Backspace') && selected.length && !readOnly) {
			e.preventDefault();
			e.stopPropagation();
			deleteItems(session, selected);
		} else if (e.key === 'Backspace' && binId) {
			setBinId(null);
		}
	};

	const crumbs = breadcrumb(doc, binId);
	const total = rows.length;

	const rowHandlers = (row: ProjectRow) => ({
		onClick: (e: React.MouseEvent) => select(row.id, e),
		onDoubleClick: () => void openItem(session, row.id, ctx, (id) => setBinId(id)),
		onContextMenu: (e: React.MouseEvent) => {
			e.preventDefault();
			if (!selectedSet.has(row.id)) select(row.id);
			setMenu({ x: e.clientX, y: e.clientY, itemId: row.id });
		},
		draggable: !readOnly,
		onDragStart: (e: React.DragEvent) => {
			const ids = selectedSet.has(row.id) ? selected : [row.id];
			if (!selectedSet.has(row.id)) select(row.id);
			writeProjectItemsDrag(e.dataTransfer, ids);
		},
		onDragOver: row.type === 'bin' ? (e: React.DragEvent) => onDragOver(e, row.id) : undefined,
		onDragLeave: row.type === 'bin' ? () => setDropTarget(null) : undefined,
		onDrop: row.type === 'bin' ? (e: React.DragEvent) => onDrop(e, row.id) : undefined,
	});

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: panel body = drop zone and keyboard scope (S05 §7, PRJ-007)
		<div
			ref={rootRef}
			className={cx(
				'relative flex h-full min-h-0 flex-col bg-pr-panel text-pr-text outline-none',
				dropTarget === 'panel' ? 'outline outline-2 -outline-offset-2 outline-pr-accent' : '',
			)}
			data-testid="project-panel"
			data-panel-kind="project"
			// biome-ignore lint/a11y/noNoninteractiveTabindex: the panel body takes keyboard focus (S05 §7)
			tabIndex={0}
			onKeyDown={onKeyDown}
			onPointerDown={() => touchProjectPanel(props.instanceId)}
			onDragOver={(e) => onDragOver(e, 'panel')}
			onDragLeave={(e) => {
				if (!rootRef.current?.contains(e.relatedTarget as Node)) setDropTarget(null);
			}}
			onDrop={(e) => onDrop(e, binId)}
		>
			{/* Toolbar: breadcrumb, count, search + filter (PRJ-001) */}
			<div className="flex h-[var(--pr-row-h)] shrink-0 items-center gap-1 px-2 text-pr-small">
				<nav
					className="flex min-w-0 items-center gap-1 truncate"
					aria-label="Bin path"
					data-testid="project-breadcrumb"
				>
					{crumbs.map((c, i) => (
						<span key={c.id ?? 'root'} className="flex items-center gap-1">
							{i > 0 ? <span className="text-pr-dim">▸</span> : null}
							<button
								type="button"
								className={cx(
									'truncate hover:text-pr-strong',
									i === crumbs.length - 1 ? 'text-pr-strong' : 'text-pr-muted',
								)}
								onClick={() => setBinId(c.id)}
								onDragOver={(e) => onDragOver(e, `crumb:${c.id ?? 'root'}`)}
								onDrop={(e) => onDrop(e, c.id)}
							>
								{c.name}
							</button>
						</span>
					))}
				</nav>
				<span className="ml-auto shrink-0 text-pr-muted" data-testid="project-count">
					{selected.length
						? `${selected.length} of ${total} selected`
						: `${total} ${total === 1 ? 'item' : 'items'}`}
				</span>
			</div>
			<div className="flex h-[var(--pr-row-h)] shrink-0 items-center gap-1 px-2">
				<input
					type="search"
					placeholder="Search"
					aria-label="Search project"
					data-testid="project-search"
					className="h-[calc(var(--pr-control-h)-2px)] min-w-0 flex-1 rounded-pr-control bg-pr-field-deep px-2 text-pr-small text-pr-text"
					value={search}
					onChange={(e) => setSearch(e.target.value)}
				/>
				<select
					aria-label="Filter"
					data-testid="project-filter"
					className="h-[calc(var(--pr-control-h)-2px)] rounded-pr-control bg-pr-field px-1 text-pr-small text-pr-text"
					value={filter}
					onChange={(e) => setFilter(e.target.value as ProjectFilter)}
				>
					{FILTERS.map((f) => (
						<option key={f.id} value={f.id}>
							{f.label}
						</option>
					))}
				</select>
			</div>

			{/* Body */}
			{/* gaps (UI-6): the scrolling list is keyboard-reachable (axe scrollable-region-focusable). */}
			<section
				ref={bodyRef}
				className="min-h-0 flex-1 overflow-auto"
				data-testid="project-body"
				// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be focusable to scroll by keyboard
				tabIndex={0}
				aria-label="Project items"
			>
				{uploads.length ? <PendingImports jobs={uploads} /> : null}
				{rows.length === 0 && !uploads.length ? (
					<EmptyState
						filtered={!!search || filter !== 'all'}
						readOnly={readOnly}
						onImport={() => void importDialog()}
					/>
				) : view.view === 'list' ? (
					<ListView
						scrollRef={bodyRef}
						revealId={revealId}
						rows={rows}
						selected={selectedSet}
						primary={selection.primary}
						renaming={renaming}
						dropTarget={dropTarget}
						expanded={expanded}
						sort={view.sort}
						onSort={(key) =>
							updateView({
								sort: view.sort.key === key ? { key, dir: view.sort.dir === 1 ? -1 : 1 } : { key, dir: 1 },
							})
						}
						onToggle={(id) =>
							setExpanded((s) => {
								const n = new Set(s);
								if (n.has(id)) n.delete(id);
								else n.add(id);
								return n;
							})
						}
						onRename={(id, name) => {
							if (name !== null) renameItem(session, id, name);
							setRenaming(null);
						}}
						handlers={rowHandlers}
					/>
				) : (
					<IconView
						scrollRef={bodyRef}
						revealId={revealId}
						session={session}
						rows={rows}
						selected={selectedSet}
						renaming={renaming}
						dropTarget={dropTarget}
						tile={view.tile}
						hoverScrub={view.hoverScrub}
						onRename={(id, name) => {
							if (name !== null) renameItem(session, id, name);
							setRenaming(null);
						}}
						handlers={rowHandlers}
					/>
				)}
			</section>

			{/* Footer (PRJ-003) */}
			<div className="relative flex h-[var(--pr-row-h)] shrink-0 items-center gap-1 border-t border-pr-border-subtle px-1">
				<IconButton
					icon={readOnly ? 'track.lock' : 'track.unlock'}
					label={readOnly ? 'Project is read-only' : 'Project is editable'}
					disabled
				/>
				<IconButton
					icon="app.menu"
					label="List View"
					shortcut="Ctrl+PgUp"
					toggled={view.view === 'list' ? 'on' : 'off'}
					onClick={() => updateView({ view: 'list' })}
					data-testid="project-list-view"
				/>
				<IconButton
					icon="media.image"
					label="Icon View"
					shortcut="Ctrl+PgDn"
					toggled={view.view === 'icon' ? 'on' : 'off'}
					onClick={() => updateView({ view: 'icon' })}
					data-testid="project-icon-view"
				/>
				{view.view === 'icon' ? (
					<input
						type="range"
						aria-label="Thumbnail size"
						min={TILE_MIN}
						max={TILE_MAX}
						step={16}
						value={view.tile}
						onChange={(e) => updateView({ tile: Number(e.target.value) })}
						className="w-20 accent-[var(--pr-accent)]"
					/>
				) : null}
				<span className="flex-1" />
				<IconButton
					icon="app.import"
					label="Import"
					shortcut="Ctrl+I"
					disabled={readOnly}
					onClick={() => void importDialog()}
				/>
				<IconButton
					icon="panel.project"
					label="New Bin"
					shortcut="Ctrl+B"
					disabled={readOnly}
					data-testid="project-new-bin"
					onClick={() => {
						const id = createBin(session, binId);
						if (id) setRenaming(id);
					}}
				/>
				<IconButton
					icon="app.add"
					label="New Item"
					disabled={readOnly}
					data-testid="project-new-item"
					onClick={() => setShowNewItem((v) => !v)}
				/>
				<IconButton
					icon="app.remove"
					label="Clear"
					shortcut="Delete"
					disabled={readOnly || !selected.length}
					data-testid="project-clear"
					onClick={() => deleteItems(session, selected)}
				/>
				{showNewItem ? (
					<Menu onClose={() => setShowNewItem(false)} anchor="footer">
						<MenuEntry
							testId="new-item-sequence"
							onClick={() => projectDialogs.open({ kind: 'newSequence', binId })}
						>
							Sequence…
						</MenuEntry>
						<MenuEntry onClick={() => createBin(session, binId)}>Bin</MenuEntry>
						<MenuEntry onClick={() => createText(session)}>Text</MenuEntry>
						<MenuEntry onClick={() => void runIfRegistered('panel.open.motionTemplates', ctx)}>
							Motion Graphic…
						</MenuEntry>
						{/* edit-structure: Premiere's synthetic New Items. */}
						<MenuEntry
							testId="new-item-adjustment"
							onClick={() => void runIfRegistered('project.newAdjustmentLayer', ctx, { binId })}
						>
							Adjustment Layer
						</MenuEntry>
						<MenuEntry
							testId="new-item-bars"
							onClick={() => void runIfRegistered('project.newBarsAndTone', ctx, { binId })}
						>
							Bars and Tone
						</MenuEntry>
						<MenuEntry
							testId="new-item-black"
							onClick={() => void runIfRegistered('project.newBlackVideo', ctx, { binId })}
						>
							Black Video
						</MenuEntry>
						<MenuEntry
							testId="new-item-matte"
							onClick={() => void runIfRegistered('project.newColorMatte', ctx, { binId })}
						>
							Color Matte…
						</MenuEntry>
						<MenuEntry
							testId="new-item-transparent"
							onClick={() => void runIfRegistered('project.newTransparentVideo', ctx, { binId })}
						>
							Transparent Video
						</MenuEntry>
						<MenuEntry
							testId="new-item-leader"
							onClick={() => void runIfRegistered('project.newCountingLeader', ctx, { binId })}
						>
							Universal Counting Leader…
						</MenuEntry>
						{/* three-d: a camera / light at the playhead of the active sequence (After Effects' New ▸ Camera / Light). */}
						<MenuEntry testId="new-item-camera" onClick={() => void runIfRegistered('threeD.newCamera', ctx)}>
							Camera…
						</MenuEntry>
						<MenuEntry testId="new-item-light" onClick={() => void runIfRegistered('threeD.newLight', ctx)}>
							Light…
						</MenuEntry>
					</Menu>
				) : null}
			</div>

			{menu ? (
				<ContextMenu
					x={menu.x}
					y={menu.y}
					onClose={() => setMenu(null)}
					session={session}
					itemIds={selected}
					readOnly={readOnly}
					onRename={() => menu.itemId && setRenaming(menu.itemId)}
					onOpen={() => menu.itemId && void openItem(session, menu.itemId, ctx, setBinId)}
					onNewBin={() => createBin(session, binId)}
					onCommand={(id) => void runIfRegistered(id, ctx)}
					onCommandArgs={(id, args) => void runIfRegistered(id, ctx, args)}
				/>
			) : null}
		</div>
	);
}

// ------------------------------------------------------------ pieces

function EmptyState(props: { filtered: boolean; readOnly: boolean; onImport(): void }) {
	return (
		<div
			className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center"
			data-testid="project-empty"
		>
			<span className="text-pr-icon">
				<Icon id="app.import" size={24} />
			</span>
			{props.filtered ? (
				<p className="text-pr-small text-pr-muted">No items match the search.</p>
			) : (
				<>
					<p className="text-pr-ui text-pr-text">Import media to start</p>
					<p className="text-pr-small text-pr-muted">Drop files here or press Ctrl+I.</p>
					{props.readOnly ? null : <Button onClick={props.onImport}>Import…</Button>}
				</>
			)}
		</div>
	);
}

function PendingImports({ jobs }: { jobs: ClientJob[] }) {
	return (
		<ul className="border-b border-pr-border-subtle" data-testid="project-pending">
			{jobs.map((j) => (
				<li
					key={j.id}
					className="flex h-[var(--pr-row-h)] items-center gap-2 px-2 text-pr-small text-pr-muted"
				>
					<ProgressRing value={j.progress ?? 0} />
					<span className="truncate">{j.title.replace(/^Upload – /, '')}</span>
					<span className="ml-auto">{Math.round((j.progress ?? 0) * 100)}%</span>
				</li>
			))}
		</ul>
	);
}

function ProgressRing({ value, size = 12 }: { value: number; size?: number }) {
	const r = size / 2 - 1.5;
	const c = 2 * Math.PI * r;
	return (
		<svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" className="shrink-0">
			<circle
				cx={size / 2}
				cy={size / 2}
				r={r}
				fill="none"
				stroke="var(--pr-border-strong)"
				strokeWidth={1.5}
			/>
			<circle
				cx={size / 2}
				cy={size / 2}
				r={r}
				fill="none"
				stroke="var(--pr-accent)"
				strokeWidth={1.5}
				strokeDasharray={`${c * Math.max(0, Math.min(1, value))} ${c}`}
				transform={`rotate(-90 ${size / 2} ${size / 2})`}
			/>
		</svg>
	);
}

type Handlers = (row: ProjectRow) => Record<string, unknown>;

function RenameField(props: { initial: string; onDone(name: string | null): void }) {
	const [v, setV] = useState(props.initial);
	const done = useRef(false);
	const finish = (name: string | null) => {
		if (done.current) return;
		done.current = true;
		props.onDone(name);
	};
	return (
		<input
			// biome-ignore lint/a11y/noAutofocus: inline rename takes focus like Premiere
			autoFocus
			aria-label="Name"
			data-testid="project-rename"
			className="h-[calc(var(--pr-row-h)-4px)] w-full min-w-0 rounded-pr-control bg-pr-field px-1 text-pr-text"
			value={v}
			onChange={(e) => setV(e.target.value)}
			onFocus={(e) => e.currentTarget.select()}
			onKeyDown={(e) => {
				e.stopPropagation();
				if (e.key === 'Enter') finish(v);
				if (e.key === 'Escape') finish(null);
			}}
			onBlur={() => finish(v)}
			onClick={(e) => e.stopPropagation()}
		/>
	);
}

function StatusCell({ row }: { row: ProjectRow }) {
	if (!row.status) return null;
	return (
		<span
			className={cx(
				row.status === 'offline' || row.status === 'error'
					? 'text-pr-danger'
					: row.status === 'online'
						? 'text-pr-muted'
						: 'text-pr-warning',
			)}
		>
			{STATUS_TEXT[row.status] ?? row.status}
		</span>
	);
}

const COLUMNS: {
	key: string;
	label: string;
	width: number;
	sort?: SortKey;
	cell(r: ProjectRow): React.ReactNode;
}[] = [
	{ key: 'frameRate', label: 'Frame Rate', width: 80, sort: 'frameRate', cell: (r) => r.frameRate },
	{ key: 'start', label: 'Media Start', width: 96, cell: (r) => r.mediaStart },
	{ key: 'end', label: 'Media End', width: 96, cell: (r) => r.mediaEnd },
	{ key: 'duration', label: 'Media Duration', width: 104, sort: 'duration', cell: (r) => r.duration },
	{ key: 'video', label: 'Video Info', width: 128, cell: (r) => r.videoInfo },
	{ key: 'audio', label: 'Audio Info', width: 128, cell: (r) => r.audioInfo },
	{ key: 'usage', label: 'Usage', width: 56, sort: 'usage', cell: (r) => (r.mediaId ? r.usage : '') },
	{ key: 'proxy', label: 'Proxy', width: 64, cell: (r) => r.proxy },
	{ key: 'status', label: 'Status', width: 104, sort: 'status', cell: (r) => <StatusCell row={r} /> },
];

/** The height of a rendered list row (windowing). */
const measureListRow = (l: HTMLElement) =>
	l.querySelector<HTMLElement>('tr[data-testid="project-row"]')?.getBoundingClientRect().height || null;

function ListView(props: {
	scrollRef: React.RefObject<HTMLElement | null>;
	revealId: string | null;
	rows: ProjectRow[];
	selected: Set<string>;
	primary: string | null;
	renaming: string | null;
	dropTarget: string | null;
	expanded: Set<string>;
	sort: { key: SortKey; dir: 1 | -1 };
	onSort(key: SortKey): void;
	onToggle(id: string): void;
	onRename(id: string, name: string | null): void;
	handlers: Handlers;
}) {
	const arrow = (k: SortKey) => (props.sort.key === k ? (props.sort.dir === 1 ? ' ↑' : ' ↓') : '');
	// ui-perf: large bins render only the rows in view (virtual.ts).
	const tbodyRef = useRef<HTMLTableSectionElement>(null);
	const revealIndex = props.revealId ? props.rows.findIndex((r) => r.id === props.revealId) : -1;
	const win = useRowWindow({
		scroll: props.scrollRef,
		list: tbodyRef,
		rows: props.rows.length,
		enabled: props.rows.length >= VIRTUALIZE_MIN_ROWS,
		measure: measureListRow,
		reveal: revealIndex >= 0 ? revealIndex : null,
	});
	const shown = win.on ? props.rows.slice(win.start, win.end) : props.rows;
	const spacer = (rows: number, key: string) =>
		win.on && rows > 0 && win.rowH > 0 ? (
			<tr key={key} aria-hidden data-virtual-spacer="">
				<td colSpan={COLUMNS.length + 2} style={{ height: rows * win.rowH, padding: 0 }} />
			</tr>
		) : null;
	return (
		<table className="w-max min-w-full border-collapse text-pr-small" data-testid="project-list">
			<thead className="sticky top-0 bg-pr-panel text-pr-muted">
				<tr className="h-[var(--pr-row-h)]">
					<th className="w-5" aria-label="Label" />
					<th
						className="min-w-48 cursor-pointer px-2 text-left font-normal"
						onClick={() => props.onSort('name')}
					>
						Name{arrow('name')}
					</th>
					{COLUMNS.map((c) => (
						<th
							key={c.key}
							className={cx('px-2 text-left font-normal whitespace-nowrap', c.sort ? 'cursor-pointer' : '')}
							style={{ minWidth: c.width }}
							onClick={c.sort ? () => props.onSort(c.sort!) : undefined}
						>
							{c.label}
							{c.sort ? arrow(c.sort) : ''}
						</th>
					))}
				</tr>
			</thead>
			<tbody ref={tbodyRef}>
				{spacer(win.start, 'above')}
				{shown.map((row, k) => {
					const i = win.start + k;
					const sel = props.selected.has(row.id);
					return (
						<tr
							key={row.id}
							data-testid="project-row"
							data-item-id={row.id}
							aria-selected={sel}
							data-primary={sel && props.primary === row.id ? '' : undefined}
							className={cx(
								'h-[var(--pr-row-h)] cursor-default select-none',
								sel ? 'bg-pr-selected' : i % 2 ? 'bg-pr-panel-alt' : 'bg-pr-panel',
								sel && props.primary === row.id ? 'text-pr-strong' : '',
								props.dropTarget === row.id ? 'outline outline-2 -outline-offset-2 outline-pr-accent' : '',
								row.status === 'offline' ? 'text-pr-danger' : '',
							)}
							{...props.handlers(row)}
						>
							<td className="px-1">
								<span
									className="block size-3 rounded-[2px]"
									style={{ background: labelVar(row.item.label as LabelColor) }}
								/>
							</td>
							<td className="px-2">
								<div className="flex items-center gap-1" style={{ paddingLeft: row.depth * 14 }}>
									{row.type === 'bin' ? (
										<button
											type="button"
											aria-label={props.expanded.has(row.id) ? 'Collapse' : 'Expand'}
											className="w-3 text-pr-muted"
											onClick={(e) => {
												e.stopPropagation();
												props.onToggle(row.id);
											}}
										>
											{props.expanded.has(row.id) ? '▾' : '▸'}
										</button>
									) : (
										<span className="w-3" />
									)}
									<span className="text-pr-icon">
										<Icon id={TYPE_ICON[row.type]} size={14} />
									</span>
									{props.renaming === row.id ? (
										<RenameField initial={row.name} onDone={(n) => props.onRename(row.id, n)} />
									) : (
										<span className="truncate" data-no-i18n>
											{row.name}
										</span>
									)}
									{row.status === 'analyzing' ? <span className="animate-pulse text-pr-dim">•</span> : null}
								</div>
							</td>
							{COLUMNS.map((c) => (
								<td key={c.key} className="px-2 whitespace-nowrap text-pr-muted">
									{c.cell(row)}
								</td>
							))}
						</tr>
					);
				})}
				{spacer(props.rows.length - win.end, 'below')}
			</tbody>
		</table>
	);
}

/** Icon view grid geometry: `p-2` padding and `gap-2` between tiles (px). */
const GRID_PAD = 8;
const GRID_GAP = 8;
const measureTileRow = (l: HTMLElement) => {
	const h = l.querySelector<HTMLElement>('[data-testid="project-tile"]')?.getBoundingClientRect().height;
	return h ? h + GRID_GAP : null;
};

function IconView(props: {
	scrollRef: React.RefObject<HTMLElement | null>;
	revealId: string | null;
	session: EditorSession;
	rows: ProjectRow[];
	selected: Set<string>;
	renaming: string | null;
	dropTarget: string | null;
	tile: number;
	hoverScrub: boolean;
	onRename(id: string, name: string | null): void;
	handlers: Handlers;
}) {
	// ui-perf: large bins render only the grid rows in view (virtual.ts); columns follow CSS `auto-fill`.
	const gridRef = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		const el = gridRef.current;
		if (!el) return;
		const read = () => setWidth(el.clientWidth);
		read();
		if (typeof ResizeObserver === 'undefined') return;
		const ro = new ResizeObserver(read);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	const cols = Math.max(1, Math.floor((width - 2 * GRID_PAD + GRID_GAP) / (props.tile + GRID_GAP)));
	const gridRows = Math.ceil(props.rows.length / cols);
	const revealIndex = props.revealId ? props.rows.findIndex((r) => r.id === props.revealId) : -1;
	const win = useRowWindow({
		scroll: props.scrollRef,
		list: gridRef,
		rows: gridRows,
		enabled: props.rows.length >= VIRTUALIZE_MIN_ROWS && width > 0,
		measure: measureTileRow,
		reveal: revealIndex >= 0 ? Math.floor(revealIndex / cols) : null,
	});
	const shown = win.on ? props.rows.slice(win.start * cols, win.end * cols) : props.rows;
	const pad = (rows: number) => (win.on && win.rowH > 0 ? rows * win.rowH : 0);
	return (
		<div
			ref={gridRef}
			role="listbox"
			aria-multiselectable="true"
			aria-label="Project items"
			className="grid gap-2 p-2"
			style={{
				gridTemplateColumns: `repeat(auto-fill, minmax(${props.tile}px, 1fr))`,
				...(win.on
					? {
							paddingTop: GRID_PAD + pad(win.start),
							paddingBottom: GRID_PAD + pad(gridRows - win.end),
						}
					: {}),
			}}
			data-testid="project-icons"
		>
			{shown.map((row) => (
				<Tile
					key={row.id}
					session={props.session}
					row={row}
					selected={props.selected.has(row.id)}
					renaming={props.renaming === row.id}
					drop={props.dropTarget === row.id}
					width={props.tile}
					hoverScrub={props.hoverScrub}
					onRename={(n) => props.onRename(row.id, n)}
					handlers={props.handlers(row)}
				/>
			))}
		</div>
	);
}

function Tile(props: {
	session: EditorSession;
	row: ProjectRow;
	selected: boolean;
	renaming: boolean;
	drop: boolean;
	width: number;
	hoverScrub: boolean;
	onRename(name: string | null): void;
	handlers: Record<string, unknown>;
}) {
	const { row } = props;
	const engine = useEngine();
	const rt = useSessionState((s) => (row.mediaId ? s.media[row.mediaId] : undefined));
	const asset = row.mediaId ? props.session.getCommitted().media[row.mediaId] : undefined;
	const key = mediaKeyOf(asset);
	const [posterFailed, setPosterFailed] = useState(false);
	const [scrub, setScrub] = useState<React.CSSProperties | null>(null);
	const poster =
		rt?.posterUrl ??
		(key && !posterFailed && row.type !== 'audio' ? engine.client.mediaUrl(key, 'poster') : null);
	const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
		if (!props.hoverScrub || !key || row.type !== 'video' || rt?.thumbs.state === 'failed') return;
		const rect = e.currentTarget.getBoundingClientRect();
		const frac = rect.width ? (e.clientX - rect.left) / rect.width : 0;
		const w = rect.width || props.width;
		void loadSpriteIndex(engine.client, key).then((index) => {
			if (!index) return;
			const tile = spriteTileAt(index, frac, durationSeconds(asset));
			if (tile) setScrub(spriteTileStyle(engine.client, key, index, tile, w));
		});
	};
	return (
		<div
			role="option"
			tabIndex={-1}
			data-testid="project-tile"
			data-item-id={row.id}
			aria-selected={props.selected}
			className={cx(
				'flex cursor-default flex-col gap-1 rounded-pr-control p-1 select-none',
				props.selected ? 'bg-pr-selected' : 'hover:bg-pr-hover',
				props.drop ? 'outline outline-2 -outline-offset-2 outline-pr-accent' : '',
			)}
			{...props.handlers}
		>
			<div
				className={cx(
					'relative aspect-video overflow-hidden rounded-pr-control bg-pr-field-deep',
					row.status === 'analyzing' ? 'animate-pulse' : '',
					row.status === 'offline' ? 'bg-pr-danger' : '',
				)}
				onPointerMove={onMove}
				onPointerLeave={() => setScrub(null)}
			>
				{scrub ? (
					<div className="absolute inset-0" style={scrub} />
				) : poster ? (
					<img
						src={poster}
						alt=""
						draggable={false}
						className="absolute inset-0 size-full object-cover"
						onError={() => setPosterFailed(true)}
					/>
				) : (
					<span className="absolute inset-0 flex items-center justify-center text-pr-icon">
						<Icon id={TYPE_ICON[row.type]} size={Math.round(props.width / 5)} />
					</span>
				)}
				{row.status === 'offline' ? (
					<span className="absolute inset-0 flex items-center justify-center text-pr-small text-pr-on-accent">
						Media Offline
					</span>
				) : null}
				<span className="absolute top-1 right-1 flex gap-1">
					{row.mediaId && row.usage ? (
						<span className="rounded-pr-control bg-pr-menu px-1 text-pr-small text-pr-text" title="Usage">
							{row.usage}
						</span>
					) : null}
					{rt && (rt.proxy.state === 'running' || rt.proxy.state === 'queued') ? (
						<span title={`Proxy ${row.proxy}`}>
							<ProgressRing value={rt.proxy.progress} />
						</span>
					) : null}
					{rt?.proxy.state === 'ready' ? (
						<span
							className="rounded-pr-control bg-pr-menu px-1 text-pr-small text-pr-accent"
							title="Proxy ready"
						>
							P
						</span>
					) : null}
				</span>
				{row.duration || row.type === 'lut' ? (
					<span className="absolute right-1 bottom-1 rounded-pr-control bg-pr-menu px-1 text-pr-small text-pr-text">
						{row.duration || row.videoInfo}
					</span>
				) : null}
				<span
					className="absolute inset-x-0 bottom-0 h-[3px]"
					style={{ background: labelVar(row.item.label as LabelColor) }}
				/>
			</div>
			{props.renaming ? (
				<RenameField initial={row.name} onDone={props.onRename} />
			) : (
				<span className="line-clamp-2 text-pr-small break-words">{row.name}</span>
			)}
		</div>
	);
}

function Menu(props: {
	children: React.ReactNode;
	onClose(): void;
	anchor: 'footer' | { x: number; y: number };
}) {
	const ref = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		const onDown = (e: PointerEvent) => {
			if (!ref.current?.contains(e.target as Node)) props.onClose();
		};
		const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
		window.addEventListener('pointerdown', onDown, true);
		window.addEventListener('keydown', onKey, true);
		return () => {
			window.removeEventListener('pointerdown', onDown, true);
			window.removeEventListener('keydown', onKey, true);
		};
	}, [props.onClose]);
	const className =
		'flex min-w-40 flex-col rounded-pr-menu border border-pr-menu-border bg-pr-menu py-1 text-pr-ui shadow-pr-overlay';
	if (props.anchor !== 'footer')
		// At the pointer: kept inside the window, flipped up / left or pinned and scrolling, also after the inline
		// Label list opens (PointMenu, wp fixups).
		return (
			<PointMenu
				x={props.anchor.x}
				y={props.anchor.y}
				menuRef={ref}
				className={className}
				onClick={() => props.onClose()}
				onKeyDown={() => undefined}
			>
				{props.children}
			</PointMenu>
		);
	return (
		<div
			ref={ref}
			role="menu"
			className={cx(className, 'absolute z-10')}
			style={{ right: 4, bottom: 'calc(var(--pr-row-h) + 2px)' }}
			onClick={() => props.onClose()}
			onKeyDown={() => undefined}
		>
			{props.children}
		</div>
	);
}

function MenuEntry(props: {
	children: React.ReactNode;
	onClick(): void;
	disabled?: boolean;
	testId?: string;
}) {
	return (
		<button
			type="button"
			role="menuitem"
			data-testid={props.testId}
			disabled={props.disabled}
			className="px-3 py-1 text-left text-pr-text hover:bg-pr-accent-fill hover:text-pr-on-accent disabled:text-pr-dim"
			onClick={props.onClick}
		>
			{props.children}
		</button>
	);
}

function ContextMenu(props: {
	x: number;
	y: number;
	onClose(): void;
	session: EditorSession;
	itemIds: string[];
	readOnly: boolean;
	onRename(): void;
	onOpen(): void;
	onNewBin(): void;
	/** Runs an Edit command for this panel (wp-clipboard: Cut / Copy / Paste, S01:CLB-007). */
	onCommand(commandId: string): void;
	onCommandArgs(commandId: string, args: unknown): void;
}) {
	const [labels, setLabels] = useState(false);
	const doc = props.session.getCommitted();
	const editableSynthetic =
		props.itemIds.length === 1 &&
		doc.items[props.itemIds[0]!]?.kind === 'synthetic' &&
		['color-matte', 'counting-leader'].includes(
			doc.synthetics[(doc.items[props.itemIds[0]!] as { syntheticId: string }).syntheticId]?.kind ?? '',
		)
			? props.itemIds[0]!
			: null;
	return (
		<Menu anchor={{ x: props.x, y: props.y }} onClose={props.onClose}>
			<MenuEntry onClick={props.onOpen}>Open</MenuEntry>
			<MenuEntry
				disabled={props.readOnly || !props.itemIds.length}
				onClick={() => props.onCommand('edit.cut')}
				testId="project-menu-cut"
			>
				Cut
			</MenuEntry>
			<MenuEntry
				disabled={!props.itemIds.length}
				onClick={() => props.onCommand('edit.copy')}
				testId="project-menu-copy"
			>
				Copy
			</MenuEntry>
			<MenuEntry
				disabled={props.readOnly}
				onClick={() => props.onCommand('edit.paste')}
				testId="project-menu-paste"
			>
				Paste
			</MenuEntry>
			<MenuEntry disabled={props.readOnly || props.itemIds.length !== 1} onClick={props.onRename}>
				Rename
			</MenuEntry>
			<button
				type="button"
				role="menuitem"
				disabled={props.readOnly}
				className="px-3 py-1 text-left text-pr-text hover:bg-pr-hover disabled:text-pr-dim"
				onClick={(e) => {
					e.stopPropagation();
					setLabels((v) => !v);
				}}
			>
				Label ▸
			</button>
			{labels
				? LABEL_NAMES.map((l) => (
						<MenuEntry key={l} onClick={() => setLabel(props.session, props.itemIds, l)}>
							<span className="flex items-center gap-2">
								<span className="block size-3 rounded-[2px]" style={{ background: labelVar(l) }} />
								{labelName(l)}
							</span>
						</MenuEntry>
					))
				: null}
			<MenuEntry disabled={props.readOnly} onClick={props.onNewBin}>
				New Bin
			</MenuEntry>
			{/* edit-structure: Duplicate (sequences), synthetic settings, Remove Unused. */}
			<MenuEntry
				disabled={props.readOnly || !props.itemIds.some((id) => doc.items[id]?.kind === 'sequence')}
				onClick={() => props.onCommandArgs('project.duplicateSequence', { itemIds: props.itemIds })}
				testId="project-menu-duplicate"
			>
				Duplicate
			</MenuEntry>
			{/* wp-multicam: Premiere's Project panel context menu entries. */}
			<MenuEntry
				disabled={props.readOnly || mediaCount(doc, props.itemIds) < 2}
				onClick={() => props.onCommand('clip.mergeClips')}
				testId="project-menu-merge-clips"
			>
				Merge Clips…
			</MenuEntry>
			<MenuEntry
				disabled={props.readOnly || mediaCount(doc, props.itemIds) < 1}
				onClick={() => props.onCommand('clip.createMulticam')}
				testId="project-menu-create-multicam"
			>
				Create Multi-Camera Source Sequence…
			</MenuEntry>
			{editableSynthetic ? (
				<MenuEntry
					disabled={props.readOnly}
					onClick={() => props.onCommandArgs('project.editSynthetic', { itemId: editableSynthetic })}
					testId="project-menu-edit-synthetic"
				>
					{doc.synthetics[(doc.items[editableSynthetic] as { syntheticId: string }).syntheticId]?.kind ===
					'counting-leader'
						? 'Universal Counting Leader Setup…'
						: 'Color Picker…'}
				</MenuEntry>
			) : null}
			{/* wp interchange (S04:AS-011): relink offline media. */}
			<MenuEntry
				disabled={props.readOnly || !props.itemIds.some((id) => isOfflineItem(props.session, id))}
				onClick={() => props.onCommand('project.linkMedia')}
				testId="project-menu-link-media"
			>
				Link Media…
			</MenuEntry>
			<MenuEntry disabled={props.readOnly} onClick={() => props.onCommand('edit.removeUnused')}>
				Remove Unused
			</MenuEntry>
			<MenuEntry
				disabled={props.readOnly || !props.itemIds.length}
				onClick={() => deleteItems(props.session, props.itemIds)}
			>
				Clear
			</MenuEntry>
			{/* M2 entries registered by feature packages (Process…, Rebuild bundle…; ARCHITECTURE §19.10). */}
			<ExtensionEntries
				items={extensionItems(props.session, props.itemIds, props.readOnly, props.onCommandArgs)}
				onClose={props.onClose}
			/>
		</Menu>
	);
}

/** wp interchange: a media item whose file is offline (an imported placeholder or a missing file). */
function isOfflineItem(session: EditorSession, id: string): boolean {
	const st = session.getState();
	const item = st.document.items[id];
	if (item?.kind !== 'media') return false;
	const m = st.document.media[item.mediaId];
	return (
		!!m && (m.fingerprint.startsWith('pending:interchange:') || st.media[m.id]?.availability === 'offline')
	);
}

/** wp-multicam: audio/video media items among `ids`. */
function mediaCount(doc: ReturnType<EditorSession['getCommitted']>, ids: readonly string[]): number {
	return ids.filter((id) => {
		const it = doc.items[id];
		const k = it?.kind === 'media' ? doc.media[it.mediaId]?.kind : undefined;
		return k === 'video' || k === 'audio';
	}).length;
}

function extensionItems(
	session: EditorSession,
	itemIds: readonly string[],
	readOnly: boolean,
	runCommand?: (commandId: string, args: unknown) => void,
): MenuItemSpec[] {
	const doc = session.getCommitted();
	const items = itemIds.map((id) => doc.items[id]).filter((i): i is ProjectItem => !!i);
	if (!items.length) return [];
	return collectMenuItems(projectItemMenuExtensions.list(), {
		session,
		items,
		readOnly,
		...(runCommand ? { runCommand } : {}),
	});
}

function ExtensionEntries(props: { items: MenuItemSpec[]; onClose(): void; depth?: number }) {
	const pad = props.depth ? { paddingLeft: 12 + props.depth * 12 } : undefined;
	return (
		<>
			{props.items.map((it, i) =>
				it.kind === 'separator' ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: static menu entries
					<hr key={`sep-${i}`} className="my-1 h-px border-0 bg-pr-border-subtle" />
				) : it.kind === 'submenu' ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: static menu entries
					<div key={`sub-${i}`}>
						<div className="px-3 py-1 text-pr-small text-pr-muted" style={pad}>
							{it.label}
						</div>
						<ExtensionEntries items={it.items} onClose={props.onClose} depth={(props.depth ?? 0) + 1} />
					</div>
				) : (
					<MenuEntry
						// biome-ignore lint/suspicious/noArrayIndexKey: static menu entries
						key={`item-${i}`}
						disabled={it.disabled}
						onClick={() => {
							it.run();
							props.onClose();
						}}
					>
						<span style={pad}>{it.label}</span>
					</MenuEntry>
				),
			)}
		</>
	);
}
