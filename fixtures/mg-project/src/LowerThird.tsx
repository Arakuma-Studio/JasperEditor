// A lower third that draws with a font embedded in the bundle (public/fonts/Inter-Bold.ttf, SIL OFL 1.1), used
// by the hybrid text layer tests (S08:MGC-036…039): the name is a text object {text, color, fontSize,
// fontFamily, fontWeight, align}, the role has prefixed style props (roleColor, roleSize), the quote is a
// two-row text with *accent* markup (jasper.mg.json declares its limits, safe box and accent prop). The name
// panel clips (overflow hidden), so a long name is cut off; the quote wraps at 1400 px. Timing derives from
// useVideoConfig().fps.
import { useEffect, useState } from 'react';
import {
	AbsoluteFill,
	cancelRender,
	continueRender,
	delayRender,
	interpolate,
	staticFile,
	useCurrentFrame,
	useVideoConfig,
} from 'remotion';
import type { LowerThirdProps } from './jasper-schemas.ts';

// The embedded face, registered once with the FontFace API; every mount holds the frame until it is loaded.
let interLoaded: Promise<unknown> | null = null;
function loadInter(): Promise<unknown> {
	interLoaded ??= new FontFace('Inter', `url('${staticFile('fonts/Inter-Bold.ttf')}') format('truetype')`, {
		weight: '700',
	})
		.load()
		.then((face) => document.fonts.add(face));
	return interLoaded;
}

export const LowerThird = ({ name, role, roleColor, roleSize, quote, accent }: LowerThirdProps) => {
	const [handle] = useState(() => delayRender('Embedded font Inter Bold'));
	useEffect(() => {
		loadInter().then(
			() => continueRender(handle),
			(err) => cancelRender(err),
		);
	}, [handle]);
	const frame = useCurrentFrame();
	const { fps, height } = useVideoConfig();
	const enter = interpolate(frame / fps, [0, 0.4], [0, 1], {
		extrapolateLeft: 'clamp',
		extrapolateRight: 'clamp',
	});
	return (
		<AbsoluteFill>
			<div
				data-testid="lt-quote"
				style={{
					position: 'absolute',
					left: 96,
					top: 120,
					width: 1400,
					fontFamily: 'Inter, sans-serif',
					fontWeight: 700,
					fontSize: 54,
					lineHeight: 1.25,
					color: 'white',
					whiteSpace: 'pre-line',
					textShadow: '0 4px 18px rgba(0, 0, 0, 0.5)',
					opacity: enter,
				}}
			>
				{/* Accent markup (jasper.mg.json `accent`): *…* spans in the accent colour, asterisks not drawn. */}
				{quote.split('*').map((part, i) =>
					i % 2 === 1 ? (
						// biome-ignore lint/suspicious/noArrayIndexKey: the parts of one string, in order
						<span key={i} data-accent="" style={{ color: accent }}>
							{part}
						</span>
					) : (
						part
					),
				)}
			</div>
			<div
				data-testid="lt-panel"
				style={{
					position: 'absolute',
					left: 96,
					top: height - 420,
					width: 1100,
					height: 300,
					overflow: 'hidden',
					boxSizing: 'border-box',
					padding: '36px 40px',
					background: 'rgba(8, 12, 24, 0.6)',
					borderLeft: `12px solid ${accent}`,
					opacity: enter,
					transform: `translateX(${(1 - enter) * -40}px)`,
				}}
			>
				<div
					data-testid="lt-name"
					style={{
						fontFamily: `${name.fontFamily}, sans-serif`,
						fontWeight: name.fontWeight,
						fontSize: name.fontSize,
						color: name.color,
						textAlign: name.align,
						lineHeight: 1.15,
						whiteSpace: 'nowrap',
					}}
				>
					{name.text}
				</div>
				<div
					data-testid="lt-role"
					style={{
						marginTop: 10,
						fontFamily: 'Inter, sans-serif',
						fontWeight: 700,
						fontSize: roleSize,
						color: roleColor,
						whiteSpace: 'nowrap',
					}}
				>
					{role}
				</div>
			</div>
		</AbsoluteFill>
	);
};
