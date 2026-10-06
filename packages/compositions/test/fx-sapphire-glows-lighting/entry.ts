// Browser entry of the Sapphire Glows + Lighting GL test (bundled with esbuild, run in headless Chrome by
// ../fx-sapphire-glows-lighting-gl.test.ts): runs the family's effects on the real GPU host (src/fx/host.ts) over
// painted test scenes and reports pixels, PNGs (visual review) and a contact sheet.
import { type EffectSpec, FX_FAMILIES, fxBuiltinUniforms, planGpuEffect } from '@jasper/project';
import { fxHost, runShaderPlan } from '../../src/fx/host.ts';
import { fxCanvasLayout } from '../../src/fx/plan.ts';

type Px = [number, number, number, number];
type Box = { x: number; y: number; w: number; h: number };

const FAMILY = FX_FAMILIES.find((f) => f.file === 'sapphire-glows-lighting')!.effects;

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

// ---------------------------------------------------------------- test scenes (deterministic)

/** A night street: dark sky, a moon, lit windows, street lamps, coloured neon and white title text. */
function paintNight(ctx: CanvasRenderingContext2D, b: Box) {
	const { x, y, w, h } = b;
	const sky = ctx.createLinearGradient(0, y, 0, y + h);
	sky.addColorStop(0, '#0b1030');
	sky.addColorStop(0.6, '#2a1840');
	sky.addColorStop(1, '#120c18');
	ctx.fillStyle = sky;
	ctx.fillRect(x, y, w, h);
	// moon
	ctx.fillStyle = '#fffbe8';
	ctx.beginPath();
	ctx.arc(x + w * 0.78, y + h * 0.2, h * 0.07, 0, Math.PI * 2);
	ctx.fill();
	// buildings with windows
	const bld = [
		[0.02, 0.45, 0.16],
		[0.2, 0.32, 0.14],
		[0.36, 0.5, 0.18],
		[0.58, 0.4, 0.12],
		[0.86, 0.55, 0.14],
	];
	let k = 0;
	for (const [bx, top, bw] of bld) {
		ctx.fillStyle = '#1a1a26';
		ctx.fillRect(x + w * bx!, y + h * top!, w * bw!, h * (1 - top!));
		for (let wy = top! + 0.04; wy < 0.85; wy += 0.07)
			for (let wx = bx! + 0.015; wx < bx! + bw! - 0.02; wx += 0.035) {
				k = (k * 1103515245 + 12345) & 0x7fffffff;
				if (k % 3 === 0) continue;
				ctx.fillStyle = k % 5 === 0 ? '#9fd8ff' : '#ffd27a';
				ctx.fillRect(x + w * wx, y + h * wy, w * 0.016, h * 0.03);
			}
	}
	// street lamps
	for (const lx of [0.12, 0.5, 0.72]) {
		ctx.fillStyle = '#333';
		ctx.fillRect(x + w * lx - 1, y + h * 0.62, 3, h * 0.38);
		ctx.fillStyle = '#ffffff';
		ctx.beginPath();
		ctx.arc(x + w * lx, y + h * 0.62, h * 0.018, 0, Math.PI * 2);
		ctx.fill();
	}
	// neon sign
	ctx.strokeStyle = '#ff2fa8';
	ctx.lineWidth = Math.max(2, h * 0.012);
	ctx.strokeRect(x + w * 0.38, y + h * 0.56, w * 0.14, h * 0.08);
	ctx.strokeStyle = '#22e4ff';
	ctx.beginPath();
	ctx.moveTo(x + w * 0.6, y + h * 0.7);
	ctx.lineTo(x + w * 0.68, y + h * 0.62);
	ctx.lineTo(x + w * 0.68, y + h * 0.76);
	ctx.stroke();
	// title
	ctx.fillStyle = '#ffffff';
	ctx.font = `bold ${Math.round(h * 0.14)}px sans-serif`;
	ctx.textBaseline = 'alphabetic';
	ctx.fillText('JASPER', x + w * 0.05, y + h * 0.93);
	// colour bar
	const bar = ctx.createLinearGradient(x + w * 0.62, 0, x + w * 0.98, 0);
	for (const [i, c] of ['#f00', '#ff0', '#0f0', '#0ff', '#00f', '#f0f'].entries()) bar.addColorStop(i / 5, c);
	ctx.fillStyle = bar;
	ctx.fillRect(x + w * 0.62, y + h * 0.88, w * 0.36, h * 0.05);
}

/** A white logo on transparency (alpha tests: drop shadow, edges). */
function paintLogo(ctx: CanvasRenderingContext2D, b: Box) {
	const { x, y, w, h } = b;
	ctx.fillStyle = '#ffffff';
	ctx.font = `bold ${Math.round(h * 0.3)}px sans-serif`;
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.fillText('JASPER', x + w / 2, y + h * 0.42);
	ctx.fillStyle = '#ffb000';
	ctx.beginPath();
	ctx.arc(x + w / 2, y + h * 0.78, h * 0.08, 0, Math.PI * 2);
	ctx.fill();
}

