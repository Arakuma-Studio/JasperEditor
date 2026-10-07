// Photoshop documents (`.psd`, `.psb`) on the engine (imports workstream), read with ag-psd (MIT). Three uses:
// - probe: an `image` media (the flattened document) with a `layered` header;
// - display picture: the document's composite image (when the file has none — "Maximize Compatibility" off — the
//   layers are composited here with the shared blend kernel, Photoshop's formulas);
// - layers: every pixel layer extracted as a straight-alpha PNG (its layer mask and vector mask applied to the alpha),
//   with name, visibility, opacity × fill opacity, blend mode, clipping and position, in a tree of groups.
// Bitmap, Grayscale, Indexed and RGB documents at 8/16/32 bits; ag-psd refuses CMYK, Lab, Multichannel and Duotone
// documents (those import flattened through ffmpeg's PSD decoder when it reads them).
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { LayeredLayer } from '@jasper/api';
import { BLEND_MODES, type LayeredInfo, makeBlendKernel } from '@jasper/project';
import { initializeCanvas, type Layer, type Psd, readPsd } from 'ag-psd';
import { JobError } from '../jobs/types.ts';
import type { Ffmpeg } from '../tools/ffmpeg.ts';
import { type CubicPath, type Pt, rasterizePaths } from './raster.ts';
import { type RgbaImage, writeRgbaPng } from './png.ts';

const MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024;
/** Largest document (pixels) whose bitmaps are decoded. */
const MAX_PIXELS = 300_000_000;
const MEMORY_LIMIT = 3 * 1024 * 1024 * 1024;
const MAX_LAYERS = 5000;
const MAX_DEPTH = 64;

export const isPsdFileName = (file: string) => /\.(psd|psb)$/i.test(file);

// ag-psd allocates image data through a canvas unless told otherwise: in Node, plain typed arrays (no canvas is ever
// drawn: `useImageData` keeps every bitmap as raw pixels).
let canvasReady = false;
function ensureNoCanvas(): void {
	if (canvasReady) return;
	canvasReady = true;
	initializeCanvas(
		() => {
			throw new Error('No canvas in the engine (ag-psd useImageData)');
		},
		(width: number, height: number) =>
			({ width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: 'srgb' }) as unknown as ImageData,
	);
}

type PsdBlend = LayeredLayer['blendMode'];

/** ag-psd blend mode → the layered-layer blend vocabulary (Photoshop's names). */
export function psdBlendMode(mode: string | undefined): { mode: PsdBlend; note?: string } {
	const m = (mode ?? 'normal').replace(/ /g, '-');
	const known: Record<string, PsdBlend> = {
		'pass-through': 'pass-through',
		normal: 'normal',
		dissolve: 'dissolve',
		darken: 'darken',
		multiply: 'multiply',
		'color-burn': 'color-burn',
		'linear-burn': 'linear-burn',
		'darker-color': 'darker-color',
		lighten: 'lighten',
		screen: 'screen',
		'color-dodge': 'color-dodge',
		'linear-dodge': 'linear-dodge',
		'lighter-color': 'lighter-color',
		overlay: 'overlay',
		'soft-light': 'soft-light',
		'hard-light': 'hard-light',
		'vivid-light': 'vivid-light',
		'linear-light': 'linear-light',
		'pin-light': 'pin-light',
		'hard-mix': 'hard-mix',
		difference: 'difference',
		exclusion: 'exclusion',
		subtract: 'subtract',
		subtraction: 'subtract',
		divide: 'divide',
		hue: 'hue',
		saturation: 'saturation',
		color: 'color',
		luminosity: 'luminosity',
	};
	const out = known[m];
	return out ? { mode: out } : { mode: 'normal', note: `blend mode "${mode}" is drawn Normal` };
}

/** The editor's blend mode for a Photoshop blend mode (`linear-dodge` = Linear Dodge (Add); pass-through = normal). */
export function editorBlendMode(mode: PsdBlend): (typeof BLEND_MODES)[number] {
	if (mode === 'linear-dodge') return 'add';
	if (mode === 'pass-through') return 'normal';
	return mode as (typeof BLEND_MODES)[number];
}

