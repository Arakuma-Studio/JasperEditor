// Virtualized tree/list (S05:CT-040…045): 22 px rows, optional zebra, hover; selection colors depend on
// panel focus (primary row accent fill in the focused panel); click / Ctrl+click / Shift+click; arrows,
// Shift+arrows, Home/End, PgUp/PgDn, type-ahead, Enter/F2 rename; → expands, ← collapses or goes to the
// parent, Alt+click expands recursively. Only visible rows (plus overscan) are rendered; ARIA row counts
// stay correct. Key handling is local: the root carries `data-keymap-local` so the global dispatcher
// defers to it (S05:KB-003).
import {
	type KeyboardEvent,
	type MouseEvent,
	type ReactNode,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import { cx } from '../cx.ts';
import { Icon } from '../icons/Icon.tsx';
import type { IconId } from '../icons/registry.ts';

export type TreeNode = {
	id: string;
	label: string;
	icon?: IconId;
	children?: readonly TreeNode[];
	/** Secondary text on the right (duration, count). */
	detail?: string;
};

export type FlatRow = {
	node: TreeNode;
	depth: number;
	parentId: string | null;
	index: number;
	setSize: number;
	posInSet: number;
};

/** Flattens expanded nodes in display order for the tree renderer. */
function flattenTree(nodes: readonly TreeNode[], expanded: ReadonlySet<string>): FlatRow[] {
	const out: FlatRow[] = [];
	const walk = (list: readonly TreeNode[], depth: number, parentId: string | null) => {
		list.forEach((node, i) => {
			out.push({ node, depth, parentId, index: out.length, setSize: list.length, posInSet: i + 1 });
			if (node.children?.length && expanded.has(node.id)) walk(node.children, depth + 1, node.id);
		});
	};
	walk(nodes, 0, null);
	return out;
}

function descendantIds(node: TreeNode): string[] {
	const ids: string[] = [];
	const walk = (n: TreeNode) => {
		if (n.children?.length) {
			ids.push(n.id);
			n.children.forEach(walk);
		}
	};
	walk(node);
	return ids;
}

export type TreeListProps = {
	nodes: readonly TreeNode[];
	label: string;
	expanded: ReadonlySet<string>;
	onExpandedChange(next: Set<string>): void;
	selected: readonly string[];
	primary?: string | null;
	onSelectionChange(ids: string[], primary: string | null): void;
	/** Enter / double-click. */
	onActivate?(id: string): void;
	/** F2 (and Enter when `enterRenames`). */
	onRename?(id: string): void;
	enterRenames?: boolean;
	/** The owning panel has focus: primary selected row uses the accent fill (CT-041). */
	panelFocused?: boolean;
	zebra?: boolean;
	rowHeight?: number;
	overscan?: number;
	renderRow?(row: FlatRow, state: { selected: boolean; primary: boolean }): ReactNode;
	onContextMenu?(id: string, e: MouseEvent): void;
	className?: string;
};

export function TreeList(props: TreeListProps) {
	const { nodes, expanded, selected, primary = null, rowHeight = 22, overscan = 8 } = props;
	const rows = useMemo(() => flattenTree(nodes, expanded), [nodes, expanded]);
	const selectedSet = useMemo(() => new Set(selected), [selected]);
	const scrollRef = useRef<HTMLDivElement>(null);
	const [scrollTop, setScrollTop] = useState(0);
	const [viewport, setViewport] = useState(400);
	const anchor = useRef<string | null>(null);
	const typeahead = useRef({ text: '', at: 0 });

	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const measure = () => setViewport(el.clientHeight || 400);
		measure();
		if (typeof ResizeObserver === 'undefined') return;
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
	const last = Math.min(rows.length, Math.ceil((scrollTop + viewport) / rowHeight) + overscan);
	const visible = rows.slice(first, last);
	const focusIndex = Math.max(
		0,
		rows.findIndex((r) => r.node.id === primary),
	);

	const scrollIntoView = (index: number) => {
		const el = scrollRef.current;
		if (!el) return;
		const top = index * rowHeight;
		if (top < el.scrollTop) el.scrollTop = top;
		else if (top + rowHeight > el.scrollTop + el.clientHeight)
			el.scrollTop = top + rowHeight - el.clientHeight;
		setScrollTop(el.scrollTop);
	};

	const selectRange = (toIndex: number, additive: boolean) => {
		const aIndex = Math.max(
			0,
			rows.findIndex((r) => r.node.id === (anchor.current ?? primary)),
		);
		const [lo, hi] = aIndex < toIndex ? [aIndex, toIndex] : [toIndex, aIndex];
		const range = rows.slice(lo, hi + 1).map((r) => r.node.id);
		const ids = additive ? [...new Set([...selected, ...range])] : range;
		props.onSelectionChange(ids, rows[toIndex]?.node.id ?? null);
	};

	const moveTo = (index: number, extend: boolean) => {
		const i = Math.max(0, Math.min(rows.length - 1, index));
		const row = rows[i];
		if (!row) return;
		if (extend) selectRange(i, false);
		else {
			anchor.current = row.node.id;
			props.onSelectionChange([row.node.id], row.node.id);
		}
		scrollIntoView(i);
	};

	const toggle = (node: TreeNode, recursive: boolean) => {
		if (!node.children?.length) return;
		const next = new Set(expanded);
		const open = !expanded.has(node.id);
		for (const id of recursive ? descendantIds(node) : [node.id]) {
			if (open) next.add(id);
			else next.delete(id);
		}
		props.onExpandedChange(next);
	};

	const onRowClick = (row: FlatRow, e: MouseEvent) => {
		const id = row.node.id;
		if (e.shiftKey) selectRange(row.index, e.ctrlKey || e.metaKey);
		else if (e.ctrlKey || e.metaKey) {
			anchor.current = id;
			const has = selectedSet.has(id);
			props.onSelectionChange(has ? selected.filter((x) => x !== id) : [...selected, id], has ? null : id);
		} else {
			anchor.current = id;
			props.onSelectionChange([id], id);
		}
	};

	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		const row = rows[focusIndex];
		const page = Math.max(1, Math.floor(viewport / rowHeight) - 1);
		switch (e.key) {
			case 'ArrowDown':
				moveTo(focusIndex + 1, e.shiftKey);
				break;
			case 'ArrowUp':
				moveTo(focusIndex - 1, e.shiftKey);
				break;
			case 'Home':
				moveTo(0, e.shiftKey);
				break;
			case 'End':
				moveTo(rows.length - 1, e.shiftKey);
				break;
			case 'PageDown':
				moveTo(focusIndex + page, e.shiftKey);
				break;
			case 'PageUp':
				moveTo(focusIndex - page, e.shiftKey);
				break;
			case 'ArrowRight':
				if (!row) return;
				if (row.node.children?.length && !expanded.has(row.node.id)) toggle(row.node, e.altKey);
				else if (row.node.children?.length) moveTo(focusIndex + 1, false);
				break;
			case 'ArrowLeft': {
				if (!row) return;
				if (row.node.children?.length && expanded.has(row.node.id)) toggle(row.node, e.altKey);
				else if (row.parentId)
					moveTo(
						rows.findIndex((r) => r.node.id === row.parentId),
						false,
					);
				break;
			}
			case 'Enter':
				if (!row) return;
				if (props.enterRenames && props.onRename) props.onRename(row.node.id);
				else props.onActivate?.(row.node.id);
				break;
			case 'F2':
				if (!row || !props.onRename) return;
				props.onRename(row.node.id);
				break;
			default: {
				if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
				const now = Date.now();
				const t = typeahead.current;
				t.text = now - t.at > 800 ? e.key.toLowerCase() : t.text + e.key.toLowerCase();
				t.at = now;
				const start = t.text.length === 1 ? focusIndex + 1 : focusIndex;
				const order = [...rows.slice(start), ...rows.slice(0, start)];
				const hit = order.find((r) => r.node.label.toLowerCase().startsWith(t.text));
				if (hit) moveTo(hit.index, false);
				break;
			}
		}
		e.preventDefault();
	};

	return (
		<div
			ref={scrollRef}
			role="tree"
			aria-label={props.label}
			aria-multiselectable
			tabIndex={0}
			data-keymap-local=""
			data-testid="tree-list"
			onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
			onKeyDown={onKeyDown}
			className={cx('relative h-full min-h-0 overflow-auto outline-none', props.className)}
		>
			<div style={{ height: rows.length * rowHeight, position: 'relative' }}>
				{visible.map((row) => {
					const isSel = selectedSet.has(row.node.id);
					const isPrimary = row.node.id === primary && isSel;
					const hasChildren = !!row.node.children?.length;
					return (
						// biome-ignore lint/a11y/useKeyWithClickEvents: the tree root owns focus and keys (roving selection)
						<div
							key={row.node.id}
							role="treeitem"
							tabIndex={-1}
							aria-level={row.depth + 1}
							aria-setsize={row.setSize}
							aria-posinset={row.posInSet}
							aria-selected={isSel}
							aria-expanded={hasChildren ? expanded.has(row.node.id) : undefined}
							data-row-id={row.node.id}
							onClick={(e) => onRowClick(row, e)}
							onDoubleClick={() => props.onActivate?.(row.node.id)}
							onContextMenu={(e) => props.onContextMenu?.(row.node.id, e)}
							className={cx(
								'absolute right-0 left-0 flex cursor-default items-center gap-1 pr-2 font-pr text-pr-ui select-none',
								isPrimary && props.panelFocused
									? 'bg-pr-accent-fill text-pr-on-accent'
									: isSel
										? 'bg-pr-selected text-pr-text'
										: cx(
												props.zebra && row.index % 2 ? 'bg-pr-panel-alt' : '',
												'text-pr-text hover:bg-pr-hover',
											),
							)}
							style={{ top: row.index * rowHeight, height: rowHeight, paddingLeft: 4 + row.depth * 14 }}
						>
							{props.renderRow ? (
								props.renderRow(row, { selected: isSel, primary: isPrimary })
							) : (
								<>
									<span
										className={cx(
											'inline-flex w-3.5 shrink-0 justify-center text-pr-muted',
											!hasChildren && 'invisible',
										)}
										onClick={(e) => {
											e.stopPropagation();
											toggle(row.node, e.altKey);
										}}
										aria-hidden
									>
										<Icon id={expanded.has(row.node.id) ? 'app.chevronDown' : 'app.chevronRight'} size={12} />
									</span>
									{row.node.icon ? (
										<span className="inline-flex shrink-0 text-pr-icon">
											<Icon id={row.node.icon} size={14} />
										</span>
									) : null}
									<span className="min-w-0 flex-1 truncate">{row.node.label}</span>
									{row.node.detail ? (
										<span className="shrink-0 text-pr-small text-pr-muted pr-tabular">{row.node.detail}</span>
									) : null}
								</>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}
