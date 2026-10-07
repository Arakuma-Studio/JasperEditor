// Clip audio decoding for the offline mixer (audio-mix): one ffmpeg per playing clip, streaming float32 PCM at the
// mix rate over stdout. The chain maps the clip's channels (`channels.map`), applies its speed (tempo-preserving
// `atempo` when "Maintain Audio Pitch" is on, a rate change — like the preview — when it is off; reversed clips are
// decoded forwards and reversed) and resamples with SoX (VHQ) when the build has it, else swr with a long filter.
import type { ChildProcess } from 'node:child_process';
import type { AudioStream, ClipReader, Rational, RenderAudioClip } from '@jasper/project';
import { FLICKS_PER_SECOND, fileTimeOf, flicksPerFrame, frameToSample } from '@jasper/project';
import type { Ffmpeg } from '../tools/ffmpeg.ts';
import { sec } from '../tools/ffmpeg.ts';

/** atempo chain for a constant speed (each instance limited to 0.5…100). */
export function atempoChain(speed: number): string[] {
	if (Math.abs(speed - 1) < 1e-9) return [];
	const parts: number[] = [];
	let s = speed;
	while (s < 0.5) {
		parts.push(0.5);
		s /= 0.5;
	}
	while (s > 100) {
		parts.push(100);
		s /= 100;
	}
	parts.push(s);
	return parts.map((p) => `atempo=${round6(p)}`);
}

const round6 = (n: number) => {
	const r = Math.round(n * 1e6) / 1e6;
	return Object.is(r, -0) ? '0' : String(r);
};

const PAN_LAYOUT: Record<number, string> = { 1: 'mono', 2: 'stereo', 6: '5.1' };

/** The resampler options (`aresample` arguments after the rate). */
export function resamplerArgs(soxr: boolean): string {
	return soxr ? 'resampler=soxr:precision=28:cheby=1' : 'filter_size=64:phase_shift=12:cutoff=0.97';
}

/** Output channel count of a clip: its channel map, else the stream's channels (1, 2 or 6; others → stereo). */
export function clipChannels(
	clip: Pick<RenderAudioClip, 'channels'>,
	stream: Pick<AudioStream, 'channels'>,
): number {
	const n = clip.channels.map.length > 0 ? clip.channels.map.length : stream.channels;
	return n === 1 || n === 2 || n === 6 ? n : 2;
}

/**
 * ffmpeg arguments that decode `length` samples of a clip's span from span sample `offset` at `sampleRate`, as
 * interleaved f32le on stdout.
 */
