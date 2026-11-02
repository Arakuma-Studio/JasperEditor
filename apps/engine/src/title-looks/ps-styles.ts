// Spec 19 TL-113: reads the layer styles of a `.psd` (every layer with enabled effects) or an `.asl` style library, ported
// from Pachislop src/io/psStyle.ts (port record pachislop-interchange). The result is checked with `PsStyleSchema`; a style
// that does not pass, or cannot be parsed, is listed with its reason and the others are kept.
//
// ag-psd rejects the Stroke effect's Shape Burst gradient ('GrdT.shapeburst' is missing from Photoshop's published
// terminology, so its enum lacks it) and then the whole file fails. The decoder is extended here: `apps/engine/test/
// ps-styles.test.ts` has a stroke of that type, and fails without this.
import { type Layer, type LayerEffectsInfo, readPsd } from 'ag-psd';
import { GrdT, parseEffects, readVersionAndDescriptor } from 'ag-psd/dist/descriptor.js';
import { createReader, readSignature, readUint16, readUint32, skipBytes } from 'ag-psd/dist/psdReader.js';
import { type LayerStyleFile, type LayerStyleSource, MAX_STYLE_FILE_BYTES, MAX_STYLES_PER_FILE } from '@jasper/api';
import { type PsStyle, PsStyleSchema } from '@jasper/project';

export class StyleFileError extends Error {
	constructor(
		readonly code: 'STYLE_FILE_INVALID' | 'STYLE_FILE_TOO_LARGE' | 'STYLE_FILE_EMPTY',
		message: string,
	) {
		super(message);
		this.name = 'StyleFileError';
	}
}

const decodeGrdT = GrdT.decode;
GrdT.decode = (v: string) => (v === 'GrdT.shapeburst' ? ('shapeburst' as never) : decodeGrdT(v));

const DEFAULT_PX = 100;

type Doc = Pick<PsStyle, 'ppi' | 'globalAngle' | 'globalAltitude'>;

const hasEnabled = (fx: LayerEffectsInfo) =>
	!fx.disabled &&
	Object.values(fx).some((v) =>
		Array.isArray(v)
			? v.some((e) => (e as { enabled?: boolean })?.enabled)
			: typeof v === 'object' && v !== null && 'enabled' in v && (v as { enabled?: boolean }).enabled,
	);

function checked(name: string, style: unknown, skipped: string[]): PsStyle | null {
	const r = PsStyleSchema.safeParse(style);
	if (r.success) return r.data;
	skipped.push(`${name}: unreadable values (${r.error.issues[0]?.path.join('.') ?? 'style'})`);
	return null;
}

function layerSource(l: Layer, effects: LayerEffectsInfo, doc: Doc, skipped: string[]): LayerStyleSource | null {
	const name = l.name?.trim() || 'Layer style';
	const height = Math.max(0, (l.bottom ?? 0) - (l.top ?? 0));
	const text = l.text;
	const style = text?.style ?? text?.styleRuns?.[0]?.style;
	const parsed = checked(
		name,
		{
			effects,
			baseColor: style?.fillColor ?? null,
			...doc,
			fillOpacity: Math.min(1, Math.max(0, l.fillOpacity ?? 1)),
			knockout: !!l.knockout,
		},
		skipped,
	);
	if (!parsed) return null;
	if (text && style?.fontSize) {
		// Type size is in points; free-transforming a text layer scales its matrix instead of the size.
		const [, , yx = 0, yy = 1] = text.transform ?? [];
		const k = Math.hypot(yx, yy) || 1;
		const refPx = Math.max(1, Math.round(style.fontSize * k * (doc.ppi / 72) * 10) / 10);
		return {
			name,
			origin: 'text layer',
			refPx,
			refKnown: true,
			refNote: `font ${Math.round(style.fontSize * 100) / 100} pt${Math.abs(k - 1) > 0.005 ? ` × ${Math.round(k * 100) / 100}` : ''}${doc.ppi !== 72 ? ` at ${Math.round(doc.ppi)} ppi` : ''}`,
			style: parsed,
		};
	}
	return {
		name,
		origin: 'layer',
		refPx: height > 0 ? Math.round(height) : DEFAULT_PX,
		refKnown: false,
		refNote: height > 0 ? 'layer height' : 'unknown size',
		style: parsed,
	};
}

