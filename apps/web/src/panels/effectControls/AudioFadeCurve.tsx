// Effect Controls ▸ Transition for audio transitions (Premiere port, docs/wp-notes/audio-crossfades.md): the gain
// curves of the transition's sides drawn from the shared curve model (`audioTransitionCurves` / `fadeCurve`, the
// functions the mixers play), and the Custom Fade controls — Fade Shape (Linear / Cosine), Fade Value (slider and
// scrubby number, −100…100), Crossfade Symmetry and, when asymmetrical, the fade out's own shape and value.
// Dragging the curve up or down changes the fade value as Premiere's fade handles do (a Constant Gain / Power /
// Exponential Fade becomes a Custom Fade starting from its own curve); Shift-drag on a crossfade changes only the
// side under the pointer (asymmetrical). One History entry per drag or edit.
import {
	audioTransitionCurves,
	CUSTOM_FADE,
	customFadeParamsFor,
	FADE_SHAPE_TYPES,
	FADE_VALUE_MAX,
	FADE_VALUE_MIN,
	type AudioFadeCurve as FadeCurveOf,
	type FadeShapeType,
	fadeCurve,
	type Transition,
	type TransitionSpec,
} from '@jasper/project';
import { type PointerEvent as ReactPointerEvent, useRef, useState } from 'react';
import { SelectField } from '../properties/controls/fields.tsx';
import { ScrubbyNumber } from '../properties/controls/ScrubbyNumber.tsx';
import type { InspectorOps } from '../properties/lib/ops.ts';

const W = 200;
const H = 64;
const SHAPE_LABELS = ['Linear', 'Cosine'];

type Patch = { effectId?: string; params: Record<string, unknown> };

const staticValue = (t: Transition, name: string): unknown => t.params[name]?.value;

/**
 * SVG path (x 0…W over the span) of one fade: `rising` = a fade in (the incoming clip, or a fade at a clip head),
 * else a fade out (the outgoing clip, or a fade at a clip tail).
 */
function fadePath(c: FadeCurveOf, rising: boolean): string {
	const pts: string[] = [];
	const n = 48;
	for (let i = 0; i <= n; i++) {
		const p = i / n;
		const g = fadeCurve(c.curve, rising ? p : 1 - p, c.shape);
		pts.push(`${(p * W).toFixed(2)} ${(H - 2 - g * (H - 4)).toFixed(2)}`);
	}
	return `M${pts.join(' L')}`;
}

