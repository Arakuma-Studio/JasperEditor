// One property row shared by Properties and Effect Controls (S03:EC-005, INS-005, S05:ECP-005):
// stopwatch (Effect Controls), label, value editor(s) by registry control, keyframe navigator ◀ ◆ ▶
// and reset ⟲. Every numeric scrub is one gesture = one undo step; discrete edits are one transaction.
import type { Command, ProjectDocument, Sequence } from '@jasper/project';
import type { TransportStore } from '@jasper/session';
import { cx } from '@jasper/ui';
import { type ReactNode, useRef } from 'react';
import { inspectorFocus } from '../lib/focus.ts';
import {
	animState,
	editLabel,
	keyAtFrame,
	navigateKey,
	planReset,
	planSet,
	planStopwatch,
	planToggleKey,
	type Row,
	rowValue,
	vecComponent,
} from '../lib/model.ts';
import type { InspectorOps } from '../lib/ops.ts';
import { CheckboxField, ColorField, MiniButton, SelectField, TextField } from './fields.tsx';
import { DiamondGlyph, NextGlyph, PrevGlyph, ResetGlyph, StopwatchGlyph } from './glyphs.tsx';
import { ScrubbyNumber, type ValueFn } from './ScrubbyNumber.tsx';

export type RowContext = {
	doc: ProjectDocument;
	seq: Sequence;
	/** Playhead frame (throttled, S03:EC-006). */
	frame: number;
	ops: InspectorOps;
	transport: TransportStore;
	mode: 'properties' | 'effectControls';
	/** Shows a short hint in the panel (e.g. "Move the playhead over the clip to add a keyframe"). */
	hint(message: string): void;
	/** Asks before turning a stopwatch off (S03:KF-041); calls `onConfirm` when accepted. */
	confirmStopwatchOff(label: string, onConfirm: () => void): void;
};

const OUTSIDE_HINT = 'Move the playhead over the clip to add a keyframe';

const unitText = (u?: string) => (u === 'deg' ? '°' : u === '%' ? '%' : u ? ` ${u}` : undefined);

