// Literal colors for monitor overlays that the specs fix exactly (S03:OVL-001/010, XF-010). Kept in a
// `*.tokens.ts` file so the token lint (S05:DT-002) stays meaningful everywhere else.
export const MONITOR_COLORS = {
	/** Safe margins: 1 screen px rgba(255,255,255,.55) (OVL-001). */
	safeMargin: 'rgba(255, 255, 255, 0.55)',
	/** Transparency checkerboard squares (OVL-010). */
	checkerA: '#2b2b2b',
	checkerB: '#3a3a3a',
	/** Handle fill: white squares with an accent border (XF-010). */
	handleFill: '#ffffff',
	/** Dark casing under overlay strokes so they read on bright frames. */
	casing: 'rgba(0, 0, 0, 0.6)',
	/** Letterbox around the frame (the panel background shows through otherwise). */
	letterbox: 'transparent',
} as const;

/** Checkerboard background (8 screen px squares) for the transparency grid. */
export function checkerboard(size = 8): {
	backgroundImage: string;
	backgroundSize: string;
	backgroundColor: string;
	backgroundPosition?: string;
} {
	const c = MONITOR_COLORS.checkerB;
	return {
		backgroundColor: MONITOR_COLORS.checkerA,
		backgroundImage: `linear-gradient(45deg, ${c} 25%, transparent 25%, transparent 75%, ${c} 75%), linear-gradient(45deg, ${c} 25%, transparent 25%, transparent 75%, ${c} 75%)`,
		backgroundSize: `${size * 2}px ${size * 2}px`,
		backgroundPosition: `0 0, ${size}px ${size}px`,
	};
}
