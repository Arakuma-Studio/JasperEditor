// Browser entry of the "Sapphire other stylize" GL test (bundled with esbuild, run in headless Chrome by
// ../fx-sapphire-stylize-other-gl.test.ts): runs the family's production effects on the real GPU host with painted
// scenes (or a photo) and reports probe pixels, a checksum and optionally a PNG. Pattern of test/fx-gl/entry.ts.
import { defaultEffectRegistry, type EffectSpec, fxBuiltinUniforms, planGpuEffect } from '@jasper/project';
import { fxHost, runShaderPlan } from '../../src/fx/host.ts';
import { fxCanvasLayout } from '../../src/fx/plan.ts';

type Px = [number, number, number, number];
type Scene = {
	kind: 'photo' | 'ramp' | 'quad' | 'bars' | 'transparent' | 'solid' | 'disc' | 'invertStrip';
	dx?: number;
	dy?: number;
	/** photo: scale about the box centre. */
	zoom?: number;
	color?: string;
};

let photo: HTMLImageElement | null = null;

function canvas(w: number, h: number, paint?: (ctx: CanvasRenderingContext2D) => void): HTMLCanvasElement {
	const c = document.createElement('canvas');
	c.width = w;
	c.height = h;
	paint?.(c.getContext('2d')!);
	return c;
}

/** Paints a scene into the box (x, y, w, h) of a canvas context. */
function paintScene(
	ctx: CanvasRenderingContext2D,
	s: Scene,
	b: { x: number; y: number; w: number; h: number },
) {
	ctx.save();
	ctx.beginPath();
	ctx.rect(b.x, b.y, b.w, b.h);
	ctx.clip();
	const x = b.x + (s.dx ?? 0);
	const y = b.y + (s.dy ?? 0);
	switch (s.kind) {
		case 'photo':
			if (photo) {
				const z = s.zoom ?? 1;
				ctx.drawImage(photo, x + (b.w * (1 - z)) / 2, y + (b.h * (1 - z)) / 2, b.w * z, b.h * z);
			}
			break;
		case 'ramp': {
			const g = ctx.createLinearGradient(b.x, 0, b.x + b.w, 0);
			g.addColorStop(0, '#000');
			g.addColorStop(1, '#fff');
			ctx.fillStyle = g;
			ctx.fillRect(b.x, b.y, b.w, b.h);
			break;
		}
		case 'quad':
			for (const [i, c] of ['#e02020', '#20c040', '#2040e0', '#f0e020'].entries()) {
				ctx.fillStyle = c;
				ctx.fillRect(x + (i % 2) * (b.w / 2), y + Math.floor(i / 2) * (b.h / 2), b.w / 2, b.h / 2);
			}
			break;
		case 'bars':
			// Vertical bars of decreasing grey (for sorting: dark → bright reorders).
			for (let i = 0; i < 8; i++) {
				const v = Math.round((255 * ((i * 5) % 8)) / 7);
				ctx.fillStyle = `rgb(${v},${v},${v})`;
				ctx.fillRect(b.x, y + (i * b.h) / 8, b.w, b.h / 8 + 1);
			}
			break;
		case 'solid':
			ctx.fillStyle = s.color ?? '#808080';
			ctx.fillRect(b.x, b.y, b.w, b.h);
			break;
		case 'disc':
			ctx.fillStyle = '#000';
			ctx.fillRect(b.x, b.y, b.w, b.h);
			ctx.fillStyle = s.color ?? '#fff';
			ctx.beginPath();
			ctx.arc(x + b.w / 2, y + b.h / 2, Math.min(b.w, b.h) / 4, 0, Math.PI * 2);
			ctx.fill();
			break;
		case 'invertStrip':
			// An inverting 2D LUT strip of a 4³ cube (16 × 4: x = red + 4·blue, y = green).
			for (let py = 0; py < 4; py++)
				for (let px = 0; px < 16; px++) {
					const r = (px % 4) / 3;
					const g = py / 3;
					const bl = Math.floor(px / 4) / 3;
					ctx.fillStyle = `rgb(${255 * (1 - r)},${255 * (1 - g)},${255 * (1 - bl)})`;
					ctx.fillRect(b.x + px, b.y + py, 1, 1);
				}
			break;
		case 'transparent':
			break;
	}
	ctx.restore();
}