export function AudioFadeCurve(props: {
	t: Transition;
	spec: TransitionSpec | null;
	oneSided: 'in' | 'out' | null;
	ops: InspectorOps;
}) {
	const { t, ops, oneSided } = props;
	const ref = useRef<SVGSVGElement>(null);
	const [tip, setTip] = useState<string | null>(null);
	const custom = t.effectId === CUSTOM_FADE;
	const two = !oneSided;
	const asym = custom && two && staticValue(t, 'symmetry') === 'asymmetric';
	const curves = audioTransitionCurves(t);
	const sideValue = (side: 'in' | 'out') => {
		const s = (side === 'out' && asym ? curves.out : curves.in).shape;
		return s?.value ?? customFadeParamsFor(t.effectId).fadeValue;
	};
	const update = (label: string, patch: Patch) =>
		ops.apply(label, [{ type: 'transition.update', transitionId: t.id, ...patch } as never]);
	/** A change of params; a fixed transition first becomes a Custom Fade with its own curve. */
	const patchFor = (params: Record<string, unknown>): Patch =>
		custom
			? { params }
			: { effectId: CUSTOM_FADE, params: { ...customFadeParamsFor(t.effectId), ...params } };

	const onDown = (e: ReactPointerEvent<SVGSVGElement>) => {
		if (e.button !== 0 || !ref.current) return;
		e.preventDefault();
		const box = ref.current.getBoundingClientRect();
		// Shift on a crossfade: only the side under the pointer (left half = the outgoing clip's fade out).
		const side: 'in' | 'out' | 'both' =
			e.shiftKey && two ? (e.clientX - box.left < box.width / 2 ? 'out' : 'in') : 'both';
		const y0 = e.clientY;
		const base = { in: sideValue('in'), out: sideValue('out') };
		let active = false;
		let changed = false;
		const move = (ev: PointerEvent) => {
			const dv = Math.round(y0 - ev.clientY);
			if (!active) {
				if (Math.abs(dv) < 2) return;
				if (!ops.scrub.start('Fade Curve')) return;
				active = true;
			}
			const clamp = (v: number) => Math.min(FADE_VALUE_MAX, Math.max(FADE_VALUE_MIN, v));
			const params: Record<string, unknown> =
				side === 'both'
					? { fadeValue: clamp(base.in + dv), ...(asym ? { outFadeValue: clamp(base.out + dv) } : {}) }
					: side === 'in'
						? { fadeValue: clamp(base.in + dv), ...(asym ? {} : seedOut(t, base.out)) }
						: { ...(asym ? {} : seedOut(t, base.out)), outFadeValue: clamp(base.out + dv) };
			const r = ops.scrub.update([
				{ type: 'transition.update', transitionId: t.id, ...patchFor(params) } as never,
			]);
			if (r?.ok) {
				changed = true;
				const v = (params.fadeValue ?? params.outFadeValue) as number;
				setTip(`${side === 'out' ? 'Fade out value' : 'Fade value'} ${v}`);
			}
		};
		const up = () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			window.removeEventListener('keydown', key, true);
			if (active) ops.scrub.end(!changed);
			setTip(null);
		};
		const key = (ev: KeyboardEvent) => {
			if (ev.key !== 'Escape') return;
			changed = false;
			up();
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
		window.addEventListener('keydown', key, true);
	};

	// The default shape (absent or unreadable) is Cosine, as the curve model reads it.
	const shapeOf = (name: string): FadeShapeType => (staticValue(t, name) === 'linear' ? 'linear' : 'cosine');
	return (
		<div className="px-4 pt-1" data-testid="audio-fade-curve">
			<svg
				ref={ref}
				viewBox={`0 0 ${W} ${H}`}
				preserveAspectRatio="none"
				className="h-[64px] w-full cursor-ns-resize rounded-pr-control"
				style={{ background: 'var(--pr-graph-bg)' }}
				onPointerDown={onDown}
				data-testid="audio-fade-curve-graph"
				aria-label="Fade curve: drag up or down to change the fade value"
			>
				<title>Drag up or down to change the fade value (Shift: one side of a crossfade)</title>
				<line x1={0} x2={W} y1={H / 2} y2={H / 2} stroke="var(--pr-graph-grid)" />
				<line x1={W / 2} x2={W / 2} y1={0} y2={H} stroke="var(--pr-graph-grid)" />
				{oneSided !== 'in' ? (
					<path
						// the outgoing clip's fade out; a fade at a clip tail uses the transition's main curve
						d={fadePath(oneSided === 'out' ? curves.in : curves.out, false)}
						fill="none"
						stroke="var(--pr-graph-x)"
						strokeWidth={1.5}
						data-testid="audio-fade-curve-out"
					/>
				) : null}
				{oneSided !== 'out' ? (
					<path
						d={fadePath(curves.in, true)}
						fill="none"
						stroke="var(--pr-graph-y)"
						strokeWidth={1.5}
						data-testid="audio-fade-curve-in"
					/>
				) : null}
			</svg>
			<p className="h-[16px] text-pr-small text-pr-muted" data-testid="audio-fade-curve-tip">
				{tip ?? (custom ? 'Drag the curve to change the fade value' : 'Drag the curve to make a Custom Fade')}
			</p>
			{custom ? (
				<>
					<ShapeRow
						label="Fade Shape"
						value={shapeOf('fadeShape')}
						onChange={(v) => update('Custom Fade: Fade Shape', { params: { fadeShape: v } })}
						testId="custom-fade-shape"
					/>
					<ValueRow
						label="Fade Value"
						value={sideValue('in')}
						ops={ops}
						toCommand={(v) => ({ type: 'transition.update', transitionId: t.id, params: { fadeValue: v } })}
						testId="custom-fade-value"
					/>
					{two ? (
						<Row label="Crossfade Symmetry">
							<SelectField<string>
								value={asym ? 'asymmetric' : 'symmetric'}
								options={['symmetric', 'asymmetric']}
								labels={['Symmetrical', 'Asymmetrical']}
								label="Crossfade Symmetry"
								onChange={(v) =>
									update('Custom Fade: Crossfade Symmetry', {
										params:
											v === 'asymmetric' ? { symmetry: v, ...seedOut(t, sideValue('in')) } : { symmetry: v },
									})
								}
								data-testid="custom-fade-symmetry"
							/>
						</Row>
					) : null}
					{asym ? (
						<>
							<ShapeRow
								label="Fade Out Shape"
								value={shapeOf('outFadeShape')}
								onChange={(v) => update('Custom Fade: Fade Out Shape', { params: { outFadeShape: v } })}
								testId="custom-fade-out-shape"
							/>
							<ValueRow
								label="Fade Out Value"
								value={sideValue('out')}
								ops={ops}
								toCommand={(v) => ({
									type: 'transition.update',
									transitionId: t.id,
									params: { outFadeValue: v },
								})}
								testId="custom-fade-out-value"
							/>
						</>
					) : null}
				</>
			) : null}
		</div>
	);
}

