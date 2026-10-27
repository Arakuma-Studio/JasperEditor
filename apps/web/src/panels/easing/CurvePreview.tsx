// Easing panel ▸ the preview strip: a dot travelling and a bar scaling along the curve on a loop (play, short hold,
// again). With `prefers-reduced-motion` (or when the panel is hidden) it shows still frames instead: the dot at five
// evenly spaced moments. The overshoot room at both ends shows curves that go past the start or the end.
import { type EaseCurve, evaluateEaseCurve } from '@jasper/project';
import { useEffect, useRef, useState } from 'react';

const PLAY_MS = 1100;
const HOLD_MS = 450;
/** Progress shown across the strip: room for overshoot on both sides. */
const LO = -0.25;
const HI = 1.25;

const pct = (p: number) => `${((Math.min(HI, Math.max(LO, p)) - LO) / (HI - LO)) * 100}%`;

function useReducedMotion(): boolean {
	const [reduced, setReduced] = useState(
		() => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
	);
	useEffect(() => {
		const mq =
			typeof window !== 'undefined' ? window.matchMedia?.('(prefers-reduced-motion: reduce)') : undefined;
		if (!mq) return;
		const on = () => setReduced(mq.matches);
		mq.addEventListener?.('change', on);
		return () => mq.removeEventListener?.('change', on);
	}, []);
	return reduced;
}

export function CurvePreview(props: { curve: EaseCurve; playing: boolean; label?: string }) {
	const reduced = useReducedMotion();
	const animate = props.playing && !reduced;
	const dot = useRef<HTMLDivElement | null>(null);
	const bar = useRef<HTMLDivElement | null>(null);
	const curveRef = useRef(props.curve);
	curveRef.current = props.curve;

	useEffect(() => {
		if (!animate || typeof requestAnimationFrame === 'undefined') return;
		let raf = 0;
		const t0 = performance.now();
		const tick = (now: number) => {
			const phase = (now - t0) % (PLAY_MS + HOLD_MS);
			const u = Math.min(1, phase / PLAY_MS);
			const p = evaluateEaseCurve(curveRef.current, u);
			if (dot.current) dot.current.style.left = pct(p);
			if (bar.current) bar.current.style.transform = `scaleX(${Math.min(HI, Math.max(0, p))})`;
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [animate]);

	const stills = [0, 0.25, 0.5, 0.75, 1].map((u) => evaluateEaseCurve(props.curve, u));
	return (
		<div
			className="flex shrink-0 flex-col gap-1 px-1 py-1"
			role="img"
			aria-label={props.label ?? 'Curve preview'}
			data-testid="ease-preview"
		>
			<div className="relative h-[12px] rounded-pr-control bg-pr-field">
				<div className="absolute inset-y-0 border-pr-border-subtle border-l" style={{ left: pct(0) }} />
				<div className="absolute inset-y-0 border-pr-border-subtle border-l" style={{ left: pct(1) }} />
				{animate ? (
					<div
						ref={dot}
						className="absolute top-1/2 size-[8px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-pr-accent"
						style={{ left: pct(0) }}
					/>
				) : (
					stills.map((p, i) => (
						<div
							// biome-ignore lint/suspicious/noArrayIndexKey: fixed five frames
							key={i}
							className="absolute top-1/2 size-[8px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-pr-accent"
							style={{ left: pct(p), opacity: 0.3 + 0.175 * i }}
							data-testid="ease-preview-still"
						/>
					))
				)}
			</div>
			<div className="relative h-[6px] overflow-hidden rounded-pr-control bg-pr-field">
				<div
					ref={bar}
					className="absolute inset-y-0 left-0 w-[80%] origin-left bg-pr-accent-fill"
					style={{ transform: `scaleX(${animate ? 0 : Math.min(HI, Math.max(0, stills[4]!))})` }}
				/>
			</div>
		</div>
	);
}
