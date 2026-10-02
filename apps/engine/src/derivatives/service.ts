// Derivatives (ARCHITECTURE §9.4, S04 §7): keyframe index, poster, filmstrip sprite + index, waveform peaks,
// proxies. Content-addressed under `<appdir>/cache/<fingerprintHex>/<kind>-<paramsHash>.<ext>` (S04:CA-001),
// so the same file in several projects shares artifacts, and a job whose artifact exists completes at once.
import { createHash } from 'node:crypto';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
	DerivativeKind,
	DerivativeStatus,
	EngineJob,
	JobKind,
	PeaksHeader,
	SpriteIndex,
} from '@jasper/api';
import type { Broadcaster } from '../events/broadcaster.ts';
import type { JobQueue } from '../jobs/queue.ts';
import { type JobContext, JobError, type JobPriority } from '../jobs/types.ts';
import { alphaDecoder } from '../media/alpha.ts';
import { fingerprintHex } from '../media/fingerprint.ts';
import type { MediaRecord, MediaRegistry } from '../media/registry.ts';
import { audioEncodeArgs, type EncoderService, videoEncodeArgs } from '../tools/encoders.ts';
import { type Ffmpeg, sec } from '../tools/ffmpeg.ts';
import { atomicWriteJson, exists } from '../tools/fs.ts';
import { PEAKS_PER_SECOND, PEAKS_SAMPLE_RATE, planarBytes, reducePeaksFromChild } from './peaks.ts';

/** Generator versions: bumping one invalidates only that artifact kind (S04:CA-002). */
const GENERATOR_VERSIONS: Record<DerivativeKind, number> = {
	keyframes: 1,
	poster: 1,
	sprite: 1,
	// v2: streams are keyed by the container stream index (S01 `channels.streamIndex`), not the audio ordinal.
	peaks: 2,
	'proxy-720': 1,
	'proxy-540': 1,
};

const SPRITE_TILE_WIDTH = 160;
const SPRITE_COLUMNS = 10;
const SPRITE_TILES_PER_SHEET = 100;
const POSTER_WIDTH = 320;

const JOB_KIND: Record<DerivativeKind, JobKind> = {
	keyframes: 'keyframes',
	poster: 'poster',
	sprite: 'sprite',
	peaks: 'peaks',
	'proxy-720': 'proxy',
	'proxy-540': 'proxy',
};
const SLOTS: Record<DerivativeKind, number> = {
	keyframes: 1,
	poster: 1,
	sprite: 1,
	peaks: 1,
	'proxy-720': 4,
	'proxy-540': 4,
};
const TITLES: Record<DerivativeKind, string> = {
	keyframes: 'Keyframe index',
	poster: 'Poster frame',
	sprite: 'Thumbnails',
	peaks: 'Waveform',
	'proxy-720': 'Proxy 720p',
	'proxy-540': 'Proxy 540p',
};

/** What `alphaProxy` needs from a media record. */
export type AlphaSource = Pick<MediaRecord, 'kind' | 'probe'>;

type DerivativeJobInput = { mediaKey: string; kind: DerivativeKind };

export type ArtifactPaths = {
	/** The file whose existence marks the artifact complete (JSON header / index / media file). */
	main: string;
	/** Directory with sheets/streams (sprite, peaks). */
	dir: string | null;
	hash: string;
};

/**
 * Proxies of sources with an alpha channel keep it: VP9 `yuva420p` in WebM, which Chromium plays with
 * transparency (H.264 has no alpha: an MP4 proxy of a ProRes 4444 overlay would hide the footage under it).
 */
const ALPHA_PROXY_ENCODER = 'libvpx-vp9';

function paramsFor(
	kind: DerivativeKind,
	proxyEncoder?: string | null,
	alpha = false,
): Record<string, unknown> {
	// Proxies made by another encoder than libx264 get their own cache key (D-13); libx264 proxies keep the
	// historical key so existing caches stay valid.
	const enc = alpha
		? { enc: ALPHA_PROXY_ENCODER, alpha: 'yuva420p' }
		: proxyEncoder && proxyEncoder !== 'libx264'
			? { enc: proxyEncoder }
			: {};
	switch (kind) {
		case 'poster':
			return { width: POSTER_WIDTH, at: 0.1 };
		case 'sprite':
			return { tileWidth: SPRITE_TILE_WIDTH, columns: SPRITE_COLUMNS, perSheet: SPRITE_TILES_PER_SHEET };
		case 'peaks':
			return { pps: PEAKS_PER_SECOND, rate: PEAKS_SAMPLE_RATE };
		case 'proxy-720':
			return { height: 720, gop: 15, crf: 23, ...enc };
		case 'proxy-540':
			return { height: 540, gop: 15, crf: 26, ...enc };
		default:
			return {};
	}
}

