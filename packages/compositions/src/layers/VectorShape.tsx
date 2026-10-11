// Vector shape layers (wp shapes): the After Effects-style contents of a `vector` shape clip — groups, paths,
// solid / gradient fills and strokes, path operators — drawn from the shared render plan (`vectorRenderPlan`). Contents
// sit around the layer box centre (content (0, 0) = box centre = the default anchor). Two renderers draw the same
// plan:
// - SVG (default): every paint and blended group uses a mode CSS draws exactly (`isCssBlend`); `mix-blend-mode`
//   inside an isolated `<svg>`, so paints blend with what is under them in this layer only;
// - canvas compositor: any other mode (Dissolve, Linear Burn, Vivid Light, the stencils…). Each primitive is drawn
//   alone with Canvas 2D (same Chromium rasteriser), then composited with the shared blend kernel
//   (`makeBlendKernel`, as the GL compositor and the native export), groups first composited in their own buffer.
// Shape clips are always rendered by this composition (preview, stills, the Remotion path and the layer bake), so
// preview and export are the same pixels. Inline styles only (ARCHITECTURE D-14).
import {
	type ShapeAffine as Affine,
	dissolveSeed,
	evaluateVectorShape,
	gradientSvgStops,
	isStencilBlend,
	makeBlendKernel,
	type PlanPrimitive,
	planBlendIndex,
	planIsCssExact,
	type ShapeItem,
	type ShapePaint,
	vectorRenderPlan,
} from '@jasper/project';
import { type ReactNode, useLayoutEffect, useMemo, useRef } from 'react';
import { blendModeCss } from '../pipeline.ts';

type Box = { width: number; height: number };

const n = (v: number) => (Number.isFinite(v) ? Math.round(v * 10000) / 10000 : 0);
const matrixAttr = (m: Affine) => `matrix(${m.map(n).join(' ')})`;
const rgb = (c: readonly number[]) =>
	`rgb(${Math.round(Math.min(1, Math.max(0, c[0]!)) * 255)}, ${Math.round(Math.min(1, Math.max(0, c[1]!)) * 255)}, ${Math.round(Math.min(1, Math.max(0, c[2]!)) * 255)})`;

/** Focal point of a radial gradient: Highlight Length (% of the radius) at Highlight Angle from the start→end axis. */
export function radialFocal(p: Exclude<ShapePaint, { type: 'solid' }>): {
	cx: number;
	cy: number;
	r: number;
	fx: number;
	fy: number;
} {
	const dx = p.end[0] - p.start[0];
	const dy = p.end[1] - p.start[1];
	const r = Math.max(1e-6, Math.hypot(dx, dy));
	const hl = Math.max(-0.99, Math.min(0.99, p.highlightLength / 100));
	const a = Math.atan2(dy, dx) + (p.highlightAngle * Math.PI) / 180;
	return {
		cx: p.start[0],
		cy: p.start[1],
		r,
		fx: p.start[0] + r * hl * Math.cos(a),
		fy: p.start[1] + r * hl * Math.sin(a),
	};
}

export type VectorShapeProps = {
	contents: readonly ShapeItem[];
	contentTime: number;
	box: Box;
	/** Device pixels per layer pixel (layer scale × output scale): stroke outline sampling and canvas resolution. */
	resScale: number;
	/** Dissolve seed key (the clip id) and frame. */
	seedKey: string;
	localFrame: number;
	uid: string;
};

export function VectorShape(props: VectorShapeProps) {
	const { contents, contentTime, resScale } = props;
	const plan = useMemo(
		() => vectorRenderPlan(evaluateVectorShape(contents, contentTime), resScale),
		[contents, contentTime, resScale],
	);
	if (!plan.length) return null;
	return planIsCssExact(plan) ? <SvgShape {...props} plan={plan} /> : <CanvasShape {...props} plan={plan} />;
}

type Node =
	| { prim: PlanPrimitive; index: number }
	| { group: { key: string; blend: PlanPrimitive['blend'] }; children: Node[] };

/** Nests consecutive primitives of the same blended group instance. */
function nest(plan: readonly PlanPrimitive[]): Node[] {
	const root: Node[] = [];
	const stack: { key: string; children: Node[] }[] = [];
	plan.forEach((prim, index) => {
		let depth = 0;
		while (
			depth < stack.length &&
			depth < prim.groups.length &&
			stack[depth]!.key === prim.groups[depth]!.key
		)
			depth++;
		stack.length = depth;
		for (let k = depth; k < prim.groups.length; k++) {
			const g = prim.groups[k]!;
			const node: Node = { group: g, children: [] };
			(k === 0 ? root : stack[k - 1]!.children).push(node);
			stack.push({ key: g.key, children: (node as { children: Node[] }).children });
		}
		(prim.groups.length ? stack[prim.groups.length - 1]!.children : root).push({ prim, index });
	});
	return root;
}

