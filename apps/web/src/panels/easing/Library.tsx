// Easing panel ▸ the library: group tabs (favourites, the built-in groups, the user's groups; New Group), a grid of
// curve tiles (size slider, fitted or fixed columns). Hover shows a tile in the preview and info line; click applies
// it to the selected keys (with the targeting modifiers) and loads it into the editor; the tile matching the
// current curve is highlighted. User curves can be renamed, colour-labelled, moved to another group, reordered (drag,
// or Alt+←/→ on a focused tile, or the menu) and deleted (with Undo); built-ins are read-only (Duplicate to edit).
// Import / export a JSON file (validated, size-capped; problems are listed inline).
import type { EasePreset, LabelColor } from '@jasper/project';
import { Button, cx, LABEL_DISPLAY_NAMES, LABEL_NAMES, labelColor, Slider } from '@jasper/ui';
import {
	type DragEvent,
	type KeyboardEvent as ReactKeyboardEvent,
	type MouseEvent as ReactMouseEvent,
	useRef,
	useState,
} from 'react';
import { t } from '../../i18n/runtime.ts';
import { SelectField } from '../properties/controls/fields.tsx';
import { downloadBytes } from '../text/state.ts';
import { ContextMenu } from '../timeline/components/Chrome.tsx';
import type { ContextMenuItem } from '../timeline/state/ui-store.ts';
import { CurveThumb } from './CurveThumb.tsx';
import type { EaseCatalog } from './catalog.ts';
import {
	addGroup,
	DEFAULT_GROUP_ID,
	deleteGroup,
	deletePreset,
	duplicatePreset,
	type EaseLibraryState,
	easeLibrary,
	exportLibrary,
	importLibrary,
	MAX_IMPORT_BYTES,
	movePresetToGroup,
	renameGroup,
	renamePreset,
	reorderPreset,
	setPresetColor,
	toggleFavourite,
	type UserPreset,
} from './library.ts';

export const FAVOURITES_TAB = '__favourites';
const BUILTIN = 'builtin:';
const DRAG_MIME = 'application/x-jasper-ease-preset';

type Tab = { id: string; label: string; kind: 'favourites' | 'builtin' | 'user' };

export function groupLabel(id: string, name: string): string {
	return id === DEFAULT_GROUP_ID ? t('My Curves') : name;
}

export function libraryTabs(catalog: EaseCatalog, lib: EaseLibraryState): Tab[] {
	return [
		{ id: FAVOURITES_TAB, label: t('Favourites'), kind: 'favourites' },
		...catalog.groups.map((g) => ({ id: `${BUILTIN}${g.id}`, label: t(g.name), kind: 'builtin' as const })),
		...lib.groups.map((g) => ({ id: g.id, label: groupLabel(g.id, g.name), kind: 'user' as const })),
	];
}

/** Presets shown on a tab. */
export function tabPresets(catalog: EaseCatalog, lib: EaseLibraryState, tab: Tab | undefined): UserPreset[] {
	if (!tab) return [];
	if (tab.kind === 'favourites') {
		const all = new Map<string, UserPreset>([...catalog.presets, ...lib.presets].map((p) => [p.id, p]));
		return lib.favourites.map((id) => all.get(id)).filter((p): p is UserPreset => !!p);
	}
	if (tab.kind === 'builtin') return catalog.presets.filter((p) => `${BUILTIN}${p.group}` === tab.id);
	return lib.presets.filter((p) => p.group === tab.id);
}

type Editing = { kind: 'preset' | 'group' | 'newGroup'; id: string } | null;

function InlineName(props: { initial: string; label: string; onDone(name: string | null): void }) {
	const [v, setV] = useState(props.initial);
	const done = useRef(false);
	const finish = (name: string | null) => {
		if (done.current) return;
		done.current = true;
		props.onDone(name);
	};
	return (
		<input
			// biome-ignore lint/a11y/noAutofocus: the field appears because the user asked to name something
			autoFocus
			aria-label={props.label}
			className="h-[20px] w-full min-w-[60px] rounded-pr-control border border-pr-focus bg-pr-field px-1 font-pr text-pr-ui text-pr-text outline-none"
			value={v}
			maxLength={200}
			onChange={(e) => setV(e.target.value)}
			onKeyDown={(e) => {
				if (e.key === 'Enter') finish(v);
				if (e.key === 'Escape') finish(null);
				e.stopPropagation();
			}}
			onBlur={() => finish(v)}
			onFocus={(e) => e.currentTarget.select()}
			data-testid="ease-inline-name"
		/>
	);
}