export function PropertyRow(props: {
	row: Row;
	ctx: RowContext;
	/** Replaces the default editor (e.g. the font picker). */
	editor?: ReactNode;
	indent?: boolean;
	className?: string;
}) {
	const { row, ctx } = props;
	const spec = row.spec;
	const clips = row.bindings.length;
	const label = editLabel(row, clips);
	const scrubRow = useRef<Row | null>(null);
	const anim = animState(row);
	const animatable = spec.animatable !== 'no';
	const outside = row.bindings.every((b) => b.resolved.outside);

	/** Live playhead for writes (the rendered `ctx.frame` is throttled for display). */
	const live = () => ctx.transport.getState().frame;
	const report = (skipped: string[]) => {
		if (skipped.length) ctx.hint(OUTSIDE_HINT);
	};
	const apply = (commands: Command[], skipped: string[] = [], opts?: { coalesceKey?: string }) => {
		report(skipped);
		ctx.ops.apply(label, commands, opts);
	};
	const commitFn = (compute: (base: unknown) => unknown) => {
		const plan = planSet(row, live(), compute);
		apply(plan.commands, plan.skipped);
	};

	// ---- scrubs: one gesture from pointer-down to pointer-up
	const scrubStart = () => {
		scrubRow.current = row;
		ctx.ops.scrub.start(label);
	};
	const scrubTo = (compute: (base: unknown) => unknown) => {
		const base = scrubRow.current ?? row;
		const plan = planSet(base, live(), compute);
		ctx.ops.scrub.update(plan.commands);
	};
	const scrubEnd = (cancelled: boolean) => {
		const base = scrubRow.current;
		scrubRow.current = null;
		ctx.ops.scrub.end(cancelled);
		if (base && !cancelled) report(planSet(base, live(), (b) => b).skipped);
	};

	const numberEditor = (component?: 0 | 1) => {
		const v = component === undefined ? rowValue(row) : { mixed: false, value: vecComponent(row, component) };
		const value = v.mixed || typeof v.value !== 'number' ? null : (v.value as number);
		const map = (fn: ValueFn) => (base: unknown) => {
			if (component === undefined) return fn(Number(base));
			const vec = Array.isArray(base) ? [...(base as number[])] : [0, 0];
			vec[component] = fn(Number(vec[component]));
			return vec;
		};
		const axis = component === undefined ? '' : component === 0 ? ' X' : ' Y';
		return (
			<ScrubbyNumber
				key={component ?? 'n'}
				value={value}
				label={`${row.label}${axis}`}
				step={spec.range?.step ?? 1}
				precision={spec.ui.precision}
				unit={component === 1 || component === undefined ? unitText(spec.unit) : undefined}
				min={component === undefined ? spec.range?.min : undefined}
				max={component === undefined ? spec.range?.max : undefined}
				dim={outside}
				onScrubStart={scrubStart}
				onScrub={(d) => scrubTo(map((b) => b + d))}
				onScrubEnd={scrubEnd}
				onCommit={(fn) => commitFn(map(fn))}
				data-testid={`prop-${row.id}${component === undefined ? '' : `-${component}`}`}
			/>
		);
	};

	const editor = (() => {
		if (props.editor) return props.editor;
		const { mixed, value } = rowValue(row);
		switch (spec.kind) {
			case 'number':
				return numberEditor();
			case 'vec2':
				return (
					<span className="inline-flex gap-3">
						{numberEditor(0)}
						{numberEditor(1)}
					</span>
				);
			case 'color':
				return (
					<ColorField
						value={mixed ? null : (value as [number, number, number, number])}
						label={row.label}
						onChange={(c) => {
							const plan = planSet(row, live(), () => c);
							apply(plan.commands, plan.skipped, {
								coalesceKey: `color:${row.id}:${row.bindings.map((b) => b.clip.id).join(',')}`,
							});
						}}
						data-testid={`prop-${row.id}`}
					/>
				);
			case 'enum':
				return (
					<SelectField
						value={mixed ? null : (value as string)}
						options={spec.options ?? []}
						labels={spec.optionLabels}
						label={row.label}
						onChange={(v) => commitFn(() => v)}
						data-testid={`prop-${row.id}`}
					/>
				);
			case 'boolean':
				return (
					<CheckboxField
						value={mixed ? null : value === true}
						label={row.label}
						onChange={(v) => commitFn(() => v)}
					/>
				);
			case 'string':
				return (
					<TextField
						value={mixed ? null : String(value ?? '')}
						label={row.label}
						multiline={spec.ui.multiline}
						onCommit={(v) => commitFn(() => v)}
						data-testid={`prop-${row.id}`}
					/>
				);
		}
	})();

	const keyHere = row.bindings.every((b) => keyAtFrame(b, ctx.seq, ctx.frame) !== null);
	const prev = anim !== 'none' ? navigateKey(row, ctx.seq, ctx.frame, -1) : null;
	const next = anim !== 'none' ? navigateKey(row, ctx.seq, ctx.frame, 1) : null;
	const toggleKey = () => {
		const plan = planToggleKey(row, ctx.seq, live());
		if (plan.commands.length === 0 && plan.skipped.length) ctx.hint(OUTSIDE_HINT);
		else apply(plan.commands, plan.skipped);
	};
	const stopwatch = () => {
		if (anim === 'none') {
			const plan = planStopwatch(row, live(), true);
			ctx.ops.apply(`Toggle Animation: ${row.label}`, plan.commands);
		} else {
			ctx.confirmStopwatchOff(row.label, () => {
				const plan = planStopwatch(row, live(), false);
				ctx.ops.apply(`Toggle Animation: ${row.label}`, plan.commands);
			});
		}
	};
	const reset = () => {
		const plan = planReset(row, ctx.doc, ctx.seq, live());
		apply(plan.commands, plan.skipped);
	};
	const canReset = spec.defaultValue !== undefined && row.bindings.some((b) => b.path !== null);
	const ec = ctx.mode === 'effectControls';

	return (
		<div
			className={cx(
				'group flex min-h-[var(--pr-row-h)] items-center gap-1 pr-1',
				props.indent ? 'pl-5' : 'pl-2',
				spec.ui.multiline && 'items-start py-1',
				props.className,
			)}
			data-row={row.id}
			onPointerDownCapture={() =>
				inspectorFocus.set({
					source: ctx.mode,
					clipIds: row.bindings.map((b) => b.clip.id),
					rowId: row.id,
				})
			}
			onFocusCapture={() =>
				inspectorFocus.set({ source: ctx.mode, clipIds: row.bindings.map((b) => b.clip.id), rowId: row.id })
			}
		>
			{ec ? (
				<span className="w-[18px] shrink-0">
					{animatable ? (
						<MiniButton
							label={`Toggle animation for ${row.label}`}
							active={anim !== 'none'}
							onClick={stopwatch}
							data-testid={`stopwatch-${row.id}`}
						>
							<StopwatchGlyph size={13} />
						</MiniButton>
					) : null}
				</span>
			) : null}
			<span
				className={cx(
					'shrink-0 truncate text-pr-ui',
					ec ? 'w-[38%]' : 'w-[34%]',
					anim !== 'none' ? 'text-pr-text' : 'text-pr-muted',
				)}
				title={spec.description ?? row.label}
			>
				{row.label}
			</span>
			<span className={cx('flex min-w-0 flex-1 items-center', outside && 'opacity-60')}>{editor}</span>
			{animatable && (!ec || anim !== 'none') ? (
				<span className="flex shrink-0 items-center">
					{anim !== 'none' ? (
						<MiniButton
							label={`Previous keyframe for ${row.label}`}
							disabled={prev === null}
							onClick={() => {
								const f = navigateKey(row, ctx.seq, live(), -1);
								if (f !== null) ctx.transport.seek(f);
							}}
							data-testid={`kf-prev-${row.id}`}
						>
							<PrevGlyph size={11} />
						</MiniButton>
					) : null}
					<MiniButton
						label={
							keyHere && anim !== 'none'
								? `Remove keyframe for ${row.label}`
								: `Add keyframe for ${row.label}`
						}
						active={anim !== 'none'}
						onClick={toggleKey}
						data-testid={`kf-toggle-${row.id}`}
					>
						<DiamondGlyph size={12} filled={keyHere && anim !== 'none'} />
					</MiniButton>
					{anim !== 'none' ? (
						<MiniButton
							label={`Next keyframe for ${row.label}`}
							disabled={next === null}
							onClick={() => {
								const f = navigateKey(row, ctx.seq, live(), 1);
								if (f !== null) ctx.transport.seek(f);
							}}
							data-testid={`kf-next-${row.id}`}
						>
							<NextGlyph size={11} />
						</MiniButton>
					) : null}
				</span>
			) : null}
			<span className="w-[18px] shrink-0">
				{canReset ? (
					<MiniButton label={`Reset ${row.label}`} onClick={reset} data-testid={`reset-${row.id}`}>
						<ResetGlyph size={12} />
					</MiniButton>
				) : null}
			</span>
		</div>
	);
}
