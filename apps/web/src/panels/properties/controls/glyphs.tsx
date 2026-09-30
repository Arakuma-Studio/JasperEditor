// Small inspector glyphs drawn on a 12/16-unit grid with currentColor (S05:IC-003 style). Kept local
// because the shared icon registry (WP-2A) has no stopwatch/keyframe/reset glyphs yet.
import type { SVGProps } from 'react';

type GlyphProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 14, children, ...rest }: GlyphProps) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.3}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden
			{...rest}
		>
			{children}
		</svg>
	);
}

export const StopwatchGlyph = (p: GlyphProps) => (
	<Svg {...p}>
		<circle cx="8" cy="9" r="5.2" />
		<path d="M8 9V6.2M6.5 1.8h3M8 1.8v2" />
	</Svg>
);
export const DiamondGlyph = ({ filled, ...p }: GlyphProps & { filled?: boolean }) => (
	<Svg {...p}>
		<path d="M8 2.5 13.5 8 8 13.5 2.5 8Z" fill={filled ? 'currentColor' : 'none'} />
	</Svg>
);
export const PrevGlyph = (p: GlyphProps) => (
	<Svg {...p}>
		<path d="M10.5 3.5 5.5 8l5 4.5Z" fill="currentColor" />
	</Svg>
);
export const NextGlyph = (p: GlyphProps) => (
	<Svg {...p}>
		<path d="M5.5 3.5 10.5 8l-5 4.5Z" fill="currentColor" />
	</Svg>
);
export const ResetGlyph = (p: GlyphProps) => (
	<Svg {...p}>
		<path d="M3.5 8a4.5 4.5 0 1 0 1.4-3.3" />
		<path d="M3.2 2.6v2.6h2.6" />
	</Svg>
);
export const CaretGlyph = ({ open, ...p }: GlyphProps & { open?: boolean }) => (
	<Svg {...p}>
		<path d={open ? 'M4 6l4 4 4-4' : 'M6 4l4 4-4 4'} />
	</Svg>
);
export const FxGlyph = ({ off, ...p }: GlyphProps & { off?: boolean }) => (
	<Svg {...p}>
		<path d="M3 13c2 0 2-2 2.6-5.5S7 3 9 3M3.5 7.5h4.5M9 8l4 5M13 8l-4 5" />
		{off ? <path d="M2 2l12 12" /> : null}
	</Svg>
);
export const TrashGlyph = (p: GlyphProps) => (
	<Svg {...p}>
		<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5" />
	</Svg>
);
export const GripGlyph = (p: GlyphProps) => (
	<Svg {...p}>
		<path d="M6 4h.01M10 4h.01M6 8h.01M10 8h.01M6 12h.01M10 12h.01" strokeWidth={2} />
	</Svg>
);
export const SparkleGlyph = (p: GlyphProps) => (
	<Svg {...p}>
		<path d="M8 1.5 9.4 6.6 14.5 8 9.4 9.4 8 14.5 6.6 9.4 1.5 8 6.6 6.6Z" fill="currentColor" stroke="none" />
	</Svg>
);
export const EditGlyph = (p: GlyphProps) => (
	<Svg {...p}>
		<path d="M3 13l1-3.5L10.5 3 13 5.5 6.5 12Z" />
	</Svg>
);
export const SwapGlyph = (p: GlyphProps) => (
	<Svg {...p}>
		<path d="M4 5h8l-2-2M12 11H4l2 2" />
	</Svg>
);
