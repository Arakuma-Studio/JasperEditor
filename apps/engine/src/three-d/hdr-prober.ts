// Radiance `.hdr` assets (spec 19 TL-075): they register as media of kind `hdri` through the asset-prober hook of
// media/probe.ts, ahead of ffprobe. Browsers cannot show them, and float data must reach the 3D renderer as float, so
// they are not images. The prober runs the renderer's reader over the file, at a small output size: a file it refuses
// fails the import with the reason (INVALID_HDR), and nothing the header claims is allocated first.
import { readFile, stat } from 'node:fs/promises';
import {
	decodeHdr,
	EMPTY_PROBE,
	HDR_MAX_BYTES,
	HdrParseError,
	isHdrFile,
	parseHdrHeader,
} from '@jasper/project';
import { JobError } from '../jobs/types.ts';
import type { AssetProber } from '../media/probe.ts';

export const hdrProber: AssetProber = {
	id: 'three-d.hdr',
	matches: isHdrFile,
	async probe(file) {
		const st = await stat(file);
		if (st.size > HDR_MAX_BYTES)
			throw new JobError('INVALID_HDR', `HDR file too large (${st.size} bytes, max ${HDR_MAX_BYTES})`, false);
		const bytes = new Uint8Array(await readFile(file));
		try {
			const head = parseHdrHeader(bytes);
			decodeHdr(bytes, 64);
			return {
				kind: 'hdri',
				container: 'hdr',
				probe: { ...EMPTY_PROBE, streams: [] },
				browserPlayable: 'no',
				durationSec: null,
				frameCount: null,
				interlaced: false,
				hasVideo: false,
				hasAudio: false,
				display: { width: head.width, height: head.height },
			};
		} catch (e) {
			if (e instanceof HdrParseError)
				throw new JobError('INVALID_HDR', `Cannot read the HDR file: ${e.message}`, false);
			throw e;
		}
	},
};
