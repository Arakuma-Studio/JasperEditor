// Spec 19 TL-089: Properties ▸ Appearance: the stack as rows, top of the stack first. A row is an eye, a swatch, one line
// and the primary value; clicking opens it in place, one at a time, so one selection stays one screen. Dragging reorders,
// and Move Up / Move Down do the same without a pointer.
import {
	type Command,
	GENERATOR_LAYER_PREFIX,
	type Paint,
	TITLE_GENERATORS,
	TITLE_LAYER_TYPES,
	titleLayerType,
	withDefaults,
} from '@jasper/project';
import { cx, DropdownMenu, Icon, type ResolvedMenuItem } from '@jasper/ui';
import { type DragEvent, Fragment, useState } from 'react';
import { MiniButton, SelectField } from '../panels/properties/controls/fields.tsx';
import { CaretGlyph, GripGlyph, ResetGlyph, TrashGlyph } from '../panels/properties/controls/glyphs.tsx';
import { PropertyRow, type RowContext } from '../panels/properties/controls/PropertyRow.tsx';
import { ScrubbyNumber } from '../panels/properties/controls/ScrubbyNumber.tsx';
import { PLAYHEAD_PLANNER, type Row, rowValue } from '../panels/properties/lib/model.ts';
import { LIGHT_TARGET, lookFocus, useLookFocus } from './focus.ts';
import { GeneratorPresetChips, generatorOf } from './GeneratorPresets.tsx';
import { flatPalette, paintCss } from './paint.ts';
import { layerRows, lightRows, paletteRows } from './rows.ts';
import { type LookedClip, layerName, type SharedLayer, sharedStack } from './selection.ts';

const REORDER_MIME = 'application/x-jasper-look-layer';
const rowCls = 'group flex h-[var(--pr-row-h)] items-center gap-1 pr-1 pl-2 text-pr-ui';

/** Where a new layer goes so it never covers the title by surprise (TL-064): what reaches outside the shape goes under it. */
export function newLayerIndex(type: string, a: LookedClip['appearance']): number {
	const top = a.layers.length;
	const def = titleLayerType(type);
	if (!def) return top;
	const generator = type.startsWith(GENERATOR_LAYER_PREFIX)
		? TITLE_GENERATORS.find((g) => g.id === type.slice(GENERATOR_LAYER_PREFIX.length))
		: undefined;
	const onTop = generator ? generator.front === true : !def.reach;
	if (onTop) return top;
	const face = a.layers.findIndex((l) => l.type === 'face');
	return face < 0 ? top : face;
}

function summaryOf(s: SharedLayer) {
	const def = titleLayerType(s.type);
	if (!def) return null;
	const a = s.looked[0]!.appearance;
	const stored = Object.fromEntries(Object.entries(s.layers[0]!.params).map(([k, v]) => [k, v.value]));
	const palette = flatPalette(a);
	return { summary: def.summary(withDefaults(def, stored as never), { palette }), palette };
}

/** The row's primary value: scrubs like any number, without opening the row. */
function PrimaryValue(props: { row: Row; ctx: RowContext }) {
	const { row, ctx } = props;
	const { mixed, value } = rowValue(row);
	const plan = (compute: (b: unknown) => unknown) =>
		PLAYHEAD_PLANNER.set(row, ctx.transport.getState().frame, compute);
	return (
		<ScrubbyNumber
			value={mixed || typeof value !== 'number' ? null : value}
			label={row.label}
			step={row.spec.range?.step ?? 1}
			precision={1}
			unit={row.spec.unit === '%' ? '%' : undefined}
			min={row.spec.range?.min}
			max={row.spec.range?.max}
			mixedText="—"
			onScrubStart={() => ctx.ops.scrub.start(row.label)}
			onScrub={(d) => ctx.ops.scrub.update(plan((b) => Number(b) + d).commands)}
			onScrubEnd={(c) => ctx.ops.scrub.end(c)}
			onCommit={(fn) => ctx.ops.apply(row.label, plan((b) => fn(Number(b))).commands)}
			data-testid={`look-primary-${row.id}`}
		/>
	);
}

