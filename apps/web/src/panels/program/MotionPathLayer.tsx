// Motion path drawing (S03:OVL-020): every frame of the selected clip as a 2 px dot (spacing encodes speed),
// keys as 7 px squares (filled when selected, dimmed off the clip), Bezier tangent handles (KF-030). Pure
// drawing; the transform overlay hit-tests it (`hitMotionPath`) and turns drags into one session gesture.
import { memo } from 'react';
import { MONITOR_COLORS } from './monitor.tokens.ts';
import { dotsPathData, type MotionPath } from './motion-path.ts';
import { toScreen, type View } from './viewport.ts';

type Props = { path: MotionPath; view: View; selected: ReadonlySet<string> };

export const MotionPathLayer = memo(function MotionPathLayer({ path, view, selected }: Props) {
	const d = dotsPathData(path, view);
	return (
		<g data-testid="overlay-motion-path" data-clip-id={path.clipId} pointerEvents="none">
			<path d={d} stroke={MONITOR_COLORS.casing} strokeWidth={4} strokeLinecap="round" fill="none" />
			<path
				data-testid="motion-path-dots"
				data-count={path.dots.length}
				d={d}
				stroke={MONITOR_COLORS.handleFill}
				strokeWidth={2}
				strokeLinecap="round"
				fill="none"
			/>
			{path.keys.map((k) => {
				const at = toScreen(view, k.pos);
				return (['in', 'out'] as const).map((side) => {
					const h = side === 'in' ? k.inHandle : k.outHandle;
					if (!h) return null;
					const s = toScreen(view, h);
					return (
						<g key={`${k.id}:${side}`} data-tangent={`${k.id}:${side}`} opacity={k.offClip ? 0.5 : 1}>
							<line
								x1={at[0]}
								y1={at[1]}
								x2={s[0]}
								y2={s[1]}
								stroke={MONITOR_COLORS.casing}
								strokeWidth={3}
							/>
							<line x1={at[0]} y1={at[1]} x2={s[0]} y2={s[1]} stroke="var(--pr-accent)" strokeWidth={1} />
							<circle
								cx={s[0]}
								cy={s[1]}
								r={3}
								fill={MONITOR_COLORS.handleFill}
								stroke="var(--pr-accent)"
								strokeWidth={1}
							/>
						</g>
					);
				});
			})}
			{path.keys.map((k) => {
				const at = toScreen(view, k.pos);
				const on = selected.has(k.id);
				return (
					<rect
						key={k.id}
						data-path-key={k.id}
						data-selected={on ? 'true' : undefined}
						x={at[0] - 3.5}
						y={at[1] - 3.5}
						width={7}
						height={7}
						fill={on ? 'var(--pr-keyframe-selected)' : MONITOR_COLORS.casing}
						stroke={on ? 'var(--pr-keyframe-selected-stroke)' : 'var(--pr-keyframe-stroke)'}
						strokeWidth={1}
						opacity={k.offClip ? 0.5 : 1}
					/>
				);
			})}
		</g>
	);
});
