// `plate` (§5.1): a backing shape. Pachislop's plate.ts builds these from vector outlines (offset polygons, Andrew's hull, a
// leaning box); here the input is any alpha at any frame, so each is a distance computed on the GPU, written to `tlPlate`:
//   contour  the shape grown, optionally closed: `close` fills counters and gaps up to that radius (a second flood from the
//            grown outline: inside it the closed shape's edge is `close` further in, outside it the field is already right);
//   hull     the convex hull as its support function: the most any block of ink reaches in each of 64 directions. A hull
//            grown by a disc is the same intersection of half-planes with each offset grown, so corners come out round;
//   box      a rounded box around the alpha bounds; pill the same with fully round ends;
//   slant    a box leaning by `skew`, its corners cut straight by `corner`, tight on the ink along the lean.
import { FRAG_TL_FLOOD } from '../glsl.ts';
import type { ShaderPass } from '../../shader.ts';
import {
	fmtDistance,
	layerSwatch,
	lp,
	paintText,
	type PrepassContext,
	type TitleLayerInit,
} from '../contract.ts';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const DEG = Math.PI / 180;

export const PLATE_KINDS = ['contour', 'hull', 'box', 'slant', 'pill'] as const;

/** Texels of the hull's support function, four directions each. */
const HULL_TEXELS = 16;

/** 4 × 4 blocks of ink: their tight boxes (−x0, −y0, x1, y1), every further reduction reads corners of these. */
const BLOCKS_FRAG = /* glsl */ `
void main() {
  ivec2 sz = textureSize(u_source, 0);
  ivec2 base = ivec2(floor(v_uv * u_resolution)) * 4;
  vec4 m = vec4(-1.0e9);
  for (int y = 0; y < 4; y++)
    for (int x = 0; x < 4; x++) {
      ivec2 q = base + ivec2(x, y);
      if (q.x >= sz.x || q.y >= sz.y) continue;
      if (texelFetch(u_source, q, 0).a >= 0.02) m = max(m, vec4(-vec2(q), vec2(q) + 1.0));
    }
  fragColor = m;
}`;

const HULL_FRAG = /* glsl */ `
void main() {
  ivec2 sz = textureSize(u_tlPlateBlocks, 0);
  int i = int(floor(v_uv.x * u_resolution.x)) * 4;
  vec2 d0 = vec2(cos(u_tlpStep * float(i)), sin(u_tlpStep * float(i)));
  vec2 d1 = vec2(cos(u_tlpStep * float(i + 1)), sin(u_tlpStep * float(i + 1)));
  vec2 d2 = vec2(cos(u_tlpStep * float(i + 2)), sin(u_tlpStep * float(i + 2)));
  vec2 d3 = vec2(cos(u_tlpStep * float(i + 3)), sin(u_tlpStep * float(i + 3)));
  vec4 h = vec4(-1.0e9);
  for (int y = 0; y < sz.y; y++)
    for (int x = 0; x < sz.x; x++) {
      vec4 b = texelFetch(u_tlPlateBlocks, ivec2(x, y), 0);
      if (b.x + b.z < -1.0e8) continue;
      // The block's centre and half size: its most in a direction is the centre's plus the half size along it.
      vec2 c = vec2(b.z - b.x, b.w - b.y) * 0.5;
      vec2 e = vec2(b.z + b.x, b.w + b.y) * 0.5;
      h = max(h, vec4(dot(c, d0) + dot(e, abs(d0)), dot(c, d1) + dot(e, abs(d1)), dot(c, d2) + dot(e, abs(d2)), dot(c, d3) + dot(e, abs(d3))));
    }
  fragColor = h;
}`;

const SLANT_FRAG = /* glsl */ `
void main() {
  ivec2 sz = textureSize(u_tlPlateBlocks, 0);
  float k = tan(radians(u_skew));
  vec4 m = vec4(-1.0e9);
  for (int y = 0; y < sz.y; y++)
    for (int x = 0; x < sz.x; x++) {
      vec4 b = texelFetch(u_tlPlateBlocks, ivec2(x, y), 0);
      if (b.x + b.z < -1.0e8) continue;
      // u = x + k·y over the block's box.
      float lo = -b.x + min(k * -b.y, k * b.w);
      float hi = b.z + max(k * -b.y, k * b.w);
      m = max(m, vec4(-lo, b.y, hi, b.w));
    }
  fragColor = m;
}`;

