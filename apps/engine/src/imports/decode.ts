// One decoding definition is shared by the display pictures of
// stills, the interpreted proxies / masters and the native export, so every path shows the same pixels.
// - Scene-linear stills (OpenEXR, Radiance HDR) are shown with the sRGB transfer (EXR decoder `apply_trc`, `zscale`
//   for HDR); values above 1 clip. 16-bit output keeps the precision of half / float sources.
// - Interpret Footage ▸ field order / alpha: `pixelInterpretationFilters` (bwdif, unpremultiply / geq, lutrgb).
import { type MediaProbe, type PixelInterpretation, pixelInterpretationFilters } from '@jasper/project';

type RecordLike = { probe: Pick<MediaProbe, 'streams'>; kind: string };

function videoCodec(r: RecordLike): string {
	const vs = r.probe.streams.find((s) => s.type === 'video');
	return vs?.type === 'video' ? vs.codec : '';
}

/** Decoder options placed before `-i` for this media (EXR: apply the sRGB transfer). */
export function decoderArgs(r: RecordLike): string[] {
	return videoCodec(r) === 'exr' ? ['-apply_trc', 'iec61966_2_1'] : [];
}

/** Filters right after decoding (before any interpretation): Radiance HDR is linear light → sRGB. */
export function decodeFilters(r: RecordLike): string[] {
	return videoCodec(r) === 'hdr'
		? ['zscale=transferin=linear:transfer=iec61966-2-1:primariesin=bt709:primaries=bt709']
		: [];
}

/** True when the source has more than 8 bits per channel (display pictures are then 16-bit PNGs). */
export function isDeep(r: RecordLike): boolean {
	const vs = r.probe.streams.find((s) => s.type === 'video');
	if (vs?.type !== 'video') return false;
	return (
		vs.bitDepth > 8 ||
		/(f32|f16|16le|16be|48|64|p10|p12|p16)/.test(vs.pixelFormat) ||
		['exr', 'hdr'].includes(vs.codec)
	);
}

/** Every filter from the decoded picture to the interpreted one. */
export function sourceFilters(r: RecordLike, pixel: PixelInterpretation | null | undefined): string[] {
	return [...decodeFilters(r), ...pixelInterpretationFilters(pixel ?? null)];
}
