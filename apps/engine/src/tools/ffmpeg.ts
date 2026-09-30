// ffmpeg/ffprobe: binary resolution (ARCHITECTURE D-13, S04:ENG-011), a `-progress pipe:1` runner with
// AbortSignal (R-NVL §4.1) and the startup self-check that lists versions, encoders and filters.
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { ENV } from '@jasper/config';
import { runTool, type SpawnOptions, spawnTool, ToolError } from './process.ts';

export type BinaryPaths = { ffmpeg: string | null; ffprobe: string | null };

function onPath(name: string, env: Record<string, string | undefined>): string | null {
	const exe = process.platform === 'win32' ? `${name}.exe` : name;
	for (const dir of (env.PATH ?? '').split(delimiter)) {
		if (!dir) continue;
		const p = join(dir, exe);
		if (existsSync(p)) return p;
	}
	return null;
}

/**
 * Resolution order: `JASPER_FFMPEG`/`JASPER_FFPROBE` → packaged resources (`<resourcesDir>/bin`) → PATH.
 * Returns null for a binary that cannot be found (capabilities degrade, the engine keeps running).
 */
export function resolveBinaries(
	opts: { env?: Record<string, string | undefined>; resourcesDir?: string | null } = {},
): BinaryPaths {
	const env = opts.env ?? process.env;
	const pick = (name: 'ffmpeg' | 'ffprobe', envName: string): string | null => {
		const explicit = env[envName];
		if (explicit) return existsSync(explicit) ? explicit : null;
		if (opts.resourcesDir) {
			const exe = process.platform === 'win32' ? `${name}.exe` : name;
			const p = join(opts.resourcesDir, 'bin', exe);
			if (existsSync(p)) return p;
		}
		return onPath(name, env);
	};
	return { ffmpeg: pick('ffmpeg', ENV.FFMPEG), ffprobe: pick('ffprobe', ENV.FFPROBE) };
}

export type FfmpegProgress = {
	/** Output time in microseconds. */
	outTimeUs: number;
	frame: number | null;
	speed: number | null;
	done: boolean;
};

export type FfmpegRunOptions = SpawnOptions & {
	onProgress?(p: FfmpegProgress): void;
	/** Extra global flags placed before `args` (default: none). */
	loglevel?: 'error' | 'warning' | 'info';
};

/** Parses `-progress` key=value blocks; calls back on every `progress=` line. */
export function createProgressParser(onProgress: (p: FfmpegProgress) => void): (chunk: string) => void {
	let buf = '';
	const cur: Record<string, string> = {};
	return (chunk) => {
		buf += chunk;
		for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			const eq = line.indexOf('=');
			if (eq < 0) continue;
			const key = line.slice(0, eq);
			const value = line.slice(eq + 1);
			cur[key] = value;
			if (key === 'progress') {
				const us = Number(cur.out_time_us ?? cur.out_time_ms ?? 0);
				const speed = cur.speed ? Number.parseFloat(cur.speed) : Number.NaN;
				const frame = cur.frame !== undefined ? Number(cur.frame) : Number.NaN;
				onProgress({
					outTimeUs: Number.isFinite(us) && us > 0 ? us : 0,
					frame: Number.isFinite(frame) ? frame : null,
					speed: Number.isFinite(speed) ? speed : null,
					done: value === 'end',
				});
			}
		}
	};
}

export class Ffmpeg {
	constructor(readonly bins: BinaryPaths) {}

	get available(): boolean {
		return this.bins.ffmpeg !== null && this.bins.ffprobe !== null;
	}

	private need(name: 'ffmpeg' | 'ffprobe'): string {
		const b = this.bins[name];
		if (!b)
			throw new ToolError(
				'BINARY_MISSING',
				`${name} was not found (set ${name === 'ffmpeg' ? ENV.FFMPEG : ENV.FFPROBE})`,
			);
		return b;
	}

	/**
	 * Runs ffmpeg with `-hide_banner -nostdin -y -progress pipe:1 -nostats` in front of `args`
	 * (R-NVL §4.1). Rejects with a ToolError (`JOB_CANCELLED` when the signal aborted).
	 */
	run(args: readonly string[], opts: FfmpegRunOptions = {}): Promise<{ stderr: string }> {
		const bin = this.need('ffmpeg');
		return new Promise((resolve, reject) => {
			let child: ChildProcess;
			try {
				child = spawnTool(
					bin,
					[
						'-hide_banner',
						'-nostdin',
						'-y',
						'-loglevel',
						opts.loglevel ?? 'error',
						'-progress',
						'pipe:1',
						'-nostats',
						...args,
					],
					opts,
				);
			} catch (e) {
				reject(new ToolError('BINARY_MISSING', `Cannot start ffmpeg: ${(e as Error).message}`));
				return;
			}
			let stderr = '';
			const parse = opts.onProgress ? createProgressParser(opts.onProgress) : null;
			child.stdout!.setEncoding('utf8').on('data', (c: string) => parse?.(c));
			child.stderr!.setEncoding('utf8').on('data', (c: string) => {
				stderr = (stderr + c).slice(-64_000);
			});
			child.on('error', (e) => reject(new ToolError('BINARY_MISSING', `Cannot run ffmpeg: ${e.message}`)));
			child.on('close', (code, sig) => {
				if (opts.signal?.aborted) reject(new ToolError('JOB_CANCELLED', 'ffmpeg cancelled', { stderr }));
				else if (code === 0) resolve({ stderr });
				else
					reject(
						new ToolError('TOOL_FAILED', `ffmpeg exited ${code ?? sig}: ${stderr.trim().slice(-1500)}`, {
							exitCode: code,
							stderr,
						}),
					);
			});
		});
	}

