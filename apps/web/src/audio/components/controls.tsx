// Mixer controls (audio-mix): vertical fader with Premiere's fader law (−∞ … +15 dB, 0 dB at three quarters), a
// rotary pan/balance knob, and the 5.1 surround panner pad (puck, Center %, LFE). Each control reports gestures:
// `onTouch(value)` on every move (the preview follows live, the recorder records) and `onRelease()` once.
import { cx } from '@jasper/ui';
import { type PointerEvent as RPointerEvent, useRef } from 'react';

/** Fader law: position 0 … 1 ↔ dB, piecewise linear (finer near 0 dB, like a console fader). */
const FADER_POINTS: [number, number][] = [
	[0, -96],
	[0.06, -60],
	[0.16, -40],
	[0.3, -24],
	[0.44, -12],
	[0.58, -6],
	[0.75, 0],
	[0.86, 6],
	[1, 15],
];

function dbToFader(db: number): number {
	if (!Number.isFinite(db) || db <= -96) return 0;
	for (let i = 1; i < FADER_POINTS.length; i++) {
		const [p0, d0] = FADER_POINTS[i - 1]!;
		const [p1, d1] = FADER_POINTS[i]!;
		if (db <= d1) return p0 + ((db - d0) / (d1 - d0)) * (p1 - p0);
	}
	return 1;
}

function faderToDb(p: number): number {
	const x = Math.min(1, Math.max(0, p));
	for (let i = 1; i < FADER_POINTS.length; i++) {
		const [p0, d0] = FADER_POINTS[i - 1]!;
		const [p1, d1] = FADER_POINTS[i]!;
		if (x <= p1) return Math.round((d0 + ((x - p0) / (p1 - p0)) * (d1 - d0)) * 10) / 10;
	}
	return 15;
}

export const dbText = (db: number) => (db <= -96 ? '-∞' : `${db > 0 ? '+' : ''}${db.toFixed(1)}`);

type GestureProps = {
	disabled?: boolean;
	onTouch(value: number): void;
	onRelease(): void;
	label: string;
	className?: string;
	'data-testid'?: string;
};

/** Captures a pointer drag and maps it to values. */
function useDrag(map: (e: PointerEvent, el: HTMLElement) => number, p: GestureProps) {
	const ref = useRef<HTMLDivElement>(null);
	const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
		if (p.disabled || e.button !== 0) return;
		const el = ref.current;
		if (!el) return;
		e.preventDefault();
		el.setPointerCapture(e.pointerId);
		p.onTouch(map(e.nativeEvent, el));
		const move = (ev: PointerEvent) => p.onTouch(map(ev, el));
		const up = () => {
			el.removeEventListener('pointermove', move);
			el.removeEventListener('pointerup', up);
			el.removeEventListener('pointercancel', up);
			p.onRelease();
		};
		el.addEventListener('pointermove', move);
		el.addEventListener('pointerup', up);
		el.addEventListener('pointercancel', up);
	};
	return { ref, onPointerDown };
}

/** Vertical fader (dB). Double-click resets to 0 dB; arrow keys step 0.5 dB. */
export function Fader(props: GestureProps & { value: number }) {
	const { ref, onPointerDown } = useDrag((e, el) => {
		const r = el.getBoundingClientRect();
		return faderToDb(1 - (e.clientY - r.top) / r.height);
	}, props);
	const pos = dbToFader(props.value);
	return (
		<div
			ref={ref}
			role="slider"
			tabIndex={props.disabled ? -1 : 0}
			aria-label={props.label}
			aria-valuemin={-96}
			aria-valuemax={15}
			aria-valuenow={props.value}
			aria-valuetext={`${dbText(props.value)} dB`}
			aria-disabled={props.disabled || undefined}
			data-testid={props['data-testid']}
			className={cx(
				'relative w-6 cursor-ns-resize touch-none select-none',
				props.disabled && 'opacity-40',
				props.className,
			)}
			onPointerDown={onPointerDown}
			onDoubleClick={() => {
				if (props.disabled) return;
				props.onTouch(0);
				props.onRelease();
			}}
			onKeyDown={(e) => {
				if (props.disabled) return;
				const d = e.key === 'ArrowUp' ? 0.5 : e.key === 'ArrowDown' ? -0.5 : 0;
				if (!d) return;
				e.preventDefault();
				props.onTouch(Math.min(15, Math.max(-96, (props.value <= -96 ? -60 : props.value) + d)));
				props.onRelease();
			}}
		>
			<div className="absolute top-0 bottom-0 left-1/2 w-[3px] -translate-x-1/2 rounded bg-pr-field-deep" />
			<div
				className="absolute left-0 right-0 h-px bg-pr-border"
				style={{ bottom: `${dbToFader(0) * 100}%` }}
				aria-hidden
			/>
			<div
				className="absolute left-0 h-[10px] w-full -translate-y-1/2 rounded-[2px] border border-pr-border-strong bg-pr-raised"
				style={{ top: `${(1 - pos) * 100}%` }}
				aria-hidden
			/>
		</div>
	);
}

