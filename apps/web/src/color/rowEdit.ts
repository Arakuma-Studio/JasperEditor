// Absolute-value writes to one inspector Row for the colour controls (sliders, curves, wheels, LUT pickers).
// Same rules as PropertyRow: a discrete edit is one transaction; a drag is one gesture (one undo step) whose
// updates re-apply to the gesture base, planned against the row captured at gesture start (so the instance
// that the first update creates is not created twice).
import { useRef } from 'react';
import { editLabel, planSet, type Row } from '../panels/properties/lib/model.ts';
import type { InspectorOps } from '../panels/properties/lib/ops.ts';

type RowWriter = {
	/** One transaction. */
	commit(value: unknown): void;
	/** Starts a gesture; false when another gesture is running. */
	begin(): boolean;
	update(value: unknown): void;
	end(cancelled: boolean): void;
};

export type RowWriteContext = {
	ops: InspectorOps;
	/** Live playhead frame (writes key at the playhead when the param is animated). */
	live(): number;
	/** Reports clips skipped because the playhead is outside them. */
	hint?(message: string): void;
};

const OUTSIDE_HINT = 'Move the playhead over the clip to add a keyframe';

function createRowWriter(getRow: () => Row, ctx: RowWriteContext, label?: string): RowWriter {
	let base: Row | null = null;
	const labelOf = (row: Row) => label ?? editLabel(row, row.bindings.length);
	return {
		commit(value) {
			const row = getRow();
			const plan = planSet(row, ctx.live(), () => value);
			if (plan.skipped.length) ctx.hint?.(OUTSIDE_HINT);
			ctx.ops.apply(labelOf(row), plan.commands);
		},
		begin() {
			const row = getRow();
			if (!ctx.ops.scrub.start(labelOf(row))) return false;
			base = row;
			return true;
		},
		update(value) {
			if (!base) return;
			ctx.ops.scrub.update(planSet(base, ctx.live(), () => value).commands);
		},
		end(cancelled) {
			const b = base;
			base = null;
			ctx.ops.scrub.end(cancelled);
			if (b && !cancelled && planSet(b, ctx.live(), (v) => v).skipped.length) ctx.hint?.(OUTSIDE_HINT);
		},
	};
}

/** React binding: a stable writer that always plans against the latest rendered row. */
export function useRowWriter(row: Row, ctx: RowWriteContext, label?: string): RowWriter {
	const rowRef = useRef(row);
	rowRef.current = row;
	const ctxRef = useRef(ctx);
	ctxRef.current = ctx;
	const writer = useRef<RowWriter | null>(null);
	if (!writer.current)
		writer.current = createRowWriter(
			() => rowRef.current,
			{
				ops: {
					apply: (...a) => ctxRef.current.ops.apply(...a),
					get scrub() {
						return ctxRef.current.ops.scrub;
					},
				},
				live: () => ctxRef.current.live(),
				hint: (m) => ctxRef.current.hint?.(m),
			},
			label,
		);
	return writer.current;
}