/** Reads a PSD/PSB (`images`: decode bitmaps; else headers and layer records only). */
export async function readPsdFile(file: string, opts: { images: boolean }): Promise<Psd> {
	const st = await stat(file);
	if (st.size > MAX_FILE_BYTES) throw new JobError('UNSUPPORTED_MEDIA', 'The document is too large', false);
	const buf = await readFile(file);
	ensureNoCanvas();
	try {
		const psd = readPsd(buf, {
			useImageData: true,
			skipLayerImageData: !opts.images,
			skipCompositeImageData: !opts.images,
			skipThumbnail: true,
			skipLinkedFilesData: true,
			totalMemoryLimit: MEMORY_LIMIT,
		});
		if (opts.images && psd.width * psd.height > MAX_PIXELS)
			throw new JobError('UNSUPPORTED_MEDIA', `The document is too large (${psd.width}×${psd.height})`, false);
		return psd;
	} catch (e) {
		if (e instanceof JobError) throw e;
		const msg = (e as Error).message ?? String(e);
		throw new JobError('INVALID_PSD', `Cannot read the Photoshop document: ${msg.slice(0, 300)}`, false, {
			unsupportedColorMode: /Color mode not supported/i.test(msg),
		});
	}
}

const COLOR_MODES = ['bitmap', 'grayscale', 'indexed', 'rgb', 'cmyk', 'multichannel', 'duotone', 'lab'];

function countLayers(layers: Layer[] | undefined, depth = 0): number {
	if (!layers || depth > MAX_DEPTH) return 0;
	let n = 0;
	for (const l of layers) n += 1 + countLayers(l.children, depth + 1);
	return n;
}

export function psdLayeredInfo(psd: Psd, file: string): LayeredInfo {
	return {
		format: /\.psb$/i.test(file) ? 'psb' : 'psd',
		width: psd.width,
		height: psd.height,
		layerCount: countLayers(psd.children),
		...(psd.colorMode !== undefined ? { colorMode: COLOR_MODES[psd.colorMode] ?? String(psd.colorMode) } : {}),
		...(psd.bitsPerChannel ? { bitDepth: psd.bitsPerChannel } : {}),
	};
}

// ---------------------------------------------------------------- pixels

const srgbEncode = (v: number) => {
	const x = Math.max(0, Math.min(1, v));
	return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
};

/** ag-psd pixel data (RGBA at 8/16/32 bits) → an 8- or 16-bit straight RGBA image (32-bit: linear → sRGB). */
export function toRgba(px: { data: ArrayLike<number>; width: number; height: number }, bitsPerChannel: number): RgbaImage {
	const n = px.width * px.height * 4;
	if (bitsPerChannel <= 8) {
		const data = new Uint8Array(n);
		for (let i = 0; i < n; i++) data[i] = px.data[i] ?? 0;
		return { width: px.width, height: px.height, bits: 8, data };
	}
	const data = new Uint16Array(n);
	if (bitsPerChannel === 16) for (let i = 0; i < n; i++) data[i] = px.data[i] ?? 0;
	else
		for (let i = 0; i < n; i++) {
			const v = Number(px.data[i] ?? 0);
			// 32-bit documents are linear light; alpha is linear coverage.
			data[i] = Math.round((i % 4 === 3 ? Math.max(0, Math.min(1, v)) : srgbEncode(v)) * 65535);
		}
	return { width: px.width, height: px.height, bits: 16, data };
}

const maxOf = (img: RgbaImage) => (img.bits === 8 ? 255 : 65535);

/** A layer mask's value at document pixel (x, y) (0…1); outside its bounds the mask's default colour. */
function maskSampler(
	mask: NonNullable<Layer['mask']>,
	bits: number,
): ((x: number, y: number) => number) | null {
	if (mask.disabled) return null;
	const def = (mask.defaultColor ?? 0) / 255;
	const img = mask.imageData;
	const left = mask.left ?? 0;
	const top = mask.top ?? 0;
	if (!img) return () => def;
	const max = bits <= 8 ? 255 : bits === 16 ? 65535 : 1;
	return (x, y) => {
		const mx = x - left;
		const my = y - top;
		if (mx < 0 || my < 0 || mx >= img.width || my >= img.height) return def;
		return Math.max(0, Math.min(1, Number(img.data[(my * img.width + mx) * 4] ?? 0) / max));
	};
}

