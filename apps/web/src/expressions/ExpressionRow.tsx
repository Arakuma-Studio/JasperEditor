// The expression row under a property in Effect Controls (AE's expression controls in the timeline): the Enable
// Expression switch (=), the pick-whip, the expression language menu (reference, presets, links to other
// properties, enable/remove) and the inline editor, with the error shown under it (AE's warning triangle + bar).
import {
	EXPRESSION_REFERENCE,
	expressionPresetsFor,
	type PropertyStatus,
	pickWhipExpression,
	type RefScope,
} from '@jasper/expressions';
import { type Command, type ProjectDocument, paramPathToExpressionRef } from '@jasper/project';
import { cx } from '@jasper/ui';
import { type PointerEvent as ReactPointerEvent, useMemo, useRef, useState } from 'react';
import { MiniButton } from '../panels/properties/controls/fields.tsx';
import { ExpressionGlyph, LanguageMenuGlyph, PickWhipGlyph, WarningGlyph } from '../panels/properties/controls/glyphs.tsx';
import { ContextMenu } from '../panels/timeline/components/Chrome.tsx';
import type { ContextMenuItem } from '../panels/timeline/state/ui-store.ts';
import { ExpressionField, type ExpressionFieldHandle } from './ExpressionField.tsx';
import { completionNames, linkTargets, type RowExpression, setExpressionCommand } from './row.ts';

const SCOPES: [RefScope, string][] = [
	['global', 'Global'],
	['comp', 'Comp'],
	['layer', 'Layer'],
	['property', 'Property'],
	['key', 'Key'],
	['marker', 'Marker'],
	['selector', 'Text Selector'],
];

/** Element attribute that marks a property row as a pick-whip target (its ParamPath as JSON). */
export const PICK_WHIP_ATTR = 'data-expr-path';

