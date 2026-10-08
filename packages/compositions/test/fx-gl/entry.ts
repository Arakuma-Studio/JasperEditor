// Browser entry of the fx GL test (bundled with esbuild, run in headless Chrome by ../fx-gl.test.ts): drives the
// real GPU host (src/fx/host.ts) with planned effects and reports pixels. No React, no Remotion chain — the host's
// contract (passes, padding layout, orientation, premultiplied alpha, samples, media textures, LUT, errors).
import '../gl-poison.ts';
import {
	bakeLut,
	defaultEffectRegistry,
	defineShaderEffect,
	type EffectParams,
	type EffectSpec,
	FX_FAMILIES,
	fxBuiltinUniforms,
	fxParam,
	GLSL_LIBRARY,
	GLSL_LUT,
	GLSL_NOISE,
	lutParam,
	planGpuEffect,
} from '@jasper/project';
import { meanGrid } from '@jasper/testkit/image';
import { TRANSFORM } from '../../../project/src/registry/fx/premiere-adjust-color-keying/transform.ts';
import { chainGpuStandIn } from '../../src/fx/builtins.ts';
import { FxShaderError, fxHost, runLutPass, runShaderPlan } from '../../src/fx/host.ts';
import { fxCanvasLayout } from '../../src/fx/plan.ts';
import { TEST_FX } from '../fx-examples.ts';
import { REF_NOISE } from './glsl-reference.ts';

type Px = [number, number, number, number];

function canvas(w: number, h: number, paint?: (ctx: CanvasRenderingContext2D) => void): HTMLCanvasElement {
	const c = document.createElement('canvas');
	c.width = w;
	c.height = h;
	const ctx = c.getContext('2d')!;
	paint?.(ctx);
	return c;
}

const px = (c: HTMLCanvasElement, x: number, y: number): Px =>
	Array.from(c.getContext('2d')!.getImageData(Math.floor(x), Math.floor(y), 1, 1).data) as Px;

const defaults = (spec: EffectSpec, over: Record<string, unknown> = {}) => ({
	...Object.fromEntries(spec.params.map((p) => [p.name, p.default])),
	...over,
});

/**
 * The golden test card painted into a layer box (golden-fuzz fingerprints): a horizontal colour ramp, dark and light
 * bars, a bright disc and a transparent corner — edges, gradients, highlights and alpha for every kind of effect.
 */
function testCard(ctx: CanvasRenderingContext2D, b: { x: number; y: number; w: number; h: number }): void {
	const g = ctx.createLinearGradient(b.x, 0, b.x + b.w, 0);
	g.addColorStop(0, '#1a2a6c');
	g.addColorStop(0.5, '#b21f1f');
	g.addColorStop(1, '#fdbb2d');
	ctx.fillStyle = g;
	ctx.fillRect(b.x, b.y, b.w, b.h);
	ctx.fillStyle = '#000';
	ctx.fillRect(b.x + b.w * 0.15, b.y, b.w * 0.08, b.h);
	ctx.fillStyle = '#fff';
	ctx.fillRect(b.x + b.w * 0.7, b.y, b.w * 0.06, b.h);
	ctx.beginPath();
	ctx.arc(b.x + b.w * 0.45, b.y + b.h * 0.5, b.h * 0.25, 0, Math.PI * 2);
	ctx.fill();
	ctx.clearRect(b.x, b.y, b.w * 0.12, b.h * 0.25);
}

/**
 * Every parameter moved off its default in a deterministic way (numbers to 70 % of their soft / hard range, the
 * next enum option, booleans flipped, colours and points set): the second fingerprint of each effect, so effects that
 * are an identity at their defaults are covered too, and parameter wiring is exercised.
 */
