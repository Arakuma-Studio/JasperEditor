import { ICONS, type IconId, isCustomGlyph } from './registry.ts';

export type IconProps = {
	id: IconId;
	size?: number;
	className?: string;
	title?: string;
	strokeWidth?: number;
};

/** Renders a registry icon; color comes from `currentColor` (S05:IC-003). */
export function Icon({ id, size = 16, className, title, strokeWidth = 1.5 }: IconProps) {
	const src = ICONS[id];
	if (isCustomGlyph(src)) {
		return (
			// biome-ignore lint/a11y/noSvgWithoutTitle: decorative glyphs are aria-hidden; titled ones render <title>
			<svg
				width={size}
				height={size}
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth={strokeWidth}
				strokeLinecap="round"
				strokeLinejoin="round"
				className={className}
				role={title ? 'img' : undefined}
				aria-hidden={title ? undefined : true}
				data-icon={id}
			>
				{title ? <title>{title}</title> : null}
				{src.paths.map((d) => (
					<path key={d} d={d} />
				))}
			</svg>
		);
	}
	const Lucide = src;
	return (
		<Lucide
			size={size}
			strokeWidth={strokeWidth}
			className={className}
			aria-label={title}
			aria-hidden={title ? undefined : true}
			data-icon={id}
		/>
	);
}