/** Daylight-ish: a sky gradient, green hills, a bright sun (lighting effects on mid tones). */
function paintDay(ctx: CanvasRenderingContext2D, b: Box) {
	const { x, y, w, h } = b;
	const sky = ctx.createLinearGradient(0, y, 0, y + h);
	sky.addColorStop(0, '#3a78c8');
	sky.addColorStop(0.6, '#a8d0f0');
	ctx.fillStyle = sky;
	ctx.fillRect(x, y, w, h);
	ctx.fillStyle = '#fff6d0';
	ctx.beginPath();
	ctx.arc(x + w * 0.3, y + h * 0.25, h * 0.06, 0, Math.PI * 2);
	ctx.fill();
	ctx.fillStyle = '#3f8a3a';
	ctx.beginPath();
	ctx.moveTo(x, y + h * 0.7);
	ctx.quadraticCurveTo(x + w * 0.3, y + h * 0.5, x + w * 0.6, y + h * 0.68);
	ctx.quadraticCurveTo(x + w * 0.85, y + h * 0.8, x + w, y + h * 0.62);
	ctx.lineTo(x + w, y + h);
	ctx.lineTo(x, y + h);
	ctx.fill();
	ctx.fillStyle = '#c23b22';
	ctx.fillRect(x + w * 0.62, y + h * 0.55, w * 0.12, h * 0.18);
	ctx.fillStyle = '#ffffff';
	ctx.font = `bold ${Math.round(h * 0.12)}px sans-serif`;
	ctx.fillText('Sunny', x + w * 0.05, y + h * 0.92);
}

/** A depth map for S_ZGlow: near (white) at the bottom, far (black) at the top. */
function depthMap(w: number, h: number) {
	return canvas(w, h, (ctx) => {
		const g = ctx.createLinearGradient(0, 0, 0, h);
		g.addColorStop(0, '#000');
		g.addColorStop(1, '#fff');
		ctx.fillStyle = g;
		ctx.fillRect(0, 0, w, h);
	});
}

/** Opaque black with one white dot at (70 %, 30 %) of the box (tracking, glow falloff). */
function paintDot(ctx: CanvasRenderingContext2D, b: Box) {
	ctx.fillStyle = '#000';
	ctx.fillRect(b.x, b.y, b.w, b.h);
	ctx.fillStyle = '#fff';
	ctx.beginPath();
	ctx.arc(b.x + b.w * 0.7, b.y + b.h * 0.3, Math.max(2, b.h * 0.04), 0, Math.PI * 2);
	ctx.fill();
}

const SCENES = { night: paintNight, logo: paintLogo, day: paintDay, dot: paintDot, black: () => {} } as const;
type Scene = keyof typeof SCENES;

// ---------------------------------------------------------------- running effects

type RunOpts = {
	scene?: Scene;
	width?: number;
	height?: number;
	frame?: number;
	depth?: boolean;
	seed?: number;
};

function run(spec: EffectSpec, params: Record<string, unknown>, o: RunOpts = {}) {
	const h = fxHost();
	if (!h) throw new Error('no WebGL2');
	const box = { width: o.width ?? 480, height: o.height ?? 270 };
	const pad = spec.gpu?.padding?.(params as never, { ...box, pxScale: 1, fps: 30 }) ?? 0;
	const padding =
		typeof pad === 'number'
			? { left: pad, top: pad, right: pad, bottom: pad }
			: { left: 0, top: 0, right: 0, bottom: 0, ...pad };
	const layout = fxCanvasLayout(box, padding, 8192);
	const frame = o.frame ?? 0;
	const seed = o.seed ?? 0.25;
	const plan = planGpuEffect(
		spec,
		{ id: 'fx1', params: params as never },
		{
			width: box.width,
			height: box.height,
			pxScale: layout.pxScale,
			fps: 30,
			frame,
			duration: 90,
			seed,
			progress: 0,
		},
		{ width: layout.width, height: layout.height },
	);
	const input = canvas(layout.width, layout.height, (ctx) => SCENES[o.scene ?? 'night'](ctx, layout.box));
	const out = canvas(layout.width, layout.height);
	const textures: Record<string, unknown> = {};
	for (const t of plan.textures) {
		textures[t.uniform] =
			o.depth && t.mediaId
				? {
						source: depthMap(box.width, box.height),
						width: box.width,
						height: box.height,
						version: '1',
					}
				: null;
	}
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
					duration: 90,
					compSize: { width: 1920, height: 1080 },
				}),
				{ name: 'u_seed', type: 'float', value: [seed] },
			],
			textures: textures as never,
			samples: { sources: [], offsets: [] },
		},
		out.getContext('2d')!,
	);
	return { out, input, layout, plan };
}

const specOf = (id: string) => {
	const s = FAMILY.find((e) => e.id === id);
	if (!s) throw new Error(`no effect ${id}`);
	return s;
};

/** The layer box of a result composited over black (what a full-frame layer shows in the sequence). */
function boxImage(r: ReturnType<typeof run>, withPadding = false): HTMLCanvasElement {
	const b = r.layout.box;
	const area = withPadding ? { x: 0, y: 0, w: r.layout.width, h: r.layout.height } : b;
	return canvas(Math.round(area.w), Math.round(area.h), (ctx) => {
		ctx.fillStyle = '#000';
		ctx.fillRect(0, 0, area.w, area.h);
		ctx.drawImage(r.out, area.x, area.y, area.w, area.h, 0, 0, area.w, area.h);
	});
}

