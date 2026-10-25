// One property row shared by Properties and Effect Controls (S03:EC-005, INS-005, S05:ECP-005):
// stopwatch (Effect Controls), label, value editor(s) by registry control, keyframe navigator ◀ ◆ ▶
// and reset ⟲. Every numeric scrub is one gesture = one undo step; discrete edits are one transaction.
// In Effect Controls a twirl opens the row's Value / Velocity graphs (S05:ECP-005, S03:KF-022).
import { type Command, dropdownItems, type ProjectDocument, type Sequence } from '@jasper/project';
import type { SessionState, TransportStore } from '@jasper/session';
import { useSessionOrNull, useStoreSelector } from '@jasper/session/react';
import { cx } from '@jasper/ui';
import { Fragment, type ReactNode, useMemo, useRef, useState } from 'react';
import { browseForLut } from '../../../color/actions.ts';
import { CurveField } from '../../../color/controls/CurveField.tsx';
import { LutPicker } from '../../../color/controls/LutPicker.tsx';
import { Slider } from '../../../color/controls/Slider.tsx';
import { WheelField } from '../../../color/controls/WheelField.tsx';
import { ExpressionRow, PICK_WHIP_ATTR } from '../../../expressions/ExpressionRow.tsx';
import { ensureExpressionEngine, useExpressionsFor } from '../../../expressions/engine.ts';
import {
	defaultExpressionText,
	rowExpressionOf,
	rowStatus,
	setExpressionCommand,
} from '../../../expressions/row.ts';
import { templateParamControls } from '../../../extensions/index.ts';
import { useRegistry } from '../../../extensions/react.ts';
import { ShapeJsonValue } from '../../../shapes/ShapeJsonValue.tsx';
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
import { applyTemplateParamPatch, clipParams } from '../lib/template-params.ts';
import { CheckboxField, ColorField, MiniButton, SelectField, TextField } from './fields.tsx';
import { CaretGlyph, DiamondGlyph, NextGlyph, PrevGlyph, ResetGlyph, StopwatchGlyph } from './glyphs.tsx';
import { MediaParamPicker } from './MediaParamPicker.tsx';
import { ScrubbyNumber, type ValueFn } from './ScrubbyNumber.tsx';
import { TemplateParamControlHost } from './TemplateParamControl.tsx';

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

const NO_SESSION_STORE = { getState: (): SessionState | null => null, subscribe: () => () => {} };

const unitText = (u?: string) => (u === 'deg' ? '°' : u === '%' ? '%' : u ? ` ${u}` : undefined);