function SvgShape({ plan, box, uid }: VectorShapeProps & { plan: PlanPrimitive[] }) {
	const tree = useMemo(() => nest(plan), [plan]);
	const render = (nodes: Node[]): ReactNode[] =>
		nodes.map((node) =>
			'prim' in node ? (
				<SvgPrimitive key={`p${node.index}`} prim={node.prim} id={`${uid}-${node.index}`} />
			) : (
				<g
					key={`g${node.group.key}`}
					style={{ mixBlendMode: blendModeCss(node.group.blend), isolation: 'isolate' }}
				>
					{render(node.children)}
				</g>
			),
		);
	return (
		<svg
			data-shape="vector"
			aria-hidden="true"
			width={box.width}
			height={box.height}
			viewBox={`0 0 ${box.width} ${box.height}`}
			style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', isolation: 'isolate' }}
		>
			<g transform={`translate(${n(box.width / 2)} ${n(box.height / 2)})`}>{render(tree)}</g>
		</svg>
	);
}

function SvgPaintDef({ paint, id }: { paint: ShapePaint; id: string }) {
	if (paint.type === 'solid') return null;
	const stops = gradientSvgStops(paint.gradient).map((s) => (
		<stop key={s.offset} offset={n(s.offset)} stopColor={rgb(s.color)} stopOpacity={n(s.alpha)} />
	));
	if (paint.type === 'linear')
		return (
			<linearGradient
				id={id}
				gradientUnits="userSpaceOnUse"
				x1={n(paint.start[0])}
				y1={n(paint.start[1])}
				x2={n(paint.end[0])}
				y2={n(paint.end[1])}
			>
				{stops}
			</linearGradient>
		);
	const f = radialFocal(paint);
	return (
		<radialGradient
			id={id}
			gradientUnits="userSpaceOnUse"
			cx={n(f.cx)}
			cy={n(f.cy)}
			r={n(f.r)}
			fx={n(f.fx)}
			fy={n(f.fy)}
		>
			{stops}
		</radialGradient>
	);
}

function SvgPrimitive({ prim, id }: { prim: PlanPrimitive; id: string }) {
	const paint = prim.paint;
	const color = paint.type === 'solid' ? rgb(paint.color) : `url(#${id}-paint)`;
	const alpha = paint.type === 'solid' ? Math.min(1, Math.max(0, paint.color[3])) : 1;
	const b = prim.bounds;
	const pad = 2;
	const s = prim.stroke;
	return (
		<g
			data-shape-item={prim.itemId}
			data-shape-part={prim.kind}
			transform={matrixAttr(prim.xf)}
			opacity={n(prim.opacity)}
			style={{ mixBlendMode: blendModeCss(prim.blend) }}
		>
			<defs>
				<SvgPaintDef paint={paint} id={`${id}-paint`} />
				{prim.clip ? (
					<clipPath id={`${id}-clip`}>
						<path d={prim.clip} clipRule="nonzero" />
					</clipPath>
				) : null}
				{prim.cut && b ? (
					<mask
						id={`${id}-cut`}
						maskUnits="userSpaceOnUse"
						x={b.x0 - pad}
						y={b.y0 - pad}
						width={b.x1 - b.x0 + 2 * pad}
						height={b.y1 - b.y0 + 2 * pad}
					>
						<rect
							x={b.x0 - pad}
							y={b.y0 - pad}
							width={b.x1 - b.x0 + 2 * pad}
							height={b.y1 - b.y0 + 2 * pad}
							fill="white"
						/>
						<path d={prim.cut} fill="black" fillRule="nonzero" />
					</mask>
				) : null}
			</defs>
			{s ? (
				<path
					d={prim.d}
					fill="none"
					stroke={color}
					strokeOpacity={alpha}
					strokeWidth={n(s.width)}
					strokeLinecap={s.cap}
					strokeLinejoin={s.join}
					strokeMiterlimit={n(s.miterLimit)}
					strokeDasharray={s.dash ? s.dash.map(n).join(' ') : undefined}
					strokeDashoffset={s.dash ? n(s.dashOffset) : undefined}
					clipPath={prim.clip ? `url(#${id}-clip)` : undefined}
					mask={prim.cut ? `url(#${id}-cut)` : undefined}
				/>
			) : (
				<path
					d={prim.d}
					fill={color}
					fillOpacity={alpha}
					fillRule={prim.fillRule}
					clipPath={prim.clip ? `url(#${id}-clip)` : undefined}
					mask={prim.cut ? `url(#${id}-cut)` : undefined}
				/>
			)}
		</g>
	);
}