export function AppearanceList(props: {
	looked: readonly LookedClip[];
	ctx: RowContext;
	readOnly?: boolean;
}) {
	const { looked, ctx, readOnly } = props;
	const [open, setOpen] = useState<string | null>(null);
	const [dropAt, setDropAt] = useState<number | null>(null);
	const focus = useLookFocus();
	const stack = sharedStack(looked);
	const first = looked[0];
	if (!first) return null;
	if (!stack)
		return (
			<p className="px-2 py-1 text-pr-small text-pr-muted" data-testid="look-stacks-differ">
				These clips have different stacks. Select one clip to edit its layers.
			</p>
		);
	const { doc, seq, frame } = ctx;
	const apply = (label: string, command: (l: LookedClip, i: number) => Command) =>
		ctx.ops.apply(label, looked.map(command));
	const layerOf = (s: SharedLayer, i: number) => s.layers[i]!;

	const select = (target: string) => lookFocus.set({ clipId: first.clip.id, fxId: first.fx.id, target });
	const toggle = (key: string, target: string) => {
		setOpen(open === key ? null : key);
		select(target);
	};
	const setEnabled = (s: SharedLayer, enabled: boolean) =>
		apply(
			enabled ? 'Show Layer' : 'Hide Layer',
			(l, i) =>
				({
					type: 'appearance.setLayerEnabled',
					effectInstanceId: l.fx.id,
					layerId: layerOf(s, i).id,
					enabled,
				}) as Command,
		);
	/** `listIndex`: the place in the list, top first; the stack is bottom-first. */
	const move = (s: SharedLayer, listIndex: number) => {
		const index = Math.max(0, Math.min(stack.length - 1, stack.length - 1 - listIndex));
		apply(
			'Reorder Layers',
			(l, i) =>
				({
					type: 'appearance.reorderLayer',
					effectInstanceId: l.fx.id,
					layerId: layerOf(s, i).id,
					index,
				}) as Command,
		);
	};
	const remove = (s: SharedLayer) =>
		apply(
			'Remove Layer',
			(l, i) =>
				({
					type: 'appearance.removeLayer',
					effectInstanceId: l.fx.id,
					layerId: layerOf(s, i).id,
				}) as Command,
		);
	const add = (type: string) =>
		apply(
			'Add Layer',
			(l) =>
				({
					type: 'appearance.addLayer',
					effectInstanceId: l.fx.id,
					layerType: type,
					index: newLayerIndex(type, l.appearance),
				}) as Command,
		);
	const resetLayer = (s: SharedLayer) => {
		const lids = looked.map((_, i) => layerOf(s, i).id);
		ctx.ops.apply(
			'Reset Look Layer',
			looked.map((l, i) => ({ type: 'look.reset', clipIds: [l.clip.id], layerIds: [lids[i]!] }) as Command),
		);
	};

	const inLook = (s: SharedLayer) =>
		looked.every((l, i) => {
			const id = l.appearance.lookId ? layerOf(s, i).id : null;
			const added = (l.appearance.lookOverrides?.$added ?? []) as string[];
			return id !== null && !added.includes(id);
		});

	const onDrop = (e: DragEvent, listIndex: number) => {
		const key = e.dataTransfer.getData(REORDER_MIME);
		setDropAt(null);
		const s = stack.find((x) => x.key === key);
		if (!s) return;
		e.preventDefault();
		const from = stack.indexOf(s);
		move(s, listIndex > from ? listIndex - 1 : listIndex);
	};

	const addItems: ResolvedMenuItem[] = TITLE_LAYER_TYPES.map((d) => ({
		type: 'item',
		id: d.type,
		label: d.label,
		disabled: readOnly,
		onSelect: () => add(d.type),
	}));

	const groupRow = (key: string, label: string, target: string, rows: Row[], note?: string) => (
		<Fragment key={key}>
			<button
				type="button"
				className={cx(
					rowCls,
					'w-full text-left hover:bg-pr-hover',
					focus?.target === target && focus.clipId === first.clip.id ? 'bg-pr-selected' : '',
				)}
				aria-expanded={open === key}
				onClick={() => toggle(key, target)}
				data-testid={`look-group-${key}`}
			>
				<span className="w-[18px]" />
				<span className="min-w-0 flex-1 truncate text-pr-text">{label}</span>
				{note ? <span className="truncate text-pr-small text-pr-muted">{note}</span> : null}
				<CaretGlyph open={open === key} size={10} />
			</button>
			{open === key ? rows.map((r) => <PropertyRow key={r.id} row={r} ctx={ctx} indent />) : null}
		</Fragment>
	);

	const source = looked.map((l) => l.appearance.light.source);
	const sameSource = source.every((x) => x === source[0]);
	return (
		<div data-testid="look-appearance">
			{/* biome-ignore lint/a11y/useSemanticElements: rows carry buttons of their own, a list box cannot */}
			<div role="list" aria-label="Layers, top of the stack first">
				{stack.map((s, listIndex) => {
					const info = summaryOf(s);
					const on = s.layers[0]!.enabled;
					const name = layerName(s.layers[0]!);
					const key = s.key;
					const isOpen = open === key;
					const selected = focus?.target === s.layers[0]!.id && focus.clipId === first.clip.id;
					const rows = isOpen ? layerRows(doc, seq, s, frame) : [];
					const generator = isOpen ? generatorOf(s.type) : undefined;
					const primary = info?.summary.primary
						? layerRows(doc, seq, s, frame).find((r) => r.id.endsWith(`.${info.summary.primary}`))
						: undefined;
					return (
						// biome-ignore lint/a11y/useSemanticElements: see the list above
						<div
							key={key}
							role="listitem"
							data-testid={`look-layer-${listIndex}`}
							data-layer-type={s.type}
							onDragOver={(e) => {
								if (!Array.from(e.dataTransfer.types).includes(REORDER_MIME)) return;
								e.preventDefault();
								e.dataTransfer.dropEffect = 'move';
								setDropAt(listIndex);
							}}
							onDragLeave={() => setDropAt(null)}
							onDrop={(e) => onDrop(e, listIndex)}
							className={cx(dropAt === listIndex && 'border-t-2 border-pr-accent')}
						>
							{/* biome-ignore lint/a11y/noStaticElementInteractions: the row's name is the button; the row is a drag handle */}
							<div
								className={cx(rowCls, selected ? 'bg-pr-selected' : 'hover:bg-pr-hover')}
								draggable={!readOnly}
								onDragStart={(e) => {
									e.dataTransfer.setData(REORDER_MIME, key);
									e.dataTransfer.effectAllowed = 'move';
								}}
							>
								<span className="w-[12px] shrink-0 cursor-grab text-pr-dim" title="Drag to reorder">
									<GripGlyph size={11} />
								</span>
								<MiniButton
									label={on ? `Hide ${name}` : `Show ${name}`}
									active={on}
									disabled={readOnly}
									onClick={() => setEnabled(s, !on)}
									data-testid={`look-layer-eye-${listIndex}`}
								>
									<Icon id={on ? 'track.output' : 'track.outputOff'} size={12} />
								</MiniButton>
								<span
									className="h-[14px] w-[18px] shrink-0 rounded-[2px] border border-pr-border-strong"
									style={{
										background: paintCss(
											info?.summary.swatch as Paint,
											info?.palette ?? flatPalette(undefined),
										),
									}}
								/>
								<button
									type="button"
									className="flex min-w-0 flex-1 items-baseline gap-1 text-left"
									aria-expanded={isOpen}
									onClick={() => toggle(key, s.layers[0]!.id)}
									data-testid={`look-layer-open-${listIndex}`}
								>
									<span className={cx('shrink-0 truncate', on ? 'text-pr-text' : 'text-pr-dim')}>{name}</span>
									<span className="min-w-0 truncate text-pr-small text-pr-muted">{info?.summary.text}</span>
								</button>
								{primary ? <PrimaryValue row={primary} ctx={ctx} /> : null}
								<CaretGlyph open={isOpen} size={10} />
							</div>
							{isOpen ? (
								<>
									{generator ? (
										<div className="pr-1 pl-5">
											<GeneratorPresetChips
												generator={generator}
												rows={rows}
												frame={frame}
												readOnly={readOnly}
												apply={(label, commands) => ctx.ops.apply(label, commands)}
												data-testid={`look-generator-presets-${listIndex}`}
											/>
										</div>
									) : null}
									{rows.map((r) => (
										<PropertyRow key={r.id} row={r} ctx={ctx} indent />
									))}
									<div className="flex h-[var(--pr-row-h)] items-center gap-1 pr-1 pl-5">
										<MiniButton
											label="Move Up"
											disabled={readOnly || listIndex === 0}
											onClick={() => move(s, listIndex - 1)}
											data-testid="look-layer-up"
										>
											<Icon id="app.up" size={12} />
										</MiniButton>
										<MiniButton
											label="Move Down"
											disabled={readOnly || listIndex === stack.length - 1}
											onClick={() => move(s, listIndex + 1)}
											data-testid="look-layer-down"
										>
											<Icon id="app.up" size={12} className="rotate-180" />
										</MiniButton>
										<span className="ml-auto" />
										{inLook(s) ? (
											<MiniButton
												label={`Reset ${name} to the look`}
												disabled={readOnly}
												onClick={() => resetLayer(s)}
												data-testid="look-layer-reset"
											>
												<ResetGlyph size={12} />
											</MiniButton>
										) : null}
										<MiniButton
											label={`Remove ${name}`}
											disabled={readOnly}
											onClick={() => remove(s)}
											data-testid="look-layer-remove"
										>
											<TrashGlyph size={12} />
										</MiniButton>
									</div>
								</>
							) : null}
						</div>
					);
				})}
			</div>
			{groupRow(
				'palette',
				'Colours',
				'palette',
				open === 'palette' ? paletteRows(doc, seq, looked, frame) : [],
			)}
			{groupRow(
				'light',
				'Light',
				LIGHT_TARGET,
				open === 'light' ? lightRows(doc, seq, looked, frame) : [],
				sameSource ? (source[0] === 'sequence' ? 'Follows the sequence' : 'Own light') : '—',
			)}
			{open === 'light' ? (
				<div className="flex h-[var(--pr-row-h)] items-center gap-2 pr-1 pl-5">
					<span className="w-[34%] shrink-0 text-pr-ui text-pr-muted">Source</span>
					<SelectField<'look' | 'sequence'>
						value={sameSource ? source[0]! : null}
						options={['look', 'sequence']}
						labels={['This Look', 'Sequence Light']}
						mixedLabel="—"
						label="Light source"
						disabled={readOnly}
						onChange={(v) =>
							apply(
								'Light Source',
								(l) =>
									({
										type: 'appearance.setLightSource',
										effectInstanceId: l.fx.id,
										source: v,
									}) as Command,
							)
						}
						data-testid="look-light-source"
					/>
				</div>
			) : null}
			<div className="flex h-[var(--pr-row-h)] items-center pl-2">
				<DropdownMenu
					align="start"
					trigger={
						<button
							type="button"
							className="text-pr-small text-pr-accent hover:underline disabled:text-pr-dim disabled:no-underline"
							disabled={readOnly}
							data-testid="look-add-layer"
						>
							Add Layer
						</button>
					}
					items={addItems}
				/>
			</div>
		</div>
	);
}