export function PropertyRow(props: {
	row: Row;
	ctx: RowContext;
	/** Replaces the default editor (e.g. the font picker). */
	editor?: ReactNode;
	indent?: boolean;
	className?: string;
	/** Effect Controls: twirl for properties with graphs (S03:EC-005); absent rows keep the slot empty. */
	twirl?: { open: boolean; onToggle(): void };
}) {
	const { row, ctx } = props;
	const spec = row.spec;
	const clips = row.bindings.length;
	const label = editLabel(row, clips);
	const scrubRow = useRef<Row | null>(null);
	const session = useSessionOrNull();
	const readOnly = useStoreSelector(
		session?.store ?? NO_SESSION_STORE,
		(st: SessionState | null) => st?.readOnly === true,
	);
	// C3: a template param whose template names a registered custom control.
	const controls = useRegistry(templateParamControls);
	const customControl =
		spec.ui.customControl && spec.key.startsWith('params.')
			? controls.find((c) => c.id === spec.ui.customControl)
			: undefined;
	const anim = animState(row);
	const animatable = spec.animatable !== 'no';
	const outside = row.bindings.every((b) => b.resolved.outside);

	// Wave expressions: the row's expression (single binding), its post-expression value and error.
	const single = row.bindings.length === 1 ? row.bindings[0]! : null;
	const rx = useMemo(
		() => (single ? rowExpressionOf(ctx.doc, single, ctx.seq.id) : null),
		[ctx.doc, ctx.seq.id, single],
	);
	const exprReady = useExpressionsFor(ctx.doc);
	const status = useMemo(
		() => (rx && single ? rowStatus(ctx.doc, rx, single.resolved.time, exprReady) : null),
		[ctx.doc, rx, single, exprReady],
	);
	const exprActive = !!rx?.expression?.enabled && !!status && status.expressionError === null;
	const [focusExpr, setFocusExpr] = useState(false);
	/** What the editors show: the post-expression value (AE shows it in red) or the stored/keyframed one. */
	const shown = (): { mixed: boolean; value: unknown } =>
		exprActive ? { mixed: false, value: status!.value } : rowValue(row);
	const toggleExpression = () => {
		if (!rx) return;
		if (rx.expression) {
			ctx.ops.apply(`Remove Expression: ${row.label}`, [
				{ type: 'expression.clear', target: rx.path, sequenceId: rx.ref.seq } as Command,
			]);
			return;
		}
		void ensureExpressionEngine();
		setFocusExpr(true);
		ctx.ops.apply(`Add Expression: ${row.label}`, [
			setExpressionCommand(rx, defaultExpressionText(ctx.doc, rx.ref)),
		]);
	};

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

	const numberEditor = (component?: 0 | 1 | 2) => {
		const post = exprActive ? (status!.value as unknown) : undefined;
		const v =
			component === undefined
				? shown()
				: {
						mixed: false,
						value: exprActive && Array.isArray(post) ? post[component] : vecComponent(row, component),
					};
		const value = v.mixed || typeof v.value !== 'number' ? null : (v.value as number);
		const map = (fn: ValueFn) => (base: unknown) => {
			if (component === undefined) return fn(Number(base));
			const vec = Array.isArray(base) ? [...(base as number[])] : spec.kind === 'vec3' ? [0, 0, 0] : [0, 0];
			vec[component] = fn(Number(vec[component]));
			return vec;
		};
		const axis = component === undefined ? '' : component === 0 ? ' X' : component === 1 ? ' Y' : ' Z';
		return (
			<ScrubbyNumber
				key={component ?? 'n'}
				value={value}
				label={`${row.label}${axis}`}
				step={spec.range?.step ?? 1}
				precision={spec.ui.precision}
				unit={
					component === undefined || component === (spec.kind === 'vec3' ? 2 : 1)
						? unitText(spec.unit)
						: undefined
				}
				min={component === undefined ? spec.range?.min : undefined}
				max={component === undefined ? spec.range?.max : undefined}
				dim={outside}
				className={exprActive ? 'text-pr-expr-value!' : undefined}
				onScrubStart={scrubStart}
				onScrub={(d) => scrubTo(map((b) => b + d))}
				onScrubEnd={scrubEnd}
				onCommit={(fn) => commitFn(map(fn))}
				data-testid={`prop-${row.id}${component === undefined ? '' : `-${component}`}`}
			/>
		);
	};

	// M2 controls (wp-m2-color): sliders, LUT pickers, tone curves and colour wheels, reusable by any effect.
	const writeCtx = { ops: ctx.ops, live, hint: ctx.hint };
	const controlEditor = (): ReactNode => {
		const { mixed, value } = shown();
		switch (spec.ui.control) {
			case 'slider': {
				if (spec.kind !== 'number') return null;
				const min = spec.range?.min ?? 0;
				const max = spec.range?.max ?? 100;
				return (
					<span className="flex min-w-0 flex-1 items-center gap-2">
						<Slider
							value={mixed || typeof value !== 'number' ? null : value}
							min={min}
							max={max}
							step={spec.range?.step}
							bipolar={spec.ui.bipolar ?? min < 0}
							label={row.label}
							onStart={() => {
								scrubRow.current = row;
								return ctx.ops.scrub.start(label);
							}}
							onChange={(v) => scrubTo(() => v)}
							onEnd={scrubEnd}
							onReset={() => reset()}
							data-testid={`slider-${row.id}`}
						/>
						{numberEditor()}
					</span>
				);
			}
			case 'media':
				// fx framework: picture inputs (image/video kinds) get the generic picker; LUT params keep LutPicker.
				// Template media params (avatars): "None" is null; Project panel items can be dropped on the field.
				if (spec.mediaKinds && !spec.mediaKinds.includes('lut'))
					return (
						<MediaParamPicker
							doc={ctx.doc}
							value={mixed ? null : value}
							kinds={spec.mediaKinds}
							label={row.label}
							nullable={spec.mediaNullable}
							onChange={(mediaId) =>
								commitFn(() => (mediaId === '' && spec.mediaNullable ? null : { mediaId }))
							}
							onRefusedDrop={ctx.hint}
							data-testid={`prop-${row.id}`}
						/>
					);
				return (
					<LutPicker
						doc={ctx.doc}
						value={mixed ? null : value}
						label={row.label}
						onChange={(mediaId) => commitFn(() => ({ mediaId }))}
						onBrowse={session ? () => browseForLut(session) : undefined}
						data-testid={`prop-${row.id}`}
					/>
				);
			case 'curve':
				return <CurveField row={row} ctx={writeCtx} data-testid={`prop-${row.id}`} />;
			// Track Matte Key's Matte = a video track of the sequence ('' = None).
			case 'track': {
				const tracks = ctx.seq.videoTracks;
				return (
					<SelectField
						value={mixed ? null : String(value ?? '')}
						options={['', ...tracks.map((t) => t.id)]}
						labels={['None', ...tracks.map((t, i) => t.name || `Video ${i + 1}`)]}
						label={row.label}
						onChange={(v) => commitFn(() => v)}
						data-testid={`prop-${row.id}`}
					/>
				);
			}
			// Wave expressions: Dropdown Menu Control — the items are the instance's `items` param, one per line.
			case 'menu': {
				const b = row.bindings[0]!;
				const fxId = b.path?.[0] === 'effect' ? b.path[1] : null;
				const fx = (
					b.clip as { effects?: { id: string; params: Record<string, { value: unknown }> }[] }
				).effects?.find((e) => e.id === fxId);
				const items = dropdownItems(fx?.params.items?.value);
				const index = typeof value === 'number' ? Math.min(items.length, Math.max(1, Math.round(value))) : 1;
				return (
					<SelectField
						value={mixed ? null : String(index)}
						options={items.map((_, i) => String(i + 1))}
						labels={items}
						label={row.label}
						onChange={(v) => commitFn(() => Number(v))}
						data-testid={`prop-${row.id}`}
					/>
				);
			}
			// parity (roto): a roto object of the clip ('' = None) — Object Matte / Object Blur / Screen Keyer masks.
			case 'roto-object': {
				const clip = row.bindings[0]?.clip as
					| { rotos?: { id: string; name: string; kind: string }[] }
					| undefined;
				const rotos = clip?.rotos ?? [];
				return (
					<SelectField
						value={mixed ? null : String(value ?? '')}
						options={['', ...rotos.map((r) => r.id)]}
						labels={['None', ...rotos.map((r) => (r.kind === 'faces' ? `${r.name} (faces)` : r.name))]}
						label={row.label}
						onChange={(v) => commitFn(() => v)}
						data-testid={`prop-${row.id}`}
					/>
				);
			}
			// Wave expressions: Layer Control — a clip of the sequence ('' = None), listed in layer order.
			case 'layer': {
				const clips = Object.values(ctx.seq.clips).sort((a, b) => a.start - b.start);
				return (
					<SelectField
						value={mixed ? null : String(value ?? '')}
						options={['', ...clips.map((c) => c.id)]}
						labels={['None', ...clips.map((c) => c.name || c.id)]}
						label={row.label}
						onChange={(v) => commitFn(() => v)}
						data-testid={`prop-${row.id}`}
					/>
				);
			}
			// a distortion mesh (Mesh Warp, Liquify) is edited on the Program monitor; the row shows whether it
			// distorts and resets it (an empty mesh = no distortion).
			case 'mesh': {
				const arr = Array.isArray(value) ? (value as number[]) : [];
				const changed = !mixed && arr.length > 0;
				return (
					<span
						className="flex items-center gap-2 text-pr-small text-pr-muted"
						data-testid={`prop-${row.id}`}
					>
						<span>{mixed ? '' : changed ? 'Edited on the Program monitor' : 'Not distorted'}</span>
						{changed && (
							<button
								type="button"
								className="text-pr-accent underline"
								onClick={() => commitFn(() => [])}
								data-testid={`prop-${row.id}-reset`}
							>
								Reset
							</button>
						)}
					</span>
				);
			}
			// Mask Path has no value editor (edited on the monitor): its vertex count.
			case 'json':
				// gradients (editor) and shape paths (vertex count, Closed).
				if (spec.group === 'shape') return <ShapeJsonValue row={row} ctx={ctx} value={value} mixed={mixed} />;
				if (spec.group === 'mask') {
					const p = value as { vertices?: unknown[]; closed?: boolean } | null;
					return (
						<span className="text-pr-small text-pr-muted" data-testid={`prop-${row.id}`}>
							{mixed || !p?.vertices ? '' : `${p.vertices.length} vertices${p.closed ? '' : ' (open)'}`}
						</span>
					);
				}
				// WP7a: an object-valued template param without its custom control: its value, read-only.
				if (spec.key.startsWith('params.')) {
					let text = '–';
					try {
						text = mixed ? '–' : (JSON.stringify(value) ?? '–');
					} catch {
						text = '?';
					}
					return (
						<span
							className="min-w-0 truncate font-pr-mono text-pr-small text-pr-muted"
							title={text}
							data-testid={`prop-${row.id}`}
						>
							{text}
						</span>
					);
				}
				return null;
			case 'wheel':
				return <WheelField row={row} ctx={writeCtx} title="" data-testid={`prop-${row.id}`} />;
			default:
				return null;
		}
	};

	const editor = (() => {
		if (props.editor) return props.editor;
		if (customControl) {
			const first = row.bindings[0]!;
			const { mixed, value } = shown();
			const clips = row.bindings.map((b) => b.clip);
			const clipIds = clips.map((c) => c.id);
			return (
				<TemplateParamControlHost
					def={customControl}
					clipId={first.clip.id}
					paramName={spec.key.slice('params.'.length)}
					value={mixed ? first.resolved.value : value}
					params={clipParams(first.clip)}
					disabled={readOnly}
					clipIds={clipIds}
					mixed={mixed}
					onChange={(next, opts) => {
						const plan = planSet(row, live(), () => next);
						report(plan.skipped);
						if (plan.commands.length === 0) return plan.skipped.length === 0;
						const r = ctx.ops.apply(
							label,
							plan.commands,
							opts?.coalesce ? { coalesceKey: `template-param:${row.id}:${clipIds.join(',')}` } : undefined,
						);
						return r?.ok === true;
					}}
					onChangeParams={(patch, opts) =>
						applyTemplateParamPatch(
							{ doc: ctx.doc, seq: ctx.seq, ops: ctx.ops, frame: live, hint: ctx.hint },
							clips,
							session?.ctx.registries.mgTemplates,
							patch,
							label,
							opts,
						)
					}
				/>
			);
		}
		const custom = controlEditor();
		if (custom) return custom;
		const { mixed, value } = shown();
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
			// Wave expressions: 3D Point Control.
			case 'vec3':
				return (
					<span className="inline-flex gap-3">
						{numberEditor(0)}
						{numberEditor(1)}
						{numberEditor(2)}
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
						{...(spec.optionGroups ? { groups: spec.optionGroups } : {})}
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
	const stopwatch = (e?: { altKey: boolean }) => {
		// AE: Alt/Option-click the stopwatch adds or removes an expression.
		if (e?.altKey && rx) {
			toggleExpression();
			return;
		}
		if (!animatable) {
			ctx.hint(`${row.label} has no keyframes. Alt-click the stopwatch to add an expression.`);
			return;
		}
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
	// WP7a: a custom control with `layout: 'block'` is drawn under the label row across the panel width.
	const block = !props.editor && customControl?.layout === 'block';
	const focusRow = () =>
		inspectorFocus.set({ source: ctx.mode, clipIds: row.bindings.map((b) => b.clip.id), rowId: row.id });

	return (
		<Fragment>
			<div
				{...(rx ? { [PICK_WHIP_ATTR]: JSON.stringify(rx.path) } : {})}
				className={cx(
					'group flex min-h-[var(--pr-row-h)] items-center gap-1 pr-1',
					props.indent ? (ctx.mode === 'effectControls' ? 'pl-[3px]' : 'pl-5') : 'pl-2',
					spec.ui.multiline && !block && 'items-start py-1',
					props.className,
				)}
				data-row={row.id}
				onPointerDownCapture={focusRow}
				onFocusCapture={focusRow}
			>
				{ec && props.indent ? (
					<span className="flex w-[13px] shrink-0 justify-center">
						{props.twirl ? (
							<button
								type="button"
								aria-label={
									props.twirl.open ? `Hide graphs for ${row.label}` : `Show graphs for ${row.label}`
								}
								title={props.twirl.open ? 'Hide Value and Velocity graphs' : 'Show Value and Velocity graphs'}
								aria-expanded={props.twirl.open}
								onClick={props.twirl.onToggle}
								className="inline-flex h-[18px] w-[13px] items-center justify-center rounded-pr-control text-pr-icon hover:bg-pr-hover hover:text-pr-icon-hover"
								data-testid={`twirl-${row.id}`}
							>
								<CaretGlyph open={props.twirl.open} size={10} />
							</button>
						) : null}
					</span>
				) : null}
				{ec ? (
					<span className="w-[18px] shrink-0">
						{animatable || (rx && spec.key === 'text.content') ? (
							<MiniButton
								label={`Toggle animation for ${row.label}${rx ? ' (Alt-click: expression)' : ''}`}
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
				<span
					className={cx(
						'flex min-w-0 flex-1 items-center',
						outside && 'opacity-60',
						exprActive && 'text-pr-expr-value [&_input]:text-pr-expr-value [&_button]:text-pr-expr-value',
					)}
					data-expression={rx?.expression ? (exprActive ? 'active' : 'inactive') : undefined}
					title={exprActive ? 'Value set by an expression' : undefined}
				>
					{block ? null : editor}
				</span>
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
			{block ? (
				<div
					className={cx(
						'flex min-w-0 pr-1 pb-1',
						props.indent && !ec ? 'pl-5' : 'pl-2',
						outside && 'opacity-60',
					)}
					data-row-block={row.id}
					onPointerDownCapture={focusRow}
					onFocusCapture={focusRow}
				>
					{editor}
				</div>
			) : null}
			{ec && rx?.expression ? (
				<ExpressionRow
					doc={ctx.doc}
					rx={{ ...rx, expression: rx.expression }}
					status={status}
					label={row.label}
					apply={(label, commands) => ctx.ops.apply(label, commands)}
					autoFocus={focusExpr}
				/>
			) : null}
		</Fragment>
	);
}