function perturbed(spec: EffectSpec): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const p of spec.params) {
		const d = p.default as unknown;
		if (p.type === 'number' && typeof d === 'number') {
			// A third of the way towards the soft maximum (else the hard one), at most ±max(|default|, 1) without a
			// soft range: visible, but never the extreme sizes that exhaust a software GPU.
			const hi = p.range?.softMax ?? p.range?.max;
			const lo = p.range?.softMin ?? p.range?.min;
			const toward =
				hi !== undefined && hi > d ? hi : lo !== undefined && lo < d ? lo : d + Math.max(Math.abs(d), 1);
			let v = d + (toward - d) / 3;
			if (p.range?.softMax === undefined)
				v = d + Math.sign(v - d) * Math.min(Math.abs(v - d), Math.max(Math.abs(d), 1));
			out[p.name] = p.range?.step === 1 || Number.isInteger(p.range?.step) ? Math.round(v) : v;
		} else if (p.type === 'boolean') out[p.name] = !d;
		else if (p.type === 'enum' && p.options?.length)
			out[p.name] = p.options[(p.options.indexOf(d as string) + 1) % p.options.length];
		else if (p.type === 'color') out[p.name] = [0.9, 0.25, 0.45, 1];
		else if (p.type === 'vec2' && Array.isArray(d)) out[p.name] = (d as number[]).map((v) => v * 0.8 + 0.1);
		else out[p.name] = d;
	}
	return out;
}

/** 4×4 mean-RGB grid of a whole canvas (the testkit fingerprint). */
function fingerprintOf(c: HTMLCanvasElement): number[] {
	const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
	return meanGrid({ width: c.width, height: c.height, data: new Uint8Array(d.buffer) }, 4);
}

/** Runs one effect on a layer of `box` size whose box is painted by `paint` (layer px = canvas px here). */
function run(
	spec: EffectSpec,
	params: Record<string, unknown>,
	box: { width: number; height: number },
	paint: (ctx: CanvasRenderingContext2D, b: { x: number; y: number; w: number; h: number }) => void,
	extra: {
		samples?: HTMLCanvasElement[];
		offsets?: number[];
		textures?: Record<string, unknown>;
		frame?: number;
		paramsAt?: (f: number) => EffectParams;
		samplesKey?: string;
		samplesValid?: number;
	} = {},
) {
	const h = fxHost();
	if (!h) throw new Error('no WebGL2');
	const pad = spec.gpu?.padding?.(params as never, { ...box, pxScale: 1, fps: 30 }) ?? 0;
	const padding =
		typeof pad === 'number'
			? { left: pad, top: pad, right: pad, bottom: pad }
			: { left: 0, top: 0, right: 0, bottom: 0, ...pad };
	const layout = fxCanvasLayout(box, padding, 8192);
	const frame = extra.frame ?? 0;
	const plan = planGpuEffect(
		spec,
		{ id: 'fx1', params: params as never },
		{
			width: box.width,
			height: box.height,
			pxScale: layout.pxScale,
			fps: 30,
			frame,
			duration: 30,
			seed: 0.25,
			progress: 0,
			...(extra.paramsAt ? { paramsAt: extra.paramsAt } : {}),
		},
		{ width: layout.width, height: layout.height },
	);
	const input = canvas(layout.width, layout.height, (ctx) => paint(ctx, layout.box));
	const out = canvas(layout.width, layout.height);
	runShaderPlan(
		h,
		plan,
		input,
		{
			builtins: [
				...fxBuiltinUniforms({
					canvas: layout,
					box: layout.box,
					pxScale: layout.pxScale,
					frame,
					fps: 30,
					duration: 30,
					compSize: { width: 1920, height: 1080 },
				}),
				{ name: 'u_seed', type: 'float', value: [0.25] },
			],
			textures: (extra.textures ?? {}) as never,
			samples: {
				sources: extra.samples ?? [],
				offsets: extra.offsets ?? [],
				...(extra.samplesKey ? { key: extra.samplesKey } : {}),
				...(extra.samplesValid !== undefined ? { valid: extra.samplesValid } : {}),
			},
		},
		out.getContext('2d')!,
	);
	return { out, layout, plan };
}