export function clipDecodeArgs(o: {
	clip: RenderAudioClip;
	path: string;
	stream: AudioStream;
	fps: Rational;
	sampleRate: number;
	offset: number;
	length: number;
	soxr: boolean;
}): { args: string[]; channels: number } {
	const { clip, fps, sampleRate } = o;
	const F = flicksPerFrame(fps);
	const [s0] = [frameToSample(clip.start - (clip.headHandle ?? 0), fps, sampleRate)];
	const startSample = s0 + o.offset;
	// Local clip time (frames, fractional) of the first and one-past-last decoded sample.
	const spf = (sampleRate * fps.den) / fps.num;
	const u0 = startSample / spf - clip.start;
	const u1 = (startSample + o.length) / spf - clip.start;
	const rate = clip.speed.rate;
	let c0: number;
	let c1: number;
	if (clip.speed.reverse) {
		c0 = clip.sourceIn + (clip.duration - u1) * F * rate;
		c1 = clip.sourceIn + (clip.duration - u0) * F * rate;
	} else {
		c0 = clip.sourceIn + u0 * F * rate;
		c1 = clip.sourceIn + u1 * F * rate;
	}
	// Content before the start of the media (a head handle reaching past 0) is silence: delay it in.
	const lead = c0 < 0 ? -c0 : 0;
	// imports (Interpret Footage): content time is interpreted media time; the file is read at
	// `fileTimeOf(mediaTime, t)` — an assumed frame rate scales it (the sound plays `scale` times faster, pitch
	// following like the picture) and a loop wraps it (`-stream_loop`: the file restarts at its end).
	const map = clip.mediaTime;
	const scale = map?.scale ?? 1;
	const startSec = fileTimeOf(map, Math.max(0, c0)) / FLICKS_PER_SECOND;
	const durSec = (Math.max(0, c1 - Math.max(0, c0)) * scale) / FLICKS_PER_SECOND;
	const loops = !!map?.period && Math.max(0, c0) + (c1 - Math.max(0, c0)) > map.period;
	const channels = clipChannels(clip, o.stream);
	const map = clip.channels.map;
	const chain: string[] = [];
	if (map.length > 0) {
		const layout = PAN_LAYOUT[channels] ?? 'stereo';
		const picks = Array.from({ length: channels }, (_, i) => `c${i}=c${map[i] ?? map[0] ?? 0}`);
		chain.push(`pan=${layout}|${picks.join('|')}`);
	} else if (!PAN_LAYOUT[o.stream.channels]) chain.push('aformat=channel_layouts=stereo');
	if (clip.speed.reverse) chain.push('areverse');
	// The interpretation's scale is a rate change (pitch follows); the clip's own speed honours Maintain Pitch.
	if (Math.abs(scale - 1) > 1e-9) chain.push(`asetrate=${Math.round(o.stream.sampleRate * scale)}`);
	if (Math.abs(rate - 1) > 1e-9) {
		if (clip.speed.maintainPitch) chain.push(...atempoChain(rate));
		// Rate change: the pitch follows the speed (as the Web Audio preview plays it).
		else chain.push(`asetrate=${Math.round(o.stream.sampleRate * scale * rate)}`);
	}
	chain.push(`aresample=${sampleRate}:${resamplerArgs(o.soxr)}`);
	if (lead > 0) {
		const leadSamples = Math.round((lead / FLICKS_PER_SECOND / rate) * sampleRate);
		chain.push(`adelay=delays=${leadSamples}S:all=1`);
	}
	chain.push(`apad=whole_len=${o.length}`, `atrim=end_sample=${o.length}`);
	const args = [
		...(loops ? ['-stream_loop', '-1'] : []),
		'-ss',
		sec(startSec),
		'-t',
		sec(durSec + 0.25),
		'-i',
		o.path,
		'-map',
		`0:${o.stream.index}`,
		'-af',
		chain.join(','),
		'-f',
		'f32le',
		'-ac',
		String(channels),
		'pipe:1',
	];
	return { args, channels };
}

/** Streams interleaved f32le from a child's stdout into planar blocks. */
export class PcmStreamReader implements ClipReader {
	private readonly iter: AsyncIterator<Buffer>;
	private pending: Buffer = Buffer.alloc(0);
	private ended = false;
	private stderr = '';

	constructor(
		readonly channels: number,
		private readonly child: ChildProcess,
	) {
		this.iter = (child.stdout as NodeJS.ReadableStream)[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
		child.stderr?.setEncoding('utf8').on('data', (c: string) => {
			this.stderr = (this.stderr + c).slice(-4000);
		});
	}

	get errors(): string {
		return this.stderr;
	}

	async read(out: Float32Array[], frames: number): Promise<number> {
		const bytesPerFrame = 4 * this.channels;
		const need = frames * bytesPerFrame;
		const chunks: Buffer[] = [this.pending];
		let have = this.pending.length;
		while (have < need && !this.ended) {
			const r = await this.iter.next();
			if (r.done) {
				this.ended = true;
				break;
			}
			chunks.push(r.value);
			have += r.value.length;
		}
		const all = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, have);
		const got = Math.min(frames, Math.floor(all.length / bytesPerFrame));
		const dv = new DataView(all.buffer, all.byteOffset, got * bytesPerFrame);
		for (let i = 0; i < got; i++)
			for (let c = 0; c < this.channels; c++) out[c]![i] = dv.getFloat32((i * this.channels + c) * 4, true);
		this.pending = Buffer.from(all.subarray(got * bytesPerFrame));
		return got;
	}

	close(): void {
		this.ended = true;
		if (this.child.exitCode === null) this.child.kill('SIGKILL');
	}
}

/** Whether this ffmpeg can use libsoxr (cached per binary). */
const soxrCache = new Map<string, Promise<boolean>>();
export function hasSoxr(ff: Ffmpeg): Promise<boolean> {
	const bin = ff.bins.ffmpeg ?? '';
	let p = soxrCache.get(bin);
	if (!p) {
		p = new Promise<boolean>((resolve) => {
			try {
				const child = ff.spawnRaw(['-buildconf']);
				let s = '';
				child.stdout?.setEncoding('utf8').on('data', (c: string) => {
					s += c;
				});
				child.on('close', () => resolve(/--enable-libsoxr/.test(s)));
				child.on('error', () => resolve(false));
			} catch {
				resolve(false);
			}
		});
		soxrCache.set(bin, p);
	}
	return p;
}