	/** Spawns ffmpeg with raw stdout (e.g. `-f f32le pipe:1`); the caller consumes `child.stdout`. */
	spawnRaw(args: readonly string[], opts: SpawnOptions = {}): ChildProcess {
		return spawnTool(this.need('ffmpeg'), ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args], opts);
	}

	/** `ffprobe -v error -print_format json …` parsed. */
	async probeJson(args: readonly string[], opts: SpawnOptions = {}): Promise<Record<string, unknown>> {
		const { stdout } = await runTool(
			this.need('ffprobe'),
			['-v', 'error', '-print_format', 'json', ...args],
			opts,
		);
		try {
			return JSON.parse(stdout) as Record<string, unknown>;
		} catch {
			throw new ToolError('UNSUPPORTED_MEDIA', 'ffprobe returned invalid JSON');
		}
	}

	/** Raw ffprobe run (text output). */
	async probeText(args: readonly string[], opts: SpawnOptions = {}): Promise<string> {
		return (await runTool(this.need('ffprobe'), ['-v', 'error', ...args], opts)).stdout;
	}

	/** Number of decoded-packet video frames (fast packet count, no decode) of the first video stream. */
	async countVideoFrames(file: string, opts: SpawnOptions = {}): Promise<number> {
		const j = await this.probeJson(
			['-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_packets', file],
			opts,
		);
		const s = (j.streams as { nb_read_packets?: string }[] | undefined)?.[0];
		return Number(s?.nb_read_packets ?? Number.NaN);
	}
}

// ---------------------------------------------------------------- self-check (S04:ENG-011)

export const REQUIRED_ENCODERS = ['libx264', 'aac', 'prores_ks', 'libvpx-vp9'] as const;
export const REQUIRED_FILTERS = [
	'trim',
	'atrim',
	'overlay',
	'amix',
	'scale',
	'fps',
	'tile',
	'silencedetect',
	'scdet',
	'ebur128',
	'loudnorm',
] as const;

export type SelfCheck = {
	ffmpegVersion: string | null;
	ffprobeVersion: string | null;
	encoders: string[];
	filters: string[];
	missingEncoders: string[];
	missingFilters: string[];
	/** H.264 + AAC encoders and the compositing filters exist (native export possible). */
	nativeRender: boolean;
	errors: string[];
};

function parseVersion(out: string): string | null {
	const m = /version\s+(\S+)/.exec(out);
	return m ? m[1]! : null;
}

function parseCodecList(out: string): string[] {
	// Lines like " V....D libx264   libx264 H.264 …" after a "------" separator.
	const names: string[] = [];
	let started = false;
	for (const line of out.split('\n')) {
		if (!started) {
			if (/^\s*-{3,}/.test(line)) started = true;
			continue;
		}
		const m = /^\s*[A-Z.]{6}\s+(\S+)/.exec(line);
		if (m) names.push(m[1]!);
	}
	return names;
}

function parseFilterList(out: string): string[] {
	// Lines like " TSC overlay  VV->V  Overlay …" after "Filters:" legend.
	const names: string[] = [];
	for (const line of out.split('\n')) {
		const m = /^\s*[TSC.|]{3}\s+(\S+)\s+\S+->\S+/.exec(line);
		if (m) names.push(m[1]!);
	}
	return names;
}

const selfCheckCache = new Map<string, Promise<SelfCheck>>();

/** Versions, encoders and filters of the resolved binaries. Never throws; cached per binary pair. */
export function selfCheck(bins: BinaryPaths): Promise<SelfCheck> {
	const key = `${bins.ffmpeg}|${bins.ffprobe}`;
	let p = selfCheckCache.get(key);
	if (!p) {
		p = runSelfCheck(bins);
		selfCheckCache.set(key, p);
	}
	return p;
}

async function runSelfCheck(bins: BinaryPaths): Promise<SelfCheck> {
	const errors: string[] = [];
	const text = async (bin: string | null, args: string[]) => {
		if (!bin) return '';
		try {
			return (await runTool(bin, args)).stdout;
		} catch (e) {
			errors.push((e as Error).message);
			return '';
		}
	};
	const [ffv, fpv, enc, fil] = await Promise.all([
		text(bins.ffmpeg, ['-hide_banner', '-version']),
		text(bins.ffprobe, ['-hide_banner', '-version']),
		text(bins.ffmpeg, ['-hide_banner', '-encoders']),
		text(bins.ffmpeg, ['-hide_banner', '-filters']),
	]);
	if (!bins.ffmpeg) errors.push('ffmpeg not found');
	if (!bins.ffprobe) errors.push('ffprobe not found');
	const encoders = parseCodecList(enc);
	const filters = parseFilterList(fil);
	const hasH264 = encoders.some((e) => e === 'libx264' || e === 'libopenh264' || /^h264_/.test(e));
	const nativeRender =
		!!bins.ffmpeg &&
		!!bins.ffprobe &&
		hasH264 &&
		encoders.includes('aac') &&
		['overlay', 'amix', 'scale', 'fps', 'trim', 'atrim'].every((f) => filters.includes(f));
	return {
		ffmpegVersion: parseVersion(ffv),
		ffprobeVersion: parseVersion(fpv),
		encoders,
		filters,
		missingEncoders: REQUIRED_ENCODERS.filter((e) => !encoders.includes(e)),
		missingFilters: REQUIRED_FILTERS.filter((f) => !filters.includes(f)),
		nativeRender,
		errors,
	};
}

/** Seconds with microsecond precision for ffmpeg time arguments (S04:RN-022). */
export function sec(seconds: number): string {
	const v = Math.max(0, seconds);
	return v.toFixed(6);
}

/** `frames × den / num` seconds (S04:RN-022). */
export function framesToSec(frames: number, fps: { num: number; den: number }): number {
	return (frames * fps.den) / fps.num;
}
