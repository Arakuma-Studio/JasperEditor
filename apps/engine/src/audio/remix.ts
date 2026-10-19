// Music remix planning (audio-fx): decodes a media's content range to mono 22.05 kHz (ffmpeg), tracks beats and
// self-similarity (`analyzeMusic`, @jasper/audio-fx) and plans pieces retiming it to a target (`planRemix`). The
// analysis of a range is cached (LRU) so dragging the Remix tool or changing Segments/Variations is instant.
// P6-E11 (wp-note "Phase 6 → WP-E7"): with `anchors` the plan lands source moments (the drop) on output times within
// 1 ms, joining at bar lines (`planAnchoredRemix`); the result lists the bar lines and the drop candidates.
import type { RemixPlanRequest, RemixPlanResult } from '@jasper/api';
import {
	type Analysis,
	analyzeMusic,
	beatsPerBarOf,
	isChoppedMusic,
	type Plan,
	planAnchoredRemix,
	planCuts,
	planLength,
	planRemix,
	RemixError,
} from '@jasper/audio-fx';
import { REMIX_CHOP_CROSSFADE_SEC, SOUND_CHECK_EDGE_THRESHOLDS } from '@jasper/project';
import type { Ffmpeg } from '../tools/ffmpeg.ts';

/** Analysis rate: the reference's (FilmCraft analyses 22.05 kHz); beats are found within 10 ms at it. */
export const REMIX_ANALYSIS_RATE = 22050;
const CACHE_MAX = 8;

export class RemixPlanError extends Error {
	constructor(
		readonly code:
			| 'REMIX_NO_BEAT'
			| 'REMIX_TOO_SHORT'
			| 'REMIX_TARGET_TOO_SHORT'
			| 'REMIX_DECODE_FAILED'
			| 'E_INVALID_PARAM',
		message: string,
		/** E_INVALID_PARAM of an anchored plan: why, and the nearest targets that work (seconds). */
		readonly detail?: { reason: string; nearestTargetSeconds?: number[] },
	) {
		super(message);
		this.name = 'RemixPlanError';
	}
}

/** Hop (s) of the level envelope the joints are judged on. */
export const JOINT_LEVEL_HOP_S = 0.005;
/** The default crossfade of a remix joint (s; `clip.remix`'s 30 ms). */
const JOINT_DEFAULT_S = 0.03;

/** Mean square of each `hop`-sample block of a mono signal (non-finite samples count as 0). Pure. */
export function blockMeanSquares(x: Float32Array, hop: number): Float32Array {
	const h = Math.max(1, Math.floor(hop));
	const out = new Float32Array(Math.ceil(x.length / h));
	for (let b = 0; b < out.length; b++) {
		let e = 0;
		const a = b * h;
		const z = Math.min(x.length, a + h);
		for (let i = a; i < z; i++) {
			const v = x[i]!;
			if (v - v === 0) e += v * v;
		}
		out[b] = z > a ? e / (z - a) : 0;
	}
	return out;
}

/**
 * The crossfade (s) each joint of a plan needs on the timeline so the music is not heard chopped there — Sound Check's
 * EDGE rule (`isChoppedMusic` with its thresholds): the source after the outgoing piece (what the cut removes) within
 * 6 dB of the piece's last 50 ms and over 6 dB above the incoming piece's first 50 ms needs ≥ 100 ms
 * (`REMIX_CHOP_CROSSFADE_SEC`), else the default 30 ms. `cuts` are [end of the outgoing piece, start of the incoming
 * one] in samples of `ms`'s signal; `ms` its block mean squares (`blockMeanSquares`, `hop` samples). Pure; final
 * verification B (a landed drop's joint was found chopped by the next Sound Check).
 */
export function jointCrossfadesSeconds(
	ms: Float32Array,
	hop: number,
	cuts: readonly [number, number][],
): number[] {
	const T = SOUND_CHECK_EDGE_THRESHOLDS;
	const w = Math.max(1, Math.round(T.musicWindowMs / 1000 / ((hop || 1) / REMIX_ANALYSIS_RATE)));
	const dbOf = (from: number, n: number) => {
		const a = Math.max(0, Math.min(ms.length, Math.round(from)));
		const b = Math.max(a, Math.min(ms.length, a + n));
		if (b <= a) return -120;
		let e = 0;
		for (let i = a; i < b; i++) e += ms[i]!;
		const m = e / (b - a);
		return m > 0 ? Math.max(-120, 10 * Math.log10(m)) : -120;
	};
	return cuts.map(([o, i]) => {
		const ho = o / hop;
		const hi = i / hop;
		const chopped = isChoppedMusic(
			{ outDb: dbOf(ho - w, w), cutOffDb: dbOf(ho, w), nextInDb: dbOf(hi, w) },
			JOINT_DEFAULT_S * 1000,
			{ sustainDb: T.musicSustainDb, overNextDb: T.musicOverNextDb, crossfadeMs: T.musicCrossfadeMs },
		);
		return chopped ? REMIX_CHOP_CROSSFADE_SEC : JOINT_DEFAULT_S;
	});
}