const halves = (ctx: CanvasRenderingContext2D, b: { x: number; y: number; w: number; h: number }) => {
	ctx.fillStyle = 'rgb(255, 0, 0)';
	ctx.fillRect(b.x, b.y, b.w / 2, b.h);
	ctx.fillStyle = 'rgb(0, 0, 255)';
	ctx.fillRect(b.x + b.w / 2, b.y, b.w / 2, b.h);
};
const fx1 = (frag: string, extra: Partial<Parameters<typeof defineShaderEffect>[0]> = {}) =>
	defineShaderEffect({
		id: 'test.followup',
		label: 'Follow-up',
		category: 'Utility',
		params: [],
		gpu: { passes: [{ frag }] },
		...extra,
	});

const identity = defineShaderEffect({
	id: 'test.identity',
	label: 'Identity',
	category: 'Utility',
	params: [],
	gpu: { passes: [{ frag: 'void main() { fragColor = texture(u_source, v_uv); }' }] },
});

const api = {
	info() {
		const h = fxHost();
		if (!h) return { webgl2: false };
		const dbg = h.gl.getExtension('WEBGL_debug_renderer_info');
		return {
			webgl2: true,
			renderer: String(h.gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : h.gl.RENDERER)),
			floatTargets: h.floatTargets,
		};
	},

	/** Every library chunk in one program (GLSL compilers check unused functions too). */
	library() {
		const spec = defineShaderEffect({
			id: 'test.library',
			label: 'Library',
			category: 'Utility',
			params: [],
			gpu: {
				passes: [
					{
						include: GLSL_LIBRARY,
						frag: /* glsl */ `
void main() {
  vec2 p = fx_layerPx();
  float n = fx_fbm(p * 0.1, 4, 2.0, 0.5, u_seed) + fx_cellular(p * 0.1, 1.0, u_seed).x + fx_turbulence(vec3(p, u_time), 3, 2.0, 0.5, u_seed);
  vec3 c = fx_hsv2rgb(fx_rgb2hsv(vec3(n))) + fx_hsl2rgb(fx_rgb2hsl(vec3(0.5)));
  vec4 b = fx_blend(FX_BLEND_SCREEN, texture(u_source, v_uv), vec4(c, 1.0), 0.5);
  b += fx_sampleEdge(u_source, fx_rotateAround(v_uv, vec2(0.5), 0.3), FX_EDGE_MIRROR) * 0.0;
  b += fx_gaussian1d(u_source, v_uv, vec2(1.0, 0.0), u_texel, 2.0) * 0.0;
  fragColor = fx_finish(b, texture(u_source, v_uv), fx_luma(c), 0.0, FX_SHOW_RESULT);
}`,
					},
				],
			},
		});
		try {
			run(spec, {}, { width: 16, height: 16 }, (ctx) => ctx.fillRect(0, 0, 16, 16));
			return { ok: true };
		} catch (e) {
			return { ok: false, error: (e as Error).message };
		}
	},

	/**
	 * Plans and runs registered GPU effects with default params: one fx family (`FX_FAMILIES[].file`), or without a
	 * family every GPU effect outside the families plus the test effects (one call per family keeps each test short).
	 */
	catalogue(family?: string) {
		const familySpecs = FX_FAMILIES.find((f) => f.file === family)?.effects;
		const inFamily = new Set(FX_FAMILIES.flatMap((f) => f.effects.map((e) => e.id)));
		const specs = familySpecs
			? familySpecs.filter((s) => s.gpu)
			: [...defaultEffectRegistry.list().filter((s) => s.gpu && !inFamily.has(s.id)), ...TEST_FX];
		const errors: string[] = [];
		for (const spec of specs) {
			try {
				run(spec, defaults(spec), { width: 64, height: 36 }, (ctx, b) => {
					ctx.fillStyle = '#c84';
					ctx.fillRect(b.x, b.y, b.w, b.h);
				});
			} catch (e) {
				errors.push(`${spec.id}: ${(e as Error).message}`);
			}
		}
		return { count: specs.length, errors };
	},

	/**
	 * Fingerprints (4×4 mean RGB) of every GPU effect of a family at its defaults on the golden test card, frame 12:
	 * compared with goldens/fx-fingerprints.json by fx-gl.test.ts (JASPER_BLESS=1 re-blesses). Effects that fail to
	 * run are left out here (`catalogue` reports them).
	 */
	fingerprints(family?: string) {
		const familySpecs = FX_FAMILIES.find((f) => f.file === family)?.effects;
		const inFamily = new Set(FX_FAMILIES.flatMap((f) => f.effects.map((e) => e.id)));
		const specs = familySpecs
			? familySpecs.filter((s) => s.gpu)
			: [...defaultEffectRegistry.list().filter((s) => s.gpu && !inFamily.has(s.id)), ...TEST_FX];
		const out: Record<string, number[]> = {};
		for (const spec of specs) {
			try {
				out[spec.id] = fingerprintOf(
					run(spec, defaults(spec), { width: 64, height: 36 }, testCard, { frame: 12 }).out,
				);
			} catch {
				// reported by `catalogue`
			}
			try {
				out[`${spec.id}@perturbed`] = fingerprintOf(
					run(spec, perturbed(spec), { width: 64, height: 36 }, testCard, { frame: 12 }).out,
				);
				if (fxHost()?.gl.isContextLost()) throw new Error('the WebGL context was lost');
			} catch (e) {
				// Failing at other settings is a bug: recorded as NaNs, which no golden accepts.
				out[`${spec.id}@perturbed`] = new Array(48).fill(Number.NaN);
				console.error(`${spec.id} @perturbed: ${(e as Error).message}`);
			}
		}
		return out;
	},

	orientation() {
		const { out } = run(identity, {}, { width: 4, height: 4 }, (ctx) => {
			ctx.fillStyle = 'rgb(255, 0, 0)';
			ctx.fillRect(0, 0, 4, 2);
			ctx.fillStyle = 'rgb(0, 0, 255)';
			ctx.fillRect(0, 2, 4, 2);
		});
		return { top: px(out, 1, 0), bottom: px(out, 1, 3) };
	},

	alpha() {
		const { out } = run(identity, {}, { width: 2, height: 2 }, (ctx) => {
			ctx.fillStyle = 'rgba(255, 0, 0, 0.5)';
			ctx.fillRect(0, 0, 2, 2);
		});
		return { pixel: px(out, 0, 0) };
	},

	glow() {
		const spec = TEST_FX.find((s) => s.id === 'test.s.glow')!;
		const { out, layout, plan } = run(
			spec,
			defaults(spec, { radius: 4, threshold: 10 }),
			{ width: 20, height: 20 },
			(ctx, b) => {
				ctx.fillStyle = '#fff';
				ctx.fillRect(b.x + 5, b.y + 5, 10, 10);
			},
		);
		const b = layout.box;
		return {
			canvas: [layout.width, layout.height],
			box: [b.x, b.y, b.w, b.h],
			centre: px(out, b.x + 10, b.y + 10),
			nearOutside: px(out, b.x - 2, b.y + 10),
			farCorner: px(out, 0, 0),
			passes: plan.passes.map((p) => [p.output, p.width, p.height]),
		};
	},

	gradient() {
		const spec = TEST_FX.find((s) => s.id === 'test.s.gradient')!;
		const { out } = run(spec, defaults(spec), { width: 100, height: 4 }, () => {});
		return { left: px(out, 0, 1), mid: px(out, 50, 1), right: px(out, 99, 1) };
	},

	shadow() {
		const spec = TEST_FX.find((s) => s.id === 'test.drop-shadow')!;
		const { out, layout } = run(
			spec,
			defaults(spec, { direction: 0, distance: 6, softness: 0, opacity: 50 }),
			{ width: 20, height: 20 },
			(ctx, b) => {
				ctx.fillStyle = '#fff';
				ctx.fillRect(b.x, b.y, b.w, b.h);
			},
		);
		const b = layout.box;
		return {
			canvas: [layout.width, layout.height],
			right: px(out, b.x + b.w + 3, b.y + 10),
			left: px(out, b.x - 3, b.y + 10),
			inside: px(out, b.x + 10, b.y + 10),
		};
	},

	samples() {
		const spec = TEST_FX.find((s) => s.id === 'test.s.trails')!;
		const sample = (color: string) =>
			canvas(8, 8, (ctx) => {
				ctx.fillStyle = color;
				ctx.fillRect(4, 0, 4, 8);
			});
		const { out } = run(
			spec,
			defaults(spec, { count: 2, decay: 1 }),
			{ width: 8, height: 8 },
			(ctx) => {
				ctx.fillStyle = '#f00';
				ctx.fillRect(0, 0, 4, 8);
			},
			{ samples: [sample('#0f0'), sample('#00f')], offsets: [-1, -2] },
		);
		return { source: px(out, 1, 4), sample: px(out, 6, 4) };
	},

	media() {
		const spec = defineShaderEffect({
			id: 'test.media',
			label: 'Media',
			category: 'Utility',
			params: [fxParam.media('map', 'Map')],
			gpu: {
				passes: [
					{
						frag: 'void main() { fragColor = u_map_size.x > 0.0 ? texture(u_map, v_uv) : vec4(1.0, 0.0, 1.0, 1.0); }',
					},
				],
			},
		});
		const map = canvas(3, 2, (ctx) => {
			ctx.fillStyle = 'rgb(0, 200, 100)';
			ctx.fillRect(0, 0, 3, 2);
		});
		const bound = run(spec, { map: { mediaId: 'm1' } }, { width: 4, height: 4 }, () => {}, {
			textures: { u_map: { source: map, width: 3, height: 2, version: '1' } },
		}).out;
		const missing = run(spec, { map: { mediaId: '' } }, { width: 4, height: 4 }, () => {}, {
			textures: { u_map: null },
		}).out;
		return { bound: px(bound, 1, 1), missing: px(missing, 1, 1) };
	},

	lut() {
		const h = fxHost()!;
		const lut = bakeLut(5, (c) => {
			c[0] = 1 - c[0];
			c[1] = 1 - c[1];
			c[2] = 1 - c[2];
		});
		const input = canvas(2, 2, (ctx) => {
			ctx.fillStyle = 'rgb(255, 64, 0)';
			ctx.fillRect(0, 0, 2, 2);
		});
		const out = canvas(2, 2);
		runLutPass(h, lut, 'invert', input, out.getContext('2d')!, 2, 2);
		return { pixel: px(out, 0, 0) };
	},

	error() {
		const broken = defineShaderEffect({
			id: 'test.broken',
			label: 'Broken',
			category: 'Utility',
			params: [],
			gpu: { passes: [{ frag: 'void main() { fragColor = undefinedThing; }' }] },
		});
		try {
			run(broken, {}, { width: 2, height: 2 }, () => {});
			return { thrown: false };
		} catch (e) {
			return { thrown: e instanceof FxShaderError, message: (e as Error).message };
		}
	},

	halfFloat() {
		const spec = defineShaderEffect({
			id: 'test.hdr',
			label: 'HDR',
			category: 'Utility',
			params: [],
			gpu: {
				passes: [
					{
						output: 'hdr',
						format: 'rgba16f',
						frag: 'void main() { fragColor = texture(u_source, v_uv) * 4.0; }',
					},
					{ frag: 'void main() { fragColor = texture(u_hdr, v_uv) * 0.25; }' },
				],
			},
		});
		const { out } = run(spec, {}, { width: 2, height: 2 }, (ctx) => {
			ctx.fillStyle = 'rgb(200, 100, 40)';
			ctx.fillRect(0, 0, 2, 2);
		});
		return { pixel: px(out, 0, 0) };
	},
};

