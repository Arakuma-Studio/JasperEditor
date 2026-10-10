// Music remix planning (audio-fx): decodes a media's content range to mono 22.05 kHz (ffmpeg), tracks beats and
// self-similarity (`analyzeMusic`, @jasper/audio-fx) and plans pieces retiming it to a target (`planRemix`). The
// analysis of a range is cached (LRU) so dragging the Remix tool or changing Segments/Variations is instant.
import type { RemixPlanRequest, RemixPlanResult } from '@jasper/api';
import { type Analysis, analyzeMusic, planCuts, planLength, planRemix, RemixError } from '@jasper/audio-fx';
import type { Ffmpeg } from '../tools/ffmpeg.ts';

/** Analysis rate: the reference's (FilmCraft analyses 22.05 kHz); beats are found within 10 ms at it. */
export const REMIX_ANALYSIS_RATE = 22050;
const CACHE_MAX = 8;

export class RemixPlanError extends Error {
	constructor(
		readonly code: 'REMIX_NO_BEAT' | 'REMIX_TOO_SHORT' | 'REMIX_TARGET_TOO_SHORT' | 'REMIX_DECODE_FAILED',
		message: string,
	) {
		super(message);
		this.name = 'RemixPlanError';
	}
}

export class RemixPlanner {
	private readonly cache = new Map<string, Analysis>();

	constructor(private readonly ff: Ffmpeg) {}

	/** Mono samples of `[start, start + duration)` seconds of a media's audio stream at the analysis rate. */
	private decode(
		path: string,
		stream: number | undefined,
		start: number,
		duration: number,
	): Promise<Float32Array> {
		const args = [
			'-ss',
			start.toFixed(6),
			'-t',
			duration.toFixed(6),
			'-i',
			path,
			'-map',
			stream === undefined ? '0:a:0' : `0:${stream}`,
			'-ac',
			'1',
			'-ar',
			String(REMIX_ANALYSIS_RATE),
			'-f',
			'f32le',
			'pipe:1',
		];
		return new Promise((resolve, reject) => {
			const child = this.ff.spawnRaw(args);
			const chunks: Buffer[] = [];
			let err = '';
			child.stdout!.on('data', (c: Buffer) => chunks.push(c));
			child.stderr!.setEncoding('utf8').on('data', (c: string) => {
				err = (err + c).slice(-4000);
			});
			child.on('error', (e) => reject(new RemixPlanError('REMIX_DECODE_FAILED', e.message)));
			child.on('close', (code) => {
				if (code !== 0)
					return reject(new RemixPlanError('REMIX_DECODE_FAILED', `ffmpeg exited ${code}: ${err.trim()}`));
				const b = Buffer.concat(chunks);
				const out = new Float32Array(Math.floor(b.byteLength / 4));
				Buffer.from(out.buffer).set(b.subarray(0, out.length * 4));
				resolve(out);
			});
		});
	}

	async plan(path: string, req: RemixPlanRequest): Promise<RemixPlanResult> {
		const key = `${req.mediaKey}|${req.streamIndex ?? 'a0'}|${req.startSeconds.toFixed(4)}|${req.durationSeconds.toFixed(4)}`;
		let a = this.cache.get(key);
		if (!a) {
			const mono = await this.decode(path, req.streamIndex, req.startSeconds, req.durationSeconds);
			try {
				a = analyzeMusic([mono], REMIX_ANALYSIS_RATE);
			} catch (e) {
				throw this.wrap(e);
			}
			this.cache.set(key, a);
			if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
		} else {
			this.cache.delete(key);
			this.cache.set(key, a);
		}
		const sr = REMIX_ANALYSIS_RATE;
		let plan: ReturnType<typeof planRemix>;
		try {
			plan = planRemix(a, Math.round(req.targetSeconds * sr), {
				segments: req.segments ?? 50,
				variations: req.variations ?? 50,
			});
		} catch (e) {
			throw this.wrap(e);
		}
		return {
			bpm: a.bpm,
			beats: a.beats.map((b) => b / sr),
			pieces: plan.pieces.map((p) => ({ srcSeconds: p.src / sr, lenSeconds: p.len / sr })),
			lengthSeconds: planLength(plan) / sr,
			crossfadeSeconds: plan.xfade / sr,
			cuts: planCuts(plan).map(([o, i]) => [o / sr, i / sr] as [number, number]),
		};
	}

	private wrap(e: unknown): Error {
		if (e instanceof RemixError)
			return new RemixPlanError(
				e.code === 'NO_BEAT'
					? 'REMIX_NO_BEAT'
					: e.code === 'TOO_SHORT'
						? 'REMIX_TOO_SHORT'
						: 'REMIX_TARGET_TOO_SHORT',
				e.message,
			);
		return e as Error;
	}
}