function paramsHash(kind: DerivativeKind, proxyEncoder?: string | null, alpha = false): string {
	return createHash('sha256')
		.update(JSON.stringify({ kind, v: GENERATOR_VERSIONS[kind], p: paramsFor(kind, proxyEncoder, alpha) }))
		.digest('hex')
		.slice(0, 12);
}

/** Which derivative kinds make sense for a media record. */
function applicableKinds(r: Pick<MediaRecord, 'kind' | 'hasAudio'>): DerivativeKind[] {
	switch (r.kind) {
		case 'video':
			return [
				'keyframes',
				'poster',
				'sprite',
				...(r.hasAudio ? (['peaks'] as const) : []),
				'proxy-720',
				'proxy-540',
			];
		case 'animated-image':
			return ['poster', 'sprite'];
		case 'image':
			return ['poster'];
		case 'audio':
			return ['peaks'];
		default:
			return [];
	}
}

/** Kinds queued automatically after registration (S04:IN-011, ARCHITECTURE §9.4). */
function autoKinds(r: Pick<MediaRecord, 'kind' | 'hasAudio' | 'browserPlayable'>): DerivativeKind[] {
	switch (r.kind) {
		case 'video':
			return [
				'keyframes',
				'poster',
				...(r.hasAudio ? (['peaks'] as const) : []),
				'sprite',
				...(r.browserPlayable === 'no' ? (['proxy-720'] as const) : []),
			];
		case 'animated-image':
			return ['poster', 'sprite'];
		case 'image':
			return ['poster'];
		case 'audio':
			return ['peaks'];
		default:
			return [];
	}
}

export class DerivativeService {
	private readonly failures = new Map<string, string>();

	constructor(
		private readonly deps: {
			cacheDir: string;
			ff: Ffmpeg;
			/** Proxy encoder selection (D-13); absent = libx264 (tests). */
			encoders?: EncoderService;
			queue: JobQueue;
			registry: MediaRegistry;
			broadcaster: Broadcaster;
		},
	) {}

	/** Registers the job runners for keyframes/poster/sprite/peaks/proxy. */
	registerRunners(): void {
		const runner = (ctx: JobContext) => this.run(ctx);
		for (const k of ['keyframes', 'poster', 'sprite', 'peaks', 'proxy'] as const)
			this.deps.queue.registerRunner(k, runner);
	}

	/** The proxy encoder choice (null: no usable video encoder). */
	private proxyChoice() {
		if (!this.deps.encoders)
			return { codec: 'h264', encoder: 'libx264', audioEncoder: 'aac', container: 'mp4' } as const;
		return this.deps.encoders.select({ purpose: 'proxy' });
	}

	/**
	 * True when the proxies of this media are VP9 WebM with alpha instead of the regular MP4: a video with
	 * an alpha channel, on a build that has libvpx-vp9.
	 */
	alphaProxy(r: AlphaSource | null | undefined): boolean {
		return (
			!!r && r.kind === 'video' && r.probe.hasAlpha && (this.deps.encoders?.has(ALPHA_PROXY_ENCODER) ?? false)
		);
	}

	private hashOf(kind: DerivativeKind, alpha = false): string {
		const proxy = kind.startsWith('proxy-');
		return paramsHash(kind, proxy ? (this.proxyChoice()?.encoder ?? null) : null, proxy && alpha);
	}

	/** Artifact paths; pass the media record (`r`) for proxies so alpha sources resolve to their WebM. */
	paths(fingerprint: string, kind: DerivativeKind, r?: AlphaSource | null): ArtifactPaths {
		const alpha = kind.startsWith('proxy-') && this.alphaProxy(r);
		const hash = this.hashOf(kind, alpha);
		const base = join(this.deps.cacheDir, fingerprintHex(fingerprint));
		switch (kind) {
			case 'keyframes':
				return { main: join(base, `keyframes-${hash}.json`), dir: null, hash };
			case 'poster':
				return { main: join(base, `poster-${hash}.jpg`), dir: null, hash };
			case 'sprite':
				return { main: join(base, `sprite-${hash}.json`), dir: join(base, `sprite-${hash}`), hash };
			case 'peaks':
				return { main: join(base, `peaks-${hash}.json`), dir: join(base, `peaks-${hash}`), hash };
			default:
				return { main: join(base, `${kind}-${hash}.${alpha ? 'webm' : 'mp4'}`), dir: null, hash };
		}
	}

