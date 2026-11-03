// Spec 19 TL-091: the paint control, drawn by `PropertyRow` for every paint param: role, colour, gradient or the clip's own
// picture. It edits every selected clip in one step and shows "—" when they differ. A gradient opens its stops under
// the row (`GradientField`), each stop a role or a colour.
import {
	COLOR_ROLES,
	type Command,
	type Gradient,
	type Paint,
	type RGBA,
	ROLE_LABELS,
	type Role,
} from '@jasper/project';
import { ColorField, SelectField } from '../panels/properties/controls/fields.tsx';
import type { RowContext } from '../panels/properties/controls/PropertyRow.tsx';
import type { Row } from '../panels/properties/lib/model.ts';
import { rowValue } from '../panels/properties/lib/model.ts';
import { GradientField } from './GradientField.tsx';
import {
	convertPaint,
	flatPalette,
	PAINT_KIND_LABELS,
	PAINT_KINDS,
	type PaintKind,
	type Palette,
	paintCss,
} from './paint.ts';
import { lookedClip } from './selection.ts';

const MIXED = '—';

/** The palette of a row's first clip: what roles read as in swatches. */
function paletteOf(row: Row): Palette {
	const looked = lookedClip(row.bindings[0]!.clip);
	return flatPalette(looked?.appearance);
}

function write(
	row: Row,
	ctx: RowContext,
	command: (b: Row['bindings'][number]) => Command,
	key?: string,
): void {
	const commands = row.bindings.map(command);
	const r = ctx.ops.apply(row.label, commands, key ? { coalesceKey: key } : undefined);
	if (r && !r.ok) ctx.hint(r.errors[0]?.message ?? 'That paint cannot be used here.');
}

function setPaint(row: Row, ctx: RowContext, paint: Paint, key?: string): void {
	write(
		row,
		ctx,
		(b) =>
			({
				type: 'appearance.setPaint',
				effectInstanceId: b.path![1],
				layerId: b.path![2],
				param: b.path![3],
				paint,
			}) as Command,
		key,
	);
}

function setGradient(row: Row, ctx: RowContext, gradient: Gradient): void {
	write(
		row,
		ctx,
		(b) =>
			({
				type: 'appearance.setGradient',
				effectInstanceId: b.path![1],
				layerId: b.path![2],
				param: b.path![3],
				gradient,
			}) as Command,
	);
}

/** Inline part of the row: the kind and, for a role or a colour, its value. */
export function PaintField(props: { row: Row; ctx: RowContext }) {
	const { row, ctx } = props;
	const { mixed, value } = rowValue(row);
	const paint = value as Paint | null;
	const palette = paletteOf(row);
	const coalesce = `paint:${row.id}:${row.bindings.map((b) => b.clip.id).join(',')}`;
	return (
		<span
			className="flex min-w-0 items-center gap-1"
			data-testid={`prop-${row.id}`}
			data-mixed={mixed || undefined}
		>
			<SelectField<PaintKind>
				value={mixed ? null : (paint?.kind ?? null)}
				options={PAINT_KINDS}
				labels={PAINT_KINDS.map((k) => PAINT_KIND_LABELS[k])}
				mixedLabel={MIXED}
				label={`${row.label} kind`}
				onChange={(k) => setPaint(row, ctx, convertPaint(paint ?? undefined, k, palette))}
				data-testid={`paint-kind-${row.id}`}
			/>
			{!mixed && paint?.kind === 'role' ? (
				<>
					<span
						className="h-[14px] w-[14px] shrink-0 rounded-[2px] border border-pr-border-strong"
						style={{ background: paintCss(paint, palette) }}
					/>
					<SelectField<Role>
						value={paint.role}
						options={COLOR_ROLES}
						labels={COLOR_ROLES.map((r) => ROLE_LABELS[r])}
						label={`${row.label} role`}
						onChange={(role) => setPaint(row, ctx, { kind: 'role', role })}
						data-testid={`paint-role-${row.id}`}
					/>
				</>
			) : null}
			{!mixed && paint?.kind === 'color' ? (
				<ColorField
					value={paint.color as RGBA}
					label={row.label}
					onChange={(c) => setPaint(row, ctx, { kind: 'color', color: c }, coalesce)}
					data-testid={`paint-color-${row.id}`}
				/>
			) : null}
		</span>
	);
}

/** Block part of the row: a gradient's stops, across the panel width. */
export function PaintGradientBlock(props: { row: Row; ctx: RowContext }) {
	const { row, ctx } = props;
	const { mixed, value } = rowValue(row);
	const paint = value as Paint | null;
	if (mixed || paint?.kind !== 'gradient') return null;
	return (
		<GradientField
			gradient={paint.gradient}
			palette={paletteOf(row)}
			label={row.label}
			clipKinds={row.bindings.map((b) => b.clip.kind)}
			onChange={(g) => setGradient(row, ctx, g)}
		/>
	);
}
