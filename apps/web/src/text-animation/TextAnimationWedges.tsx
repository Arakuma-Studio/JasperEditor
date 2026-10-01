// Timeline head/tail wedges of animated text clips (S11:TXA-023): like fade handles, a ramp over the In window
// at the clip head and the Out window at its tail (as rendered, i.e. compressed to the clip). No gesture.
import { type Clip, resolveTextAnimationWindows } from '@jasper/project';

export function TextAnimationWedges({
	clip,
	pxPerFrame,
	height,
}: {
	clip: Clip;
	pxPerFrame: number;
	height: number;
}) {
	if (clip.kind !== 'text' || !clip.textAnimation) return null;
	const w = resolveTextAnimationWindows(clip);
	const width = clip.duration * pxPerFrame;
	const inW = (w.in?.frames ?? 0) * pxPerFrame;
	const outW = (w.out?.frames ?? 0) * pxPerFrame;
	if (inW < 1 && outW < 1) return null;
	const h = height - 1;
	return (
		<svg
			className="pointer-events-none absolute top-0 left-0"
			width={width}
			height={h}
			aria-hidden
			data-text-anim-wedges={`${w.in?.frames ?? 0}/${w.out?.frames ?? 0}`}
		>
			{inW >= 1 ? (
				<path
					d={`M0 ${h} L${inW} 0 L0 0 Z`}
					fill="color-mix(in srgb, var(--pr-bg-app) 35%, transparent)"
					stroke="var(--pr-text-strong)"
					strokeOpacity={0.5}
					strokeWidth={1}
				/>
			) : null}
			{outW >= 1 ? (
				<path
					d={`M${width} ${h} L${width - outW} 0 L${width} 0 Z`}
					fill="color-mix(in srgb, var(--pr-bg-app) 35%, transparent)"
					stroke="var(--pr-text-strong)"
					strokeOpacity={0.5}
					strokeWidth={1}
				/>
			) : null}
		</svg>
	);
}