/** The vector mask of a layer as coverage over the layer bounds (null = none or disabled). */
function vectorMaskCoverage(layer: Layer, left: number, top: number, w: number, h: number): Uint8Array | null {
	const vm = layer.vectorMask;
	if (!vm || vm.disable || !vm.paths?.length) return null;
	let acc: Float32Array = new Float32Array(w * h).fill(vm.fillStartsWithAllPixels ? 1 : 0);
	for (const p of vm.paths) {
		if (p.open || p.knots.length < 2) continue;
		const segments: [Pt, Pt, Pt, Pt][] = [];
		for (let i = 0; i < p.knots.length; i++) {
			const a = p.knots[i]!.points;
			const b = p.knots[(i + 1) % p.knots.length]!.points;
			segments.push([
				[a[2]!, a[3]!],
				[a[4]!, a[5]!],
				[b[0]!, b[1]!],
				[b[2]!, b[3]!],
			]);
		}
		const path: CubicPath = { segments, fillRule: p.fillRule };
		const cov = rasterizePaths([path], left, top, w, h);
		const op = p.operation ?? 'combine';
		const next = new Float32Array(w * h);
		for (let i = 0; i < next.length; i++) {
			const a = acc[i]!;
			const b = cov[i]! / 255;
			next[i] =
				op === 'subtract' ? a * (1 - b) : op === 'intersect' ? a * b : op === 'exclude' ? Math.abs(a - b) : Math.max(a, b);
		}
		acc = next;
	}
	const out = new Uint8Array(w * h);
	for (let i = 0; i < out.length; i++) {
		const v = vm.invert ? 1 - acc[i]! : acc[i]!;
		out[i] = Math.round(Math.max(0, Math.min(1, v)) * 255);
	}
	return out;
}

/** A layer's picture with its masks applied to the alpha, or null (no pixels). */
export function layerPicture(layer: Layer, bits: number): RgbaImage | null {
	const px = layer.imageData;
	if (!px || px.width < 1 || px.height < 1) return null;
	const img = toRgba(px, bits);
	const left = layer.left ?? 0;
	const top = layer.top ?? 0;
	const mask = layer.mask ? maskSampler(layer.mask, bits) : null;
	const vector = vectorMaskCoverage(layer, left, top, img.width, img.height);
	if (mask || vector) {
		const max = maxOf(img);
		for (let y = 0; y < img.height; y++)
			for (let x = 0; x < img.width; x++) {
				const k = y * img.width + x;
				let m = 1;
				if (mask) m *= mask(left + x, top + y);
				if (vector) m *= vector[k]! / 255;
				if (m < 1) img.data[k * 4 + 3] = Math.round(Number(img.data[k * 4 + 3]) * m);
				void max;
			}
	}
	return img;
}

// ---------------------------------------------------------------- composite

const KERNEL = makeBlendKernel();

/**
 * Whether the file's merged image is the real composite: Photoshop says so in its version info resource
 * (`hasRealMergedData`, false when "Maximize Compatibility" was off); writers without that resource may store an empty
 * placeholder — a uniform merged image over a document whose layers are not uniform is not trusted.
 */
function hasRealComposite(psd: Psd): boolean {
	const vi = (psd.imageResources as { versionInfo?: { hasRealMergedData?: boolean } } | undefined)?.versionInfo;
	if (vi && vi.hasRealMergedData === false) return false;
	if (vi?.hasRealMergedData) return true;
	if (!psd.children?.length) return true;
	const d = psd.imageData!.data;
	for (let i = 4; i < d.length; i += 4)
		if (d[i] !== d[0] || d[i + 1] !== d[1] || d[i + 2] !== d[2] || d[i + 3] !== d[3]) return true;
	return false;
}

/**
 * The flattened document: the file's composite image when it has one, else the visible layers composited here
 * (Photoshop's blend formulas — the editor's shared kernel —, opacity × fill opacity, layer and vector masks, clipping
 * groups, pass-through and isolated groups). Layer effects and adjustment layers are not part of a self-made composite.
 */
export function psdComposite(psd: Psd): { image: RgbaImage; source: 'file' | 'layers' } {
	const bits = psd.bitsPerChannel ?? 8;
	if (psd.imageData && psd.imageData.width === psd.width && psd.imageData.height === psd.height && hasRealComposite(psd))
		return { image: toRgba(psd.imageData, bits), source: 'file' };
	const W = psd.width;
	const H = psd.height;
	const stack = new Float64Array(W * H * 4); // premultiplied, 0..1
	compositeLayers(psd.children ?? [], stack, W, H, bits, 0);
	const out: RgbaImage = bits <= 8 ? { width: W, height: H, bits: 8, data: new Uint8Array(W * H * 4) } : { width: W, height: H, bits: 16, data: new Uint16Array(W * H * 4) };
	const max = maxOf(out);
	for (let i = 0; i < W * H; i++) {
		const a = stack[i * 4 + 3]!;
		for (let c = 0; c < 3; c++) out.data[i * 4 + c] = a > 0 ? Math.round(Math.min(1, stack[i * 4 + c]! / a) * max) : 0;
		out.data[i * 4 + 3] = Math.round(Math.min(1, a) * max);
	}
	return { image: out, source: 'layers' };
}

