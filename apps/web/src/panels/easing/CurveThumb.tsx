// A small drawing of an ease curve (library tiles, Apply Ease ▸ menu entries).
import type { EaseCurve } from '@jasper/project';
import { curvePath, viewRange } from './geometry.ts';

export function CurveThumb(props: { curve: EaseCurve; size: number; className?: string }) {
	const { lo, hi } = viewRange(props.curve);
	// Same mapping as the editor, without its padding: scale the 14 px editor padding down to the tile.
	const s = props.size;
	const view = { w: s + 28, h: s + 28, lo, hi };
	return (
		<svg
			width={s}
			height={s}
			viewBox={`14 14 ${s} ${s}`}
			className={props.className}
			aria-hidden
			data-testid="ease-thumb"
		>
			<rect x={14} y={14} width={s} height={s} fill="var(--pr-graph-bg)" />
			<path d={curvePath(view, props.curve)} fill="none" stroke="var(--pr-graph-curve)" strokeWidth={1.5} />
		</svg>
	);
}
