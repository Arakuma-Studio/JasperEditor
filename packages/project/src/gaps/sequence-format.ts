// Sequence Settings ▸ Pixel Aspect Ratio and Fields (docs/wp-notes/gaps.md §TL-11).
//
// A sequence with non-square pixels (DV, HDV, DVCPRO HD, anamorphic 2:1) is edited in DISPLAY pixels: the frame the
// monitors, the layout and every renderer use is `width` = the storage width × the pixel aspect ratio (even), so
// graphics, text and media all look right on screen with no change to any renderer. Exports deliver the storage size:
// the picture is resampled horizontally to `storageWidth` and the pixel aspect is signalled (H.264 / HEVC VUI, MP4 /
// MOV `pasp`, Matroska / WebM display size) — the anamorphic file a DV / HDV workflow expects. Coordinates in the
// Program monitor and Effect Controls are display pixels (Premiere shows storage pixels; the picture is the same).
//
// Fields (Upper / Lower First): kept with the sequence (presets, New Sequence From Clip, interchange). Exports are
// progressive — the LGPL encoders here have no interlaced coding (OpenH264, Kvazaar) and Premiere's field rendering is
// not done — and the export plan says so (`FIELDS_PROGRESSIVE`).
import type { Rational } from '../time.ts';
import { registerGapsCheck } from './settings.ts';

export const SEQUENCE_FIELD_ORDERS = ['progressive', 'upper', 'lower'] as const;
export type SequenceFieldOrder = (typeof SEQUENCE_FIELD_ORDERS)[number];

/** Premiere's Pixel Aspect Ratio choices (its exact ratios), square first. */
export const SEQUENCE_PAR_CHOICES: readonly { id: string; label: string; par: Rational }[] = [
	{ id: 'square', label: 'Square Pixels (1.0)', par: { num: 1, den: 1 } },
	{ id: 'dv-ntsc', label: 'D1/DV NTSC (0.9091)', par: { num: 10, den: 11 } },
	{ id: 'dv-ntsc-wide', label: 'D1/DV NTSC Widescreen 16:9 (1.2121)', par: { num: 40, den: 33 } },
	{ id: 'dv-pal', label: 'D1/DV PAL (1.0940)', par: { num: 59, den: 54 } },
	{ id: 'dv-pal-wide', label: 'D1/DV PAL Widescreen 16:9 (1.4587)', par: { num: 118, den: 81 } },
	{ id: 'anamorphic', label: 'Anamorphic 2:1 (2.0)', par: { num: 2, den: 1 } },
	{ id: 'hdv', label: 'HD Anamorphic 1080 (1.333)', par: { num: 4, den: 3 } },
	{ id: 'dvcprohd', label: 'DVCPRO HD (1.5)', par: { num: 3, den: 2 } },
];

const even = (n: number) => Math.max(16, Math.min(8192, 2 * Math.round(n / 2)));

export function isSquarePar(par: Rational | null | undefined): boolean {
	return !par || par.num === par.den;
}

/** The display (working) width of a storage width at a pixel aspect ratio. */
export function displayWidthOf(storageWidth: number, par: Rational): number {
	return even((storageWidth * par.num) / par.den);
}

export type SequenceFormat = {
	/** Frame width the files carry (= `width` for square pixels). */
	storageWidth: number;
	/** Display width (the sequence's working `width`). */
	displayWidth: number;
	height: number;
	par: Rational;
	fieldOrder: SequenceFieldOrder;
};

type FormatSettings = {
	width: number;
	height: number;
	pixelAspectRatio?: Rational | null;
	storageWidth?: number | null;
	fieldOrder?: string | null;
};

/** The delivery format of a sequence's settings (square pixels and progressive when unset). */
export function sequenceFormatOf(s: FormatSettings): SequenceFormat {
	const par =
		s.pixelAspectRatio && !isSquarePar(s.pixelAspectRatio) && validPar(s.pixelAspectRatio)
			? s.pixelAspectRatio
			: null;
	const storage =
		par && Number.isInteger(s.storageWidth) && (s.storageWidth ?? 0) >= 16
			? (s.storageWidth as number)
			: s.width;
	return {
		storageWidth: par ? storage : s.width,
		displayWidth: s.width,
		height: s.height,
		par: par ? { num: par.num, den: par.den } : { num: 1, den: 1 },
		fieldOrder: (SEQUENCE_FIELD_ORDERS as readonly string[]).includes(s.fieldOrder ?? '')
			? (s.fieldOrder as SequenceFieldOrder)
			: 'progressive',
	};
}

export function validPar(par: Rational): boolean {
	return (
		Number.isInteger(par.num) &&
		Number.isInteger(par.den) &&
		par.num > 0 &&
		par.den > 0 &&
		par.num / par.den >= 0.1 &&
		par.num / par.den <= 10
	);
}

/** Why a format is inconsistent (null = fine). */
export function sequenceFormatProblem(s: FormatSettings): string | null {
	const par = s.pixelAspectRatio;
	if (par !== undefined && par !== null) {
		if (!validPar(par)) return 'pixel aspect ratio must be a positive ratio between 0.1 and 10';
		if (!isSquarePar(par)) {
			const sw = s.storageWidth;
			if (!Number.isInteger(sw) || (sw as number) < 16 || (sw as number) > 8192 || (sw as number) % 2)
				return 'storage width must be an even integer 16..8192';
			if (displayWidthOf(sw as number, par) !== s.width)
				return `width ${s.width} must be the display width ${displayWidthOf(sw as number, par)} of ${sw} at ${par.num}:${par.den}`;
		}
	}
	if (
		s.fieldOrder !== undefined &&
		s.fieldOrder !== null &&
		!(SEQUENCE_FIELD_ORDERS as readonly string[]).includes(s.fieldOrder)
	)
		return `unknown field order ${s.fieldOrder}`;
	return null;
}

registerGapsCheck({
	issues(doc) {
		const out: { invariant: string; message: string; path: string[] }[] = [];
		for (const seq of Object.values(doc.sequences)) {
			const why = sequenceFormatProblem(seq.settings as FormatSettings);
			if (why)
				out.push({
					invariant: 'INV-SEQUENCE-FORMAT',
					message: `sequence ${seq.id}: ${why}`,
					path: ['sequences', seq.id, 'settings'],
				});
		}
		return out;
	},
	repair(doc, note) {
		for (const seq of Object.values(doc.sequences)) {
			const s = seq.settings as FormatSettings & Record<string, unknown>;
			if (!sequenceFormatProblem(s)) continue;
			// Conservative: the picture stays as edited (display width); the delivery becomes square, progressive.
			delete s.pixelAspectRatio;
			delete s.storageWidth;
			if (
				s.fieldOrder !== undefined &&
				!(SEQUENCE_FIELD_ORDERS as readonly string[]).includes(s.fieldOrder as string)
			)
				delete s.fieldOrder;
			note(
				'reset-sequence-format',
				seq.id,
				'unreadable pixel aspect / field settings: square pixels, progressive',
			);
		}
	},
});
