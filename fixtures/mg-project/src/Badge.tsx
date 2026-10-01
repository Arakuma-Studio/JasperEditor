// A pulsing badge; no schema (JasperEditor infers the form from defaultProps).
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';

export type BadgeProps = { label: string; color: string; size: number; rounded: boolean; tags: string[] };

export const Badge = ({ label, color, size, rounded }: BadgeProps) => {
	const frame = useCurrentFrame();
	const { fps } = useVideoConfig();
	const pulse = 1 + 0.06 * Math.sin((frame / fps) * Math.PI * 2);
	return (
		<AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
			<div
				data-testid="badge"
				style={{
					padding: `${size * 0.25}px ${size * 0.6}px`,
					borderRadius: rounded ? size : 8,
					background: color,
					color: 'white',
					fontFamily: 'sans-serif',
					fontWeight: 800,
					fontSize: size,
					transform: `scale(${pulse})`,
				}}
			>
				{label}
			</div>
		</AbsoluteFill>
	);
};