export class RemixPlanner {
	private readonly cache = new Map<string, Analysis>();
	/** The level envelope of each cached analysis (`blockMeanSquares` at JOINT_LEVEL_HOP_S): ≈ 0.8 MB per hour. */
	private readonly levels = new WeakMap<Analysis, Float32Array>();

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
		const key = `${req.mediaKey}|${req.streamIndex ?? 'a0'}|${req.startSeconds.toFixed(4)}|${req.durationSeconds.toFixed(4)}|${beatsPerBarOf(req.timeSignature) ?? 'auto'}`;
		let a = this.cache.get(key);
		if (!a) {
			const mono = await this.decode(path, req.streamIndex, req.startSeconds, req.durationSeconds);
			try {
				a = analyzeMusic([mono], REMIX_ANALYSIS_RATE, { timeSignature: req.timeSignature ?? 'auto' });
			} catch (e) {
				throw this.wrap(e);
			}
			this.levels.set(a, blockMeanSquares(mono, Math.round(JOINT_LEVEL_HOP_S * REMIX_ANALYSIS_RATE)));
			this.cache.set(key, a);
			if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
		} else {
			this.cache.delete(key);
			this.cache.set(key, a);
		}
		const sr = REMIX_ANALYSIS_RATE;
		let plan: Plan;
		let anchored: ReturnType<typeof planAnchoredRemix> | null = null;
		try {
			if (req.anchors?.length) {
				anchored = planAnchoredRemix(
					a,
					req.targetSeconds * sr,
					req.anchors.map((x) => ({ src: x.sourceSeconds * sr, out: x.outputSeconds * sr })),
					{
						fit: req.fit ?? 'exact',
						...(req.maxTargetSeconds !== undefined ? { maxTarget: req.maxTargetSeconds * sr } : {}),
					},
				);
				plan = anchored;
			} else
				plan = planRemix(a, Math.round(req.targetSeconds * sr), {
					segments: req.segments ?? 50,
					variations: req.variations ?? 50,
				});
		} catch (e) {
			throw this.wrap(e);
		}
		const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
		return {
			bpm: a.bpm,
			beats: a.beats.map((b) => b / sr),
			pieces: plan.pieces.map((p) => ({ srcSeconds: p.src / sr, lenSeconds: p.len / sr })),
			lengthSeconds: planLength(plan) / sr,
			crossfadeSeconds: plan.xfade / sr,
			cuts: planCuts(plan).map(([o, i]) => [o / sr, i / sr] as [number, number]),
			...(this.levels.has(a)
				? {
						jointCrossfadeSeconds: jointCrossfadesSeconds(
							this.levels.get(a)!,
							Math.round(JOINT_LEVEL_HOP_S * sr),
							planCuts(plan),
						),
					}
				: {}),
			downbeats: a.downbeats.map((i) => r6(a.beats[i]! / sr)),
			beatsPerBar: a.beatsPerBar,
			barsGuessed: a.barsGuessed,
			drops: a.drops.map((d) => ({
				sourceSeconds: r6(d.at / sr),
				bar: d.bar,
				score: d.score,
				liftDb: d.liftDb,
				novelty: d.novelty,
				levelDb: d.levelDb,
			})),
			...(anchored
				? {
						targetSeconds: anchored.target / sr,
						headTrimSeconds: anchored.headTrim / sr,
						anchors: anchored.anchors.map((x) => ({
							sourceSeconds: r6(x.src / sr),
							outputSeconds: r6(x.out / sr),
							landedSeconds: r6(x.at / sr),
							errorMs: Math.round((x.err / sr) * 1e6) / 1000,
						})),
					}
				: {}),
		};
	}

	private wrap(e: unknown): Error {
		if (
			e instanceof RemixError &&
			(e.code === 'ANCHOR_OUT_OF_RANGE' ||
				e.code === 'ANCHOR_UNREACHABLE' ||
				e.code === 'NO_PLAN_NEAR_TARGET')
		)
			return new RemixPlanError('E_INVALID_PARAM', `The drop cannot land there: ${e.message}`, {
				reason: e.code,
				...(e.nearestTargets.length
					? {
							nearestTargetSeconds: e.nearestTargets.map(
								(t) => Math.round((t / REMIX_ANALYSIS_RATE) * 1000) / 1000,
							),
						}
					: {}),
			});
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