type Shot = {
	id: string;
	params?: Record<string, unknown>;
	opts?: RunOpts;
	label?: string;
	padded?: boolean;
};

const api = {
	ids: () => FAMILY.map((s) => ({ id: s.id, label: s.label, bin: s.bin })),

	/** Every family effect with default params on the night scene: no throw, finite pixels. */
	allDefaults() {
		const errors: string[] = [];
		for (const s of FAMILY) {
			try {
				run(s, defaults(s), { width: 96, height: 54 });
				run(s, defaults(s), { width: 96, height: 54, scene: 'logo', frame: 17 });
			} catch (e) {
				errors.push(`${s.id}: ${(e as Error).message}`);
			}
		}
		return { count: FAMILY.length, errors };
	},

	/** Milliseconds of a first (compile + run) and a second (cached) run of one effect at 96 × 54. */
	timing(id: string) {
		const s = specOf(id);
		// Read a pixel back: GL work (and SwiftShader's lazy shader compile) only happens when the result is used.
		const t0 = performance.now();
		px(run(s, defaults(s), { width: 96, height: 54 }).out, 0, 0);
		const t1 = performance.now();
		px(run(s, defaults(s), { width: 96, height: 54 }).out, 0, 0);
		return { first: Math.round(t1 - t0), second: Math.round(performance.now() - t1) };
	},

	/** One effect with default params on the night scene and the transparent logo (later frame): error or null. */
	runDefaults(id: string) {
		try {
			const s = specOf(id);
			// Read back: GL work (and SwiftShader's lazy shader compile) only happens when the result is used.
			px(run(s, defaults(s), { width: 96, height: 54 }).out, 48, 27);
			px(run(s, defaults(s), { width: 96, height: 54, scene: 'logo', frame: 17 }).out, 48, 27);
			return null;
		} catch (e) {
			return (e as Error).message;
		}
	},

	/** Pixels at layer-box points (layer px) of one effect run. */
	pixels(id: string, over: Record<string, unknown>, opts: RunOpts, points: [number, number][]) {
		const spec = specOf(id);
		const r = run(spec, defaults(spec, over), opts);
		const b = r.layout.box;
		return {
			canvas: [r.layout.width, r.layout.height],
			box: [b.x, b.y, b.w, b.h],
			out: points.map(([x, y]) => px(r.out, b.x + x, b.y + y)),
			src: points.map(([x, y]) => px(r.input, b.x + x, b.y + y)),
		};
	},

	/** A checksum of the whole output (determinism tests). */
	checksum(id: string, over: Record<string, unknown>, opts: RunOpts) {
		const spec = specOf(id);
		const r = run(spec, defaults(spec, over), opts);
		const d = r.out.getContext('2d')!.getImageData(0, 0, r.layout.width, r.layout.height).data;
		let hsh = 0x811c9dc5;
		for (let i = 0; i < d.length; i++) hsh = Math.imul(hsh ^ d[i]!, 0x01000193);
		return hsh >>> 0;
	},

	/** PNG (data URL) of one effect on a scene. */
	png(shot: Shot) {
		const spec = specOf(shot.id);
		const r = run(spec, defaults(spec, shot.params), shot.opts);
		return boxImage(r, shot.padded).toDataURL('image/png');
	},

	/** The source scene alone. */
	scenePng(scene: Scene, width = 480, height = 270) {
		return canvas(width, height, (ctx) => {
			ctx.fillStyle = '#000';
			ctx.fillRect(0, 0, width, height);
			SCENES[scene](ctx, { x: 0, y: 0, w: width, h: height });
		}).toDataURL('image/png');
	},

	/** A labelled contact sheet of shots (cols × rows thumbnails). */
	sheet(shots: Shot[], cols: number, tw: number, th: number) {
		const rows = Math.ceil(shots.length / cols);
		const lh = 16;
		const sheet = canvas(cols * tw, rows * (th + lh), (ctx) => {
			ctx.fillStyle = '#111';
			ctx.fillRect(0, 0, cols * tw, rows * (th + lh));
		});
		const ctx = sheet.getContext('2d')!;
		shots.forEach((shot, i) => {
			const spec = specOf(shot.id);
			const r = run(spec, defaults(spec, shot.params), { width: tw, height: th, ...shot.opts });
			const img = boxImage(r);
			const cx = (i % cols) * tw;
			const cy = Math.floor(i / cols) * (th + lh);
			ctx.drawImage(img, 0, 0, img.width, img.height, cx, cy, tw, th);
			ctx.fillStyle = '#ddd';
			ctx.font = '12px sans-serif';
			ctx.textBaseline = 'top';
			ctx.fillText(shot.label ?? spec.label, cx + 4, cy + th + 2);
		});
		return sheet.toDataURL('image/png');
	},
};

(window as unknown as { __sgl: typeof api }).__sgl = api;
