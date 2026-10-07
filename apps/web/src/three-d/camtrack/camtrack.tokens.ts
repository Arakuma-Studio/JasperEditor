// 3D Camera Tracker overlay colours (After Effects draws track points as small coloured X marks, the selected ones
// highlighted, the target as a red-and-white bull's-eye). Literal colours live in *.tokens.ts files
// (scripts/check-tokens.mjs).
export const CAMTRACK_COLORS = {
	points: ['#3ddc5a', '#4da6ff', '#ffd23d', '#ff7a3d', '#d26bff', '#3de0d2'] as const,
	selected: '#ffffff',
	target: '#ff3b3b',
	targetInner: '#ffffff',
	casing: 'rgba(0, 0, 0, 0.6)',
} as const;