/** Rotary knob for pan / balance (−100 … 100) and other bipolar values. Double-click resets. */
export function Knob(
	props: GestureProps & { value: number; min?: number; max?: number; reset?: number; size?: number },
) {
	const min = props.min ?? -100;
	const max = props.max ?? 100;
	const start = useRef<{ y: number; v: number } | null>(null);
	const ref = useRef<HTMLDivElement>(null);
	const size = props.size ?? 26;
	const frac = (props.value - min) / (max - min);
	const angle = -135 + frac * 270;
	const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
		if (props.disabled || e.button !== 0) return;
		const el = ref.current!;
		e.preventDefault();
		el.setPointerCapture(e.pointerId);
		start.current = { y: e.clientY, v: props.value };
		const move = (ev: PointerEvent) => {
			const s = start.current!;
			const k = ev.shiftKey ? 0.1 : 1;
			const v = Math.round(Math.min(max, Math.max(min, s.v + (s.y - ev.clientY) * k * ((max - min) / 200))));
			props.onTouch(v);
		};
		const up = () => {
			el.removeEventListener('pointermove', move);
			el.removeEventListener('pointerup', up);
			el.removeEventListener('pointercancel', up);
			props.onRelease();
		};
		el.addEventListener('pointermove', move);
		el.addEventListener('pointerup', up);
		el.addEventListener('pointercancel', up);
	};
	return (
		<div
			ref={ref}
			role="slider"
			tabIndex={props.disabled ? -1 : 0}
			aria-label={props.label}
			aria-valuemin={min}
			aria-valuemax={max}
			aria-valuenow={Math.round(props.value)}
			aria-disabled={props.disabled || undefined}
			data-testid={props['data-testid']}
			className={cx(
				'relative shrink-0 cursor-ns-resize touch-none select-none rounded-full border border-pr-border-strong bg-pr-raised',
				props.disabled && 'opacity-40',
				props.className,
			)}
			style={{ width: size, height: size }}
			onPointerDown={onPointerDown}
			onDoubleClick={() => {
				if (props.disabled) return;
				props.onTouch(props.reset ?? 0);
				props.onRelease();
			}}
			onKeyDown={(e) => {
				if (props.disabled) return;
				const d =
					e.key === 'ArrowRight' || e.key === 'ArrowUp'
						? 1
						: e.key === 'ArrowLeft' || e.key === 'ArrowDown'
							? -1
							: 0;
				if (!d) return;
				e.preventDefault();
				props.onTouch(Math.min(max, Math.max(min, props.value + d)));
				props.onRelease();
			}}
		>
			<div
				className="absolute top-[2px] left-1/2 h-[45%] w-[2px] -translate-x-1/2 rounded bg-pr-accent"
				style={{
					transform: `translateX(-50%) rotate(${angle}deg)`,
					transformOrigin: `50% ${size / 2 - 2}px`,
				}}
				aria-hidden
			/>
		</div>
	);
}

/** 5.1 panner pad: the puck at (x, y) −100 … 100 (left/rear … right/front); speakers drawn at their positions. */
export function Panner51(
	props: Omit<GestureProps, 'onTouch'> & { x: number; y: number; onTouchXY(x: number, y: number): void },
) {
	const ref = useRef<HTMLDivElement>(null);
	const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
		if (props.disabled || e.button !== 0) return;
		const el = ref.current!;
		e.preventDefault();
		el.setPointerCapture(e.pointerId);
		const at = (ev: PointerEvent | RPointerEvent<HTMLDivElement>) => {
			const r = el.getBoundingClientRect();
			const x = Math.round(Math.min(100, Math.max(-100, ((ev.clientX - r.left) / r.width) * 200 - 100)));
			const y = Math.round(Math.min(100, Math.max(-100, 100 - ((ev.clientY - r.top) / r.height) * 200)));
			props.onTouchXY(x, y);
		};
		at(e);
		const move = (ev: PointerEvent) => at(ev);
		const up = () => {
			el.removeEventListener('pointermove', move);
			el.removeEventListener('pointerup', up);
			el.removeEventListener('pointercancel', up);
			props.onRelease();
		};
		el.addEventListener('pointermove', move);
		el.addEventListener('pointerup', up);
		el.addEventListener('pointercancel', up);
	};
	const sp = (x: number, y: number, t: string) => (
		<span
			key={t}
			className="absolute -translate-x-1/2 -translate-y-1/2 text-[8px] leading-none text-pr-dim"
			style={{ left: `${(x + 1) * 50}%`, top: `${(1 - y) * 50}%` }}
		>
			{t}
		</span>
	);
	return (
		<div
			ref={ref}
			role="application"
			aria-label={props.label}
			data-testid={props['data-testid']}
			className={cx(
				'relative aspect-square w-full cursor-crosshair touch-none rounded-[3px] bg-pr-field-deep',
				props.disabled && 'opacity-40',
				props.className,
			)}
			onPointerDown={onPointerDown}
			onDoubleClick={() => {
				props.onTouchXY(0, 100);
				props.onRelease();
			}}
		>
			{sp(-0.7, 0.85, 'L')}
			{sp(0, 0.92, 'C')}
			{sp(0.7, 0.85, 'R')}
			{sp(-0.85, -0.8, 'Ls')}
			{sp(0.85, -0.8, 'Rs')}
			<span
				className="absolute size-[9px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-pr-text bg-pr-accent"
				style={{ left: `${(props.x / 100 + 1) * 50}%`, top: `${(1 - props.y / 100) * 50}%` }}
				aria-hidden
			/>
		</div>
	);
}
