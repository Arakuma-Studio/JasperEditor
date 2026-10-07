// LUT assets (S06:LUT-001): registered like media through the asset-prober hook of media/probe.ts
// (ARCHITECTURE §19.7). The prober parses the file with the shared parsers (`.cube`; color-mgmt: `.3dl`, `.spi1d`,
// `.spi3d`, `.csp`) and returns kind `lut` with the parsed header; an invalid file fails the import with the parser's
// line-numbered message.
import { readFile, stat } from 'node:fs/promises';
import { CubeParseError, EMPTY_PROBE, type Lut, lutFormatOf, parseLutFile } from '@jasper/project';
import { JobError } from '../jobs/types.ts';
import type { AssetProber } from '../media/probe.ts';

/** Largest LUT file accepted (a 256³ float table is ~420 MB of text; 65³ is ~7 MB). */
const MAX_CUBE_BYTES = 64 * 1024 * 1024;

/** Reads and parses a LUT file; throws `JobError('INVALID_LUT', …)` with the parser's line number. */
export async function readCubeFile(file: string): Promise<Lut> {
	const format = lutFormatOf(file);
	const st = await stat(file);
	if (st.size > MAX_CUBE_BYTES)
		throw new JobError('INVALID_LUT', `LUT file too large (${st.size} bytes, max ${MAX_CUBE_BYTES})`, false);
	const text = await readFile(file, 'utf8');
	try {
		return parseLutFile(text, format);
	} catch (e) {
		if (e instanceof CubeParseError)
			throw new JobError('INVALID_LUT', `Invalid ${format ? `.${format} ` : ''}LUT: ${e.message}`, false, {
				line: e.line,
			});
		throw e;
	}
}

export const cubeProber: AssetProber = {
	id: 'wp-m2-color.cube',
	matches: (file) => lutFormatOf(file) !== null,
	async probe(file) {
		const lut = await readCubeFile(file);
		const format = lutFormatOf(file) ?? 'cube';
		return {
			kind: 'lut',
			container: format,
			probe: { ...EMPTY_PROBE, streams: [] },
			browserPlayable: 'no',
			durationSec: null,
			frameCount: null,
			interlaced: false,
			hasVideo: false,
			hasAudio: false,
			display: null,
			lut: {
				format,
				dimensions: lut.dimensions,
				size: lut.size,
				title: lut.title,
				domainMin: [...lut.domainMin],
				domainMax: [...lut.domainMax],
				...(lut.shaper ? { shaperSize: lut.shaper.size } : {}),
			},
		};
	},
};
