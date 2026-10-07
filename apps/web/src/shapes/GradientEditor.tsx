// Gradient editor (wp shapes): After Effects' / Photoshop's gradient bar — colour stops under the ramp, opacity stops
// above it, a midpoint diamond between neighbouring stops. Click under / above the ramp adds a stop (sampled from
// the gradient), drag moves a stop or a midpoint, the fields edit the selected stop (location, colour or opacity,
// midpoint), Delete removes it (one colour stop always stays). Every change is one undo step: drags preview locally
// and commit on release. Writes go through the row (`param.set` at the playhead: a keyframe when Colors is animated).
import { type GradientValue, gradientSvgStops, sampleGradient } from '@jasper/project';
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react';
import { ColorField, MiniButton } from '../panels/properties/controls/fields.tsx';
import { ScrubbyNumber } from '../panels/properties/controls/ScrubbyNumber.tsx';
import { Icon } from '@jasper/ui';

type Sel = { kind: 'color' | 'opacity'; index: number } | null;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const round = (x: number) => Math.round(x * 1000) / 1000;

/** CSS preview of a gradient (left → right), over a checkerboard. */
export function gradientCss(g: GradientValue): string {
	const stops = gradientSvgStops(g).map(
		(s) =>
			`rgba(${Math.round(s.color[0] * 255)}, ${Math.round(s.color[1] * 255)}, ${Math.round(s.color[2] * 255)}, ${round(s.alpha)}) ${round(s.offset * 100)}%`, // tokens-allow: document color
	);
	return `linear-gradient(to right, ${stops.join(', ')})`;
}

/** Adds a stop at `pos` sampled from the gradient. */
export function addStop(g: GradientValue, kind: 'color' | 'opacity', pos: number): { g: GradientValue; index: number } {
	const c = sampleGradient(g, pos);
	if (kind === 'color') {
		const colors = [...g.colors, { position: round(pos), color: [c[0], c[1], c[2]] as [number, number, number] }];
		return { g: { ...g, colors }, index: colors.length - 1 };
	}
	const opacities = [...g.opacities, { position: round(pos), opacity: round(c[3]) }];
	return { g: { ...g, opacities }, index: opacities.length - 1 };
}

/** Removes a stop (the last colour stop stays). */
export function removeStop(g: GradientValue, sel: NonNullable<Sel>): GradientValue {
	if (sel.kind === 'color') return g.colors.length <= 1 ? g : { ...g, colors: g.colors.filter((_, i) => i !== sel.index) };
	return { ...g, opacities: g.opacities.filter((_, i) => i !== sel.index) };
}

/** Next stop (by position) after stop `index` of a list, or null. */
function nextOf<T extends { position: number }>(list: readonly T[], index: number): number | null {
	const p = list[index]!.position;
	let best: number | null = null;
	list.forEach((s, i) => {
		if (i === index || s.position < p) return;
		if (s.position === p && i < index) return;
		if (best === null || s.position < list[best]!.position) best = i;
	});
	return best;
}