	/** Public URL of an artifact (the params hash is the cache-busting query, S04:MS-002). */
	url(mediaKey: string, kind: DerivativeKind): string {
		const h = this.hashOf(kind, this.alphaProxy(this.deps.registry.get(mediaKey)));
		const k = encodeURIComponent(mediaKey);
		switch (kind) {
			case 'keyframes':
				return `/media/${k}/keyframes.json?v=${h}`;
			case 'poster':
				return `/media/${k}/poster.jpg?v=${h}`;
			case 'sprite':
				return `/media/${k}/sprite.json?v=${h}`;
			case 'peaks':
				return `/media/${k}/peaks.json?v=${h}`;
			case 'proxy-720':
				return `/media/${k}/proxy/720?v=${h}`;
			case 'proxy-540':
				return `/media/${k}/proxy/540?v=${h}`;
		}
	}

	private dedupeKey(r: MediaRecord, kind: DerivativeKind): string {
		const fp = fingerprintHex(r.fingerprint);
		return kind.startsWith('proxy-') ? `proxy:${kind.slice(6)}:${fp}` : `${kind}:${fp}`;
	}

	async isReady(r: MediaRecord, kind: DerivativeKind): Promise<boolean> {
		return exists(this.paths(r.fingerprint, kind, r).main);
	}

	/** Per-kind status for `GET /api/media/:key` (S01:LIFE-050 shape). */
	async status(r: MediaRecord): Promise<Record<DerivativeKind, DerivativeStatus>> {
		const out = {} as Record<DerivativeKind, DerivativeStatus>;
		const active = this.deps.queue.list({ active: true });
		for (const kind of [
			'keyframes',
			'poster',
			'sprite',
			'peaks',
			'proxy-720',
			'proxy-540',
		] as DerivativeKind[]) {
			if (await this.isReady(r, kind)) {
				out[kind] = { state: 'ready', progress: 1, url: this.url(r.mediaKey, kind) };
				continue;
			}
			const job = active.find((j) => j.dedupeKey === this.dedupeKey(r, kind));
			if (job) {
				out[kind] = {
					state: job.state === 'queued' ? 'queued' : 'running',
					progress: job.progress ?? 0,
					jobId: job.id,
				};
				continue;
			}
			const err = this.failures.get(this.dedupeKey(r, kind));
			out[kind] = err ? { state: 'failed', progress: 0, error: err } : { state: 'none', progress: 0 };
		}
		return out;
	}

	/** Queues derivative jobs (deduplicated; artifacts that exist complete immediately, S04:JB-014). */
	request(
		r: MediaRecord,
		kinds: readonly DerivativeKind[],
		opts: { priority?: JobPriority; origin?: EngineJob['origin']; projectId?: string } = {},
	): EngineJob[] {
		const applicable = new Set(applicableKinds(r));
		const jobs: EngineJob[] = [];
		for (const kind of kinds) {
			if (!applicable.has(kind)) continue;
			const priority =
				opts.priority ??
				(kind === 'sprite' || kind.startsWith('proxy-') ? ('background' as const) : ('interactive' as const));
			jobs.push(
				this.deps.queue.submit({
					kind: JOB_KIND[kind],
					title: `${TITLES[kind]} – ${r.originalName}`,
					priority,
					cpuSlots: SLOTS[kind],
					origin: opts.origin ?? { type: 'system' },
					assetId: r.mediaKey,
					...(opts.projectId ? { projectId: opts.projectId } : {}),
					dedupeKey: this.dedupeKey(r, kind),
					input: { mediaKey: r.mediaKey, kind } satisfies DerivativeJobInput,
				}),
			);
		}
		return jobs;
	}