/**
 * The document composited with only the layers whose index (pre-order, as `extractPsdLayers` numbers them) is in
 * `selected` (Premiere's "Merged Layers"); a group is drawn when one of its layers is selected.
 */
export function psdCompositeSubset(psd: Psd, selected: ReadonlySet<number>): RgbaImage {
	let index = 0;
	const prune = (layers: Layer[], depth: number): { list: Layer[]; any: boolean } => {
		const list: Layer[] = [];
		let any = false;
		for (const l of layers) {
			if (depth > MAX_DEPTH) break;
			const i = index++;
			if (l.children) {
				const sub = prune(l.children, depth + 1);
				list.push({ ...l, children: sub.list, hidden: l.hidden || !sub.any });
				any ||= sub.any && !l.hidden;
			} else {
				const on = selected.has(i) && !l.hidden;
				list.push({ ...l, hidden: !on });
				any ||= on;
			}
		}
		return { list, any };
	};
	const children = prune(psd.children ?? [], 0).list;
	return psdComposite({ ...psd, children, imageData: undefined }).image;
}

function blendIndex(mode: PsdBlend): number {
	const i = BLEND_MODES.indexOf(editorBlendMode(mode));
	return i < 0 ? 0 : i;
}

function compositeLayers(layers: Layer[], dst: Float64Array, W: number, H: number, bits: number, depth: number): void {
	if (depth > MAX_DEPTH) return;
	// ag-psd lists children bottom → top.
	let clipBase: Float64Array | null = null;
	for (const l of layers) {
		if (l.hidden) {
			if (!l.clipping) clipBase = null;
			continue;
		}
		const opacity = (l.opacity ?? 1) * (l.fillOpacity ?? 1);
		const blend = psdBlendMode(l.blendMode).mode;
		let pic: Float64Array;
		if (l.children) {
			if (blend === 'pass-through' && opacity >= 1 && !l.mask && !l.vectorMask) {
				compositeLayers(l.children, dst, W, H, bits, depth + 1);
				clipBase = null;
				continue;
			}
			pic = new Float64Array(W * H * 4);
			compositeLayers(l.children, pic, W, H, bits, depth + 1);
			const m = l.mask ? maskSampler(l.mask, bits) : null;
			if (m)
				for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
					const k = (y * W + x) * 4;
					const v = m(x, y);
					for (let c = 0; c < 4; c++) pic[k + c]! *= v;
				}
		} else {
			const img = layerPicture(l, bits);
			pic = new Float64Array(W * H * 4);
			if (img) {
				const max = maxOf(img);
				const left = l.left ?? 0;
				const top = l.top ?? 0;
				for (let y = 0; y < img.height; y++) {
					const dy = top + y;
					if (dy < 0 || dy >= H) continue;
					for (let x = 0; x < img.width; x++) {
						const dx = left + x;
						if (dx < 0 || dx >= W) continue;
						const s = (y * img.width + x) * 4;
						const a = Number(img.data[s + 3]) / max;
						const k = (dy * W + dx) * 4;
						for (let c = 0; c < 3; c++) pic[k + c] = (Number(img.data[s + c]) / max) * a;
						pic[k + 3] = a;
					}
				}
			}
		}
		if (l.clipping && clipBase) {
			// Clipped to the base layer's alpha.
			for (let i = 0; i < W * H; i++) {
				const ba = clipBase[i * 4 + 3]!;
				for (let c = 0; c < 4; c++) pic[i * 4 + c]! *= ba;
			}
		} else if (!l.clipping) clipBase = pic;
		const mode = blendIndex(blend);
		const s = new Float64Array(4);
		const d = new Float64Array(4);
		for (let i = 0; i < W * H; i++) {
			const k = i * 4;
			if (pic[k + 3]! <= 0 && mode !== BLEND_MODES.indexOf('stencil-alpha')) continue;
			for (let c = 0; c < 4; c++) {
				s[c] = pic[k + c]! * opacity;
				d[c] = dst[k + c]!;
			}
			KERNEL.blend(mode, d, s, 0.5);
			const a = Math.min(1, Math.max(0, d[3]!));
			dst[k + 3] = a;
			for (let c = 0; c < 3; c++) dst[k + c] = Math.min(a, Math.max(0, d[c]!));
		}
	}
}

