// Horizontal value slider (Lumetri-style, S06:CGU-001): a thin track with a centre mark for bipolar params,
// a fill from the centre (or the start) to the value and a round thumb. Dragging anywhere on the track is one
// gesture (`onStart` → `onChange`… → `onEnd`); Esc during the drag cancels; double-click resets.
import { cx } from '@jasper/ui';
import { type CSSProperties, type PointerEvent, useEffect, useRef } from 'react';

export type SliderProps = {
	value: number | null;
	min: number;
	max: number;
	step?: number;
	/** Centre mark and fill from the middle (e.g. −100…100). */
	bipolar?: boolean;
	label: string;
	disabled?: boolean;
	/** Background of the track (e.g. the temperature gradient token). */
	trackBackground?: string;
	/** Starts the gesture; false aborts the drag (another gesture is running). */
	onStart(): boolean;
	onChange(value: number): void;
	onEnd(cancelled: boolean): void;
	onReset?(): void;
	className?: string;
	'data-testid'?: string;
};

/** Fallback track width when layout is unavailable (tests). */
const FALLBACK_W = 100;

export function sliderValueAt(
	x: number,
	width: number,
	min: number,
	max: number,
	step = 0,
	origin = min,
): number {
	const t = Math.min(1, Math.max(0, x / (width || FALLBACK_W)));
	let v = min + t * (max - min);
	if (step > 0) v = Math.round((v - origin) / step) * step + origin;
	return Number(Math.min(max, Math.max(min, v)).toFixed(6));
}

export function Slider(props: SliderProps) {
	const { value, min, max, bipolar, disabled } = props;
	const cbs = useRef(props);
	cbs.current = props;
	const cleanup = useRef<(() => void) | null>(null);
	useEffect(() => () => cleanup.current?.(), []);

	const span = max - min || 1;
	const pos = value === null ? null : Math.min(1, Math.max(0, (value - min) / span));
	const zero = bipolar ? Math.min(1, Math.max(0, (0 - min) / span)) : 0;

	const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
		if (disabled || e.button !== 0) return;
		e.preventDefault();
		const el = e.currentTarget;
		const rect = el.getBoundingClientRect();
		const at = (clientX: number) =>
			sliderValueAt(clientX - rect.left, rect.width, min, max, props.step, bipolar ? 0 : min);
		if (cbs.current.onStart() === false) return;
		cbs.current.onChange(at(e.clientX));
		let done = false;
		const move = (ev: globalThis.PointerEvent) => cbs.current.onChange(at(ev.clientX));
		const finish = (cancelled: boolean) => {
			if (done) return;
			done = true;
			cleanup.current?.();
			cleanup.current = null;
			cbs.current.onEnd(cancelled);
		};
		const up = () => finish(false);
		const key = (ev: globalThis.KeyboardEvent) => {
			if (ev.key !== 'Escape') return;
			ev.preventDefault();
			finish(true);
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
		window.addEventListener('pointercancel', up);
		window.addEventListener('keydown', key, true);
		cleanup.current = () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			window.removeEventListener('pointercancel', up);
			window.removeEventListener('keydown', key, true);
		};
	};

	const fill: CSSProperties | null =
		pos === null ? null : { left: `${Math.min(pos, zero) * 100}%`, width: `${Math.abs(pos - zero) * 100}%` };

	return (
		<div
			role="slider"
			aria-label={props.label}
			aria-valuemin={min}
			aria-valuemax={max}
			aria-valuenow={value ?? undefined}
			aria-disabled={disabled || undefined}
			tabIndex={-1}
			className={cx(
				'relative h-[14px] min-w-[48px] flex-1',
				disabled ? 'opacity-40' : 'cursor-pointer',
				props.className,
			)}
			style={{ touchAction: 'none' }}
			onPointerDown={onPointerDown}
			onDoubleClick={() => !disabled && props.onReset?.()}
			data-testid={props['data-testid']}
		>
			<div
				className="absolute inset-x-0 top-[6px] h-[2px] rounded-full"
				style={{ background: props.trackBackground ?? 'var(--pr-slider-track)' }}
			/>
			{fill && !props.trackBackground ? (
				<div
					className="absolute top-[6px] h-[2px] rounded-full"
					style={{ ...fill, background: 'var(--pr-slider-fill)' }}
				/>
			) : null}
			{bipolar ? (
				<div
					className="absolute top-[3px] h-[8px] w-px"
					style={{ left: `${zero * 100}%`, background: 'var(--pr-slider-center)' }}
				/>
			) : null}
			{pos !== null ? (
				<div
					className="absolute top-[2px] size-[10px] -translate-x-1/2 rounded-full border"
					style={{
						left: `${pos * 100}%`,
						background: 'var(--pr-slider-thumb)',
						borderColor: 'var(--pr-slider-thumb-border)',
					}}
				/>
			) : null}
		</div>
	);
}