const KERNEL = makeBlendKernel();

type Canvas2D = CanvasRenderingContext2D;

/** Paints one primitive with Canvas 2D (the SVG semantics: paint, fill rule, stroke style, clip / cut). */
export function paintPrimitive(ctx: Canvas2D, prim: PlanPrimitive, toDevice: Affine): void {
	const m = compose2(toDevice, prim.xf);
	ctx.save();
	ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
	const p = prim.paint;
	let style: string | CanvasGradient;
	if (p.type === 'solid')
		style = `rgba(${Math.round(p.color[0] * 255)}, ${Math.round(p.color[1] * 255)}, ${Math.round(p.color[2] * 255)}, ${Math.min(1, Math.max(0, p.color[3]))})`;
	else {
		const g =
			p.type === 'linear'
				? ctx.createLinearGradient(p.start[0], p.start[1], p.end[0], p.end[1])
				: (() => {
						const f = radialFocal(p);
						return ctx.createRadialGradient(f.fx, f.fy, 0, f.cx, f.cy, f.r);
					})();
		for (const s of gradientSvgStops(p.gradient))
			g.addColorStop(
				Math.min(1, Math.max(0, s.offset)),
				`rgba(${Math.round(s.color[0] * 255)}, ${Math.round(s.color[1] * 255)}, ${Math.round(s.color[2] * 255)}, ${s.alpha})`,
			);
		style = g;
	}
	if (prim.clip) ctx.clip(new Path2D(prim.clip), 'nonzero');
	ctx.globalAlpha = Math.min(1, Math.max(0, prim.opacity));
	const path = new Path2D(prim.d);
	const s = prim.stroke;
	if (s) {
		ctx.strokeStyle = style;
		ctx.lineWidth = s.width;
		ctx.lineCap = s.cap;
		ctx.lineJoin = s.join;
		ctx.miterLimit = s.miterLimit;
		ctx.setLineDash(s.dash ?? []);
		ctx.lineDashOffset = s.dashOffset;
		ctx.stroke(path);
	} else {
		ctx.fillStyle = style;
		ctx.fill(path, prim.fillRule);
	}
	if (prim.cut) {
		ctx.globalAlpha = 1;
		ctx.globalCompositeOperation = 'destination-out';
		ctx.fillStyle = '#000';
		ctx.fill(new Path2D(prim.cut), 'nonzero');
	}
	ctx.restore();
}

function compose2(m: Affine, k: Affine): Affine {
	return [
		m[0] * k[0] + m[2] * k[1],
		m[1] * k[0] + m[3] * k[1],
		m[0] * k[2] + m[2] * k[3],
		m[1] * k[2] + m[3] * k[3],
		m[0] * k[4] + m[2] * k[5] + m[4],
		m[1] * k[4] + m[3] * k[5] + m[5],
	];
}

/**
 * Composites a plan into premultiplied RGBA (0…1, `w × h` device pixels): each primitive painted alone, then blended
 * onto the buffer below with the shared kernel; blended groups are composited in their own buffer first. The
 * buffer is stored on the 8-bit grid after every layer, like the GL compositor.
 */