const PLATE_COMMON = /* glsl */ `
float tl_sdBox(vec2 q, vec2 h) { vec2 o = abs(q) - h; return length(max(o, 0.0)) + min(max(o.x, o.y), 0.0); }
`;

const SHAPE: Record<string, string> = {
	contour: /* glsl */ `
float tl_plateAt(TlSurface s, float grow) { return s.d - grow; }`,
	closed: /* glsl */ `
float tl_plateAt(TlSurface s, float grow) {
  float r = tl_px(u_close);
  if (s.d >= r) return s.d - grow;
  vec4 e = texture(u_tlFlood, s.uv);
  float inner = e.w > 0.5 ? length(e.xy - s.px) : 1.0e4;
  return r - inner - grow;
}`,
	hull: /* glsl */ `
float tl_plateAt(TlSurface s, float grow) {
  float d = -1.0e9;
  for (int i = 0; i < ${HULL_TEXELS}; i++) {
    vec4 h = texelFetch(u_tlSupport, ivec2(i, 0), 0);
    for (int k = 0; k < 4; k++) {
      float a = u_tlpStep * float(i * 4 + k);
      d = max(d, dot(s.px, vec2(cos(a), sin(a))) - h[k]);
    }
  }
  return d - grow;
}`,
	box: /* glsl */ `
float tl_plateAt(TlSurface s, float grow) {
  vec4 b = tl_bounds();
  vec2 h = (b.zw - b.xy) * 0.5 + grow;
  float r = min(tl_px(u_corner), min(h.x, h.y));
  return tl_sdBox(s.px - (b.xy + b.zw) * 0.5, h - r) - r;
}`,
	pill: /* glsl */ `
float tl_plateAt(TlSurface s, float grow) {
  vec4 b = tl_bounds();
  vec2 h = (b.zw - b.xy) * 0.5 + grow;
  float r = min(h.x, h.y);
  return tl_sdBox(s.px - (b.xy + b.zw) * 0.5, h - r) - r;
}`,
	slant: /* glsl */ `
float tl_plateAt(TlSurface s, float grow) {
  vec4 m = texelFetch(u_tlSupport, ivec2(0), 0);
  float k = tan(radians(u_skew));
  // Lean coordinate: u = x + k·y is constant along a side (y is down: a positive skew leans right, as italics do).
  float u = s.px.x + k * s.px.y;
  vec2 lean = vec2(-m.x + m.z, -m.y + m.w) * 0.5;
  vec2 half_ = vec2(m.x + m.z, m.y + m.w) * 0.5;
  vec2 o = abs(vec2(u, s.px.y) - lean) - half_;
  o.x *= 1.0 / sqrt(1.0 + k * k);
  o -= grow;
  float d = length(max(o, 0.0)) + min(max(o.x, o.y), 0.0);
  return max(d, (o.x + o.y + tl_px(u_corner)) * 0.7071068);
}`,
};