export function GradientEditor(props: {
	value: GradientValue | null;
	label: string;
	disabled?: boolean;
	onChange(g: GradientValue): void;
}) {
	const [draft, setDraft] = useState<GradientValue | null>(null);
	const [sel, setSel] = useState<Sel>(null);
	const barRef = useRef<HTMLDivElement>(null);
	useEffect(() => setDraft(null), [props.value]);
	const g = draft ?? props.value;
	if (!g) return <span className="text-pr-small text-pr-muted">–</span>;
	const selected = sel && (sel.kind === 'color' ? g.colors[sel.index] : g.opacities[sel.index]) ? sel : null;

	const posAt = (clientX: number) => {
		const r = barRef.current!.getBoundingClientRect();
		return clamp01((clientX - r.left) / Math.max(1, r.width));
	};
	const dragStop = (e: ReactPointerEvent, s: NonNullable<Sel>, what: 'stop' | 'mid') => {
		if (props.disabled || e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		setSel(s);
		const start = g;
		let cur = g;
		let moved = false;
		const move = (ev: PointerEvent) => {
			moved = true;
			const p = posAt(ev.clientX);
			const list = (s.kind === 'color' ? start.colors : start.opacities) as { position: number; midpoint?: number }[];
			const next = list.map((x, i) => {
				if (i !== s.index) return x;
				if (what === 'stop') return { ...x, position: round(p) };
				const j = nextOf(list, i);
				if (j === null) return x;
				const a = x.position;
				const b = list[j]!.position;
				return { ...x, midpoint: round(Math.min(0.95, Math.max(0.05, b > a ? (p - a) / (b - a) : 0.5))) };
			});
			cur = s.kind === 'color' ? { ...start, colors: next as GradientValue['colors'] } : { ...start, opacities: next as GradientValue['opacities'] };
			setDraft(cur);
		};
		const up = () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			if (moved) props.onChange(cur);
			else setDraft(null);
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
	};
	const onBarClick = (e: ReactPointerEvent<HTMLDivElement>, kind: 'color' | 'opacity') => {
		if (props.disabled || e.button !== 0) return;
		const r = addStop(g, kind, posAt(e.clientX));
		setSel({ kind, index: r.index });
		props.onChange(r.g);
	};
	const markers = (kind: 'color' | 'opacity') => {
		const list = (kind === 'color' ? g.colors : g.opacities) as { position: number; midpoint?: number }[];
		return list.map((s, i) => {
			const active = selected?.kind === kind && selected.index === i;
			const j = nextOf(list, i);
			const mid = j === null ? null : s.position + (list[j]!.position - s.position) * (s.midpoint ?? 0.5);
			const swatch =
				kind === 'color'
					? `rgb(${(g.colors[i]!.color as number[]).map((x) => Math.round(clamp01(x) * 255)).join(', ')})` // tokens-allow: document color
					: `rgba(255, 255, 255, ${(g.opacities[i]!.opacity ?? 1).toFixed(3)})`; // tokens-allow: opacity swatch
			return (
				<span key={`${kind}${i}`}>
					<span
						role="slider"
						tabIndex={0}
						aria-label={`${kind === 'color' ? 'Color' : 'Opacity'} stop ${i + 1}`}
						aria-valuenow={Math.round(s.position * 100)}
						onPointerDown={(e) => dragStop(e, { kind, index: i }, 'stop')}
						onKeyDown={(e) => {
							if ((e.key === 'Delete' || e.key === 'Backspace') && !props.disabled) props.onChange(removeStop(g, { kind, index: i }));
						}}
						className={`absolute h-[10px] w-[8px] -translate-x-1/2 cursor-ew-resize border ${active ? 'border-pr-focus' : 'border-pr-border-strong'}`}
						style={{ left: `${s.position * 100}%`, top: kind === 'color' ? 18 : 0, background: swatch }}
						data-testid={`gradient-${kind}-stop-${i}`}
					/>
					{mid !== null && active ? (
						<span
							role="slider"
							tabIndex={0}
							aria-label="Midpoint"
							aria-valuenow={Math.round((s.midpoint ?? 0.5) * 100)}
							onPointerDown={(e) => dragStop(e, { kind, index: i }, 'mid')}
							className="absolute h-[6px] w-[6px] -translate-x-1/2 rotate-45 cursor-ew-resize border border-pr-focus bg-pr-panel"
							style={{ left: `${mid * 100}%`, top: kind === 'color' ? 19 : 2 }}
							data-testid={`gradient-${kind}-mid-${i}`}
						/>
					) : null}
				</span>
			);
		});
	};
	const update = (f: (x: GradientValue) => GradientValue) => props.onChange(f(g));
	return (
		<div className="flex w-full min-w-0 flex-col gap-1" data-testid="gradient-editor">
			<div className="relative h-[30px] w-full select-none">
				<div
					className="absolute right-0 left-0 h-[8px] cursor-copy"
					style={{ top: 0 }}
					title="Click to add an opacity stop"
					onPointerDown={(e) => onBarClick(e, 'opacity')}
					data-testid="gradient-opacity-lane"
				/>
				<div
					ref={barRef}
					className="absolute right-0 left-0 h-[10px] rounded-[2px] border border-pr-border-strong"
					style={{
						top: 8,
						background: `${gradientCss(g)}, repeating-conic-gradient(var(--pr-border-strong) 0 25%, transparent 0 50%) 0 0 / 8px 8px`,
					}}
					aria-label={props.label}
				/>
				<div
					className="absolute right-0 left-0 h-[10px] cursor-copy"
					style={{ top: 18 }}
					title="Click to add a colour stop"
					onPointerDown={(e) => onBarClick(e, 'color')}
					data-testid="gradient-color-lane"
				/>
				{markers('opacity')}
				{markers('color')}
			</div>
			{selected ? (
				<div className="flex flex-wrap items-center gap-2">
					<span className="text-pr-small text-pr-muted">{selected.kind === 'color' ? 'Color stop' : 'Opacity stop'}</span>
					<ScrubbyNumber
						value={Math.round(((selected.kind === 'color' ? g.colors : g.opacities)[selected.index]!.position) * 1000) / 10}
						label="Location"
						step={0.1}
						precision={1}
						unit="%"
						min={0}
						max={100}
						onCommit={(fn) =>
							update((x) => {
								const list = (selected.kind === 'color' ? x.colors : x.opacities) as { position: number }[];
								const next = list.map((s, i) => (i === selected.index ? { ...s, position: round(clamp01(fn(s.position * 100) / 100)) } : s));
								return selected.kind === 'color' ? { ...x, colors: next as never } : { ...x, opacities: next as never };
							})
						}
						data-testid="gradient-stop-location"
					/>
					{selected.kind === 'color' ? (
						<ColorField
							value={[...g.colors[selected.index]!.color, 1] as [number, number, number, number]}
							label="Stop color"
							alpha={false}
							onChange={(c) =>
								update((x) => ({
									...x,
									colors: x.colors.map((s, i) => (i === selected.index ? { ...s, color: [c[0], c[1], c[2]] } : s)),
								}))
							}
							data-testid="gradient-stop-color"
						/>
					) : (
						<ScrubbyNumber
							value={Math.round(g.opacities[selected.index]!.opacity * 1000) / 10}
							label="Opacity"
							step={1}
							precision={0}
							unit="%"
							min={0}
							max={100}
							onCommit={(fn) =>
								update((x) => ({
									...x,
									opacities: x.opacities.map((s, i) =>
										i === selected.index ? { ...s, opacity: round(clamp01(fn(s.opacity * 100) / 100)) } : s,
									),
								}))
							}
							data-testid="gradient-stop-opacity"
						/>
					)}
					<MiniButton
						label="Delete stop"
						disabled={props.disabled || (selected.kind === 'color' && g.colors.length <= 1)}
						onClick={() => {
							update((x) => removeStop(x, selected));
							setSel(null);
						}}
						data-testid="gradient-stop-delete"
					>
						<Icon id="app.close" size={12} />
					</MiniButton>
				</div>
			) : null}
		</div>
	);
}
