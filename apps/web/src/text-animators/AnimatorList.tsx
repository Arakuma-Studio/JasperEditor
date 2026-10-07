// Effect Controls ▸ Text: AE-style text animators (workstream text-animators). Under Source Text: the tool row
// ("Animate ▸" menu with every animator property, animator presets and Enable Per-character 3D; Path: None / a mask;
// the Per-character 3D switch), the Source Text hold keys, Path Options, More Options, then one twirl per animator
// (name, enable, "Add ▸" menu: properties, Range / Wiggly / Expression selectors; duplicate; delete) with its
// selectors (each a twirl with an Advanced twirl) and its properties. Property rows are ordinary inspector rows
// drawn by the panel (stopwatches, keyframe lanes, graphs, expressions).
import {
	ANIMATOR_MENU,
	animatorMenuProperties,
	type Command,
	TEXT_ANIMATOR_PRESETS,
	type TextContent,
	type TextSelectorKind,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { cx, toast } from '@jasper/ui';
import { type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode, useState } from 'react';
import type { AnimatorBlock, SelectorBlock, TextAnimatorListModel } from '../panels/effectControls/items.ts';
import { CheckboxField, MiniButton, SelectField, TextField } from '../panels/properties/controls/fields.tsx';
import { CaretGlyph, TrashGlyph } from '../panels/properties/controls/glyphs.tsx';
import type { Row } from '../panels/properties/lib/model.ts';
import { ContextMenu } from '../panels/timeline/components/Chrome.tsx';
import type { ContextMenuItem } from '../panels/timeline/state/ui-store.ts';

type Layout = { left: CSSProperties; lane(children: ReactNode): ReactNode };

function apply(session: EditorSession, label: string, commands: Command[]) {
	const r = session.apply({ label, origin: 'user', commands });
	if (!r.ok) toast({ kind: 'error', title: label, detail: r.errors.map((e) => e.message).join('; ') });
	return r;
}

const SELECTOR_KINDS: { kind: TextSelectorKind; label: string }[] = [
	{ kind: 'range', label: 'Range' },
	{ kind: 'wiggly', label: 'Wiggly' },
	{ kind: 'expression', label: 'Expression' },
];

/** The "Animate ▸" property entries as menu items (AE order with separators). */
function propertyItems(run: (entry: string) => void, has?: (entry: string) => boolean): ContextMenuItem[] {
	return ANIMATOR_MENU.map((m) =>
		m.id === '-'
			? ({ kind: 'separator' } as const)
			: { kind: 'item' as const, label: m.label, disabled: has?.(m.id) ?? false, run: () => run(m.id) },
	);
}

/** Animator presets grouped by category. */
function presetItems(run: (id: string) => void): ContextMenuItem[] {
	const cats = [...new Set(TEXT_ANIMATOR_PRESETS.map((p) => p.category))];
	return cats.map((c) => ({
		kind: 'submenu' as const,
		label: c,
		items: TEXT_ANIMATOR_PRESETS.filter((p) => p.category === c).map((p) => ({
			kind: 'item' as const,
			label: p.name,
			run: () => run(p.id),
		})),
	}));
}

export function TextAnimatorList(props: {
	session: EditorSession;
	model: TextAnimatorListModel;
	readOnly: boolean;
	layout: Layout;
	collapsed: Record<string, boolean>;
	setCollapsed(next: Record<string, boolean>): void;
	renderRow(r: Row, editor?: ReactNode): ReactNode;
	filter(r: Row): boolean;
	/** Sequence frame of the playhead (Source Text keys are written there). */
	frame: number;
}) {
	const { session, model, layout } = props;
	const clipId = model.clipId;
	const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
	const open = (key: string) => !props.collapsed[key];
	const toggle = (key: string) => props.setCollapsed({ ...props.collapsed, [key]: open(key) });
	const showMenu = (e: ReactMouseEvent, items: ContextMenuItem[]) => {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		setMenu({ x: r.left, y: r.bottom, items });
	};
	const animateItems = (): ContextMenuItem[] => [
		...propertyItems((entry) =>
			apply(session, 'Add Text Animator', [
				{ type: 'textAnimator.add', clipId, properties: [entry] } as Command,
			]),
		),
		{ kind: 'separator' },
		{
			kind: 'item',
			label: 'Enable Per-character 3D',
			checked: model.perCharacter3d,
			run: () =>
				apply(session, 'Per-character 3D', [
					{ type: 'text.setPerCharacter3d', clipIds: [clipId], enabled: !model.perCharacter3d } as Command,
				]),
		},
		{
			kind: 'submenu',
			label: 'Animator Presets',
			items: presetItems((preset) =>
				apply(session, 'Apply Text Animator Preset', [
					{ type: 'textAnimator.applyPreset', clipIds: [clipId], preset } as Command,
				]),
			),
		},
		...(model.hasLegacyAnimation
			? [
					{
						kind: 'item' as const,
						label: 'Convert In/Out Animations to Animators',
						run: () =>
							apply(session, 'Convert Text Animation to Animators', [
								{ type: 'textAnimator.convertLegacy', clipIds: [clipId] } as Command,
							]),
					},
				]
			: []),
	];
	const sourceRow = model.sourceText;
	const sourceEditor = sourceRow ? (
		<TextField
			value={((sourceRow.bindings[0]!.resolved.value as TextContent | undefined)?.text ?? '') as string}
			label="Source Text"
			disabled={props.readOnly}
			data-testid={`text-source-${clipId}`}
			onCommit={(text) => {
				const b = sourceRow.bindings[0]!;
				const cur = b.resolved.value as TextContent;
				if (b.resolved.animated)
					apply(session, 'Change Source Text', [
						{
							type: 'param.set',
							target: ['clip', clipId, 'text', 'sourceText'],
							value: { ...cur, text },
							at: { sequenceFrame: props.frame },
						} as Command,
					]);
				else
					apply(session, 'Change Source Text', [
						{ type: 'clip.update', clipIds: [clipId], patch: { content: { text } } } as Command,
					]);
			}}
		/>
	) : null;
	return (
		<div data-testid={`text-animators-${clipId}`}>
			<div className="flex items-stretch">
				<div
					style={layout.left}
					className="flex h-[var(--pr-row-h)] min-w-0 shrink-0 items-center gap-2 pl-4 pr-1"
				>
					<button
						type="button"
						className="rounded-pr-control px-1 text-pr-ui text-pr-text hover:bg-pr-hover disabled:text-pr-dim"
						disabled={props.readOnly}
						data-testid={`text-animate-menu-${clipId}`}
						onClick={(e) => showMenu(e, animateItems())}
					>
						Animate ▸
					</button>
					<span className="text-pr-small text-pr-dim">Path</span>
					<SelectField<string>
						value={model.path.maskId ?? ''}
						options={['', ...model.path.masks.map((m) => m.id)]}
						labels={['None', ...model.path.masks.map((m) => m.name)]}
						label="Text path"
						disabled={props.readOnly}
						data-testid={`text-path-${clipId}`}
						onChange={(maskId) =>
							apply(session, 'Text Path Options', [
								{ type: 'text.setPathOptions', clipIds: [clipId], maskId: maskId || null } as Command,
							])
						}
					/>
					<CheckboxField
						value={model.perCharacter3d}
						label="Per-character 3D"
						disabled={props.readOnly}
						onChange={(enabled) =>
							apply(session, 'Per-character 3D', [
								{ type: 'text.setPerCharacter3d', clipIds: [clipId], enabled } as Command,
							])
						}
					>
						<span className="text-pr-small">3D</span>
					</CheckboxField>
				</div>
				{layout.lane(null)}
			</div>
			{sourceRow && props.filter(sourceRow) ? props.renderRow(sourceRow, sourceEditor) : null}
			{model.path.rows.length ? (
				<Group label="Path Options" k={`tpath:${clipId}`} open={open} toggle={toggle} layout={layout}>
					{model.path.rows.filter(props.filter).map((r) => props.renderRow(r))}
				</Group>
			) : null}
			<Group
				label="More Options"
				k={`tmore:${clipId}`}
				open={open}
				toggle={toggle}
				layout={layout}
				closedByDefault
			>
				{model.more.filter(props.filter).map((r) => props.renderRow(r))}
			</Group>
			{model.animators.map((b) => (
				<AnimatorBlockView
					key={b.animator.id}
					block={b}
					count={model.animators.length}
					index={model.animators.indexOf(b)}
					{...props}
					showMenu={showMenu}
					isOpen={open}
					toggle={toggle}
				/>
			))}
			{menu ? (
				<ContextMenu
					x={menu.x}
					y={menu.y}
					items={menu.items}
					onClose={() => setMenu(null)}
					testId="text-animator-menu"
				/>
			) : null}
		</div>
	);
}

function Group(props: {
	label: string;
	k: string;
	open(k: string): boolean;
	toggle(k: string): void;
	layout: Layout;
	children: ReactNode;
	/** Shown collapsed until the user opens it (the state key is inverted). */
	closedByDefault?: boolean;
	indent?: number;
	trailing?: ReactNode;
	testId?: string;
}) {
	const isOpen = props.closedByDefault ? !props.open(props.k) : props.open(props.k);
	return (
		<div data-testid={props.testId}>
			<div className="flex items-stretch">
				<div
					style={{ ...props.layout.left, paddingLeft: `${16 + (props.indent ?? 0) * 12}px` }}
					className="flex h-[var(--pr-row-h)] min-w-0 shrink-0 items-center gap-1 pr-1"
				>
					<MiniButton
						label={isOpen ? `Collapse ${props.label}` : `Expand ${props.label}`}
						onClick={() => props.toggle(props.k)}
					>
						<CaretGlyph open={isOpen} size={11} />
					</MiniButton>
					<span className="min-w-0 flex-1 truncate text-pr-ui text-pr-text">{props.label}</span>
					{props.trailing}
				</div>
				{props.layout.lane(null)}
			</div>
			{isOpen ? props.children : null}
		</div>
	);
}

function AnimatorBlockView(props: {
	session: EditorSession;
	model: TextAnimatorListModel;
	block: AnimatorBlock;
	index: number;
	count: number;
	readOnly: boolean;
	layout: Layout;
	renderRow(r: Row, editor?: ReactNode): ReactNode;
	filter(r: Row): boolean;
	showMenu(e: ReactMouseEvent, items: ContextMenuItem[]): void;
	isOpen(k: string): boolean;
	toggle(k: string): void;
}) {
	const { session, block, layout } = props;
	const a = block.animator;
	const clipId = props.model.clipId;
	const key = `tan:${a.id}`;
	const open = props.isOpen(key);
	const props3d = props.model.perCharacter3d;
	const has = (entry: string) => {
		const keys = animatorMenuProperties(entry, props3d);
		return keys.length > 0 && keys.every((k) => (a.properties as Record<string, unknown>)[k] !== undefined);
	};
	const addItems = (): ContextMenuItem[] => [
		{
			kind: 'submenu',
			label: 'Property',
			items: propertyItems(
				(entry) =>
					apply(session, 'Add Text Animator Property', [
						{ type: 'textAnimator.addProperty', clipId, animatorId: a.id, properties: [entry] } as Command,
					]),
				has,
			),
		},
		{
			kind: 'submenu',
			label: 'Selector',
			items: SELECTOR_KINDS.map((s) => ({
				kind: 'item' as const,
				label: s.label,
				run: () =>
					apply(session, 'Add Text Selector', [
						{ type: 'textSelector.add', clipId, animatorId: a.id, kind: s.kind } as Command,
					]),
			})),
		},
		{
			kind: 'submenu',
			label: 'Remove Property',
			items: Object.keys(a.properties)
				.flatMap((k) =>
					k === 'axes' ? Object.keys(a.properties.axes ?? {}).map((tag) => `axes.${tag}`) : [k],
				)
				.map((k) => ({
					kind: 'item' as const,
					label: k,
					run: () =>
						apply(session, 'Remove Text Animator Property', [
							{ type: 'textAnimator.removeProperty', clipId, animatorId: a.id, properties: [k] } as Command,
						]),
				})),
		},
		{ kind: 'separator' },
		{
			kind: 'item',
			label: 'Duplicate Animator',
			run: () =>
				apply(session, 'Duplicate Text Animator', [
					{ type: 'textAnimator.duplicate', clipId, animatorId: a.id } as Command,
				]),
		},
		{
			kind: 'item',
			label: 'Move Up',
			disabled: props.index === 0,
			run: () =>
				apply(session, 'Move Text Animator', [
					{ type: 'textAnimator.update', clipId, animatorId: a.id, index: props.index - 1 } as Command,
				]),
		},
		{
			kind: 'item',
			label: 'Move Down',
			disabled: props.index === props.count - 1,
			run: () =>
				apply(session, 'Move Text Animator', [
					{ type: 'textAnimator.update', clipId, animatorId: a.id, index: props.index + 1 } as Command,
				]),
		},
	];
	return (
		<div data-testid={`text-animator-${a.id}`}>
			<div className="flex items-stretch">
				<div
					style={layout.left}
					className="flex h-[var(--pr-row-h)] min-w-0 shrink-0 items-center gap-1 pl-4 pr-1"
				>
					<MiniButton
						label={open ? `Collapse ${a.name}` : `Expand ${a.name}`}
						onClick={() => props.toggle(key)}
					>
						<CaretGlyph open={open} size={11} />
					</MiniButton>
					<CheckboxField
						value={a.enabled}
						label={`Enable ${a.name}`}
						disabled={props.readOnly}
						onChange={(enabled) =>
							apply(session, 'Edit Text Animator', [
								{ type: 'textAnimator.update', clipId, animatorId: a.id, enabled } as Command,
							])
						}
					>
						{null}
					</CheckboxField>
					<span className="min-w-[72px] flex-1 truncate">
						<TextField
							value={a.name}
							label="Animator name"
							disabled={props.readOnly}
							data-testid={`text-animator-name-${a.id}`}
							onCommit={(name) =>
								name.trim() &&
								apply(session, 'Rename Text Animator', [
									{ type: 'textAnimator.update', clipId, animatorId: a.id, name: name.trim() } as Command,
								])
							}
						/>
					</span>
					<button
						type="button"
						className="rounded-pr-control px-1 text-pr-ui text-pr-text hover:bg-pr-hover disabled:text-pr-dim"
						disabled={props.readOnly}
						data-testid={`text-animator-add-${a.id}`}
						onClick={(e) => props.showMenu(e, addItems())}
					>
						Add ▸
					</button>
					<MiniButton
						label={`Delete ${a.name}`}
						disabled={props.readOnly}
						data-testid={`text-animator-delete-${a.id}`}
						onClick={() =>
							apply(session, 'Remove Text Animator', [
								{ type: 'textAnimator.remove', clipId, animatorIds: [a.id] } as Command,
							])
						}
					>
						<TrashGlyph size={12} />
					</MiniButton>
				</div>
				{layout.lane(null)}
			</div>
			{open ? (
				<>
					{block.selectors.map((sb) => (
						<SelectorView key={sb.selector.id} {...props} sb={sb} animatorId={a.id} />
					))}
					{block.rows.filter(props.filter).map((r) => props.renderRow(r))}
				</>
			) : null}
		</div>
	);
}

function SelectorView(props: {
	session: EditorSession;
	model: TextAnimatorListModel;
	sb: SelectorBlock;
	animatorId: string;
	readOnly: boolean;
	layout: Layout;
	renderRow(r: Row, editor?: ReactNode): ReactNode;
	filter(r: Row): boolean;
	isOpen(k: string): boolean;
	toggle(k: string): void;
}) {
	const { session, sb, layout } = props;
	const s = sb.selector;
	const clipId = props.model.clipId;
	const key = `tsl:${s.id}`;
	const open = props.isOpen(key);
	return (
		<div data-testid={`text-selector-${s.id}`}>
			<div className="flex items-stretch">
				<div
					style={layout.left}
					className="flex h-[var(--pr-row-h)] min-w-0 shrink-0 items-center gap-1 pl-7 pr-1"
				>
					<MiniButton
						label={open ? `Collapse ${s.name}` : `Expand ${s.name}`}
						onClick={() => props.toggle(key)}
					>
						<CaretGlyph open={open} size={11} />
					</MiniButton>
					<CheckboxField
						value={s.enabled}
						label={`Enable ${s.name}`}
						disabled={props.readOnly}
						onChange={(enabled) =>
							apply(session, 'Edit Text Selector', [
								{
									type: 'textSelector.update',
									clipId,
									animatorId: props.animatorId,
									selectorId: s.id,
									enabled,
								} as Command,
							])
						}
					>
						{null}
					</CheckboxField>
					<span
						className={cx('min-w-0 flex-1 truncate text-pr-ui', s.enabled ? 'text-pr-text' : 'text-pr-dim')}
					>
						{s.name}
					</span>
					<MiniButton
						label={`Delete ${s.name}`}
						disabled={props.readOnly}
						data-testid={`text-selector-delete-${s.id}`}
						onClick={() =>
							apply(session, 'Remove Text Selector', [
								{
									type: 'textSelector.remove',
									clipId,
									animatorId: props.animatorId,
									selectorIds: [s.id],
								} as Command,
							])
						}
					>
						<TrashGlyph size={12} />
					</MiniButton>
				</div>
				{layout.lane(null)}
			</div>
			{open ? (
				<>
					{sb.rows.filter(props.filter).map((r) => props.renderRow(r))}
					{sb.advanced.length ? (
						<Group
							label="Advanced"
							k={`tadv:${s.id}`}
							open={props.isOpen}
							toggle={props.toggle}
							layout={layout}
							closedByDefault
							indent={2}
						>
							{sb.advanced.filter(props.filter).map((r) => props.renderRow(r))}
						</Group>
					) : null}
				</>
			) : null}
		</div>
	);
}
