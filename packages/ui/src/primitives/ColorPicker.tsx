// Callers commit one undo step when onChange receives final: true.
import { Popover } from 'radix-ui';
import { type PointerEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { cx } from '../cx.ts';
import { Icon } from '../icons/Icon.tsx';
import { toast } from '../toast/toast-store.ts';
import {
	type Hsv,
	hsvToCss,
	hsvToRgb,
	parseHex,
	type Rgba,
	rgbaToCss,
	rgbaToHex,
	rgbToHsv,
	sameColor,
} from './color-math.ts';
import { TextField } from './fields.tsx';

const CHECKER =
	'repeating-conic-gradient(var(--pr-border-strong) 0% 25%, var(--pr-bg-panel-raised) 0% 50%) 50% / 8px 8px';

/** Session-wide recent colors (newest first, max 8). */
let recent: Rgba[] = [];
function pushRecent(c: Rgba) {
	recent = [c, ...recent.filter((r) => !sameColor(r, c))].slice(0, 8);
}

export type ColorChange = { final: boolean };

export type ColorPickerProps = {
	value: Rgba;
	onChange(color: Rgba, change: ColorChange): void;
	/** A drag in the picker started (map to session.beginGesture). */
	onChangeStart?(): void;
	alpha?: boolean;
	swatches?: readonly Rgba[];
};

function useDrag(onMove: (x: number, y: number) => void, onStart: () => void, onEnd: () => void) {
	return {
		onPointerDown(e: PointerEvent<HTMLDivElement>) {
			if (e.button !== 0) return;
			e.preventDefault();
			try {
				e.currentTarget.setPointerCapture?.(e.pointerId);
			} catch {
				// The browser can cancel the pointer before capture is requested.
			}
			onStart();
			const r = e.currentTarget.getBoundingClientRect();
			onMove((e.clientX - r.left) / (r.width || 1), (e.clientY - r.top) / (r.height || 1));
		},
		onPointerMove(e: PointerEvent<HTMLDivElement>) {
			if (!(e.buttons & 1)) return;
			const r = e.currentTarget.getBoundingClientRect();
			onMove((e.clientX - r.left) / (r.width || 1), (e.clientY - r.top) / (r.height || 1));
		},
		onPointerUp() {
			onEnd();
		},
	};
}

const c01 = (x: number) => Math.min(1, Math.max(0, x));

export function ColorPicker({ value, onChange, onChangeStart, alpha = true, swatches }: ColorPickerProps) {
	const [hsv, setHsv] = useState<Hsv>(() => rgbToHsv(value[0], value[1], value[2]));
	const [a, setA] = useState(value[3]);
	const [hex, setHex] = useState(() => rgbaToHex(value, alpha));
	const dragging = useRef(false);
	const latest = useRef<Rgba>(value);

	// Follow external changes (undo, other editors) when not dragging; keep hue for grays.
	useEffect(() => {
		if (dragging.current || sameColor(value, latest.current)) return;
		const next = rgbToHsv(value[0], value[1], value[2]);
		setHsv((h) => (next.s === 0 || next.v === 0 ? { ...next, h: h.h } : next));
		setA(value[3]);
		setHex(rgbaToHex(value, alpha));
		latest.current = value;
	}, [value, alpha]);

	const emit = (h: Hsv, al: number, final: boolean) => {
		const [r, g, b] = hsvToRgb(h);
		const c: Rgba = [r, g, b, al];
		latest.current = c;
		setHex(rgbaToHex(c, alpha));
		onChange(c, { final });
		if (final) pushRecent(c);
	};
	const start = () => {
		dragging.current = true;
		onChangeStart?.();
	};
	const end = () => {
		if (!dragging.current) return;
		dragging.current = false;
		emit(hsvRef.current, aRef.current, true);
	};
	const hsvRef = useRef(hsv);
	hsvRef.current = hsv;
	const aRef = useRef(a);
	aRef.current = a;

	const sv = useDrag(
		(x, y) => {
			const next = { h: hsvRef.current.h, s: c01(x), v: 1 - c01(y) };
			hsvRef.current = next;
			setHsv(next);
			emit(next, aRef.current, false);
		},
		start,
		end,
	);
	const hue = useDrag(
		(x) => {
			const next = { ...hsvRef.current, h: c01(x) * 359.999 };
			hsvRef.current = next;
			setHsv(next);
			emit(next, aRef.current, false);
		},
		start,
		end,
	);
	const alphaDrag = useDrag(
		(x) => {
			const next = Math.round(c01(x) * 1000) / 1000;
			aRef.current = next;
			setA(next);
			emit(hsvRef.current, next, false);
		},
		start,
		end,
	);

	const pick = (c: Rgba) => {
		const next = rgbToHsv(c[0], c[1], c[2]);
		setHsv(next);
		setA(alpha ? c[3] : 1);
		emit(next, alpha ? c[3] : 1, true);
	};

	const commitHex = () => {
		const parsed = parseHex(hex);
		if (!parsed) {
			setHex(rgbaToHex(latest.current, alpha));
			return;
		}
		pick(parsed);
	};

	const eyeDropperCtor =
		typeof window !== 'undefined'
			? (window as Window & { EyeDropper?: new () => { open(): Promise<{ sRGBHex: string }> } }).EyeDropper
			: undefined;

	const solid = hsvToCss(hsv);
	const color = rgbaToCss([...hsvToRgb(hsv), a]);
	return (
		<div className="flex w-[224px] flex-col gap-2 p-2" data-testid="color-picker">
			<div
				role="slider"
				aria-label="Saturation and brightness"
				aria-valuetext={`Saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`}
				aria-valuenow={Math.round(hsv.s * 100)}
				tabIndex={0}
				className="relative h-[140px] w-full cursor-crosshair touch-none rounded-pr-control"
				style={{
					background: `linear-gradient(to top, black, transparent), linear-gradient(to right, white, transparent), ${hsvToCss({ h: hsv.h, s: 1, v: 1 })}`,
				}}
				{...sv}
			>
				<span
					className="pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-pr-strong shadow-pr-floating"
					style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: solid }}
				/>
			</div>
			<div
				role="slider"
				aria-label="Hue"
				aria-valuenow={Math.round(hsv.h)}
				aria-valuemin={0}
				aria-valuemax={360}
				tabIndex={0}
				className="relative h-3 w-full touch-none rounded-pr-control"
				style={{ background: 'linear-gradient(to right, red, yellow, lime, cyan, blue, magenta, red)' }}
				{...hue}
			>
				<span
					className="pointer-events-none absolute top-1/2 h-4 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-pr-strong"
					style={{ left: `${(hsv.h / 360) * 100}%` }}
				/>
			</div>
			{alpha ? (
				<div
					role="slider"
					aria-label="Opacity"
					aria-valuenow={Math.round(a * 100)}
					aria-valuemin={0}
					aria-valuemax={100}
					tabIndex={0}
					className="relative h-3 w-full touch-none rounded-pr-control"
					style={{ background: `linear-gradient(to right, transparent, ${solid}), ${CHECKER}` }}
					{...alphaDrag}
				>
					<span
						className="pointer-events-none absolute top-1/2 h-4 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-pr-strong"
						style={{ left: `${a * 100}%` }}
					/>
				</div>
			) : null}
			<div className="flex items-center gap-2">
				<span
					className="h-[22px] w-8 shrink-0 rounded-pr-control border border-pr-border-strong"
					style={{
						background: `linear-gradient(${color}, ${color}), ${CHECKER}`,
					}}
				/>
				<TextField
					aria-label="Hex color"
					value={hex}
					onChange={(e) => setHex(e.target.value)}
					onBlur={commitHex}
					onKeyDown={(e) => {
						if (e.key === 'Enter') {
							e.preventDefault();
							commitHex();
						}
					}}
					className="w-full pr-tabular"
					data-testid="color-hex"
				/>
				{eyeDropperCtor ? (
					<button
						type="button"
						aria-label="Pick color from screen"
						className="inline-flex size-6 shrink-0 items-center justify-center rounded-pr-control text-pr-icon hover:bg-pr-hover"
						onClick={() => {
							new eyeDropperCtor()
								.open()
								.then((r) => {
									const c = parseHex(r.sRGBHex);
									if (c) pick(c);
								})
								.catch((error: unknown) => {
									if (error instanceof DOMException && error.name === 'AbortError') return;
									toast({
										kind: 'error',
										title: 'Could not pick a screen color',
										detail: error instanceof Error ? error.message : String(error),
									});
								});
						}}
					>
						<Icon id="app.eyedropper" size={14} />
					</button>
				) : null}
			</div>
			{recent.length ? (
				<Row title="Recent">
					{uniqueColors(recent).map((c) => (
						<Swatch key={rgbaToHex(c, true)} c={c} onPick={pick} />
					))}
				</Row>
			) : null}
			{swatches?.length ? (
				<Row title="Project">
					{uniqueColors(swatches).map((c) => (
						<Swatch key={rgbaToHex(c, true)} c={c} onPick={pick} />
					))}
				</Row>
			) : null}
		</div>
	);
}