export function compositePlan(
	plan: readonly PlanPrimitive[],
	w: number,
	h: number,
	toDevice: Affine,
	scratch: Canvas2D,
	seed: number,
): Float64Array<ArrayBuffer> {
	const stack: { key: string; buf: Float64Array<ArrayBuffer>; blend: PlanPrimitive['blend'] }[] = [];
	let cur = new Float64Array(w * h * 4);
	const d = new Float64Array(4);
	const sp = new Float64Array(4);
	const blendInto = (
		dst: Float64Array,
		src: Float64Array,
		mode: number,
		stencil: boolean,
		x0 = 0,
		y0 = 0,
		x1 = w,
		y1 = h,
	) => {
		for (let y = y0; y < y1; y++)
			for (let x = x0; x < x1; x++) {
				const i = (y * w + x) * 4;
				if (src[i + 3] === 0 && !stencil) continue;
				for (let c = 0; c < 4; c++) {
					d[c] = dst[i + c]!;
					sp[c] = src[i + c]!;
				}
				KERNEL.blend(mode, d, sp, KERNEL.noise(x, y, seed));
				const a = Math.min(1, Math.max(0, d[3]!));
				dst[i + 3] = Math.round(a * 255) / 255;
				for (let c = 0; c < 3; c++) dst[i + c] = Math.round(Math.min(a, Math.max(0, d[c]!)) * 255) / 255;
			}
	};
	const pop = () => {
		const g = stack.pop()!;
		const child = cur;
		cur = g.buf;
		blendInto(cur, child, planBlendIndex(g.blend), isStencilBlend(g.blend));
	};
	for (const prim of plan) {
		let depth = 0;
		while (
			depth < stack.length &&
			depth < prim.groups.length &&
			stack[depth]!.key === prim.groups[depth]!.key
		)
			depth++;
		while (stack.length > depth) pop();
		for (let k = depth; k < prim.groups.length; k++) {
			stack.push({ key: prim.groups[k]!.key, buf: cur, blend: prim.groups[k]!.blend });
			cur = new Float64Array(w * h * 4);
		}
		scratch.setTransform(1, 0, 0, 1, 0, 0);
		scratch.globalCompositeOperation = 'source-over';
		scratch.clearRect(0, 0, w, h);
		paintPrimitive(scratch, prim, toDevice);
		const mode = planBlendIndex(prim.blend);
		const stencil = isStencilBlend(prim.blend);
		// Pixels the primitive can touch (stencil / silhouette modes act on the whole buffer).
		let [x0, y0, x1, y1] = [0, 0, w, h];
		if (!stencil && prim.bounds) {
			const m = compose2(toDevice, prim.xf);
			const b = prim.bounds;
			const pts = [
				[b.x0, b.y0],
				[b.x1, b.y0],
				[b.x1, b.y1],
				[b.x0, b.y1],
			].map(([x, y]) => [m[0] * x! + m[2] * y! + m[4], m[1] * x! + m[3] * y! + m[5]]);
			x0 = Math.max(0, Math.floor(Math.min(...pts.map((q) => q[0]!))) - 1);
			y0 = Math.max(0, Math.floor(Math.min(...pts.map((q) => q[1]!))) - 1);
			x1 = Math.min(w, Math.ceil(Math.max(...pts.map((q) => q[0]!))) + 1);
			y1 = Math.min(h, Math.ceil(Math.max(...pts.map((q) => q[1]!))) + 1);
			if (!(x1 > x0 && y1 > y0)) continue;
		}
		const img = scratch.getImageData(0, 0, w, h).data;
		const src = new Float64Array(w * h * 4);
		for (let y = y0; y < y1; y++)
			for (let x = x0; x < x1; x++) {
				const i = y * w + x;
				const a = img[i * 4 + 3]! / 255;
				src[i * 4] = (img[i * 4]! / 255) * a;
				src[i * 4 + 1] = (img[i * 4 + 1]! / 255) * a;
				src[i * 4 + 2] = (img[i * 4 + 2]! / 255) * a;
				src[i * 4 + 3] = a;
			}
		blendInto(cur, src, mode, stencil, x0, y0, x1, y1);
	}
	while (stack.length) pop();
	return cur;
}

/** Largest canvas side the compositor allocates (device pixels). */
const MAX_SIDE = 8192;

function CanvasShape({
	plan,
	box,
	resScale,
	seedKey,
	localFrame,
}: VectorShapeProps & { plan: PlanPrimitive[] }) {
	const ref = useRef<HTMLCanvasElement>(null);
	const k = Math.min(resScale, MAX_SIDE / Math.max(1, box.width), MAX_SIDE / Math.max(1, box.height));
	const w = Math.max(1, Math.ceil(box.width * k));
	const h = Math.max(1, Math.ceil(box.height * k));
	useLayoutEffect(() => {
		const canvas = ref.current;
		if (!canvas) return;
		const ctx = canvas.getContext('2d');
		const scratchCanvas = document.createElement('canvas');
		scratchCanvas.width = w;
		scratchCanvas.height = h;
		const scratch = scratchCanvas.getContext('2d', { willReadFrequently: true });
		if (!ctx || !scratch) return;
		const toDevice: Affine = [k, 0, 0, k, (box.width / 2) * k, (box.height / 2) * k];
		const buf = compositePlan(plan, w, h, toDevice, scratch, dissolveSeed(seedKey, localFrame));
		const out = ctx.createImageData(w, h);
		for (let i = 0; i < w * h; i++) {
			const a = buf[i * 4 + 3]!;
			out.data[i * 4 + 3] = Math.round(a * 255);
			if (a > 0)
				for (let c = 0; c < 3; c++) out.data[i * 4 + c] = Math.round(Math.min(1, buf[i * 4 + c]! / a) * 255);
		}
		ctx.putImageData(out, 0, 0);
	}, [plan, w, h, k, box.width, box.height, seedKey, localFrame]);
	return (
		<canvas
			ref={ref}
			data-shape="vector"
			data-shape-renderer="canvas"
			width={w}
			height={h}
			style={{ position: 'absolute', left: 0, top: 0, width: box.width, height: box.height }}
		/>
	);
}
