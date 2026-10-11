// Properties ▸ Shape Contents (wp shapes): the Essential Graphics-style layer list of a vector shape, After Effects'
// shape-layer model. The tree lists groups, paths, paints and operators in stacking order (top = drawn last for
// paints; operators act on everything above them in their group). Rows: twirl (groups), eye (enable / disable),
// name (double-click renames), type. Drag a row onto another to move it before that row (onto the lower half of a
// group: into it). The toolbar adds items (Add ▸ menu with After Effects' placement: paths go above the group's
// paints, everything else at the end) and presets, groups the selected item, duplicates, deletes and moves it.
// The selected item's properties follow (keyframable rows, enums, the gradient editor; strokes add or remove
// Dashes, Taper and Wave). Every action is one undo step.
import {
	type Clip,
	type CommandInput,
	findItem,
	OPERATOR_ITEM_TYPES,
	PAINT_ITEM_TYPES,
	PATH_ITEM_TYPES,
	SHAPE_ITEM_LABELS,
	SHAPE_PRESETS,
	type ShapeItem,
	type ShapeItemType,
	shapeItemSpecs,
	walkItems,
} from '@jasper/project';
import { useSessionState } from '@jasper/session/react';
import { Icon } from '@jasper/ui';
import { type DragEvent, useState } from 'react';
import type { ClipSectionProps } from '../extensions/index.ts';
import { MiniButton, SelectField, TextField } from '../panels/properties/controls/fields.tsx';
import { useNotices } from '../panels/properties/controls/Notices.tsx';
import { PropertyRow, type RowContext } from '../panels/properties/controls/PropertyRow.tsx';
import { bindProperty, makeRow, type Row } from '../panels/properties/lib/model.ts';
import { useInspectorOps } from '../panels/properties/lib/ops.ts';
import { isVectorClip, useVectorUi, vectorUi } from './vector.ts';

type WithoutClipId<T> = T extends { clipId: string } ? Omit<T, 'clipId'> : never;
type ShapeEdit = WithoutClipId<Extract<CommandInput, { type: `shape.${string}` }>>;

const ROW = 'flex min-h-[var(--pr-row-h)] items-center gap-1 pr-1 pl-2';
const ADD_TYPES: readonly ShapeItemType[] = [
	'group',
	...PATH_ITEM_TYPES,
	...PAINT_ITEM_TYPES,
	...OPERATOR_ITEM_TYPES,
];
const ADD_GROUPS = ADD_TYPES.map((t) =>
	t === 'group'
		? 'Group'
		: (PATH_ITEM_TYPES as readonly string[]).includes(t)
			? 'Paths'
			: (PAINT_ITEM_TYPES as readonly string[]).includes(t)
				? 'Paint'
				: 'Path Operations',
);
const ADD_OPTIONS = [...ADD_TYPES, ...SHAPE_PRESETS.map((p) => `preset:${p.id}`)];
const ADD_LABELS = [...ADD_TYPES.map((t) => SHAPE_ITEM_LABELS[t]), ...SHAPE_PRESETS.map((p) => p.label)];
const ADD_OPTION_GROUPS = [
	...ADD_GROUPS,
	...SHAPE_PRESETS.map((p) => `Presets · ${p.category[0]!.toUpperCase()}${p.category.slice(1)}`),
];

export const isVectorShapeSelection = (clips: readonly Clip[]) =>
	clips.length === 1 && isVectorClip(clips[0]);

const PATH_LIKE = new Set<string>([...PATH_ITEM_TYPES, 'group']);

/** Where a new item goes: into the selected group, else next to the selected item; paths above the paints. */
export function insertionPoint(
	contents: readonly ShapeItem[],
	selectedId: string | null,
	type: ShapeItemType,
): { parentId: string | null; index: number } {
	let parentId: string | null = null;
	let list: readonly ShapeItem[] = contents;
	let after: number | null = null;
	if (selectedId) {
		const f = findItem(contents as ShapeItem[], selectedId);
		if (f?.item.type === 'group') {
			parentId = f.item.id;
			list = f.item.contents;
		} else if (f) {
			parentId = f.ancestors[f.ancestors.length - 1] ?? null;
			list = f.list;
			after = f.index + 1;
		}
	}
	if (PATH_LIKE.has(type)) {
		const firstPaint = list.findIndex((it) => !PATH_LIKE.has(it.type));
		const idx = firstPaint < 0 ? list.length : firstPaint;
		return { parentId, index: after !== null ? Math.min(after, idx) : idx };
	}
	return { parentId, index: after ?? list.length };
}