function uniqueColors(list: readonly Rgba[]): Rgba[] {
	const seen = new Set<string>();
	return list.filter((c) => {
		const k = rgbaToHex(c, true);
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
}

function Swatch({ c, onPick }: { c: Rgba; onPick(c: Rgba): void }) {
	return (
		<button
			type="button"
			aria-label={`Color ${rgbaToHex(c, true)}`}
			onClick={() => onPick(c)}
			className="size-4 rounded-[2px] border border-pr-border-strong"
			style={{ background: `linear-gradient(${rgbaToCss(c)}, ${rgbaToCss(c)}), ${CHECKER}` }}
		/>
	);
}

function Row({ title, children }: { title: string; children: ReactNode }) {
	return (
		<div className="flex flex-col gap-1">
			<span className="text-pr-small text-pr-muted">{title}</span>
			<div className="flex flex-wrap gap-1">{children}</div>
		</div>
	);
}

export type ColorSwatchProps = ColorPickerProps & {
	label: string;
	disabled?: boolean;
	className?: string;
};

export function ColorSwatch({ label, disabled, className, ...picker }: ColorSwatchProps) {
	const css = rgbaToCss(picker.value);
	return (
		<Popover.Root>
			<Popover.Trigger asChild disabled={disabled}>
				<button
					type="button"
					aria-label={label}
					data-testid="color-swatch"
					className={cx(
						'h-4 w-6 shrink-0 rounded-[2px] border border-pr-border-strong disabled:opacity-40',
						className,
					)}
					style={{ background: `linear-gradient(${css}, ${css}), ${CHECKER}` }}
				/>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					sideOffset={4}
					collisionPadding={8}
					className="z-[var(--pr-z-popover)] rounded-pr-menu border border-pr-menu-border bg-pr-menu shadow-pr-overlay"
				>
					<ColorPicker {...picker} />
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