export function Library(props: {
	catalog: EaseCatalog;
	lib: EaseLibraryState;
	/** Preset matching the editor's curve (highlighted). */
	matchedId: string | null;
	onHover(p: EasePreset | null): void;
	onPick(p: EasePreset, e: ReactMouseEvent | null): void;
	onLoad(p: EasePreset): void;
}) {
	const { catalog, lib } = props;
	const tabs = libraryTabs(catalog, lib);
	const tab = tabs.find((x) => x.id === lib.settings.group) ?? tabs.find((x) => x.kind === 'user') ?? tabs[0];
	const presets = tabPresets(catalog, lib, tab);
	const userTab = tab?.kind === 'user';
	const [editing, setEditing] = useState<Editing>(null);
	const [errors, setErrors] = useState<string[]>([]);
	const [notice, setNotice] = useState<{ text: string; undo?: EaseLibraryState } | null>(null);
	const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
	const dragId = useRef<string | null>(null);
	const fileRef = useRef<HTMLInputElement | null>(null);
	const userGroups = lib.groups;
	const isUser = (p: EasePreset) => lib.presets.some((x) => x.id === p.id);

	const run = (op: Parameters<typeof easeLibrary.run>[0]) => {
		const err = easeLibrary.run(op);
		setErrors(err ? [err] : []);
		return !err;
	};
	const setTab = (id: string) => easeLibrary.settings({ group: id });

	const presetMenu = (p: UserPreset): ContextMenuItem[] => {
		const fav = lib.favourites.includes(p.id);
		const user = isUser(p);
		const own = lib.presets.filter((x) => x.group === p.group);
		const at = own.findIndex((x) => x.id === p.id);
		const items: ContextMenuItem[] = [
			{ kind: 'item', label: t('Apply to Selected Keys'), run: () => props.onPick(p, null) },
			{ kind: 'item', label: t('Load into Editor'), run: () => props.onLoad(p) },
			{
				kind: 'item',
				label: fav ? t('Remove from Favourites') : t('Add to Favourites'),
				run: () => easeLibrary.update((s) => toggleFavourite(s, p.id)),
			},
			{ kind: 'separator' },
		];
		if (!user) {
			items.push({
				kind: 'item',
				label: t('Duplicate to My Curves'),
				run: () => {
					if (run((s) => duplicatePreset(s, p, DEFAULT_GROUP_ID)))
						setNotice({ text: t('Copied “{0}” to My Curves', p.name) });
				},
			});
			return items;
		}
		items.push(
			{ kind: 'item', label: t('Rename…'), run: () => setEditing({ kind: 'preset', id: p.id }) },
			{
				kind: 'submenu',
				label: t('Colour Label'),
				items: [
					{
						kind: 'item',
						label: t('None'),
						checked: !p.color,
						run: () => run((s) => setPresetColor(s, p.id, null)),
					},
					...LABEL_NAMES.map(
						(c): ContextMenuItem => ({
							kind: 'item',
							label: t(LABEL_DISPLAY_NAMES[c]),
							checked: p.color === c,
							run: () => run((s) => setPresetColor(s, p.id, c as LabelColor)),
						}),
					),
				],
			},
			{
				kind: 'submenu',
				label: t('Move to Group'),
				items: userGroups
					.filter((g) => g.id !== p.group)
					.map(
						(g): ContextMenuItem => ({
							kind: 'item',
							label: groupLabel(g.id, g.name),
							run: () => run((s) => movePresetToGroup(s, p.id, g.id)),
						}),
					)
					.concat(
						userGroups.length > 1
							? []
							: [{ kind: 'item', label: t('No other group'), disabled: true, run: () => {} }],
					),
			},
			{
				kind: 'item',
				label: t('Move Earlier'),
				disabled: at <= 0,
				run: () => run((s) => reorderPreset(s, p.id, at - 1)),
			},
			{
				kind: 'item',
				label: t('Move Later'),
				disabled: at < 0 || at >= own.length - 1,
				run: () => run((s) => reorderPreset(s, p.id, at + 1)),
			},
			{ kind: 'separator' },
			{
				kind: 'item',
				label: t('Delete'),
				run: () => {
					const before = easeLibrary.get();
					if (run((s) => deletePreset(s, p.id)))
						setNotice({ text: t('Deleted “{0}”', p.name), undo: before });
				},
			},
		);
		return items;
	};

	const groupMenu = (tabId: string): ContextMenuItem[] => {
		const g = userGroups.find((x) => x.id === tabId);
		if (!g) return [];
		return [
			{ kind: 'item', label: t('Rename Group…'), run: () => setEditing({ kind: 'group', id: g.id }) },
			{
				kind: 'item',
				label: g.id === DEFAULT_GROUP_ID ? t('Delete Group (the default group stays)') : t('Delete Group'),
				disabled: g.id === DEFAULT_GROUP_ID,
				run: () => {
					const before = easeLibrary.get();
					if (run((s) => deleteGroup(s, g.id)))
						setNotice({
							text: t('Deleted group “{0}”; its curves moved to My Curves', g.name),
							undo: before,
						});
				},
			},
		];
	};

	const onTileKey = (e: ReactKeyboardEvent, p: UserPreset, index: number) => {
		if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
			e.preventDefault();
			const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
			setMenu({ x: r.left + 8, y: r.bottom, items: presetMenu(p) });
			return;
		}
		if (userTab && e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
			e.preventDefault();
			run((s) => reorderPreset(s, p.id, index + (e.key === 'ArrowLeft' ? -1 : 1)));
			return;
		}
		if (e.key === 'F2' && isUser(p)) {
			e.preventDefault();
			setEditing({ kind: 'preset', id: p.id });
		}
	};

	const onDrop = (e: DragEvent, target: number) => {
		const id = dragId.current ?? e.dataTransfer.getData(DRAG_MIME);
		dragId.current = null;
		if (!id || !userTab) return;
		e.preventDefault();
		run((s) => reorderPreset(s, id, target));
	};

	const importFile = async (file: File | undefined) => {
		if (!file) return;
		if (file.size > MAX_IMPORT_BYTES) {
			setErrors([t('The file is larger than {0} KB', Math.round(MAX_IMPORT_BYTES / 1000))]);
			return;
		}
		let text: string;
		try {
			text = await file.text();
		} catch (error) {
			setErrors([
				t('The file could not be read: {0}', error instanceof Error ? error.message : String(error)),
			]);
			return;
		}
		const { state, report } = importLibrary(easeLibrary.get(), text);
		if (report.added) easeLibrary.set(state);
		setErrors(report.errors);
		setNotice({
			text: report.skipped
				? t('Imported {0} curves; {1} skipped', report.added, report.skipped)
				: t('Imported {0} curves', report.added),
		});
	};

	const exportIds = userTab ? presets.map((p) => p.id) : undefined;
	const exportCount = exportIds ? exportIds.length : lib.presets.length;
	const columns = lib.settings.columns;
	const thumb = lib.settings.thumb;

	return (
		<div className="flex min-h-0 flex-1 flex-col" data-testid="ease-library">
			<div
				className="flex shrink-0 items-center gap-1 overflow-x-auto border-pr-border-subtle border-b px-1"
				role="tablist"
				aria-label="Library groups"
			>
				{tabs.map((x) =>
					editing?.kind === 'group' && editing.id === x.id ? (
						<span key={x.id} className="w-[120px] shrink-0">
							<InlineName
								initial={x.label}
								label="Group name"
								onDone={(name) => {
									setEditing(null);
									if (name !== null) run((s) => renameGroup(s, x.id, name));
								}}
							/>
						</span>
					) : (
						<button
							key={x.id}
							type="button"
							role="tab"
							aria-selected={x.id === tab?.id}
							className={cx(
								'h-[24px] shrink-0 whitespace-nowrap rounded-pr-control px-2 text-pr-small',
								x.id === tab?.id
									? 'bg-pr-selected text-pr-strong'
									: 'text-pr-muted hover:bg-pr-hover hover:text-pr-text',
							)}
							onClick={() => setTab(x.id)}
							onContextMenu={(e) => {
								if (x.kind !== 'user') return;
								e.preventDefault();
								setMenu({ x: e.clientX, y: e.clientY, items: groupMenu(x.id) });
							}}
							onDragOver={(e) => {
								if (x.kind === 'user' && dragId.current) e.preventDefault();
							}}
							onDrop={(e) => {
								const id = dragId.current;
								dragId.current = null;
								if (x.kind !== 'user' || !id) return;
								e.preventDefault();
								run((s) => movePresetToGroup(s, id, x.id));
							}}
							data-testid={`ease-tab-${x.id}`}
						>
							{x.label}
						</button>
					),
				)}
				{editing?.kind === 'newGroup' ? (
					<span className="w-[120px] shrink-0">
						<InlineName
							initial={t('New Group')}
							label="New group name"
							onDone={(name) => {
								setEditing(null);
								if (name === null) return;
								const r = addGroup(easeLibrary.get(), name);
								if (!r.ok) setErrors([r.error]);
								else easeLibrary.set({ ...r.state, settings: { ...r.state.settings, group: r.id! } });
							}}
						/>
					</span>
				) : (
					<button
						type="button"
						className="h-[24px] shrink-0 rounded-pr-control px-2 text-pr-small text-pr-muted hover:bg-pr-hover hover:text-pr-text"
						onClick={() => setEditing({ kind: 'newGroup', id: '' })}
						data-testid="ease-new-group"
					>
						+ New Group
					</button>
				)}
			</div>
			<div className="flex shrink-0 items-center gap-2 px-2 py-1">
				<span className="text-pr-small text-pr-muted">Size</span>
				<div className="w-[100px] shrink-0">
					<Slider
						label="Thumbnail size"
						min={40}
						max={160}
						step={4}
						value={thumb}
						defaultValue={64}
						onChange={(v) => easeLibrary.settings({ thumb: Math.round(v) })}
					/>
				</div>
				<SelectField<string>
					label="Columns"
					value={String(columns)}
					options={['auto', '1', '2', '3', '4', '5', '6', '8']}
					labels={[t('Fit'), '1', '2', '3', '4', '5', '6', '8']}
					onChange={(v) => easeLibrary.settings({ columns: v === 'auto' ? 'auto' : Number(v) })}
					className="w-[64px] shrink-0"
					data-testid="ease-columns"
				/>
				<span className="ml-auto" />
				<Button variant="quiet" onClick={() => fileRef.current?.click()} data-testid="ease-import">
					Import…
				</Button>
				<Button
					variant="quiet"
					disabled={exportCount === 0}
					disabledReason={t('No curves of yours to export here')}
					onClick={() => {
						const json = exportLibrary(easeLibrary.get(), exportIds);
						const name = userTab ? (tab?.label ?? 'curves') : 'curves';
						downloadBytes(
							new TextEncoder().encode(json),
							`${name.replace(/[^\w-]+/g, '_')}.ease.json`,
							'application/json',
						);
					}}
					data-testid="ease-export"
				>
					Export…
				</Button>
				<input
					ref={fileRef}
					type="file"
					accept=".json,application/json"
					className="hidden"
					aria-label="Import curve presets"
					onChange={(e) => {
						const f = e.currentTarget.files?.[0];
						e.currentTarget.value = '';
						void importFile(f);
					}}
					data-testid="ease-import-file"
				/>
			</div>
			{errors.length ? (
				<ul
					role="alert"
					className="mx-2 mb-1 list-disc rounded-pr-control bg-pr-field px-5 py-1 text-pr-small text-pr-warning"
					data-testid="ease-library-errors"
				>
					{errors.map((m) => (
						<li key={m}>{m}</li>
					))}
				</ul>
			) : null}
			{notice ? (
				<div
					className="mx-2 mb-1 flex items-center gap-2 text-pr-small text-pr-muted"
					role="status"
					data-testid="ease-library-notice"
				>
					<span className="min-w-0 flex-1 truncate">{notice.text}</span>
					{notice.undo ? (
						<Button
							variant="quiet"
							onClick={() => {
								easeLibrary.set(notice.undo!);
								setNotice(null);
							}}
						>
							Undo
						</Button>
					) : null}
					<Button variant="quiet" onClick={() => setNotice(null)} aria-label="Dismiss">
						×
					</Button>
				</div>
			) : null}
			<div className="min-h-0 flex-1 overflow-y-auto p-2" onPointerLeave={() => props.onHover(null)}>
				{presets.length === 0 ? (
					<p className="text-pr-small text-pr-muted" data-testid="ease-library-empty">
						{tab?.kind === 'favourites'
							? t('No favourites yet: right-click a curve ▸ Add to Favourites.')
							: tab?.kind === 'user'
								? t('No curves here yet: shape one in the editor and choose Save to Library.')
								: t('This group is empty.')}
					</p>
				) : (
					<div
						className="grid gap-2"
						style={{
							gridTemplateColumns:
								columns === 'auto'
									? `repeat(auto-fill, minmax(${thumb + 8}px, 1fr))`
									: `repeat(${columns}, minmax(0, 1fr))`,
						}}
						data-testid="ease-grid"
					>
						{presets.map((p, i) => {
							const matched = props.matchedId === p.id;
							const fav = lib.favourites.includes(p.id);
							const user = isUser(p);
							const renaming = editing?.kind === 'preset' && editing.id === p.id;
							return (
								// biome-ignore lint/a11y/noStaticElementInteractions: drop target, hover preview and menu of a tile; its button is the keyboard control
								<div
									key={p.id}
									className={cx(
										'relative flex min-w-0 flex-col items-stretch rounded-pr-control border',
										matched ? 'border-pr-accent bg-pr-selected' : 'border-transparent hover:bg-pr-hover',
									)}
									onDragOver={(e) => {
										if (userTab && dragId.current) e.preventDefault();
									}}
									onDrop={(e) => onDrop(e, i)}
									onPointerEnter={() => props.onHover(p)}
									onContextMenu={(e) => {
										e.preventDefault();
										setMenu({ x: e.clientX, y: e.clientY, items: presetMenu(p) });
									}}
									data-testid={`ease-tile-${p.id}`}
									data-matched={matched ? 'true' : undefined}
								>
									{p.color ? (
										<span
											className="pointer-events-none absolute top-1 left-1 h-[3px] w-[14px] rounded-pr-control"
											style={{ background: labelColor(p.color) }}
											aria-hidden
										/>
									) : null}
									{fav ? (
										<span
											className="pointer-events-none absolute top-0 right-1 text-pr-small text-pr-accent"
											aria-hidden
										>
											★
										</span>
									) : null}
									{renaming ? (
										<div className="flex flex-col items-center gap-1 p-1">
											<CurveThumb curve={p.curve} size={thumb} />
											<InlineName
												initial={p.name}
												label="Curve name"
												onDone={(name) => {
													setEditing(null);
													if (name !== null) run((s) => renamePreset(s, p.id, name));
												}}
											/>
										</div>
									) : (
										<button
											type="button"
											className="flex min-w-0 flex-col items-center gap-1 rounded-pr-control p-1 outline-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-pr-focus"
											title={p.name}
											aria-label={
												fav ? t('{0} (favourite)', user ? p.name : t(p.name)) : user ? p.name : t(p.name)
											}
											aria-pressed={matched}
											draggable={userTab && user}
											onDragStart={(e) => {
												dragId.current = p.id;
												e.dataTransfer.setData(DRAG_MIME, p.id);
												e.dataTransfer.effectAllowed = 'move';
											}}
											onFocus={() => props.onHover(p)}
											onBlur={() => props.onHover(null)}
											onClick={(e) => props.onPick(p, e)}
											onKeyDown={(e) => onTileKey(e, p, i)}
											data-testid={`ease-pick-${p.id}`}
										>
											<CurveThumb curve={p.curve} size={thumb} />
											<span className="line-clamp-2 w-full break-words text-center text-pr-small text-pr-text leading-tight">
												{user ? p.name : t(p.name)}
											</span>
										</button>
									)}
								</div>
							);
						})}
					</div>
				)}
			</div>
			{menu ? (
				<ContextMenu
					x={menu.x}
					y={menu.y}
					items={menu.items}
					onClose={() => setMenu(null)}
					testId="ease-library-menu"
				/>
			) : null}
		</div>
	);
}