export function VectorShapeSection({ session, clips, frame, sequenceId }: ClipSectionProps) {
	const doc = useSessionState((s) => s.transient ?? s.document);
	const ops = useInspectorOps(session);
	const notices = useNotices();
	const selected = useVectorUi((s) => s.selected);
	const collapsed = useVectorUi((s) => s.collapsed);
	const [renaming, setRenaming] = useState<string | null>(null);
	const [dragId, setDragId] = useState<string | null>(null);
	const seq = doc.sequences[sequenceId];
	const clip = seq?.clips[clips[0]?.id ?? ''];
	if (!seq || !isVectorClip(clip)) return null;
	const contents = clip.shape.contents;
	const selId = selected?.clipId === clip.id && findItem(contents, selected.itemId) ? selected.itemId : null;
	const sel = selId ? findItem(contents, selId) : null;
	const ctx: RowContext = {
		doc,
		seq,
		frame,
		ops,
		transport: session.transport,
		mode: 'properties',
		hint: notices.hint,
		confirmStopwatchOff: notices.confirmStopwatchOff,
	};
	const run = (label: string, commands: ShapeEdit[]) =>
		ops.apply(
			label,
			commands.map((c) => ({ clipId: clip.id, ...c })),
		);
	const select = (itemId: string | null) => vectorUi.select(itemId ? { clipId: clip.id, itemId } : null);

	const add = (option: string) => {
		if (option.startsWith('preset:')) {
			const preset = SHAPE_PRESETS.find((p) => `preset:${p.id}` === option);
			if (!preset) return;
			const at = insertionPoint(contents, selId, 'group');
			const r = session.apply({
				label: `Add ${preset.label}`,
				origin: 'user',
				sequenceId,
				commands: [
					{
						type: 'shape.addItems',
						clipId: clip.id,
						items: [{ type: 'group', name: preset.label, contents: preset.items() }],
						...(at.parentId ? { parentId: at.parentId } : {}),
						index: at.index,
					} satisfies CommandInput,
				],
			});
			const id = r.ok ? (r.results[0] as { itemIds: string[] }).itemIds[0] : undefined;
			if (id) select(id);
			return;
		}
		const type = option as ShapeItemType;
		const at = insertionPoint(contents, selId, type);
		const r = session.apply({
			label: `Add ${SHAPE_ITEM_LABELS[type]}`,
			origin: 'user',
			sequenceId,
			commands: [
				{
					type: 'shape.addItems',
					clipId: clip.id,
					items: [type === 'path' ? { type, path: 'M-100 0 L100 0' } : { type }],
					...(at.parentId ? { parentId: at.parentId } : {}),
					index: at.index,
				} satisfies CommandInput,
			],
		});
		const id = r.ok ? (r.results[0] as { itemIds: string[] }).itemIds[0] : undefined;
		if (id) select(id);
	};

	const move = (delta: -1 | 1) => {
		if (!sel) return;
		const index = sel.index + delta;
		if (index < 0 || index >= sel.list.length) return;
		run('Move Shape Item', [
			{
				type: 'shape.moveItem',
				itemId: sel.item.id,
				parentId: sel.ancestors[sel.ancestors.length - 1] ?? null,
				index,
			},
		]);
	};

	const onDrop = (e: DragEvent, target: ShapeItem) => {
		e.preventDefault();
		const id = dragId ?? e.dataTransfer.getData('application/x-jasper-shape-item');
		setDragId(null);
		if (!id || id === target.id) return;
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const lower = e.clientY > r.top + r.height / 2;
		const t = findItem(contents, target.id);
		const moving = findItem(contents, id);
		if (!t || !moving) return;
		if (lower && target.type === 'group') {
			run('Move Shape Item', [
				{ type: 'shape.moveItem', itemId: id, parentId: target.id, index: target.contents.length },
			]);
			return;
		}
		const parentId = t.ancestors[t.ancestors.length - 1] ?? null;
		let index = t.index + (lower ? 1 : 0);
		// Moving down within the same list: the item's own slot disappears first.
		if (moving.list === t.list && moving.index < index) index--;
		run('Move Shape Item', [{ type: 'shape.moveItem', itemId: id, parentId, index }]);
	};

	const rows: { item: ShapeItem; depth: number }[] = [];
	const visit = (items: readonly ShapeItem[], depth: number) => {
		for (const it of items) {
			rows.push({ item: it, depth });
			if (it.type === 'group' && !collapsed[`${clip.id}:${it.id}`]) visit(it.contents, depth + 1);
		}
	};
	visit(contents, 0);

	return (
		<div data-testid="vector-shape-section">
			{notices.element}
			<div className={`${ROW} flex-wrap`}>
				<SelectField
					value={null}
					options={ADD_OPTIONS}
					labels={ADD_LABELS}
					groups={ADD_OPTION_GROUPS}
					label="Add"
					onChange={add}
					className="w-[110px]"
					data-testid="vector-add"
				/>
				<MiniButton
					label="Group"
					disabled={!sel}
					onClick={() => {
						if (!sel) return;
						const r = session.apply({
							label: 'Group Shapes',
							origin: 'user',
							sequenceId,
							commands: [
								{ type: 'shape.groupItems', clipId: clip.id, itemIds: [sel.item.id] } satisfies CommandInput,
							],
						});
						// After Effects selects the new group.
						if (r.ok) select((r.results[0] as { groupId: string }).groupId);
					}}
					data-testid="vector-group"
				>
					<Icon id="project.newBin" size={12} />
				</MiniButton>
				<MiniButton
					label="Duplicate"
					disabled={!sel}
					onClick={() =>
						sel && run('Duplicate Shape Item', [{ type: 'shape.duplicateItem', itemId: sel.item.id }])
					}
					data-testid="vector-duplicate"
				>
					<Icon id="app.copy" size={12} />
				</MiniButton>
				<MiniButton
					label="Move up"
					disabled={!sel || sel.index === 0}
					onClick={() => move(-1)}
					data-testid="vector-up"
				>
					<Icon id="app.chevronDown" size={12} className="rotate-180" />
				</MiniButton>
				<MiniButton
					label="Move down"
					disabled={!sel || sel.index >= sel.list.length - 1}
					onClick={() => move(1)}
					data-testid="vector-down"
				>
					<Icon id="app.chevronDown" size={12} />
				</MiniButton>
				<MiniButton
					label="Delete"
					disabled={!sel}
					onClick={() => {
						if (!sel) return;
						run('Delete Shape Items', [{ type: 'shape.removeItems', itemIds: [sel.item.id] }]);
						select(null);
					}}
					data-testid="vector-delete"
				>
					<Icon id="app.close" size={12} />
				</MiniButton>
			</div>
			<div
				role="tree"
				aria-label="Shape contents"
				className="mx-2 mb-1 rounded-pr-control border border-pr-border"
				data-testid="vector-tree"
			>
				{rows.length === 0 ? (
					<div className="px-2 py-1 text-pr-small text-pr-muted">
						Empty: use Add to create paths, paints and operators.
					</div>
				) : null}
				{rows.map(({ item, depth }) => {
					const on = item.enabled !== false;
					const isSel = item.id === selId;
					const key = `${clip.id}:${item.id}`;
					return (
						<div
							key={item.id}
							role="treeitem"
							aria-selected={isSel}
							aria-expanded={item.type === 'group' ? !collapsed[key] : undefined}
							tabIndex={0}
							draggable
							onDragStart={(e) => {
								setDragId(item.id);
								e.dataTransfer.setData('application/x-jasper-shape-item', item.id);
								e.dataTransfer.effectAllowed = 'move';
							}}
							onDragOver={(e) => e.preventDefault()}
							onDrop={(e) => onDrop(e, item)}
							onClick={() => select(item.id)}
							onKeyDown={(e) => {
								if ((e.key === 'Delete' || e.key === 'Backspace') && renaming !== item.id) {
									e.preventDefault();
									e.stopPropagation();
									run('Delete Shape Items', [{ type: 'shape.removeItems', itemIds: [item.id] }]);
									select(null);
								}
							}}
							className={`flex h-[22px] cursor-default items-center gap-1 pr-1 text-pr-ui ${isSel ? 'bg-pr-selected text-pr-strong' : 'text-pr-text hover:bg-pr-hover'}`}
							style={{ paddingLeft: 4 + depth * 14 }}
							data-testid={`vector-item-${item.id}`}
							data-item-type={item.type}
						>
							{item.type === 'group' ? (
								<MiniButton
									label={collapsed[key] ? 'Expand' : 'Collapse'}
									data-testid={`vector-twirl-${item.id}`}
									onClick={(e) => {
										e.stopPropagation();
										vectorUi.set({ collapsed: { ...collapsed, [key]: !collapsed[key] } });
									}}
								>
									<Icon id={collapsed[key] ? 'app.chevronRight' : 'app.chevronDown'} size={10} />
								</MiniButton>
							) : (
								<span className="inline-block w-[18px]" />
							)}
							<MiniButton
								label={on ? 'Disable' : 'Enable'}
								active={on}
								onClick={(e) => {
									e.stopPropagation();
									run(on ? 'Disable Shape Item' : 'Enable Shape Item', [
										{ type: 'shape.updateItem', itemId: item.id, patch: { enabled: !on } },
									]);
								}}
								data-testid={`vector-eye-${item.id}`}
							>
								<Icon id={on ? 'track.output' : 'track.outputOff'} size={12} />
							</MiniButton>
							{renaming === item.id ? (
								<TextField
									value={item.name}
									label="Name"
									onCommit={(name) => {
										setRenaming(null);
										if (name.trim())
											run('Rename Shape Item', [
												{ type: 'shape.updateItem', itemId: item.id, patch: { name: name.trim() } },
											]);
									}}
								/>
							) : (
								// biome-ignore lint/a11y/noStaticElementInteractions: double-click renames (the row itself is the treeitem)
								<span
									className={`min-w-0 flex-1 truncate ${on ? '' : 'text-pr-muted line-through'}`}
									onDoubleClick={() => setRenaming(item.id)}
								>
									{item.name}
								</span>
							)}
							<span className="shrink-0 text-pr-small text-pr-muted">{SHAPE_ITEM_LABELS[item.type]}</span>
						</div>
					);
				})}
			</div>
			{sel ? <ItemProperties clip={clip} item={sel.item} ctx={ctx} run={run} /> : null}
		</div>
	);
}

