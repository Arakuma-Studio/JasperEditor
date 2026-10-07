// Value editors of the two structured shape properties (wp shapes), used by PropertyRow for `shape.items.*` json
// rows in Properties and Effect Controls: Colors (the gradient editor, written at the playhead — a keyframe when
// animated) and Path (its vertex count and Closed toggle; vertices are edited on the Program monitor).
import { type Command, type GradientValue, isBezierPath, parseShapeItemKey } from '@jasper/project';
import { CheckboxField } from '../panels/properties/controls/fields.tsx';
import type { RowContext } from '../panels/properties/controls/PropertyRow.tsx';
import { editLabel, planSet, type Row } from '../panels/properties/lib/model.ts';
import { GradientEditor } from './GradientEditor.tsx';

export function ShapeJsonValue({ row, ctx, value, mixed }: { row: Row; ctx: RowContext; value: unknown; mixed: boolean }) {
	const parsed = parseShapeItemKey(row.spec.key);
	const field = parsed?.field.join('.');
	if (field === 'path') {
		const p = !mixed && isBezierPath(value) ? value : null;
		const b = row.bindings[0];
		return (
			<span className="inline-flex items-center gap-3" data-testid={`prop-${row.id}`}>
				<span className="text-pr-small text-pr-muted">{p ? `${p.vertices.length} vertices` : '–'}</span>
				{p && b && row.bindings.length === 1 ? (
					<CheckboxField
						value={p.closed}
						label="Closed"
						onChange={(closed) =>
							ctx.ops.apply(closed ? 'Close Path' : 'Open Path', [
								{
									type: 'shape.editPath',
									clipId: b.clip.id,
									itemId: parsed!.itemId,
									ops: [{ op: 'setClosed', closed }],
								} as Command,
							])
						}
					>
						<span className="text-pr-small text-pr-muted">Closed</span>
					</CheckboxField>
				) : null}
			</span>
		);
	}
	return (
		<GradientEditor
			value={mixed ? null : (value as GradientValue)}
			label={row.label}
			onChange={(g) => {
				const plan = planSet(row, ctx.transport.getState().frame, () => g);
				if (plan.skipped.length) ctx.hint('Move the playhead over the clip to add a keyframe');
				ctx.ops.apply(editLabel(row, row.bindings.length), plan.commands);
			}}
		/>
	);
}