// ---------------------------------------------------------------- layer extraction

export type ExtractedLayer = Omit<LayeredLayer, 'media' | 'children'> & {
	/** The PNG written for the layer (null for groups / empty / adjustment layers). */
	png: string | null;
	children?: ExtractedLayer[];
};

function layerKind(l: Layer): LayeredLayer['kind'] {
	if (l.children) return 'group';
	if (l.adjustment) return 'adjustment';
	if (l.text) return 'text';
	if (l.placedLayer) return 'smart-object';
	if (l.vectorFill || l.vectorOrigination) return 'shape';
	if (!l.imageData || !l.imageData.width || !l.imageData.height) return 'empty';
	return 'pixel';
}

/**
 * Writes every layer with pixels as `<dir>/layer-<index>.png` and returns the layer tree (bottom → top). Layer effects,
 * adjustment layers and smart-object transforms are listed in `notes` (Photoshop draws them; the extracted pixels do
 * not carry them).
 */
export async function extractPsdLayers(
	ff: Ffmpeg,
	psd: Psd,
	dir: string,
	opts: { signal?: AbortSignal; onLayer?: (done: number, total: number) => void } = {},
): Promise<{ layers: ExtractedLayer[]; warnings: string[] }> {
	const bits = psd.bitsPerChannel ?? 8;
	const warnings: string[] = [];
	let index = 0;
	const total = Math.min(MAX_LAYERS, countLayers(psd.children));
	if (countLayers(psd.children) > MAX_LAYERS) warnings.push(`Only the first ${MAX_LAYERS} layers are imported`);
	const walk = async (layers: Layer[], depth: number): Promise<ExtractedLayer[]> => {
		const out: ExtractedLayer[] = [];
		if (depth > MAX_DEPTH) return out;
		for (const l of layers) {
			if (index >= MAX_LAYERS) break;
			if (opts.signal?.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled', false);
			const i = index++;
			const kind = layerKind(l);
			const notes: string[] = [];
			const blend = psdBlendMode(l.blendMode);
			if (blend.note) notes.push(blend.note);
			if (l.effects && Object.values(l.effects).some((v) => v && (Array.isArray(v) ? v.some((e) => (e as { enabled?: boolean }).enabled !== false) : (v as { enabled?: boolean }).enabled !== false)))
				notes.push('layer effects (styles) are not carried');
			if (kind === 'adjustment') notes.push(`${l.adjustment?.type ?? 'adjustment'} adjustment layer is not carried`);
			if (kind === 'text') notes.push('text is imported as pixels');
			if (kind === 'smart-object') notes.push('smart object is imported as its rendered pixels');
			if (l.mask && !l.mask.disabled && kind === 'group') notes.push('the group mask is applied to the group');
			const left = l.left ?? 0;
			const top = l.top ?? 0;
			let png: string | null = null;
			let width = 0;
			let height = 0;
			if (kind !== 'group' && kind !== 'adjustment') {
				const pic = layerPicture(l, bits);
				if (pic) {
					png = join(dir, `layer-${i}.png`);
					await writeRgbaPng(ff, pic, png, opts.signal ? { signal: opts.signal } : {});
					width = pic.width;
					height = pic.height;
				}
			}
			const node: ExtractedLayer = {
				index: i,
				name: (l.name ?? `Layer ${i + 1}`).slice(0, 256),
				kind: png || kind === 'group' || kind === 'adjustment' ? kind : 'empty',
				visible: !l.hidden,
				opacity: Math.max(0, Math.min(1, (l.opacity ?? 1) * (l.fillOpacity ?? 1))),
				blendMode: blend.mode,
				clipping: !!l.clipping,
				left,
				top,
				width,
				height,
				png,
				...(notes.length ? { notes } : {}),
			};
			opts.onLayer?.(index, total);
			if (l.children) node.children = await walk(l.children, depth + 1);
			out.push(node);
		}
		return out;
	};
	const layers = await walk(psd.children ?? [], 0);
	return { layers, warnings };
}