/** Every layer (groups included, top → bottom) with at least one enabled effect. */
export function psdStyles(bytes: Uint8Array, fileName: string): LayerStyleFile {
	const psd = readPsd(bytes, {
		skipLayerImageData: true,
		skipCompositeImageData: true,
		skipThumbnail: true,
		skipLinkedFilesData: true,
		useImageData: true,
	});
	const res = psd.imageResources?.resolutionInfo;
	const ppi = res
		? res.horizontalResolutionUnit === 'PPCM'
			? res.horizontalResolution * 2.54
			: res.horizontalResolution
		: 72;
	const doc: Doc = {
		ppi: ppi > 0 && Number.isFinite(ppi) ? ppi : 72,
		globalAngle: psd.imageResources?.globalAngle ?? 120,
		globalAltitude: psd.imageResources?.globalAltitude ?? 30,
	};
	const styles: LayerStyleSource[] = [];
	const skipped: string[] = [];
	const walk = (layers: Layer[] | undefined, depth: number) => {
		if (depth > 64) return;
		// ag-psd lists children bottom → top; the Layers panel (and this list) goes top → bottom.
		for (const l of [...(layers ?? [])].reverse()) {
			if (styles.length >= MAX_STYLES_PER_FILE) {
				skipped.push(`Only the first ${MAX_STYLES_PER_FILE} styles are read`);
				return;
			}
			if (l.effects && hasEnabled(l.effects)) {
				const s = layerSource(l, l.effects, doc, skipped);
				if (s) styles.push(s);
			}
			walk(l.children, depth + 1);
		}
	};
	walk(psd.children, 0);
	if (!styles.length && !skipped.length) throw new StyleFileError('STYLE_FILE_EMPTY', 'No layer in this PSD has layer effects');
	return { fileName, styles, skipped: [...new Set(skipped)] };
}

/**
 * Styles of a Photoshop style library: version 2, '8BSL', patterns version, the pattern block (skipped: bitmap patterns
 * have no equivalent here), then per style its length, a name descriptor and a style descriptor whose 'Lefx' holds the
 * same effects as a layer's 'lfx2'.
 */
export function aslStyles(bytes: Uint8Array, fileName: string): LayerStyleFile {
	const r = createReader(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
	if (readUint16(r) !== 2 || readSignature(r) !== '8BSL')
		throw new StyleFileError('STYLE_FILE_INVALID', 'Not a Photoshop style library (.asl)');
	readUint16(r);
	skipBytes(r, readUint32(r));
	const count = readUint32(r);
	const styles: LayerStyleSource[] = [];
	const skipped: string[] = [];
	const limit = Math.min(count, MAX_STYLES_PER_FILE);
	if (count > limit) skipped.push(`Only the first ${MAX_STYLES_PER_FILE} of ${count} styles are read`);
	for (let i = 0; i < limit; i++) {
		if (r.offset + 4 > bytes.byteLength) {
			skipped.push(`The file ends after ${i} of ${count} styles`);
			break;
		}
		const length = readUint32(r);
		const start = r.offset;
		if (start + length > bytes.byteLength) {
			skipped.push(`Style ${i + 1}: its length runs past the end of the file`);
			break;
		}
		let name = `Style ${i + 1}`;
		try {
			const ident = readVersionAndDescriptor(r) as { 'Nm  '?: string };
			name = ident['Nm  ']?.replace(/\0/g, '').trim() || name;
			const desc = readVersionAndDescriptor(r) as { Lefx?: Parameters<typeof parseEffects>[0] };
			const effects = desc.Lefx ? parseEffects(desc.Lefx, false) : null;
			if (effects && hasEnabled(effects)) {
				const parsed = checked(
					name,
					{
						effects,
						baseColor: null,
						ppi: 72,
						globalAngle: 120,
						globalAltitude: 30,
						fillOpacity: 1,
						knockout: false,
					},
					skipped,
				);
				if (parsed)
					styles.push({
						name,
						origin: 'style library',
						refPx: DEFAULT_PX,
						refKnown: false,
						refNote: 'unknown size',
						style: parsed,
					});
			} else skipped.push(`${name}: no layer effects (blending options only)`);
		} catch (e) {
			skipped.push(`${name}: ${(e as Error).message}`);
		}
		// Style blocks are padded to 4 bytes.
		r.offset = start + Math.ceil(length / 4) * 4;
	}
	if (!styles.length && !skipped.length) throw new StyleFileError('STYLE_FILE_EMPTY', 'The style library is empty');
	return { fileName, styles, skipped };
}

/** The styles of a `.psd` or `.asl`, whichever it is by its signature. Never throws anything but `StyleFileError`. */
export function readLayerStyles(bytes: Uint8Array, fileName: string): LayerStyleFile {
	if (bytes.byteLength > MAX_STYLE_FILE_BYTES)
		throw new StyleFileError('STYLE_FILE_TOO_LARGE', `Style files are read up to ${MAX_STYLE_FILE_BYTES / 1024 ** 2} MiB`);
	const sig = String.fromCharCode(...bytes.subarray(0, 6));
	try {
		if (sig.startsWith('8BPS')) return psdStyles(bytes, fileName);
		if (sig.slice(2, 6) === '8BSL') return aslStyles(bytes, fileName);
	} catch (e) {
		if (e instanceof StyleFileError) throw e;
		throw new StyleFileError('STYLE_FILE_INVALID', `This file cannot be read: ${(e as Error).message}`);
	}
	throw new StyleFileError('STYLE_FILE_INVALID', 'Not a Photoshop file: choose a .psd or an .asl style library');
}
