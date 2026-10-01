// Re-evaluate desktop, compact, tablet and phone layouts after resize or orientation changes.
import { useEffect, useState } from 'react';
import { hasCoarsePointer } from '../runtime/platform.ts';

export type LayoutMode = 'desktop' | 'compact' | 'tablet' | 'phone';

export function computeLayoutMode(input: {
	width: number;
	height: number;
	coarse: boolean;
	forced?: LayoutMode | null;
}): LayoutMode {
	if (input.forced) return input.forced;
	const { width, height, coarse } = input;
	if (width < 600 || (coarse && Math.min(width, height) < 500)) return 'phone';
	if ((coarse && width >= 700) || width < 900) return 'tablet';
	if (width < 1280) return 'compact';
	return 'desktop';
}

function measure(forced: LayoutMode | null | undefined): LayoutMode {
	if (typeof window === 'undefined') return 'desktop';
	return computeLayoutMode({
		width: window.innerWidth,
		height: window.innerHeight,
		coarse: hasCoarsePointer(),
		forced,
	});
}

export function useLayoutMode(forced?: LayoutMode | null): LayoutMode {
	const [mode, setMode] = useState<LayoutMode>(() => measure(forced));
	useEffect(() => {
		setMode(measure(forced));
		let t: ReturnType<typeof setTimeout> | null = null;
		const onResize = () => {
			if (t) clearTimeout(t);
			t = setTimeout(() => setMode(measure(forced)), 150);
		};
		window.addEventListener('resize', onResize);
		window.addEventListener('orientationchange', onResize);
		return () => {
			if (t) clearTimeout(t);
			window.removeEventListener('resize', onResize);
			window.removeEventListener('orientationchange', onResize);
		};
	}, [forced]);
	return mode;
}