/**
 * Params that make a symmetrical Custom Fade asymmetrical without changing how its outgoing side sounds: the fade
 * out gets the current shape and value (`outValue` for a fixed transition's starting curve).
 */
function seedOut(t: Transition, outValue: number): Record<string, unknown> {
	if (t.effectId === CUSTOM_FADE && t.params.symmetry?.value === 'asymmetric') return {};
	const c = audioTransitionCurves(t).in;
	return {
		symmetry: 'asymmetric',
		outFadeShape: c.shape?.type ?? customFadeParamsFor(t.effectId).fadeShape,
		outFadeValue: c.shape ? c.shape.value : outValue,
	};
}

function Row(props: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex h-[var(--pr-row-h)] items-center gap-2 pr-0">
			<span className="w-[118px] shrink-0 truncate text-pr-muted" title={props.label}>
				{props.label}
			</span>
			<div className="flex min-w-0 flex-1 items-center gap-1">{props.children}</div>
		</div>
	);
}

function ShapeRow(props: {
	label: string;
	value: FadeShapeType;
	onChange(v: FadeShapeType): void;
	testId: string;
}) {
	return (
		<Row label={props.label}>
			<SelectField<string>
				value={props.value}
				options={[...FADE_SHAPE_TYPES]}
				labels={SHAPE_LABELS}
				label={props.label}
				onChange={(v) => props.onChange(v as FadeShapeType)}
				data-testid={props.testId}
			/>
		</Row>
	);
}

function ValueRow(props: {
	label: string;
	value: number;
	ops: InspectorOps;
	toCommand(v: number): unknown;
	testId: string;
}) {
	const { ops } = props;
	const base = useRef(0);
	const clamp = (v: number) => Math.round(Math.min(FADE_VALUE_MAX, Math.max(FADE_VALUE_MIN, v)) * 100) / 100;
	const label = `Custom Fade: ${props.label}`;
	return (
		<Row label={props.label}>
			<input
				type="range"
				min={FADE_VALUE_MIN}
				max={FADE_VALUE_MAX}
				step={1}
				value={props.value}
				aria-label={props.label}
				className="min-w-0 flex-1 accent-pr-accent"
				data-testid={`${props.testId}-slider`}
				onPointerDown={() => ops.scrub.start(label)}
				onChange={(e) => {
					const cmds = [props.toCommand(clamp(Number(e.target.value))) as never];
					if (!ops.scrub.update(cmds)) ops.apply(label, cmds);
				}}
				onPointerUp={() => ops.scrub.end(false)}
			/>
			<ScrubbyNumber
				value={props.value}
				label={props.label}
				step={1}
				min={FADE_VALUE_MIN}
				max={FADE_VALUE_MAX}
				onScrubStart={() => {
					base.current = props.value;
					ops.scrub.start(label);
				}}
				onScrub={(delta) => ops.scrub.update([props.toCommand(clamp(base.current + delta)) as never])}
				onScrubEnd={(cancelled) => ops.scrub.end(cancelled)}
				onCommit={(fn) => ops.apply(label, [props.toCommand(clamp(fn(props.value))) as never])}
				data-testid={props.testId}
			/>
		</Row>
	);
}
