// Minimal ffprobe for jasper-proc: geometry, rate, frame count, alpha, colour matrix and audio streams.
import { spawn } from 'node:child_process';
import type { Rational } from './types.ts';

export type ProcProbe = {
	width: number;
	height: number;
	fps: Rational;
	/** Exact number of video frames (counted packets when the container does not say). */
	frames: number;
	pixFmt: string;
	hasAlpha: boolean;
	/** swscale `in_color_matrix` for decoding (unknown → bt709, as the trailer pipeline did). */
	matrix: 'bt709' | 'bt601' | 'bt2020' | 'fcc' | 'smpte240m';
	range: 'tv' | 'pc';
	audioStreams: number;
};

function run(bin: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const c = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
		let out = '';
		let err = '';
		c.stdout.on('data', (d: Buffer) => {
			out += d.toString();
		});
		c.stderr.on('data', (d: Buffer) => {
			err = (err + d.toString()).slice(-2000);
		});
		c.on('error', reject);
		c.on('close', (code) =>
			code === 0 ? resolve(out) : reject(new Error(`ffprobe failed (${code}): ${err.trim()}`)),
		);
	});
}

function parseRational(s: string | undefined): Rational | null {
	if (!s) return null;
	const [n, d] = s.split('/').map(Number);
	if (!Number.isFinite(n) || !n) return null;
	return { num: n, den: Number.isFinite(d) && d ? d : 1 };
}

const ALPHA_FORMATS = /^(yuva|rgba|bgra|argb|abgr|gbrap|ya|pal8)/;

function matrixOf(space: string | undefined): ProcProbe['matrix'] {
	switch (space) {
		case 'bt470bg':
		case 'smpte170m':
			return 'bt601';
		case 'bt2020nc':
		case 'bt2020c':
			return 'bt2020';
		case 'fcc':
			return 'fcc';
		case 'smpte240m':
			return 'smpte240m';
		default:
			return 'bt709';
	}
}

export async function probeInput(ffprobe: string, file: string): Promise<ProcProbe> {
	const json = JSON.parse(
		await run(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]),
	) as {
		streams: Array<Record<string, string | number | undefined> & { tags?: Record<string, string> }>;
	};
	const v = json.streams.find((s) => s.codec_type === 'video');
	if (!v) throw new Error(`${file} has no video stream`);
	const fps = parseRational(v.r_frame_rate as string) ??
		parseRational(v.avg_frame_rate as string) ?? { num: 25, den: 1 };
	let frames = Number(v.nb_frames);
	if (!Number.isFinite(frames) || frames <= 0) frames = await countFrames(ffprobe, file);
	const pixFmt = String(v.pix_fmt ?? 'yuv420p');
	const alphaTag = v.tags?.alpha_mode === '1' || v.tags?.ALPHA_MODE === '1';
	return {
		width: Number(v.width),
		height: Number(v.height),
		fps,
		frames,
		pixFmt,
		hasAlpha: ALPHA_FORMATS.test(pixFmt) || alphaTag,
		matrix: matrixOf(v.color_space as string | undefined),
		range: v.color_range === 'pc' ? 'pc' : 'tv',
		audioStreams: json.streams.filter((s) => s.codec_type === 'audio').length,
	};
}

/** Counts the video packets of a file (ProRes/FFV1 are intra: packets = frames). */
export async function countFrames(ffprobe: string, file: string): Promise<number> {
	const counted = JSON.parse(
		await run(ffprobe, [
			'-v',
			'error',
			'-select_streams',
			'v:0',
			'-count_packets',
			'-show_entries',
			'stream=nb_read_packets',
			'-of',
			'json',
			file,
		]),
	) as { streams: Array<{ nb_read_packets?: string }> };
	return Number(counted.streams[0]?.nb_read_packets ?? 0);
}