function platePasses(p: Record<string, unknown>, ctx: PrepassContext): ShaderPass[] {
	const kind = String(p.kind);
	const closed = kind === 'contour' && num(p.close) > 0;
	const out: ShaderPass[] = [];
	const flood = { format: 'rgba32f', filter: 'nearest' } as const;
	if (kind === 'hull' || kind === 'slant') {
		out.push(
			{
				output: 'tlPlateBlocks',
				...flood,
				...ctx.write('tlPlateBlocks'),
				scale: 1 / 4,
				frag: BLOCKS_FRAG,
			},
			{
				output: 'tlSupport',
				...flood,
				...ctx.write('tlSupport'),
				size: { width: kind === 'hull' ? HULL_TEXELS : 1, height: 1 },
				uniforms: { ...ctx.uniforms, u_tlpStep: (Math.PI * 2) / (HULL_TEXELS * 4) },
				frag: `${kind === 'hull' ? HULL_FRAG : SLANT_FRAG}`,
			},
		);
	}
	if (closed) {
		const r = num(p.close) * ctx.pxPerPercent;
		out.push({
			output: 'tlFlood',
			update: true,
			...flood,
			include: ctx.include,
			uniforms: ctx.uniforms,
			frag: /* glsl */ `
void main() {
  TlSurface s = tl_surface();
  float e = s.d - tl_px(u_close);
  if (abs(e) > 1.0 || s.d <= 0.0) { fragColor = vec4(0.0); return; }
  float l = length(s.toEdge);
  fragColor = vec4(s.px + (l > 0.0 ? s.toEdge / l : vec2(0.0)) * e, 1.0, 1.0);
}`,
		});
		const top = 2 ** Math.max(0, Math.ceil(Math.log2(Math.max(2, r + 1))) - 1);
		for (let step = top; step >= 1; step /= 2)
			out.push({
				output: 'tlFlood',
				update: true,
				...flood,
				uniforms: { u_tlStep: step },
				frag: FRAG_TL_FLOOD,
			});
		out.push({
			output: 'tlFlood',
			update: true,
			...flood,
			uniforms: { u_tlStep: 1 },
			frag: FRAG_TL_FLOOD,
		});
	}
	const shape = closed ? SHAPE.closed! : (SHAPE[kind] ?? SHAPE.contour!);
	out.push({
		output: 'tlPlate',
		format: 'rgba16f',
		...ctx.write('tlPlate'),
		include: ctx.include,
		uniforms: { ...ctx.uniforms, u_tlpStep: (Math.PI * 2) / (HULL_TEXELS * 4) },
		frag: `${ctx.defines}${PLATE_COMMON}${shape}
void main() {
  TlSurface s = tl_surface();
  fragColor = vec4(tl_plateAt(s, s.base + tl_px(u_grow)));
}`,
	});
	return out;
}

export const PLATE_LAYER: TitleLayerInit = {
	type: 'plate',
	label: 'Plate',
	description: 'A backing shape behind the title: contour, hull, box, slant or pill.',
	finish: true,
	params: [
		lp.choice('kind', 'Shape', PLATE_KINDS, ['Contour', 'Hull', 'Box', 'Slant', 'Pill'], 'box'),
		lp.distance('grow', 'Grow', 14, { softMax: 80 }),
		lp.distance('corner', 'Corner', 6, { softMax: 50 }),
		lp.number('skew', 'Skew', 12, { min: -60, max: 60, step: 0.1 }, { unit: 'deg' }),
		lp.distance('close', 'Close', 10, { softMax: 60 }),
		...lp.paint('paint', 'Paint', { kind: 'role', role: 'base' }),
		lp.percent('opacity', 'Opacity', 100),
	],
	prepass: platePasses,
	prepassReadsBounds: (p) => p.kind === 'box' || p.kind === 'pill',
	shader: (p) => ({
		glsl: /* glsl */ `
vec4 tl_layer(TlSurface s) {
  float cov = tl_inside(texture(u_tlPlate, s.uv).r, 0.0);
  return tl_finish(tlPaint_paint(s), s) * cov * ${p.kind === 'contour' ? 's.opacity *' : ''} (u_opacity * 0.01);
}`,
	}),
	depth: {
		ring: false,
		glsl: /* glsl */ `
float tl_depth(TlSurface s) { return -texture(u_tlPlate, s.uv).r; }
float tl_bandPx(TlSurface s) { return 0.0; }
`,
	},
	grows: (p) => (p.kind === 'contour' ? num(p.grow) : 0),
	reach(p) {
		const g = num(p.grow);
		// A lean carries the box past the ink by tan(skew) × the height of the ink, at most the layer box's.
		const lean = p.kind === 'slant' ? Math.abs(Math.tan(num(p.skew) * DEG)) : 0;
		return { left: g, top: g, right: g, bottom: g, boxHeight: lean };
	},
	fieldReach: (p) => ({
		outside: p.kind === 'contour' ? num(p.grow) + num(p.close) + 2 : 1,
		// Layers above the plate grow it through `s.base`, and the planner adds the growth to `outside`.
		inside: 1,
	}),
	handles: [
		{ kind: 'distance', params: ['grow'] },
		{ kind: 'distance', params: ['corner'] },
		{ kind: 'angle', params: ['skew'] },
		{ kind: 'angle', params: ['paintAngle'] },
	],
	summary(p) {
		return {
			swatch: layerSwatch(PLATE_LAYER, p),
			text: `${String(p.kind)}, ${fmtDistance(p.grow)}, ${paintText(p.paint)}`,
			primary: 'grow',
		};
	},
};