	/**
	 * S04:CA-004 (M3, wp-m3-cachegc): the automatic artifacts of a media that are missing — never made, or removed by
	 * the cache GC — are queued again (failed ones stay failed until retried). Returns the jobs queued.
	 */
	regenerateMissing(
		r: MediaRecord,
		status: Readonly<Record<DerivativeKind, DerivativeStatus>>,
		projectId?: string,
	): EngineJob[] {
		const missing = autoKinds(r).filter((k) => status[k]?.state === 'none');
		return missing.length ? this.request(r, missing, projectId ? { projectId } : {}) : [];
	}

	/** IN-011 follow-up jobs after registration. */
	autoQueue(r: MediaRecord, projectId?: string): EngineJob[] {
		return this.request(r, autoKinds(r), { ...(projectId ? { projectId } : {}) });
	}

	// ------------------------------------------------------------------ runner

	private async run(ctx: JobContext): Promise<unknown> {
		const input = ctx.input as DerivativeJobInput;
		const r = this.deps.registry.get(input.mediaKey);
		if (!r) throw new JobError('ASSET_NOT_FOUND', `Unknown media ${input.mediaKey}`, false);
		const p = this.paths(r.fingerprint, input.kind, r);
		const dk = this.dedupeKey(r, input.kind);
		if (!(await exists(p.main))) {
			const src = await this.deps.registry.resolvePath(r.mediaKey);
			if (!src) throw new JobError('ASSET_NOT_FOUND', `Media ${r.originalName} is offline`, true);
			await mkdir(dirname(p.main), { recursive: true });
			try {
				switch (input.kind) {
					case 'keyframes':
						await this.keyframes(ctx, src, p);
						break;
					case 'poster':
						await this.poster(ctx, r, src, p);
						break;
					case 'sprite':
						await this.sprite(ctx, r, src, p);
						break;
					case 'peaks':
						await this.peaks(ctx, r, src, p);
						break;
					case 'proxy-720':
					case 'proxy-540':
						await this.proxy(ctx, r, src, p, input.kind === 'proxy-720' ? 720 : 540);
						break;
				}
			} catch (e) {
				if (!ctx.signal.aborted) this.failures.set(dk, (e as Error).message.slice(0, 500));
				throw e;
			}
		}
		this.failures.delete(dk);
		const url = this.url(r.mediaKey, input.kind);
		this.deps.broadcaster.publish('derivative.ready', { mediaKey: r.mediaKey, kind: input.kind, url });
		return { mediaKey: r.mediaKey, kind: input.kind, url };
	}

	private tmpName(file: string): string {
		return `${file}.${Date.now().toString(36)}.partial${file.slice(file.lastIndexOf('.'))}`;
	}

	private async keyframes(ctx: JobContext, src: string, p: ArtifactPaths): Promise<void> {
		const text = await this.deps.ff.probeText(
			[
				'-select_streams',
				'v:0',
				'-skip_frame',
				'nokey',
				'-show_entries',
				'frame=pts_time',
				'-of',
				'csv=p=0',
				src,
			],
			{ signal: ctx.signal, onSpawn: ctx.trackChild },
		);
		const times = text
			.split('\n')
			.map((l) => Number.parseFloat(l.trim().split(',')[0] ?? ''))
			.filter((t) => Number.isFinite(t))
			.sort((a, b) => a - b);
		await atomicWriteJson(p.main, { version: 1, times });
	}

	private async poster(ctx: JobContext, r: MediaRecord, src: string, p: ArtifactPaths): Promise<void> {
		const at = r.durationSec && r.kind === 'video' ? r.durationSec * 0.1 : 0;
		const tmp = this.tmpName(p.main);
		ctx.addPartial(tmp);
		await this.deps.ff.run(
			[
				...(at > 0 ? ['-ss', sec(at)] : []),
				'-i',
				src,
				'-frames:v',
				'1',
				'-vf',
				`scale=${POSTER_WIDTH}:-2`,
				'-q:v',
				'3',
				'-threads',
				String(ctx.slots),
				'-f',
				'image2',
				tmp,
			],
			{ signal: ctx.signal, onSpawn: ctx.trackChild },
		);
		await rename(tmp, p.main);
	}

