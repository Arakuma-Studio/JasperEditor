// The Title Looks test harness (Node side): renders a look in real WebGL2 and hands back pixels, with the comparisons
// every look test needs. Worked examples in docs/wp-notes/title-looks.md "How to extend".
import { join } from 'node:path';
import type { LookRecipe } from '@jasper/project';
import type { Browser, Page } from '@playwright/test';
import { CHROME, openGlPage } from './gl-browser.ts';
import type { EffectRequest, LookRequest, LookResult } from './title-look-gl/entry.ts';

export type { EffectRequest, LookRequest };
export { CHROME };

export type LookImage = Omit<LookResult, 'rgba'> & { data: Uint8Array };

export type LookPage = {
	browser: Browser;
	page: Page;
	render(req: LookRequest): Promise<LookImage>;
	/** One standalone effect on the same inputs. */
	effect(req: EffectRequest): Promise<LookImage>;
	reach(recipe: LookRecipe): Promise<{ left: number; top: number; right: number; bottom: number }>;
	/** Loads a font file for `{kind: 'text', font}` inputs. */
	loadFont(family: string, weight: number, file: Uint8Array): Promise<void>;
	/** The size at which `text` fits `width` px, at most `size`. */
	fitSize(arg: {
		text: string;
		size: number;
		width: number;
		font: { family: string; weight: number };
	}): Promise<number>;
	float(): Promise<boolean>;
	/** What `render` throws on a GPU without float targets, or null. */
	withoutFloat(req: LookRequest): Promise<string | null>;
	renderer(): Promise<string | null>;
	/** A caption as RGBA8. */
	label(text: string, width: number, height: number): Promise<Uint8Array>;
};

export async function openLookPage(dir: string): Promise<LookPage> {
	const { browser, page } = await openGlPage(join(dir, 'title-look-gl', 'entry.ts'));
	const call = <T>(name: string, arg?: unknown): Promise<T> =>
		page.evaluate(
			([n, a]) =>
				(window as unknown as { __tl: Record<string, (a?: unknown) => unknown> }).__tl[n as string]!(a),
			[name, arg] as const,
		) as Promise<T>;
	const image = ({ rgba, ...rest }: LookResult): LookImage => ({
		...rest,
		data: new Uint8Array(Buffer.from(rgba, 'base64')),
	});
	return {
		browser,
		page,
		render: async (req) => image(await call<LookResult>('render', req)),
		effect: async (req) => image(await call<LookResult>('renderEffect', req)),
		reach: (recipe) => call('reach', recipe),
		loadFont: (family, weight, file) =>
			call('loadFont', { family, weight, base64: Buffer.from(file).toString('base64') }),
		fitSize: (arg) => call('fitSize', arg),
		float: () => call('float'),
		withoutFloat: (req) => call('withoutFloat', req),
		renderer: () => call('renderer'),
		label: async (text, width, height) =>
			new Uint8Array(Buffer.from(await call<string>('label', [text, width, height]), 'base64')),
	};
}

export type Px = [number, number, number, number];

/** RGBA at canvas pixel (x, y). */
export const pixel = (img: Pick<LookImage, 'width' | 'data'>, x: number, y: number): Px => {
	const i = (Math.round(y) * img.width + Math.round(x)) * 4;
	return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!, img.data[i + 3]!];
};

/** The picture over a solid grey, as RGBA8 (`data` is straight alpha: canvas read-back). */
export function over(img: Pick<LookImage, 'width' | 'height' | 'data'>, bg = 128): Uint8Array {
	const out = new Uint8Array(img.data.length);
	for (let i = 0; i < out.length; i += 4) {
		const a = img.data[i + 3]! / 255;
		for (let k = 0; k < 3; k++) out[i + k] = Math.round(img.data[i + k]! * a + bg * (1 - a));
		out[i + 3] = 255;
	}
	return out;
}

