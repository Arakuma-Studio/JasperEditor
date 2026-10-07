// Shape layer (M2, S11:SHP-004, wp-m2-shapes): a rectangle or ellipse drawn as inline SVG inside LayerBox, so
// Motion, corner pin, opacity, blend and effects apply like on any layer. Geometry comes from `@remotion/shapes`
// (`makeRect` / `makeEllipse`, 4.0.499); size, paint and radius are evaluated at the content time
// (`evaluateShape`, the shared keyframe evaluator), centred in the layer box.
//
// Stroke position, with the visible width always equal to `width`:
// - center: `stroke-width = width` on the outline;
// - inside: `stroke-width = 2·width`, clipped to the shape (the outer half is cut away);
// - outside: `stroke-width = 2·width`, masked by the shape's complement (the inner half is hidden), so a
//   translucent stroke never darkens the fill. Corners stay square (miter joins, ratio √2 < miter limit 4).
// Inline styles only (ARCHITECTURE D-14).
import { evaluateShape, type ShapeGeometry } from '@jasper/project';
import { makeEllipse, makeRect } from '@remotion/shapes';
import { useId } from 'react';
import { rgbaCss } from '../metadata.ts';
import type { LayerProps } from '../types.ts';
import { LayerBox } from './LayerBox.tsx';
import { VectorShape } from './VectorShape.tsx';

/** SVG path of the geometry with its top-left at (0, 0) (ellipses: see `ellipseOffset`). */
function shapePath(g: Pick<ShapeGeometry, 'type' | 'size' | 'cornerRadius'>): string {
	const [w, h] = g.size;
	return g.type === 'ellipse'
		? makeEllipse({ rx: w / 2, ry: h / 2 }).path
		: makeRect({ width: w, height: h, cornerRadius: g.cornerRadius }).path;
}

/**
 * `makeEllipse` draws one arc from (rx, 0) to (rx + 1, 0), so its centre is (rx + 0.5, ry·√(1 − (0.5/rx)²)), not
 * (rx, ry): half a pixel to the right (and a hair up). This offset moves it back onto the box centre
 * (measured against the analytic reference in apps/engine/test/shapes-remotion.e2e.test.ts). Needs rx ≥ 0.5.
 */
function ellipseOffset(rx: number, ry: number): [number, number] {
	return [-0.5, ry - ry * Math.sqrt(1 - (0.5 / rx) ** 2)];
}

export function ShapeLayer(layer: LayerProps) {
	const uid = `shape-${useId().replace(/[^\w-]/g, '')}`;
	const { box } = layer.props;
	const src = layer.clip.source;
	// wp shapes: vector shapes (groups, paths, paints, operators).
	if ('shape' in src && src.shape.type === 'vector') {
		const m = layer.props.matrix;
		const layerScale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
		const out = layer.options.isPreview ? (layer.options.fxPreviewScale ?? 1) : 1;
		const dpr = typeof window !== 'undefined' && layer.options.isPreview ? window.devicePixelRatio || 1 : 1;
		return (
			<LayerBox layer={layer}>
				<VectorShape
					contents={src.shape.contents}
					contentTime={layer.contentTime}
					box={box}
					resScale={Math.min(8, Math.max(0.25, layerScale * out * dpr))}
					seedKey={layer.clip.clipId}
					localFrame={layer.localFrame}
					uid={uid}
				/>
			</LayerBox>
		);
	}
	const g =
		'shape' in src && src.shape.type !== 'vector' ? evaluateShape(src.shape, layer.contentTime, box) : null;
	const [w, h] = g?.size ?? [0, 0];
	const drawn = !!g && h > 0 && w >= (g.type === 'ellipse' ? 1 : 0) && w > 0;
	return (
		<LayerBox layer={layer}>
			{drawn ? (
				<svg
					data-shape={g.type}
					aria-hidden="true"
					width={box.width}
					height={box.height}
					viewBox={`0 0 ${box.width} ${box.height}`}
					style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}
				>
					<ShapeGraphic g={g} uid={uid} />
				</svg>
			) : null}
		</LayerBox>
	);
}

function ShapeGraphic({ g, uid }: { g: ShapeGeometry; uid: string }) {
	const d = shapePath(g);
	const [w, h] = g.size;
	const s = g.stroke;
	const strokeWidth = s ? (s.position === 'center' ? s.width : s.width * 2) : 0;
	const pad = s ? s.width + 1 : 0;
	const [fx, fy] = g.type === 'ellipse' ? ellipseOffset(w / 2, h / 2) : [0, 0];
	return (
		<g transform={`translate(${g.origin[0] + fx} ${g.origin[1] + fy})`}>
			{s?.position === 'inside' ? (
				<defs>
					<clipPath id={`${uid}-in`}>
						<path d={d} />
					</clipPath>
				</defs>
			) : null}
			{s?.position === 'outside' ? (
				<defs>
					<mask
						id={`${uid}-out`}
						maskUnits="userSpaceOnUse"
						x={-pad}
						y={-pad}
						width={w + 2 * pad}
						height={h + 2 * pad}
					>
						<rect x={-pad} y={-pad} width={w + 2 * pad} height={h + 2 * pad} fill="white" />
						<path d={d} fill="black" />
					</mask>
				</defs>
			) : null}
			{g.fill ? <path data-shape-part="fill" d={d} fill={rgbaCss(g.fill)} /> : null}
			{s ? (
				<path
					data-shape-part="stroke"
					data-stroke-position={s.position}
					d={d}
					fill="none"
					stroke={rgbaCss(s.color)}
					strokeWidth={strokeWidth}
					strokeLinejoin="miter"
					strokeMiterlimit={4}
					clipPath={s.position === 'inside' ? `url(#${uid}-in)` : undefined}
					mask={s.position === 'outside' ? `url(#${uid}-out)` : undefined}
				/>
			) : null}
		</g>
	);
}