	private async sprite(ctx: JobContext, r: MediaRecord, src: string, p: ArtifactPaths): Promise<void> {
		const dur = r.durationSec ?? 0;
		const interval = r.kind === 'animated-image' ? Math.max(dur / 20, 0.05) : Math.max(1, dur / 200); // S04:TH-002/004
		const expected = Math.max(1, Math.round(dur / interval));
		const display = r.display ?? { width: 16, height: 9 };
		const tileHeight = Math.max(2, 2 * Math.round((SPRITE_TILE_WIDTH * display.height) / display.width / 2));
		const rows = SPRITE_TILES_PER_SHEET / SPRITE_COLUMNS;
		const tmpDir = `${p.dir}.${Date.now().toString(36)}.partial`;
		ctx.addPartial(tmpDir);
		await mkdir(tmpDir, { recursive: true });
		await this.deps.ff.run(
			[
				'-i',
				src,
				'-an',
				'-vf',
				`fps=${(1 / interval).toFixed(6)},scale=${SPRITE_TILE_WIDTH}:${tileHeight},tile=${SPRITE_COLUMNS}x${rows}`,
				'-q:v',
				'4',
				'-threads',
				String(ctx.slots),
				'-start_number',
				'0',
				'-f',
				'image2',
				join(tmpDir, '%d.jpg'),
			],
			{
				signal: ctx.signal,
				onSpawn: ctx.trackChild,
				onProgress: (pr) => dur > 0 && ctx.progress(pr.outTimeUs / 1e6 / dur),
			},
		);
		const sheets = (await readdir(tmpDir)).filter((f) => /^\d+\.jpg$/.test(f)).length;
		const count = Math.min(expected, sheets * SPRITE_TILES_PER_SHEET);
		const tiles: SpriteIndex['tiles'] = [];
		for (let i = 0; i < count; i++) {
			tiles.push({
				sheet: Math.floor(i / SPRITE_TILES_PER_SHEET),
				index: i % SPRITE_TILES_PER_SHEET,
				timeSec: Number((i * interval).toFixed(6)),
			});
		}
		await rm(p.dir!, { recursive: true, force: true });
		await rename(tmpDir, p.dir!);
		const index: SpriteIndex & { version: 1; sheets: number; intervalSec: number } = {
			version: 1,
			tileWidth: SPRITE_TILE_WIDTH,
			tileHeight,
			columns: SPRITE_COLUMNS,
			sheets,
			intervalSec: interval,
			tiles,
		};
		await atomicWriteJson(p.main, index);
	}

	private async peaks(ctx: JobContext, r: MediaRecord, src: string, p: ArtifactPaths): Promise<void> {
		const audio = r.probe.streams.filter((s) => s.type === 'audio');
		if (audio.length === 0) throw new JobError('UNSUPPORTED_MEDIA', 'No audio stream', false);
		const tmpDir = `${p.dir}.${Date.now().toString(36)}.partial`;
		ctx.addPartial(tmpDir);
		await mkdir(tmpDir, { recursive: true });
		const hash = paramsHash('peaks');
		const streams: NonNullable<PeaksHeader['streams']> = [];
		let first: { channels: number; sampleCount: number; durationSec: number } | null = null;
		for (let k = 0; k < audio.length; k++) {
			const st = audio[k]!;
			const channels = Math.min(8, Math.max(1, st.type === 'audio' ? st.channels : 1));
			const child = this.deps.ff.spawnRaw(
				[
					'-i',
					src,
					'-map',
					`0:a:${k}`,
					'-vn',
					'-ac',
					String(channels),
					'-ar',
					String(PEAKS_SAMPLE_RATE),
					'-f',
					'f32le',
					'pipe:1',
				],
				{ signal: ctx.signal, onSpawn: ctx.trackChild },
			);
			const res = await reducePeaksFromChild(
				child,
				channels,
				PEAKS_SAMPLE_RATE / PEAKS_PER_SECOND,
				ctx.signal,
			);
			// Files and `streams[].index` use the container stream index, which is what audio clips store in
			// `channels.streamIndex` (S01:CLP-014), so the timeline finds `peaks/<streamIndex>.bin` directly.
			const streamIndex = st.index;
			await writeFile(join(tmpDir, `${streamIndex}.bin`), planarBytes(res.channels));
			const sampleCount = res.channels[0]?.length ?? 0;
			first ??= { channels, sampleCount, durationSec: res.frames / PEAKS_SAMPLE_RATE };
			streams.push({
				index: streamIndex,
				channels,
				url: `/media/${encodeURIComponent(r.mediaKey)}/peaks/${streamIndex}.bin?v=${hash}`,
			});
			ctx.progress((k + 1) / audio.length);
		}
		await rm(p.dir!, { recursive: true, force: true });
		await rename(tmpDir, p.dir!);
		const header: PeaksHeader & { version: 1; layout: 'planar-f32le' } = {
			version: 1,
			layout: 'planar-f32le',
			peaksPerSecond: PEAKS_PER_SECOND,
			channels: first!.channels,
			sampleCount: first!.sampleCount,
			durationSec: first!.durationSec,
			streams,
		};
		await atomicWriteJson(p.main, header);
	}