function ItemProperties({
	clip,
	item,
	ctx,
	run,
}: {
	clip: Clip;
	item: ShapeItem;
	ctx: RowContext;
	run(label: string, commands: ShapeEdit[]): void;
}) {
	const rows = shapeItemSpecs(clip, item.id)
		.map((s) => makeRow(s.key, [bindProperty(ctx.doc, ctx.seq, clip, s.key, ctx.frame)]))
		.filter((r): r is Row => r !== null);
	const stroke = item.type === 'stroke' || item.type === 'gradientStroke' ? item : null;
	const toggle = (label: string, patch: Extract<CommandInput, { type: 'shape.updateItem' }>['patch']) =>
		run(label, [{ type: 'shape.updateItem', itemId: item.id, patch }]);
	return (
		<div data-testid="vector-item-properties">
			<div className={`${ROW} text-pr-small text-pr-muted`}>{item.name}</div>
			{rows.map((r) => (
				<PropertyRow key={r.id} row={r} ctx={ctx} />
			))}
			{item.type === 'rect' || item.type === 'ellipse' || item.type === 'polystar' ? (
				<div className={ROW}>
					<OptionButton
						label="Convert to Bezier Path"
						onClick={() =>
							run('Convert to Bezier Path', [
								{
									type: 'shape.convertToPath',
									itemId: item.id,
									at: { sequenceFrame: ctx.transport.getState().frame },
								},
							])
						}
						testId="vector-convert-path"
					/>
				</div>
			) : null}
			{stroke ? (
				<div className={`${ROW} flex-wrap gap-2`}>
					<OptionButton
						label={stroke.dashes ? 'Remove Dashes' : 'Add Dashes'}
						onClick={() =>
							toggle(stroke.dashes ? 'Remove Dashes' : 'Add Dashes', {
								dashes: stroke.dashes ? null : [10, 10],
							})
						}
						testId="vector-dashes"
					/>
					{stroke.dashes && stroke.dashes.segments.length < 3 ? (
						<OptionButton
							label="Add Dash/Gap"
							onClick={() =>
								toggle('Add Dash', {
									dashes: [...stroke.dashes!.segments.flatMap((s) => [s.dash.value, s.gap.value]), 10, 10],
								})
							}
							testId="vector-dash-add"
						/>
					) : null}
					<OptionButton
						label={stroke.taper ? 'Remove Taper' : 'Add Taper'}
						onClick={() =>
							toggle(stroke.taper ? 'Remove Taper' : 'Add Taper', {
								taper: stroke.taper ? null : { startLength: 25, endLength: 25 },
							})
						}
						testId="vector-taper"
					/>
					<OptionButton
						label={stroke.wave ? 'Remove Wave' : 'Add Wave'}
						onClick={() =>
							toggle(stroke.wave ? 'Remove Wave' : 'Add Wave', { wave: stroke.wave ? null : { amount: 50 } })
						}
						testId="vector-wave"
					/>
				</div>
			) : null}
		</div>
	);
}

function OptionButton({ label, onClick, testId }: { label: string; onClick(): void; testId: string }) {
	return (
		<button
			type="button"
			className="h-[20px] rounded-pr-control border border-pr-border-strong px-2 text-pr-small text-pr-text hover:bg-pr-hover"
			onClick={onClick}
			data-testid={testId}
		>
			{label}
		</button>
	);
}

/** Every item id of a clip's contents (tests). */
export function vectorItemIds(contents: readonly ShapeItem[]): string[] {
	const out: string[] = [];
	walkItems(contents, (it) => out.push(it.id));
	return out;
}
