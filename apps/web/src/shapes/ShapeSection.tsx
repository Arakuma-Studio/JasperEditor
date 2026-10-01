// Properties ▸ Shape (S11:SHP-005, S03:TXT-020), registered through `clipSections` for shape selections:
// type (read-only), Size (two scrubby numbers + link toggle), Fill (swatch + "None"), Stroke (on/off, colour,
// width, position) and Corner Radius (rectangles). Rows reuse the inspector's PropertyRow, so ◆ keyframes,
// reset, scrubs as one gesture and multi-selection (mixed `–`, relative scrubs) work like every other property.
// "None" toggles write `clip.update {shape: {fill | stroke}}`; values go through `param.set shape.*`.
import type { Clip, Command, ShapeClip } from '@jasper/project';
import { useSessionState } from '@jasper/session/react';
import { Icon } from '@jasper/ui';
import { type ReactNode, useRef } from 'react';
import type { ClipSectionProps } from '../extensions/index.ts';
import { CheckboxField, ColorField, MiniButton } from '../panels/properties/controls/fields.tsx';
import { useNotices } from '../panels/properties/controls/Notices.tsx';
import { PropertyRow, type RowContext } from '../panels/properties/controls/PropertyRow.tsx';
import { ScrubbyNumber, type ValueFn } from '../panels/properties/controls/ScrubbyNumber.tsx';
import {
	bindProperty,
	editLabel,
	makeRow,
	planSet,
	type Row,
	rowValue,
	vecComponent,
} from '../panels/properties/lib/model.ts';
import { useInspectorOps } from '../panels/properties/lib/ops.ts';
import { SHAPE_LABELS } from './insert.ts';
import { shapePrefs, useShapePrefs } from './prefs.ts';

const ROW = 'flex min-h-[var(--pr-row-h)] items-center gap-1 pr-1 pl-2';
const LABEL = 'w-[34%] shrink-0 truncate text-pr-ui text-pr-muted';
const OUTSIDE_HINT = 'Move the playhead over the clip to add a keyframe';

export const isShapeSelection = (clips: readonly Clip[]) =>
	clips.length > 0 && clips.every((c) => c.kind === 'shape');

export function ShapeSection({ session, clips, frame, sequenceId }: ClipSectionProps) {
	const doc = useSessionState((s) => s.transient ?? s.document);
	const ops = useInspectorOps(session);
	const notices = useNotices();
	const seq = doc.sequences[sequenceId];
	if (!seq) return null;
	const shapes = clips.filter((c): c is ShapeClip => c.kind === 'shape');
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
	const row = (key: string, list: Clip[] = shapes): Row | null => {
		const r = makeRow(
			key,
			list.map((c) => bindProperty(doc, seq, c, key, frame)),
		);
		return r && r.bindings.length === list.length ? r : null;
	};
	const updateShapes = (label: string, list: ShapeClip[], shape: Record<string, unknown>) =>
		ops.apply(
			label,
			list.map((c) => ({ type: 'clip.update', clipId: c.id, patch: { shape } }) as Command),
		);
	const types = [...new Set(shapes.map((c) => c.shape.type))];
	const filled = shapes.filter((c) => c.shape.fill !== null);
	const stroked = shapes.filter((c) => c.shape.stroke !== null);
	const allRect = types.length === 1 && types[0] === 'rect';
	const size = row('shape.size');
	const fill = filled.length === shapes.length ? row('shape.fill') : null;
	const strokeRows =
		stroked.length === shapes.length
			? ['shape.stroke.color', 'shape.stroke.width', 'shape.stroke.position'].map((k) => row(k))
			: [];
	const radius = allRect ? row('shape.cornerRadius') : null;
	const noneFill = filled.length === 0 ? true : filled.length === shapes.length ? false : null;
	const noStroke = stroked.length === 0 ? true : stroked.length === shapes.length ? false : null;

	return (
		<div data-testid="shape-section">
			{notices.element}
			<div className={ROW}>
				<span className={LABEL}>Type</span>
				<span className="text-pr-ui text-pr-text" data-testid="shape-type">
					{types.length === 1 ? SHAPE_LABELS[types[0]!] : '–'}
				</span>
			</div>
			{size ? <PropertyRow row={size} ctx={ctx} editor={<SizeEditor row={size} ctx={ctx} />} /> : null}
			{fill ? (
				<PropertyRow
					row={fill}
					ctx={ctx}
					editor={
						<span className="inline-flex items-center gap-3">
							<FillSwatch row={fill} ctx={ctx} />
							<NoneToggle
								value={false}
								label="No fill"
								onChange={(none) => none && updateShapes('Fill: None', shapes, { fill: null })}
							/>
						</span>
					}
				/>
			) : (
				<div className={ROW}>
					<span className={LABEL}>Fill</span>
					<NoneToggle
						value={noneFill}
						label="No fill"
						onChange={(none) =>
							none
								? updateShapes('Fill: None', filled, { fill: null })
								: updateShapes(
										'Fill',
										shapes.filter((c) => c.shape.fill === null),
										{ fill: [1, 1, 1, 1] },
									)
						}
					/>
				</div>
			)}
			<div className={ROW}>
				<span className={LABEL}>Stroke</span>
				<NoneToggle
					value={noStroke}
					label="No stroke"
					onChange={(none) =>
						none
							? updateShapes('Stroke: None', stroked, { stroke: null })
							: updateShapes(
									'Add Stroke',
									shapes.filter((c) => c.shape.stroke === null),
									{ stroke: {} },
								)
					}
				/>
			</div>
			{strokeRows.map((r) => (r ? <PropertyRow key={r.id} row={r} ctx={ctx} indent /> : null))}
			{radius ? <PropertyRow row={radius} ctx={ctx} /> : null}
		</div>
	);
}