	private async proxy(
		ctx: JobContext,
		r: MediaRecord,
		src: string,
		p: ArtifactPaths,
		height: 720 | 540,
	): Promise<void> {
		const tmp = this.tmpName(p.main);
		ctx.addPartial(tmp);
		const dur = r.durationSec ?? 0;
		const choice = this.proxyChoice();
		if (!choice)
			throw new JobError(
				'ENCODER_UNAVAILABLE',
				'No usable video encoder for proxies (see capabilities)',
				false,
			);
		const vs = r.probe.streams.find((s) => s.type === 'video');
		const srcW = vs?.type === 'video' ? vs.width : (16 * height) / 9;
		const srcH = vs?.type === 'video' ? vs.height : height;
		const outH = Math.min(height, srcH || height);
		const outW = Math.max(2, Math.round(((srcW || outH) * outH) / (srcH || outH) / 2) * 2);
		const rate = vs?.type === 'video' && vs.frameRate ? vs.frameRate : { num: 30, den: 1 };
		const scale = `scale=w=-2:h='min(${height},ih)':flags=bicubic`;
		const deinterlace = r.interlaced ? ['yadif'] : [];
		let args: string[];
		if (this.alphaProxy(r)) {
			// Alpha sources: VP9 yuva420p in WebM (see ALPHA_PROXY_ENCODER). WebM alpha inputs need libvpx to
			// decode their alpha; WebM audio is Opus.
			const dec = alphaDecoder(r.probe);
			const opus = this.deps.encoders?.has('libopus') ?? false;
			args = [
				...(dec ? ['-c:v', dec] : []),
				'-i',
				src,
				'-map',
				'0:v:0',
				...(opus ? ['-map', '0:a:0?'] : ['-an']),
				'-vf',
				[...deinterlace, scale, 'format=yuva420p'].join(','),
				'-c:v',
				ALPHA_PROXY_ENCODER,
				'-pix_fmt',
				'yuva420p',
				'-b:v',
				'0',
				'-crf',
				String(height === 720 ? 30 : 34),
				'-deadline',
				'realtime',
				'-cpu-used',
				'8',
				'-row-mt',
				'1',
				'-auto-alt-ref',
				'0',
				'-g',
				'15',
				'-threads',
				String(Math.max(1, ctx.slots)),
				...(opus ? [...audioEncodeArgs('libopus', 128), '-ac', '2', '-ar', '48000'] : []),
				'-f',
				'webm',
				tmp,
			];
		} else {
			const enc = videoEncodeArgs(choice, {
				crf: height === 720 ? 23 : 26,
				speed: height === 720 ? 'balanced' : 'fast',
				width: outW,
				height: outH,
				fps: rate,
				gop: 15,
				realtime: true,
				threads: ctx.slots,
			});
			args = [
				...enc.pre,
				'-i',
				src,
				'-map',
				'0:v:0',
				'-map',
				'0:a:0?',
				'-vf',
				[...deinterlace, scale, ...enc.filters].join(','),
				...enc.video,
				// Proxies are always MP4 (VP9/AV1 in MP4 play in Chromium) with AAC audio.
				...audioEncodeArgs('aac', 128),
				'-ac',
				'2',
				'-ar',
				'48000',
				'-movflags',
				'+faststart',
				'-f',
				'mp4',
				tmp,
			];
		}
		await this.deps.ff.run(args, {
			signal: ctx.signal,
			onSpawn: ctx.trackChild,
			nice: 10,
			onProgress: (pr) => {
				if (dur <= 0) return;
				const done = pr.outTimeUs / 1e6;
				ctx.progress(done / dur, {
					...(pr.speed ? { speed: pr.speed, etaSec: (dur - done) / pr.speed } : {}),
				});
			},
		});
		await rename(tmp, p.main);
	}
}
