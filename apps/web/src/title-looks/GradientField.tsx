// Spec 19 TL-091: a look's gradient control. Stops under the ramp, each a palette role or a colour with its own opacity:
// click the ramp to add, drag to move, Delete removes (a gradient keeps two). A drag previews here and commits once, so
// it is one undo step.
import {
	COLOR_ROLES,
	GRADIENT_SPANS,
	GRADIENT_TYPES,
	type Gradient,
	gradientSpanOn,
	MAX_GRADIENT_STOPS,
	type RGBA,
	ROLE_LABELS,
	type Role,
} from '@jasper/project';
import { cx, Icon } from '@jasper/ui';
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react';
import { t } from '../i18n/runtime.ts';
import { ColorField, MiniButton, SelectField } from '../panels/properties/controls/fields.tsx';
import { ScrubbyNumber } from '../panels/properties/controls/ScrubbyNumber.tsx';
import {
	addStop,
	gradientRampCss,
	type Palette,
	removeStop,
	rgbaCss,
	stopColor,
	updateStop,
} from './paint.ts';

const TYPE_LABELS = ['Linear', 'Radial', 'Sweep', 'Shape'];
const SPAN_LABELS = ['Block', 'Line', 'Glyph'];
const CUSTOM = 'custom';
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export function GradientField(props: {
	gradient: Gradient;
	palette: Palette;
	label: string;
	/**
	 * The kinds of the clips the gradient paints. Line and glyph spans need text: on other clips they draw as a block
	 * (`gradientSpanOn`, TL-036), and the control says so.
	 */
	clipKinds: readonly string[];
	disabled?: boolean;
	onChange(g: Gradient): void;
}) {
	const { palette, disabled } = props;
	const [draft, setDraft] = useState<Gradient | null>(null);
	const [selected, setSelected] = useState(0);
	const bar = useRef<HTMLDivElement>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new value from the document replaces the drag's draft
	useEffect(() => setDraft(null), [props.gradient]);
	const g = draft ?? props.gradient;
	const index = Math.min(selected, g.stops.length - 1);
	const stop = g.stops[index]!;
	const full = g.stops.length >= MAX_GRADIENT_STOPS;
	// TL-036: what each clip actually draws for a span; the options and the note carry the reason.
	const blocked = (span: Gradient['span']) =>
		props.clipKinds.filter((k) => gradientSpanOn(span, k).spanNote === 'needs-text').length;
	const kinds = props.clipKinds.length;
	const spanLabels = GRADIENT_SPANS.map((span, i) =>
		kinds > 0 && blocked(span) === kinds ? t('{0} (needs text)', SPAN_LABELS[i]!) : SPAN_LABELS[i]!,
	);
	const spanBlocked = blocked(g.span);

	const posAt = (x: number) => {
		const r = bar.current!.getBoundingClientRect();
		return clamp01((x - r.left) / Math.max(1, r.width));
	};
	const dragStop = (e: ReactPointerEvent, i: number) => {
		if (disabled || e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		setSelected(i);
		let cur = g;
		let moved = false;
		const move = (ev: PointerEvent) => {
			moved = true;
			cur = updateStop(g, i, { at: Math.round(posAt(ev.clientX) * 1000) / 1000 });
			setDraft(cur);
		};
		const end = (commit: boolean) => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			window.removeEventListener('pointercancel', cancel);
			window.removeEventListener('keydown', key, true);
			setDraft(null);
			if (moved && commit) props.onChange(cur);
		};
		const up = () => end(true);
		const cancel = () => end(false);
		const key = (ev: KeyboardEvent) => {
			if (ev.key === 'Escape') {
				ev.preventDefault();
				end(false);
			}
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
		window.addEventListener('pointercancel', cancel);
		window.addEventListener('keydown', key, true);
	};
	const onRamp = (e: ReactPointerEvent) => {
		if (disabled || e.button !== 0 || full) return;
		const r = addStop(g, posAt(e.clientX), palette);
		if (r.index < 0) return;
		setSelected(r.index);
		props.onChange(r.gradient);
	};
	const remove = (i: number) => {
		if (disabled || g.stops.length <= 2) return;
		setSelected(Math.max(0, i - 1));
		props.onChange(removeStop(g, i));
	};

	const stopRole = 'role' in stop.paint ? stop.paint.role : CUSTOM;
	return (
		<div className="flex w-full min-w-0 flex-col gap-1 pt-1" data-testid="look-gradient">
			<div className="flex flex-wrap items-center gap-1">
				<SelectField
					value={g.type}
					options={GRADIENT_TYPES}
					labels={TYPE_LABELS}
					label={`${props.label} gradient type`}
					disabled={disabled}
					onChange={(type) => props.onChange({ ...g, type })}
					data-testid="look-gradient-type"
				/>
				<SelectField
					value={g.span}
					options={GRADIENT_SPANS}
					labels={spanLabels}
					label={`${props.label} gradient span`}
					disabled={disabled}
					onChange={(span) => props.onChange({ ...g, span })}
					data-testid="look-gradient-span"
				/>
				{g.type === 'linear' || g.type === 'sweep' ? (
					<ScrubbyNumber
						value={g.angle}
						label={`${props.label} gradient angle`}
						step={1}
						unit="°"
						min={-3600}
						max={3600}
						disabled={disabled}
						onScrub={(d) => setDraft({ ...props.gradient, angle: props.gradient.angle + d })}
						onScrubEnd={(cancelled) => {
							if (draft && !cancelled) props.onChange(draft);
							setDraft(null);
						}}
						onCommit={(fn) => props.onChange({ ...g, angle: fn(g.angle) })}
						data-testid="look-gradient-angle"
					/>
				) : null}
			</div>
			{spanBlocked > 0 ? (
				<p className="text-pr-small text-pr-muted" data-testid="look-gradient-span-note">
					{spanBlocked === kinds
						? kinds === 1
							? 'Line and Glyph follow text. On this clip they draw as Block.'
							: 'Line and Glyph follow text. On these clips they draw as Block.'
						: 'Line and Glyph follow text. On the clips without text they draw as Block.'}
				</p>
			) : null}
			<div className="relative h-[24px] w-full select-none">
				<div
					ref={bar}
					className={cx(
						'absolute inset-x-0 top-0 h-[12px] rounded-[2px] border border-pr-border-strong',
						full || disabled ? 'cursor-default' : 'cursor-copy',
					)}
					style={{
						background: `${gradientRampCss(g, palette)}, repeating-conic-gradient(var(--pr-border-strong) 0 25%, transparent 0 50%) 0 0 / 8px 8px`,
					}}
					role="img"
					aria-label={props.label}
					title={full ? `A gradient holds at most ${MAX_GRADIENT_STOPS} stops` : 'Click to add a stop'}
					onPointerDown={onRamp}
					data-testid="look-gradient-ramp"
				/>
				{g.stops.map((s, i) => (
					<span
						// biome-ignore lint/suspicious/noArrayIndexKey: stops are positional (two may share a place)
						key={i}
						role="slider"
						tabIndex={0}
						aria-label={`Stop ${i + 1}`}
						aria-valuenow={Math.round(s.at * 100)}
						className={cx(
							'absolute top-[12px] h-[12px] w-[9px] -translate-x-1/2 cursor-ew-resize rounded-[1px] border',
							i === index ? 'border-pr-focus' : 'border-pr-border-strong',
						)}
						style={{ left: `${s.at * 100}%`, background: rgbaCss(stopColor(s, palette)) }}
						onPointerDown={(e) => dragStop(e, i)}
						onFocus={() => setSelected(i)}
						onKeyDown={(e) => {
							if (e.key === 'Delete' || e.key === 'Backspace') {
								e.preventDefault();
								e.stopPropagation();
								remove(i);
							}
						}}
						data-testid={`look-gradient-stop-${i}`}
					/>
				))}
			</div>
			<div className="flex flex-wrap items-center gap-2">
				<ScrubbyNumber
					value={Math.round(stop.at * 1000) / 10}
					label="Stop position"
					step={0.1}
					precision={1}
					unit="%"
					min={0}
					max={100}
					disabled={disabled}
					onCommit={(fn) => props.onChange(updateStop(g, index, { at: clamp01(fn(stop.at * 100) / 100) }))}
					data-testid="look-gradient-stop-position"
				/>
				<SelectField<string>
					value={stopRole}
					options={[...COLOR_ROLES, CUSTOM]}
					labels={[...COLOR_ROLES.map((r) => ROLE_LABELS[r]), 'Custom Colour']}
					label="Stop colour"
					disabled={disabled}
					onChange={(v) =>
						props.onChange(
							updateStop(g, index, {
								paint: v === CUSTOM ? { color: [...stopColor(stop, palette)] as RGBA } : { role: v as Role },
							}),
						)
					}
					data-testid="look-gradient-stop-role"
				/>
				{'color' in stop.paint ? (
					<ColorField
						value={stop.paint.color as RGBA}
						label="Stop colour"
						disabled={disabled}
						onChange={(c) => props.onChange(updateStop(g, index, { paint: { color: c } }))}
						data-testid="look-gradient-stop-color"
					/>
				) : null}
				<ScrubbyNumber
					value={Math.round((stop.alpha ?? 1) * 100)}
					label="Stop opacity"
					step={1}
					unit="%"
					min={0}
					max={100}
					disabled={disabled}
					onCommit={(fn) =>
						props.onChange(updateStop(g, index, { alpha: clamp01(fn((stop.alpha ?? 1) * 100) / 100) }))
					}
					data-testid="look-gradient-stop-opacity"
				/>
				<MiniButton
					label="Delete stop"
					disabled={disabled || g.stops.length <= 2}
					onClick={() => remove(index)}
					data-testid="look-gradient-stop-delete"
				>
					<Icon id="app.close" size={12} />
				</MiniButton>
			</div>
		</div>
	);
}