/** The framework follow-ups in real WebGL2 (ping-pong, absolute sizes, mipmaps, ivec2, LUT textures, bindings…). */
const followups = {
	/**
	 * The library hash/noise helpers return bit-identical values to their wave-1 sources (REF_NOISE): one bit per
	 * function (r: hashes, g: 2D noises, b: 3D noises + fractal sums + cellular), over a grid of negative and positive
	 * lattice positions, several scales and seeds. Returns the number of pixels where any function differs.
	 */
	libraryIdentical() {
		const spec = defineShaderEffect({
			id: 'test.library-identical',
			label: 'Library identical',
			category: 'Utility',
			params: [fxParam.number('oct', 'Octaves', 5, { min: 0, max: 12 })],
			gpu: {
				passes: [
					{
						include: [GLSL_NOISE, REF_NOISE],
						frag: /* glsl */ `
bool eq(float a, float b) { return a == b; }
bool eq2(vec2 a, vec2 b) { return all(equal(a, b)); }
bool eq3(vec3 a, vec3 b) { return all(equal(a, b)); }
void main() {
  vec2 px = fx_canvasPx() - vec2(37.0, 21.0);
  bool h = true, n2 = true, n3 = true;
  for (int k = 0; k < 4; k++) {
    float seed = fract(u_seed + float(k) * 0.37);
    float sc = 0.07 + float(k) * 0.61;
    vec2 p = px * sc + vec2(float(k) * -13.7, float(k) * 5.3);
    vec3 q = vec3(p, float(k) * 2.9 - 4.1 + px.y * 0.013);
    ivec2 ip = ivec2(floor(p));
    ivec3 iq = ivec3(floor(q));
    int o = int(u_oct) + k;
    h = h && eq(fx_hash1(ip.x, seed), ref_hash1(ip.x, seed)) && eq(fx_hash2(ip, seed), ref_hash2(ip, seed))
          && eq(fx_hash3(iq, seed), ref_hash3(iq, seed)) && eq2(fx_hash22(ip, seed), ref_hash22(ip, seed))
          && eq3(fx_hash33(iq, seed), ref_hash33(iq, seed)) && eq(fx_random(p, float(k) - 2.0, seed), ref_random(p, float(k) - 2.0, seed));
    n2 = n2 && eq(fx_valueNoise(p, seed), ref_valueNoise(p, seed)) && eq(fx_gradientNoise(p, seed), ref_gradientNoise(p, seed))
            && eq(fx_simplex(p, seed), ref_simplex(p, seed)) && eq(fx_fbm(p, o, 2.0, 0.5, seed), ref_fbm(p, o, 2.0, 0.5, seed))
            && eq(fx_fbm(p, 3, 1.9, 0.55, seed), ref_fbm(p, 3, 1.9, 0.55, seed))
            && eq2(fx_cellular(p, 0.8, seed), ref_cellular(p, 0.8, seed)) && eq(fx_cellId(p, 1.0, seed), ref_cellId(p, 1.0, seed));
    n3 = n3 && eq(fx_valueNoise3(q, seed), ref_valueNoise3(q, seed)) && eq(fx_simplex3(q, seed), ref_simplex3(q, seed))
            && eq(fx_fbm3(q, o, 2.0, 0.5, seed), ref_fbm3(q, o, 2.0, 0.5, seed))
            && eq(fx_turbulence(q, o, 2.0, 0.5, seed), ref_turbulence(q, o, 2.0, 0.5, seed))
            && eq(fx_ridged(q, o, 2.0, 0.5, seed), ref_ridged(q, o, 2.0, 0.5, seed));
  }
  fragColor = vec4(h ? 1.0 : 0.0, n2 ? 1.0 : 0.0, n3 ? 1.0 : 0.0, 1.0);
}`,
					},
				],
			},
		});
		const { out } = run(spec, { oct: 5 }, { width: 64, height: 64 }, () => {});
		const d = out.getContext('2d')!.getImageData(0, 0, 64, 64).data;
		const bad = [0, 0, 0];
		for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) if (d[i + c]! < 255) bad[c]!++;
		return { hashes: bad[0], noise2d: bad[1], noise3d: bad[2] };
	},
	pingPong() {
		const iter = {
			output: 'acc',
			update: true,
			frag: 'void main() { fragColor = texture(u_acc, v_uv) + vec4(0.1); }',
		};
		const spec = fx1('', {
			gpu: {
				passes: [
					{ output: 'acc', format: 'rgba16f', frag: 'void main() { fragColor = vec4(0.1); }' },
					iter,
					iter,
					iter,
					{ frag: 'void main() { fragColor = texture(u_acc, v_uv); }' },
				],
			},
		});
		return px(run(spec, {}, { width: 4, height: 4 }, () => {}).out, 1, 1);
	},
	absoluteSize() {
		const spec = fx1('', {
			gpu: {
				passes: [
					{
						output: 'one',
						size: { width: 1, height: 1 },
						frag: 'void main() { fragColor = texture(u_source, vec2(0.25, 0.5)); }',
					},
					{ frag: 'void main() { fragColor = texture(u_one, v_uv); }' },
				],
			},
		});
		const { out, plan } = run(spec, {}, { width: 8, height: 4 }, halves);
		return {
			left: px(out, 1, 1),
			right: px(out, 6, 1),
			size: [plan.passes[0]!.width, plan.passes[0]!.height],
		};
	},
	mipmaps() {
		const out = run(
			fx1('', {
				gpu: {
					passes: [
						{ output: 'm', mipmaps: true, frag: 'void main() { fragColor = texture(u_source, v_uv); }' },
						{ frag: 'void main() { fragColor = textureLod(u_m, v_uv, 10.0); }' },
					],
				},
			}),
			{},
			{ width: 16, height: 16 },
			halves,
		).out;
		const src = run(
			fx1('void main() { fragColor = textureLod(u_source, v_uv, 10.0); }', {
				gpu: {
					sourceMipmaps: true,
					passes: [{ frag: 'void main() { fragColor = textureLod(u_source, v_uv, 10.0); }' }],
				},
			}),
			{},
			{ width: 16, height: 16 },
			halves,
		).out;
		return { output: px(out, 2, 2), source: px(src, 2, 2) };
	},
	ivec2() {
		const spec = fx1('', {
			gpu: {
				uniforms: () => ({ u_iv: { ivec2: [51, 102] } }),
				passes: [
					{
						frag: 'void main() { fragColor = vec4(float(u_iv.x) / 255.0, float(u_iv.y) / 255.0, 0.0, 1.0); }',
					},
				],
			},
		});
		return px(run(spec, {}, { width: 2, height: 2 }, () => {}).out, 0, 0);
	},
	lut3d() {
		const spec = fx1('', {
			params: [lutParam('look', 'Look')],
			gpu: {
				passes: [
					{
						include: [GLSL_LUT],
						frag: 'void main() { vec4 c = texture(u_source, v_uv); fragColor = vec4(fx_lut3d(u_look, u_look_size, c.rgb), 1.0); }',
					},
				],
			},
		});
		const invert = bakeLut(17, (c) => {
			c[0] = 1 - c[0];
			c[1] = 1 - c[1];
			c[2] = 1 - c[2];
		});
		const paint = (ctx: CanvasRenderingContext2D) => {
			ctx.fillStyle = 'rgb(255, 64, 0)';
			ctx.fillRect(0, 0, 4, 4);
		};
		const bound = run(spec, { look: { mediaId: 'l1' } }, { width: 4, height: 4 }, paint, {
			textures: { u_look: { lut: invert, version: 'inv' } },
		}).out;
		const none = run(spec, { look: { mediaId: '' } }, { width: 4, height: 4 }, paint, {
			textures: { u_look: null },
		}).out;
		return { bound: px(bound, 1, 1), none: px(none, 1, 1) };
	},
	/** u_sampleCount / u_sampleValid in a pass that never samples (the sampler array is not active there). */
	sampleBindings() {
		const spec = fx1(
			'void main() { fragColor = vec4(float(u_sampleCount) / 8.0, float(u_sampleValid) / 255.0, u_sampleOffsets[1] / -8.0, 1.0); }',
		);
		const pic = canvas(4, 4);
		return px(
			run(spec, {}, { width: 4, height: 4 }, () => {}, {
				samples: [pic, pic],
				offsets: [-1, -4],
				samplesValid: 1,
			}).out,
			1,
			1,
		);
	},
	/** Samples are uploaded once per key: a second effect with the same key reads the first upload. */
	samplesOnce() {
		const spec = fx1('void main() { fragColor = fx_sample(0, v_uv); }');
		const red = canvas(4, 4, (c) => {
			c.fillStyle = '#f00';
			c.fillRect(0, 0, 4, 4);
		});
		const green = canvas(4, 4, (c) => {
			c.fillStyle = '#0f0';
			c.fillRect(0, 0, 4, 4);
		});
		const a = run(spec, {}, { width: 4, height: 4 }, () => {}, {
			samples: [red],
			offsets: [-1],
			samplesKey: 'k1',
		}).out;
		const b = run(spec, {}, { width: 4, height: 4 }, () => {}, {
			samples: [green],
			offsets: [-1],
			samplesKey: 'k1',
		}).out;
		const c = run(spec, {}, { width: 4, height: 4 }, () => {}, {
			samples: [green],
			offsets: [-1],
			samplesKey: 'k2',
		}).out;
		return { first: px(a, 1, 1), sameKey: px(b, 1, 1), newKey: px(c, 1, 1) };
	},
	/** The SVG-only Gaussian Blur (one direction) as the chain's GPU stand-in. */
	blurStandIn() {
		const builtin = defaultEffectRegistry.get('jasper.gaussian-blur')!;
		const params = { radius: 3, dimensions: 'vertical', repeatEdge: false };
		const spec = chainGpuStandIn(builtin, params)!;
		const { out, layout } = run(spec, params, { width: 21, height: 21 }, (ctx, b) => {
			ctx.fillStyle = '#fff';
			ctx.fillRect(b.x, b.y + 10, b.w, 1); // a horizontal line
		});
		const b = layout.box;
		return {
			onLine: px(out, b.x + 10, b.y + 10),
			above: px(out, b.x + 10, b.y + 8),
			padding: layout.padding.top,
			equalSigmas: chainGpuStandIn(builtin, { radius: 3, dimensions: 'both', repeatEdge: false }) === null,
		};
	},
	/** Transform with a Shutter Angle and a moving position (paramsAt): the edge is smeared. */
	transformBlur() {
		const d = Object.fromEntries(TRANSFORM.params.map((p) => [p.name, p.default])) as EffectParams;
		const p = { ...d, useCompShutterAngle: false, shutterAngle: 360 };
		const at = (f: number) => ({ ...p, position: [0.5 + (f - 5) * 0.25, 0.5] as [number, number] });
		const paint = (ctx: CanvasRenderingContext2D) => {
			ctx.fillStyle = '#fff';
			ctx.fillRect(0, 0, 20, 20);
		};
		const sharp = run(TRANSFORM, d, { width: 20, height: 20 }, paint, { frame: 5 }).out;
		const blurred = run(TRANSFORM, at(5), { width: 20, height: 20 }, paint, { frame: 5, paramsAt: at }).out;
		return { sharpEdge: px(sharp, 1, 10), blurredEdge: px(blurred, 1, 10), blurredMid: px(blurred, 10, 10) };
	},
};

(window as unknown as { __fx: typeof api }).__fx = { ...api, ...followups };
