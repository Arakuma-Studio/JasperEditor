// Asset probers of the imports workstream (media/probe.ts `registerAssetProber`): Lottie (`.json` / `.lottie`),
// vector stills (`.svg`, `.svgz`, `.pdf`, `.ai`) and layered documents (`.psd`, `.psb`). Other still formats (EXR, DPX,
// TGA, TIFF, HEIF, JPEG XL…) are probed by ffprobe (media/probe.ts).
import { EMPTY_PROBE } from '@jasper/project';
import { JobError } from '../jobs/types.ts';
import type { AssetProber, ProbeResult } from '../media/probe.ts';
import type { Ffmpeg } from '../tools/ffmpeg.ts';
import { isLottieFileName, probeLottie } from './lottie.ts';
import { isPsdFileName, psdLayeredInfo, readPsdFile } from './psd.ts';
import { isVectorFileName, probeVector } from './vector.ts';

export const lottieProber: AssetProber = {
	id: 'imports.lottie',
	matches: isLottieFileName,
	probe: (file) => probeLottie(file),
};

export const vectorProber: AssetProber = {
	id: 'imports.vector',
	matches: isVectorFileName,
	probe: (file) => probeVector(file),
};

/**
 * PSD / PSB: the flattened document is the media (`image`, decoded for display by the engine: browsers cannot), its
 * layer structure the `layered` header. Documents ag-psd cannot read (CMYK, Lab…) fall back to ffprobe (flattened
 * only, when ffmpeg's PSD decoder reads them).
 */
export function psdProber(ff: Ffmpeg, fallback: (file: string) => Promise<ProbeResult>): AssetProber {
	return {
		id: 'imports.psd',
		matches: isPsdFileName,
		async probe(file) {
			let psd: Awaited<ReturnType<typeof readPsdFile>>;
			try {
				psd = await readPsdFile(file, { images: false });
			} catch (e) {
				if (
					e instanceof JobError &&
					(e.detail as { unsupportedColorMode?: boolean } | undefined)?.unsupportedColorMode
				)
					return fallback(file);
				throw e;
			}
			void ff;
			const info = psdLayeredInfo(psd, file);
			return {
				kind: 'image',
				container: info.format,
				probe: {
					...EMPTY_PROBE,
					streams: [
						{
							index: 0,
							type: 'video',
							codec: 'psd',
							width: psd.width,
							height: psd.height,
							pixelAspect: { num: 1, den: 1 },
							frameRate: { num: 25, den: 1 },
							pixelFormat: (psd.bitsPerChannel ?? 8) > 8 ? 'rgba64le' : 'rgba',
							bitDepth: Math.min(16, psd.bitsPerChannel ?? 8),
							color: { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'rgb', range: 'pc' },
							browserDecodable: false,
						},
					],
					hasAlpha: true,
				},
				browserPlayable: 'no',
				durationSec: null,
				frameCount: null,
				interlaced: false,
				hasVideo: true,
				hasAudio: false,
				display: { width: psd.width, height: psd.height },
				layered: info,
			};
		},
	};
}