export type RenderOpts = {
	id: string;
	params?: Record<string, unknown>;
	w: number;
	h: number;
	scene: Scene;
	/** Time samples: scenes for offsets (the effect's own samples hook is consulted for the offsets). */
	samples?: Scene[];
	frame?: number;
	seed?: number;
	probes?: [number, number][];
	png?: boolean;
	/** Media param textures: param name → scene. */
	media?: Record<string, Scene & { w?: number; h?: number }>;
};

function render(o: RenderOpts) {
	const h = fxHost();
	if (!h) throw new Error('no WebGL2');
	const spec = defaultEffectRegistry.get(o.id) as EffectSpec | undefined;
	if (!spec?.gpu) throw new Error(`unknown effect ${o.id}`);
	const params = { ...Object.fromEntries(spec.params.map((p) => [p.name, p.default])), ...(o.params ?? {}) };
	const box = { width: o.w, height: o.h };
	const pad = spec.gpu.padding?.(params as never, { ...box, pxScale: 1, fps: 30 }) ?? 0;
	const padding =
		typeof pad === 'number'
			? { left: pad, top: pad, right: pad, bottom: pad }
			: { left: 0, top: 0, right: 0, bottom: 0, ...pad };
	const layout = fxCanvasLayout(box, padding, 8192);
	const frame = o.frame ?? 0;
	const seed = o.seed ?? 0.25;
	const offsets =
		spec.gpu.time?.samples?.(params as never, {
			frame,
			fps: 30,
			duration: 300,
			headHandle: 0,
			tailHandle: 0,
			seed,
		}) ?? [];
	const plan = planGpuEffect(
		spec,
		{ id: 'fx1', params: params as never },
		{ width: o.w, height: o.h, pxScale: layout.pxScale, fps: 30, frame, duration: 300, seed, progress: 0 },
		{ width: layout.width, height: layout.height },
	);
	const input = canvas(layout.width, layout.height, (ctx) => paintScene(ctx, o.scene, layout.box));
	const samples = offsets.map((_, i) =>
		canvas(layout.width, layout.height, (ctx) => paintScene(ctx, o.samples?.[i] ?? o.scene, layout.box)),
	);
	const textures: Record<string, unknown> = {};
	for (const t of plan.textures) {
		const m = o.media?.[t.param];
		if (!m) {
			textures[t.uniform] = null;
			continue;
		}
		const mw = m.w ?? o.w;
		const mh = m.h ?? o.h;
		const src = canvas(mw, mh, (ctx) => paintScene(ctx, m, { x: 0, y: 0, w: mw, h: mh }));
		textures[t.uniform] = { source: src, width: mw, height: mh, version: JSON.stringify(m) };
	}
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
					duration: 300,
					compSize: { width: 1920, height: 1080 },
				}),
				{ name: 'u_seed', type: 'float', value: [seed] },
			],
			textures: textures as never,
			samples: { sources: samples, offsets },
		},
		out.getContext('2d')!,
	);
	const data = out.getContext('2d')!.getImageData(0, 0, out.width, out.height).data;
	let hash = 2166136261;
	for (let i = 0; i < data.length; i++) hash = Math.imul(hash ^ data[i]!, 16777619) >>> 0;
	const px = (x: number, y: number): Px =>
		Array.from(
			data.slice(
				(Math.floor(y) * out.width + Math.floor(x)) * 4,
				(Math.floor(y) * out.width + Math.floor(x)) * 4 + 4,
			),
		) as Px;
	return {
		canvas: [layout.width, layout.height],
		box: [layout.box.x, layout.box.y, layout.box.w, layout.box.h],
		offsets,
		hash,
		probes: (o.probes ?? []).map(([x, y]) => px(layout.box.x + x, layout.box.y + y)),
		png: o.png ? out.toDataURL('image/png') : undefined,
	};
}

const api = {
	async setPhoto(dataUrl: string) {
		const img = new Image();
		img.src = dataUrl;
		await img.decode();
		photo = img;
	},
	render,
};

(window as unknown as { __sso: typeof api }).__sso = api;