export function ExpressionRow(props: {
	doc: ProjectDocument;
	rx: RowExpression & { expression: NonNullable<RowExpression['expression']> };
	status: PropertyStatus | null;
	label: string;
	apply(label: string, commands: Command[]): void;
	leftStyle?: React.CSSProperties;
	autoFocus?: boolean;
}) {
	const { doc, rx, status } = props;
	const field = useRef<ExpressionFieldHandle>(null);
	const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
	const [whip, setWhip] = useState<{ x0: number; y0: number; x: number; y: number } | null>(null);
	const error = status?.expressionError ?? null;
	const enabled = rx.expression.enabled;
	const testId = rx.path.join('-');

	const setText = (text: string) => props.apply(`Edit Expression: ${props.label}`, [setExpressionCommand(rx, text)]);
	const toggle = () =>
		props.apply(`${enabled ? 'Disable' : 'Enable'} Expression: ${props.label}`, [
			{ type: 'expression.setEnabled', target: rx.path, enabled: !enabled, sequenceId: rx.ref.seq } as Command,
		]);
	const remove = () =>
		props.apply(`Remove Expression: ${props.label}`, [
			{ type: 'expression.clear', target: rx.path, sequenceId: rx.ref.seq } as Command,
		]);

	// ---- pick-whip: drag the spiral onto another property row and release.
	const onWhipDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
		e.preventDefault();
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		setWhip({ x0: r.left + r.width / 2, y0: r.top + r.height / 2, x: e.clientX, y: e.clientY });
	};
	const onWhipMove = (e: ReactPointerEvent) => {
		if (whip) setWhip({ ...whip, x: e.clientX, y: e.clientY });
	};
	const onWhipUp = (e: ReactPointerEvent) => {
		if (!whip) return;
		setWhip(null);
		const el = document.elementFromPoint(e.clientX, e.clientY)?.closest(`[${PICK_WHIP_ATTR}]`);
		const raw = el?.getAttribute(PICK_WHIP_ATTR);
		if (!raw) return;
		const to = paramPathToExpressionRef(doc, JSON.parse(raw) as string[], rx.ref.seq);
		const text = to ? pickWhipExpression(doc, rx.ref, to) : null;
		if (text) field.current?.insert(text);
	};

	const menuItems = useMemo((): ContextMenuItem[] => {
		if (!menu) return [];
		const insert = (t: string) => field.current?.insert(t);
		const presets = expressionPresetsFor(status?.kind ?? 'number');
		const byCategory = new Map<string, typeof presets>();
		for (const p of presets) byCategory.set(p.category, [...(byCategory.get(p.category) ?? []), p]);
		const links = linkTargets(doc, rx.ref);
		return [
			{ kind: 'item', label: enabled ? 'Disable Expression' : 'Enable Expression', run: toggle },
			{ kind: 'item', label: 'Remove Expression', run: remove },
			{ kind: 'separator' },
			{
				kind: 'submenu',
				label: 'Presets',
				items: [...byCategory].map(([cat, list]) => ({
					kind: 'submenu' as const,
					label: cat,
					items: list.map((p) => ({ kind: 'item' as const, label: p.label, run: () => setText(p.text) })),
				})),
			},
			{
				kind: 'submenu',
				label: 'Link to Property',
				items: links.length
					? links.map((c) => ({
							kind: 'submenu' as const,
							label: c.label,
							items: c.props.map((p) => ({ kind: 'item' as const, label: p.label, run: () => insert(p.text) })),
						}))
					: [{ kind: 'item' as const, label: 'No other properties', disabled: true, run: () => {} }],
			},
			{ kind: 'separator' },
			...SCOPES.map(([scope, label]) => ({
				kind: 'submenu' as const,
				label,
				items: EXPRESSION_REFERENCE.filter((r) => r.scope === scope).map((r) => ({
					kind: 'item' as const,
					label: r.signature,
					run: () => insert((r.snippet ?? r.signature).replace('$', '')),
				})),
			})),
		];
		// biome-ignore lint/correctness/useExhaustiveDependencies: rebuilt when the menu opens
	}, [menu]);

	return (
		<div className="flex flex-col pb-1" data-testid={`expr-row-${testId}`}>
			<div className="flex items-start gap-1 pl-[34px] pr-1">
				<MiniButton
					label={enabled ? 'Disable Expression' : 'Enable Expression'}
					active={enabled}
					onClick={toggle}
					data-testid={`expr-enable-${testId}`}
				>
					<ExpressionGlyph size={13} />
				</MiniButton>
				<button
					type="button"
					aria-label={`Pick-whip: drag onto a property to reference it from ${props.label}`}
					title="Pick-whip: drag onto another property to reference it"
					className="inline-flex size-[18px] shrink-0 cursor-grab items-center justify-center rounded-pr-control text-pr-icon hover:bg-pr-hover hover:text-pr-icon-hover"
					onPointerDown={onWhipDown}
					onPointerMove={onWhipMove}
					onPointerUp={onWhipUp}
					onPointerCancel={() => setWhip(null)}
					data-testid={`expr-pickwhip-${testId}`}
				>
					<PickWhipGlyph size={13} />
				</button>
				<MiniButton
					label="Expression language menu"
					onClick={(e) => setMenu({ x: e.clientX, y: e.clientY })}
					data-testid={`expr-menu-${testId}`}
				>
					<LanguageMenuGlyph size={13} />
				</MiniButton>
				<div className={cx('flex min-w-0 flex-1', !enabled && 'opacity-60')}>
					<ExpressionField
						ref={field}
						value={rx.expression.text}
						onCommit={setText}
						names={() => completionNames(doc, rx.ref)}
						label={`Expression: ${props.label}`}
						invalid={!!error && enabled}
						autoFocus={props.autoFocus}
						data-testid={`expr-field-${testId}`}
					/>
				</div>
			</div>
			{error && enabled ? (
				<div
					className="ml-[34px] mr-1 mt-0.5 flex items-start gap-1 rounded-pr-control bg-pr-expr-error-bg px-1 py-0.5 text-pr-small text-pr-warning"
					role="alert"
					data-testid={`expr-error-${testId}`}
				>
					<WarningGlyph size={12} className="mt-px shrink-0" />
					<span className="min-w-0 break-words font-pr-mono">{error}</span>
				</div>
			) : null}
			{whip ? (
				<svg className="pointer-events-none fixed inset-0 z-50 size-full" aria-hidden>
					<line x1={whip.x0} y1={whip.y0} x2={whip.x} y2={whip.y} stroke="var(--pr-accent)" strokeWidth={1.5} />
				</svg>
			) : null}
			{menu ? (
				<ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} testId="expr-language-menu" />
			) : null}
		</div>
	);
}
