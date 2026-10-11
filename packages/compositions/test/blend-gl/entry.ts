import '../gl-poison.ts';
import { type CompositeItem, type CompositePicture, planComposite } from '../../src/fx/composite-plan.ts';
import { fxHost, runShaderPlan } from '../../src/fx/host.ts';

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function canvas(w: number, h: number): HTMLCanvasElement {
	const c = document.createElement('canvas');
	c.width = w;
	c.height = h;
	return c;
}

/** A canvas holding straight RGBA bytes (stored premultiplied by the browser, as layer pictures are). */
function picture(w: number, h: number, rgba: number[]): HTMLCanvasElement {
	const c = canvas(w, h);
	const ctx = c.getContext('2d')!;
	const d = ctx.createImageData(w, h);
	d.data.set(rgba);
	ctx.putImageData(d, 0, 0);
	return c;
}
const read = (c: HTMLCanvasElement) =>
	Array.from(c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data);

type Layer = {
	key: string;
	mode: string;
	seed?: number;
	/** Straight RGBA bytes, `w × h`. */
	rgba?: number[];
	w?: number;
	h?: number;
	compToCanvas?: number[];
	opacity?: number;
	/** A matte instead of a picture. */
	matte?: [number, number, number, number];
};

/** Composites `layers` bottom → top on a `W × H` stage; returns the stage pixels and the layers as stored. */
function composite(arg: string): { out: number[]; stored: number[][] } {
	const { W, H, layers, linear } = JSON.parse(arg) as {
		W: number;
		H: number;
		layers: Layer[];
		/** A 1.0 working gamma blends in linear light. */
		linear?: 'bt1886' | 'srgb' | 'pq' | 'hlg';
	};
	const h = fxHost();
	if (!h) throw new Error('no WebGL2');
	const items: CompositeItem[] = [];
	const pics = new Map<string, CompositePicture>();
	const sources = new Map<string, HTMLCanvasElement>();
	const stored: number[][] = [];
	for (const l of layers) {
		if (l.matte) {
			items.push({ kind: 'matte', key: l.key, color: l.matte });
			stored.push([]);
			continue;
		}
		const w = l.w ?? W;
		const hh = l.h ?? H;
		const c = picture(w, hh, l.rgba!);
		sources.set(l.key, c);
		stored.push(read(c));
		items.push({ kind: 'clip', key: l.key, mode: l.mode, seed: l.seed ?? 0 });
		pics.set(l.key, {
			width: w,
			height: hh,
			compToCanvas: l.compToCanvas ?? IDENTITY,
			opacity: l.opacity ?? 1,
		});
	}
	const { plan, textures, builtins } = planComposite(
		items,
		pics,
		{ width: W, height: H },
		{ backdrop: false, ...(linear ? { linear } : {}) },
	);
	const inputs: Record<
		string,
		{ source: HTMLCanvasElement; width: number; height: number; version: string }
	> = {};
	for (const t of textures) {
		const c = sources.get(t.key)!;
		inputs[t.uniform] = { source: c, width: c.width, height: c.height, version: `${t.key}:${Math.random()}` };
	}
	const out = canvas(W, H);
	runShaderPlan(
		h,
		plan,
		canvas(1, 1),
		{ builtins, textures: inputs, samples: { sources: [], offsets: [] } },
		out.getContext('2d')!,
	);
	return { out: read(out), stored };
}

/** Draws two straight-RGBA canvases with CSS `mix-blend-mode` in an isolated group and returns the group's pixels. */
async function css(arg: string): Promise<number[]> {
	const { W, H, base, top, mode, topOpacity, baseOpacity } = JSON.parse(arg) as {
		W: number;
		H: number;
		base: number[];
		top: number[];
		mode: string;
		topOpacity: number;
		baseOpacity: number;
	};
	document.body.innerHTML = '';
	document.body.style.margin = '0';
	document.body.style.background = 'transparent';
	const root = document.createElement('div');
	root.style.cssText = `position:absolute;left:0;top:0;width:${W}px;height:${H}px;isolation:isolate`;
	const b = picture(W, H, base);
	const t = picture(W, H, top);
	for (const c of [b, t]) c.style.cssText = `position:absolute;left:0;top:0;width:${W}px;height:${H}px`;
	b.style.opacity = String(baseOpacity);
	t.style.opacity = String(topOpacity);
	t.style.mixBlendMode = mode;
	root.append(b, t);
	document.body.append(root);
	await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
	return [];
}

(window as unknown as { __blend: Record<string, (a: string) => unknown> }).__blend = {
	info: () => ({ webgl2: !!fxHost() }),
	composite,
	css,
};
