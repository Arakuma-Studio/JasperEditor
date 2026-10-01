// A lower-third style title: a translucent panel (soft shadow → semi-transparent pixels for the alpha tests),
// the headline sliding in after `delay` frames and an accent bar. Timing derives from useVideoConfig().fps.
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import type { TitleProps } from './jasper-schemas.ts';

export const Title = ({ title, accent, delay }: TitleProps) => {
	const frame = useCurrentFrame();
	const { fps, width, height } = useVideoConfig();
	const t = (frame - delay) / fps;
	const enter = interpolate(t, [0, 0.5], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
	const bar = interpolate(t, [0.2, 0.8], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
	return (
		<AbsoluteFill style={{ backgroundColor: 'transparent' }}>
			<div
				data-testid="title-panel"
				style={{
					position: 'absolute',
					left: width * 0.1,
					top: height * 0.62,
					width: width * 0.8,
					height: height * 0.22,
					borderRadius: 24,
					background: 'rgba(10, 20, 40, 0.55)',
					boxShadow: '0 20px 60px rgba(0, 0, 0, 0.45)',
					opacity: enter,
					transform: `translateY(${(1 - enter) * 40}px)`,
					display: 'flex',
					flexDirection: 'column',
					justifyContent: 'center',
					paddingLeft: 60,
					boxSizing: 'border-box',
				}}
			>
				<div
					data-testid="title-text"
					style={{
						color: 'white',
						fontFamily: 'sans-serif',
						fontWeight: 700,
						fontSize: 96,
						lineHeight: 1.1,
						whiteSpace: 'nowrap',
					}}
				>
					{title}
				</div>
				<div
					style={{
						marginTop: 16,
						height: 12,
						width: `${bar * 60}%`,
						borderRadius: 6,
						background: accent,
					}}
				/>
			</div>
		</AbsoluteFill>
	);
};