function NoneToggle(props: { value: boolean | null; label: string; onChange(none: boolean): void }) {
	return (
		<CheckboxField value={props.value} label={props.label} onChange={props.onChange}>
			<span className="text-pr-small text-pr-muted">None</span>
		</CheckboxField>
	);
}

/** Fill colour swatch: one undo step per pick, consecutive picks coalesce (like PropertyRow's colour rows). */
function FillSwatch({ row, ctx }: { row: Row; ctx: RowContext }) {
	const { mixed, value } = rowValue(row);
	return (
		<ColorField
			value={mixed ? null : (value as [number, number, number, number])}
			label={row.label}
			onChange={(c) => {
				const plan = planSet(row, ctx.transport.getState().frame, () => c);
				if (plan.skipped.length) ctx.hint(OUTSIDE_HINT);
				ctx.ops.apply(editLabel(row, row.bindings.length), plan.commands, {
					coalesceKey: `color:${row.id}:${row.bindings.map((b) => b.clip.id).join(',')}`,
				});
			}}
			data-testid={`prop-${row.id}`}
		/>
	);
}

/**
 * Width and height scrubby numbers with a link toggle (S11:SHP-005): linked, editing one side scales the other
 * by the same factor. Each scrub is one gesture; typed values are one transaction.
 */
function SizeEditor({ row, ctx }: { row: Row; ctx: RowContext }) {
	const { linkSize } = useShapePrefs();
	const scrubRow = useRef<Row | null>(null);
	const label = editLabel(row, row.bindings.length);
	const live = () => ctx.transport.getState().frame;
	const outside = row.bindings.every((b) => b.resolved.outside);
	const compute = (axis: 0 | 1, fn: ValueFn) => (base: unknown) => {
		const v = Array.isArray(base) ? [...(base as number[])] : [0, 0];
		const next = Math.max(0, fn(Number(v[axis])));
		const other = (1 - axis) as 0 | 1;
		if (linkSize && v[axis]! > 0) v[other] = (v[other]! * next) / v[axis]!;
		v[axis] = next;
		return v;
	};
	const field = (axis: 0 | 1): ReactNode => (
		<ScrubbyNumber
			value={vecComponent(row, axis)}
			label={`${row.label} ${axis === 0 ? 'Width' : 'Height'}`}
			step={row.spec.range?.step ?? 1}
			precision={row.spec.ui.precision}
			unit={axis === 1 ? ' px' : undefined}
			min={0}
			dim={outside}
			onScrubStart={() => {
				scrubRow.current = row;
				ctx.ops.scrub.start(label);
			}}
			onScrub={(d) =>
				ctx.ops.scrub.update(
					planSet(
						scrubRow.current ?? row,
						live(),
						compute(axis, (b) => b + d),
					).commands,
				)
			}
			onScrubEnd={(cancelled) => {
				scrubRow.current = null;
				ctx.ops.scrub.end(cancelled);
			}}
			onCommit={(fn) => {
				const plan = planSet(row, live(), compute(axis, fn));
				if (plan.skipped.length) ctx.hint(OUTSIDE_HINT);
				ctx.ops.apply(label, plan.commands);
			}}
			data-testid={`prop-${row.id}-${axis}`}
		/>
	);
	return (
		<span className="inline-flex items-center gap-2">
			{field(0)}
			<MiniButton
				label={linkSize ? 'Unlink width and height' : 'Link width and height'}
				active={linkSize}
				onClick={() => shapePrefs.set({ linkSize: !linkSize })}
				data-testid="shape-size-link"
			>
				<Icon id={linkSize ? 'timeline.link' : 'timeline.unlink'} size={12} />
			</MiniButton>
			{field(1)}
		</span>
	);
}
