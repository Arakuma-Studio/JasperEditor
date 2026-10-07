// Effects ▸ Presets (S05:EFX-001/002, S03:FX-030): the read-only built-in bins (Blurs, Fades, Slides, Zooms,
// Picture-in-Picture) and the user's bins and presets from the engine library. Search matches names, descriptions
// and the effects a preset uses; the RT / N badge filters keep a preset when every effect it uses passes (intrinsic
// properties never hide it). Drag a preset onto a clip, a Program Monitor layer or Effect Controls, or double-click
// (Enter) to apply it to the selected clips; drag a user preset onto a bin to move it. Context menus: New Preset Bin,
// Import / Export, Preset Properties (rename, type, description), Delete (Delete key too).
import {
	BUILTIN_EFFECT_PRESETS,
	type EffectPreset,
	type EffectPresetFolder,
	type EffectRegistry,
	type PresetSummary,
	presetMatches,
	presetSummary,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { cx } from '@jasper/ui';
import type { DragEvent, MouseEvent, ReactNode } from 'react';
import { CaretGlyph } from '../../properties/controls/glyphs.tsx';
import type { ContextMenuItem } from '../../timeline/state/ui-store.ts';
import { isEffectDrag, readEffectDragPayload, writePresetDragPayload } from '../drag.ts';
import {
	confirmDeleteBin,
	confirmDeletePreset,
	exportPresets,
	importPresets,
	newPresetBin,
	openPresetProperties,
	renameBin,
	renamePreset,
} from './actions.ts';
import { applyPresetToClips, clipsAcceptingPreset, isPresetRef, PRESET_REF_PREFIX } from './apply.ts';
import { type PresetLibraryState, updatePreset } from './store.ts';

type Filter = { query: string; realtime: boolean; native: boolean };

type Node =
	| {
			kind: 'folder';
			id: string;
			name: string;
			builtIn: boolean;
			folder?: EffectPresetFolder;
			children: Node[];
	  }
	| { kind: 'preset'; preset: EffectPreset; summary: PresetSummary };

const ROOT_ID = 'Presets';

/** The Presets tree: built-in category bins first, then user bins (nested) and user presets, sorted by name. */
export function presetTree(
	user: { folders: readonly EffectPresetFolder[]; presets: readonly EffectPreset[] },
	registry: EffectRegistry,
	filter: Filter,
): { nodes: Node[]; matches: number } {
	const filtering = !!filter.query.trim() || filter.realtime || filter.native;
	let matches = 0;
	const leaf = (p: EffectPreset): Node | null => {
		const summary = presetSummary(p, registry);
		if (!presetMatches(summary, filter.query)) return null;
		if (filter.realtime && !summary.realtime) return null;
		if (filter.native && !summary.native) return null;
		matches++;
		return { kind: 'preset', preset: p, summary };
	};
	const byName = (a: Node, b: Node) => nameOf(a).localeCompare(nameOf(b));
	const categories = new Map<string, Node[]>();
	for (const p of BUILTIN_EFFECT_PRESETS) {
		const n = leaf(p);
		if (n) categories.set(p.category ?? 'Other', [...(categories.get(p.category ?? 'Other') ?? []), n]);
	}
	const builtIn: Node[] = [...categories.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, children]) => ({ kind: 'folder', id: `builtin:${name}`, name, builtIn: true, children }));
	const known = new Set(user.folders.map((f) => f.id));
	const userFolder = (f: EffectPresetFolder): Node | null => {
		const children = [
			...user.folders.filter((x) => x.parentId === f.id).map(userFolder),
			...user.presets.filter((p) => p.folderId === f.id).map(leaf),
		]
			.filter((x): x is Node => x !== null)
			.sort(folderFirst);
		if (filtering && !children.length) return null;
		return { kind: 'folder', id: f.id, name: f.name, builtIn: false, folder: f, children };
	};
	const top = [
		...user.folders.filter((f) => !f.parentId || !known.has(f.parentId)).map(userFolder),
		...user.presets.filter((p) => !p.folderId || !known.has(p.folderId)).map(leaf),
	]
		.filter((x): x is Node => x !== null)
		.sort(folderFirst);
	return { nodes: [...builtIn, ...top], matches };

	function folderFirst(a: Node, b: Node) {
		return a.kind !== b.kind ? (a.kind === 'folder' ? -1 : 1) : byName(a, b);
	}
}

const nameOf = (n: Node) => (n.kind === 'folder' ? n.name : n.preset.name);

/** Preset glyph: an fx badge with a stack behind it (a saved set of effects). */
function PresetGlyph(props: { warning?: boolean }) {
	return (
		<span className={cx('inline-flex shrink-0', props.warning ? 'text-pr-warning' : 'text-pr-icon')}>
			<svg
				width={14}
				height={14}
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth={1.2}
				aria-hidden
			>
				<rect x="4.5" y="1.5" width="10" height="10" rx="1.5" />
				<path d="M2.5 4.5v8.5a1.5 1.5 0 0 0 1.5 1.5h8.5" />
				<path d="M7.5 9V4.5h3M7.5 6.8h2.3" />
			</svg>
		</span>
	);
}