/** The picture over a solid grey, as luma. */
export function lumaOver(img: Pick<LookImage, 'width' | 'height' | 'data'>, bg = 128): Float64Array {
	const flat = over(img, bg);
	const out = new Float64Array(img.width * img.height);
	for (let i = 0; i < out.length; i++)
		out[i] = 0.2126 * flat[i * 4]! + 0.7152 * flat[i * 4 + 1]! + 0.0722 * flat[i * 4 + 2]!;
	return out;
}

/** Mean SSIM of two equal-size luma images over 8×8 windows (Wang et al. 2004, the usual constants). */
export function ssim(a: Float64Array, b: Float64Array, w: number, h: number): number {
	const C1 = (0.01 * 255) ** 2;
	const C2 = (0.03 * 255) ** 2;
	let sum = 0;
	let n = 0;
	for (let y = 0; y + 8 <= h; y += 4)
		for (let x = 0; x + 8 <= w; x += 4) {
			let ma = 0;
			let mb = 0;
			for (let j = 0; j < 8; j++)
				for (let i = 0; i < 8; i++) {
					ma += a[(y + j) * w + x + i]!;
					mb += b[(y + j) * w + x + i]!;
				}
			ma /= 64;
			mb /= 64;
			let va = 0;
			let vb = 0;
			let cov = 0;
			for (let j = 0; j < 8; j++)
				for (let i = 0; i < 8; i++) {
					const da = a[(y + j) * w + x + i]! - ma;
					const db = b[(y + j) * w + x + i]! - mb;
					va += da * da;
					vb += db * db;
					cov += da * db;
				}
			va /= 63;
			vb /= 63;
			cov /= 63;
			sum += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
			n++;
		}
	return n ? sum / n : 1;
}

/** `img` resampled to `w`×`h` by box filtering (a resolution test's "after scaling"). */
export function resampleLuma(src: Float64Array, sw: number, sh: number, w: number, h: number): Float64Array {
	const out = new Float64Array(w * h);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const x0 = (x * sw) / w;
			const x1 = ((x + 1) * sw) / w;
			const y0 = (y * sh) / h;
			const y1 = ((y + 1) * sh) / h;
			let sum = 0;
			let area = 0;
			for (let j = Math.floor(y0); j < Math.ceil(y1); j++)
				for (let i = Math.floor(x0); i < Math.ceil(x1); i++) {
					const cx = Math.min(i + 1, x1) - Math.max(i, x0);
					const cy = Math.min(j + 1, y1) - Math.max(j, y0);
					if (cx <= 0 || cy <= 0) continue;
					sum += src[Math.min(j, sh - 1) * sw + Math.min(i, sw - 1)]! * cx * cy;
					area += cx * cy;
				}
			out[y * w + x] = area ? sum / area : 0;
		}
	return out;
}

/** The crop of the layer box in layer proportions: pictures of different resolutions compare over the same area. */
export function layerCrop(
	img: LookImage,
	luma: Float64Array,
	margin = 0,
): { data: Float64Array; w: number; h: number } {
	// The box may sit between canvas pixels (preview scale × odd padding): sample bilinearly.
	const x0 = img.box.x - margin;
	const y0 = img.box.y - margin;
	const w = Math.round(img.box.w + 2 * margin);
	const h = Math.round(img.box.h + 2 * margin);
	const out = new Float64Array(w * h);
	const at = (x: number, y: number) =>
		luma[Math.min(img.height - 1, Math.max(0, y)) * img.width + Math.min(img.width - 1, Math.max(0, x))] ?? 0;
	const fx = x0 - Math.floor(x0);
	const fy = y0 - Math.floor(y0);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const ix = x + Math.floor(x0);
			const iy = y + Math.floor(y0);
			out[y * w + x] =
				(at(ix, iy) * (1 - fx) + at(ix + 1, iy) * fx) * (1 - fy) +
				(at(ix, iy + 1) * (1 - fx) + at(ix + 1, iy + 1) * fx) * fy;
		}
	return { data: out, w, h };
}