type PresetsBinProps = {
	session: EditorSession;
	/** The library (`usePresetLibrary()` of the host panel). */
	lib: PresetLibraryState;
	tree: ReturnType<typeof presetTree>;
	filter: Filter;
	closed: Record<string, boolean>;
	onToggle(id: string): void;
	focused: string | null;
	onFocus(id: string): void;
	onStatus(text: string): void;
	onMenu(x: number, y: number, items: ContextMenuItem[]): void;
	selectedClips: readonly string[];
};

export function PresetsBin(props: PresetsBinProps) {
	const { session, filter, closed, selectedClips, lib, tree } = props;
	const searching = !!filter.query.trim() || filter.realtime || filter.native;
	if (searching && tree.matches === 0) return null;
	const engineReady = lib.status === 'ready';
	const status = (p: Promise<unknown>, ok?: string) =>
		p.then(
			(r) => {
				if (typeof r === 'string') props.onStatus(r);
				else if (ok) props.onStatus(ok);
			},
			(e: unknown) => props.onStatus(`Preset library: ${(e as Error).message}`),
		);

	const apply = (p: EffectPreset) => {
		const targets = clipsAcceptingPreset(session, p, selectedClips);
		if (!targets.length) {
			props.onStatus(
				selectedClips.length
					? `${p.name} cannot be applied to the selected clips.`
					: 'Select clips in the Timeline first.',
			);
			return;
		}
		const r = applyPresetToClips(session, p, targets);
		props.onStatus(
			r?.ok
				? `Applied ${p.name} to ${targets.length} clip${targets.length > 1 ? 's' : ''}.`
				: `Could not apply ${p.name}: ${r && !r.ok ? (r.errors[0]?.message ?? '') : ''}`,
		);
	};
	const offline: ContextMenuItem = {
		kind: 'item',
		label: 'Your presets need the engine',
		disabled: true,
		run: () => {},
	};
	const rootMenu = (): ContextMenuItem[] =>
		engineReady
			? [
					{
						kind: 'item',
						label: 'New Preset Bin…',
						run: () => void status(newPresetBin(null), 'Bin created.'),
					},
					{ kind: 'item', label: 'Import Presets…', run: () => void status(importPresets(null)) },
					{
						kind: 'item',
						label: 'Export My Presets…',
						disabled: lib.presets.length === 0,
						run: () => exportPresets(lib.presets, 'My Presets'),
					},
				]
			: [offline];
	const folderMenu = (f: EffectPresetFolder): ContextMenuItem[] => {
		const inside = (id: string): EffectPreset[] => [
			...lib.presets.filter((p) => p.folderId === id),
			...lib.folders.filter((x) => x.parentId === id).flatMap((x) => inside(x.id)),
		];
		return [
			{ kind: 'item', label: 'New Preset Bin…', run: () => void status(newPresetBin(f.id), 'Bin created.') },
			{ kind: 'item', label: 'Import Presets…', run: () => void status(importPresets(f.id)) },
			{
				kind: 'item',
				label: 'Export Bin…',
				disabled: inside(f.id).length === 0,
				run: () => exportPresets(inside(f.id), f.name),
			},
			{ kind: 'separator' },
			{ kind: 'item', label: 'Rename…', run: () => void status(renameBin(f)) },
			{ kind: 'item', label: 'Delete', run: () => void status(confirmDeleteBin(f)) },
		];
	};
	const presetMenu = (p: EffectPreset): ContextMenuItem[] => [
		{ kind: 'item', label: 'Apply to Selected Clips', disabled: !selectedClips.length, run: () => apply(p) },
		{ kind: 'separator' },
		...(p.builtIn
			? []
			: [
					{ kind: 'item' as const, label: 'Rename…', run: () => void status(renamePreset(p)) },
					{
						kind: 'item' as const,
						label: 'Preset Properties…',
						run: () => void status(openPresetProperties(p)),
					},
				]),
		{ kind: 'item', label: 'Export Preset…', run: () => exportPresets([p], p.name) },
		...(p.builtIn
			? []
			: [{ kind: 'item' as const, label: 'Delete', run: () => void status(confirmDeletePreset(p)) }]),
	];

	/** Dropping a user preset on a user bin (or the Presets root) moves it there. */
	const moveDrop = (folderId: string | null) => ({
		onDragOver: (e: DragEvent) => {
			if (!engineReady || !isEffectDrag(e.dataTransfer)) return;
			e.preventDefault();
			e.dataTransfer.dropEffect = 'move';
		},
		onDrop: (e: DragEvent) => {
			const ref = readEffectDragPayload(e.dataTransfer)?.effectId;
			if (!ref || !isPresetRef(ref)) return;
			const p = lib.presets.find((x) => x.id === ref.slice(PRESET_REF_PREFIX.length));
			if (!p) return;
			e.preventDefault();
			e.stopPropagation();
			if ((p.folderId ?? null) !== folderId)
				void status(updatePreset(p.id, { folderId }), `Moved ${p.name}.`);
		},
	});

	const rootOpen = !closed[ROOT_ID] || searching;
	const render = (n: Node, depth: number): ReactNode => {
		if (n.kind === 'folder') {
			const open = !closed[n.id] || searching;
			return (
				<div key={n.id} data-testid={`preset-bin-${n.builtIn ? n.name : n.id}`}>
					<FolderRow
						label={n.name}
						open={open}
						depth={depth}
						onToggle={() => props.onToggle(n.id)}
						title={n.builtIn ? 'Built-in presets (read-only)' : undefined}
						onContextMenu={
							n.folder ? (e) => props.onMenu(e.clientX, e.clientY, folderMenu(n.folder!)) : undefined
						}
						{...(n.folder ? moveDrop(n.folder.id) : {})}
					/>
					{open ? n.children.map((c) => render(c, depth + 1)) : null}
				</div>
			);
		}
		const p = n.preset;
		const s = n.summary;
		const id = `${PRESET_REF_PREFIX}${p.id}`;
		const holds = [...s.intrinsic, ...s.effects.map((e) => e.label)].join(', ');
		const warning = s.unknownEffects.length > 0;
		return (
			<div
				key={p.id}
				role="treeitem"
				tabIndex={0}
				aria-selected={props.focused === id}
				draggable
				title={[
					p.name,
					s.description,
					`${s.typeLabel} · ${holds}`,
					warning
						? `Uses effects this version does not know: ${s.unknownEffects.join(', ')} (skipped when applied)`
						: '',
					'Drag onto a clip or double-click to apply to the selection.',
				]
					.filter(Boolean)
					.join('\n')}
				className={cx(
					'flex h-[var(--pr-row-h)] cursor-grab items-center gap-1 pr-2 text-pr-ui',
					props.focused === id ? 'bg-pr-selected' : 'hover:bg-pr-hover',
				)}
				style={{ paddingLeft: 6 + depth * 16 }}
				onClick={() => props.onFocus(id)}
				onDoubleClick={() => apply(p)}
				onKeyDown={(ev) => {
					if (ev.key === 'Enter') apply(p);
					else if ((ev.key === 'Delete' || ev.key === 'Backspace') && !p.builtIn && engineReady) {
						ev.preventDefault();
						void status(confirmDeletePreset(p));
					}
				}}
				onContextMenu={(ev) => {
					ev.preventDefault();
					props.onFocus(id);
					props.onMenu(ev.clientX, ev.clientY, presetMenu(p));
				}}
				onDragStart={(ev) => writePresetDragPayload(ev.dataTransfer, p.id)}
				data-preset-id={p.id}
			>
				<PresetGlyph warning={warning} />
				<span className={cx('min-w-0 flex-1 truncate', warning && 'text-pr-warning')}>{p.name}</span>
				{s.realtime ? (
					<span className="text-[10px] text-pr-muted" title="Real-time preview">
						RT
					</span>
				) : null}
				{s.native ? (
					<span className="text-[10px] text-pr-engine-native" title="Renders on the native (ffmpeg) path">
						N
					</span>
				) : null}
			</div>
		);
	};

	return (
		<div data-testid="effects-bin-presets">
			<FolderRow
				label="Presets"
				open={rootOpen}
				depth={0}
				onToggle={() => props.onToggle(ROOT_ID)}
				onContextMenu={(e) => props.onMenu(e.clientX, e.clientY, rootMenu())}
				{...moveDrop(null)}
			/>
			{rootOpen ? tree.nodes.map((n) => render(n, 1)) : null}
			{rootOpen && lib.status === 'error' && !searching ? (
				<p className="py-[2px] pr-2 pl-[38px] text-pr-small text-pr-warning" title={lib.error ?? ''}>
					Your presets could not be loaded.
				</p>
			) : null}
		</div>
	);
}

function FolderRow(props: {
	label: string;
	open: boolean;
	depth: number;
	onToggle(): void;
	title?: string;
	onContextMenu?(e: MouseEvent): void;
	onDragOver?(e: DragEvent): void;
	onDrop?(e: DragEvent): void;
}) {
	return (
		<button
			type="button"
			aria-expanded={props.open}
			onClick={props.onToggle}
			title={props.title}
			onContextMenu={(e) => {
				if (!props.onContextMenu) return;
				e.preventDefault();
				props.onContextMenu(e);
			}}
			onDragOver={props.onDragOver}
			onDrop={props.onDrop}
			className="flex h-[var(--pr-row-h)] w-full items-center gap-1 pr-2 text-left text-pr-ui text-pr-text hover:bg-pr-hover"
			style={{ paddingLeft: 4 + props.depth * 16 }}
		>
			<span className="text-pr-icon">
				<CaretGlyph open={props.open} size={11} />
			</span>
			{props.label}
		</button>
	);
}
