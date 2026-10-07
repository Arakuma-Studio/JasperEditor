// Interpreted pictures (imports workstream): what the engine makes so that browsers (the Program monitor, Remotion
// renders, layer bakes) show exactly the pixels the native export decodes.
// - `display`: a still as a full-size straight-alpha PNG (16-bit when deeper than 8 bits) — every still format a
//   browser cannot decode (TIFF, EXR, DPX, TGA, HEIF, JPEG XL, PSD…) and every still with a pixel interpretation;
// - `proxy`: a 720p preview of a video with a pixel interpretation (deinterlaced with the conformed field order,
//   alpha unpremultiplied / ignored / inverted) — VP9 with alpha when the result has alpha, else the proxy codec;
// - `master`: the same at full size in ProRes (4444 with alpha, 422 HQ without) for the Remotion render path.
// Cached content-addressed under `<cache>/<fingerprint>/variant-<kind>-<hash>.<ext>` (the hash covers the generator
// version and the variant), made by `interpret` jobs, announced with `media.variant.ready`.
import { createHash } from 'node:crypto';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { EngineJob, MediaVariantKind, MediaVariantStatus } from '@jasper/api';
import { type PixelInterpretation, parsePixelVariant } from '@jasper/project';
import type { Broadcaster } from '../events/broadcaster.ts';
import type { JobQueue } from '../jobs/queue.ts';
import { type JobContext, JobError } from '../jobs/types.ts';
import { alphaDecoder } from '../media/alpha.ts';
import { fingerprintHex } from '../media/fingerprint.ts';
import type { MediaRecord, MediaRegistry } from '../media/registry.ts';
import { audioEncodeArgs, type EncoderService, videoEncodeArgs } from '../tools/encoders.ts';
import type { Ffmpeg } from '../tools/ffmpeg.ts';
import { exists } from '../tools/fs.ts';
import { decoderArgs, isDeep, sourceFilters } from './decode.ts';
import { writeRgbaPng } from './png.ts';
import { psdComposite, readPsdFile } from './psd.ts';

/** Generator versions (bumping one invalidates that kind's cache). */
const VERSIONS: Record<MediaVariantKind, number> = { display: 1, proxy: 1, master: 1 };
const EXT: Record<MediaVariantKind, string> = { display: 'png', proxy: 'mp4', master: 'mov' };
const SLOTS: Record<MediaVariantKind, number> = { display: 1, proxy: 4, master: 4 };
const PROXY_HEIGHT = 720;

type JobInput = { mediaKey: string; kind: MediaVariantKind; variant: string };

export class VariantError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = 'VariantError';
	}
}

/** Whether a variant kind applies to a media record (display: stills; proxy / master: videos). */
export function variantApplies(
	r: Pick<MediaRecord, 'kind' | 'vector' | 'lottie'>,
	kind: MediaVariantKind,
): boolean {
	if (r.vector || r.lottie) return false;
	return kind === 'display' ? r.kind === 'image' : r.kind === 'video';
}

/** The pixels of the interpreted picture have alpha (decides WebM/ProRes 4444 vs MP4/422). */
export function variantHasAlpha(r: Pick<MediaRecord, 'probe'>, pixel: PixelInterpretation | null): boolean {
	const a = pixel?.alpha;
	if (a?.invert) return true;
	if (a?.mode === 'ignore') return false;
	return r.probe.hasAlpha;
}

export class VariantService {
	private readonly failures = new Map<string, string>();

	constructor(
		private readonly deps: {
			cacheDir: string;
			ff: Ffmpeg;
			encoders?: EncoderService;
			queue: JobQueue;
			registry: MediaRegistry;
			broadcaster: Broadcaster;
		},
	) {}

	registerRunners(): void {
		this.deps.queue.registerRunner('interpret', (ctx) => this.run(ctx));
	}

	/** Validates a request: the variant parses and applies to the record. */
	check(r: MediaRecord, kind: MediaVariantKind, variant: string): PixelInterpretation | null {
		if (!variantApplies(r, kind))
			throw new VariantError('BAD_REQUEST', `A ${kind} picture does not apply to ${r.kind} media`);
		const pixel = parsePixelVariant(variant);
		if (variant !== '' && !pixel)
			throw new VariantError('BAD_REQUEST', `Malformed variant "${variant.slice(0, 80)}"`);
		if (kind !== 'display' && !pixel)
			throw new VariantError('BAD_REQUEST', 'Videos without an interpretation use the regular proxies');
		return pixel;
	}

	private hash(kind: MediaVariantKind, variant: string, r: Pick<MediaRecord, 'probe'>): string {
		const alpha = kind !== 'display' && variantHasAlpha(r, parsePixelVariant(variant));
		return createHash('sha256')
			.update(JSON.stringify({ kind, v: VERSIONS[kind], variant, alpha }))
			.digest('hex')
			.slice(0, 12);
	}

	path(r: MediaRecord, kind: MediaVariantKind, variant: string): string {
		const alpha = kind === 'proxy' && variantHasAlpha(r, parsePixelVariant(variant));
		const ext = alpha ? 'webm' : EXT[kind];
		return join(
			this.deps.cacheDir,
			fingerprintHex(r.fingerprint),
			`variant-${kind}-${this.hash(kind, variant, r)}.${ext}`,
		);
	}

	url(r: MediaRecord, kind: MediaVariantKind, variant: string): string {
		const q = new URLSearchParams({ v: variant, h: this.hash(kind, variant, r) });
		return `/media/${encodeURIComponent(r.mediaKey)}/variant/${kind}?${q.toString()}`;
	}

	private dedupeKey(r: MediaRecord, kind: MediaVariantKind, variant: string): string {
		return `interpret:${kind}:${fingerprintHex(r.fingerprint)}:${this.hash(kind, variant, r)}`;
	}

	async isReady(r: MediaRecord, kind: MediaVariantKind, variant: string): Promise<boolean> {
		return exists(this.path(r, kind, variant));
	}

	async status(r: MediaRecord, kind: MediaVariantKind, variant: string): Promise<MediaVariantStatus> {
		this.check(r, kind, variant);
		if (await this.isReady(r, kind, variant)) return { state: 'ready', url: this.url(r, kind, variant) };
		const dk = this.dedupeKey(r, kind, variant);
		const job = this.deps.queue.list({ active: true }).find((j) => j.dedupeKey === dk);
		if (job) return { state: job.state === 'queued' ? 'queued' : 'running', jobId: job.id };
		const err = this.failures.get(dk);
		return err ? { state: 'failed', error: err } : { state: 'queued' };
	}

	/** Queues the job making the picture (deduplicated); null when it already exists. */
	async ensure(
		r: MediaRecord,
		kind: MediaVariantKind,
		variant: string,
		opts: {
			projectId?: string;
			priority?: 'interactive' | 'user' | 'background';
			retry?: boolean;
			/** A child of a running export / still: no CPU slots of its own (the parent holds them). */
			parentId?: string;
		} = {},
	): Promise<EngineJob | null> {
		this.check(r, kind, variant);
		if (await this.isReady(r, kind, variant)) return null;
		const dk = this.dedupeKey(r, kind, variant);
		if (this.failures.has(dk) && !opts.retry) return null;
		this.failures.delete(dk);
		const label =
			kind === 'display' ? 'Display picture' : kind === 'proxy' ? 'Interpreted proxy' : 'Interpreted master';
		return this.deps.queue.submit({
			kind: 'interpret',
			title: `${label} – ${r.originalName}`,
			priority: opts.priority ?? (kind === 'display' ? 'interactive' : 'background'),
			...(opts.parentId ? { cpuSlots: 0, minSlots: 0, parentId: opts.parentId } : { cpuSlots: SLOTS[kind] }),
			origin: { type: 'system' },
			assetId: r.mediaKey,
			...(opts.projectId ? { projectId: opts.projectId } : {}),
			dedupeKey: opts.parentId ? `${dk}:${opts.parentId}` : dk,
			input: { mediaKey: r.mediaKey, kind, variant } satisfies JobInput,
		});
	}

	/**
	 * Makes the picture if needed and waits for it (export preparation: pass the export job as `parentId`: the child
	 * runs within the parent's CPU slots). Returns its path.
	 */
	async ensureAndWait(
		r: MediaRecord,
		kind: MediaVariantKind,
		variant: string,
		signal?: AbortSignal,
		parentId?: string,
	): Promise<string> {
		const job = await this.ensure(r, kind, variant, {
			priority: 'user',
			retry: true,
			...(parentId ? { parentId } : {}),
		});
		if (job) {
			const onAbort = () => this.deps.queue.cancel(job.id);
			signal?.addEventListener('abort', onAbort, { once: true });
			try {
				const done = await this.deps.queue.wait(job.id);
				if (done.state !== 'succeeded')
					throw new JobError(
						done.error?.code ?? 'INTERPRET_FAILED',
						`Cannot make the ${kind} picture of ${r.originalName}: ${done.error?.message ?? done.state}`,
						false,
					);
			} finally {
				signal?.removeEventListener('abort', onAbort);
			}
		}
		const p = this.path(r, kind, variant);
		if (!(await exists(p)))
			throw new JobError('INTERPRET_FAILED', `The ${kind} picture of ${r.originalName} is missing`, true);
		return p;
	}

	// ------------------------------------------------------------------ runner

	private async run(ctx: JobContext): Promise<unknown> {
		const input = ctx.input as JobInput;
		const r = this.deps.registry.get(input.mediaKey);
		if (!r) throw new JobError('ASSET_NOT_FOUND', `Unknown media ${input.mediaKey}`, false);
		const pixel = this.check(r, input.kind, input.variant);
		const out = this.path(r, input.kind, input.variant);
		const dk = this.dedupeKey(r, input.kind, input.variant);
		if (!(await exists(out))) {
			const src = await this.deps.registry.resolvePath(r.mediaKey);
			if (!src) throw new JobError('ASSET_NOT_FOUND', `Media ${r.originalName} is offline`, true);
			await mkdir(dirname(out), { recursive: true });
			const tmp = `${out}.${Date.now().toString(36)}.partial${out.slice(out.lastIndexOf('.'))}`;
			ctx.addPartial(tmp);
			try {
				if (input.kind === 'display') await this.display(ctx, r, src, pixel, tmp);
				else await this.video(ctx, r, src, pixel, input.kind, tmp);
				await rename(tmp, out);
			} catch (e) {
				await rm(tmp, { force: true });
				if (!ctx.signal.aborted) this.failures.set(dk, (e as Error).message.slice(0, 500));
				throw e;
			}
		}
		this.failures.delete(dk);
		const url = this.url(r, input.kind, input.variant);
		this.deps.broadcaster.publish('media.variant.ready', {
			mediaKey: r.mediaKey,
			kind: input.kind,
			variant: input.variant,
			url,
		});
		return { mediaKey: r.mediaKey, kind: input.kind, variant: input.variant, url };
	}

	private async display(
		ctx: JobContext,
		r: MediaRecord,
		src: string,
		pixel: PixelInterpretation | null,
		out: string,
	): Promise<void> {
		const deep = isDeep(r) || (r.layered?.bitDepth ?? 8) > 8;
		const fmt = deep ? 'rgba64be' : 'rgba';
		const spawn = { signal: ctx.signal, onSpawn: ctx.trackChild };
		let input = src;
		let pre = decoderArgs(r);
		let filters = sourceFilters(r, pixel);
		let composite: string | null = null;
		if (r.layered) {
			// Photoshop documents: ag-psd's composite (or our own compositing of the layers) instead of ffmpeg's decoder.
			const psd = await readPsdFile(src, { images: true });
			const { image } = psdComposite(psd);
			composite = `${out}.composite.png`;
			ctx.addPartial(composite);
			await writeRgbaPng(this.deps.ff, image, composite, spawn);
			input = composite;
			pre = [];
			filters = sourceFilters({ ...r, probe: { ...r.probe, streams: [] } }, pixel);
		}
		try {
			await this.deps.ff.run(
				[
					...pre,
					'-i',
					input,
					'-map',
					'0:v:0',
					'-frames:v',
					'1',
					'-vf',
					[...filters, `format=${fmt}`].join(','),
					'-c:v',
					'png',
					'-pix_fmt',
					fmt,
					'-f',
					'image2',
					out,
				],
				spawn,
			);
		} finally {
			if (composite) await rm(composite, { force: true });
		}
	}

	private async video(
		ctx: JobContext,
		r: MediaRecord,
		src: string,
		pixel: PixelInterpretation | null,
		kind: 'proxy' | 'master',
		out: string,
	): Promise<void> {
		const alpha = variantHasAlpha(r, pixel);
		const dec = alphaDecoder(r.probe);
		const dur = r.durationSec ?? 0;
		const vs = r.probe.streams.find((s) => s.type === 'video');
		const rate = vs?.type === 'video' ? vs.frameRate : { num: 30, den: 1 };
		const filters = sourceFilters(r, pixel);
		const common = [...(dec ? ['-c:v', dec] : []), ...decoderArgs(r), '-i', src, '-map', '0:v:0'];
		let args: string[];
		if (kind === 'master') {
			args = [
				...common,
				'-an',
				'-vf',
				[...filters, `format=${alpha ? 'yuva444p10le' : 'yuv422p10le'}`].join(','),
				'-c:v',
				'prores_ks',
				'-profile:v',
				alpha ? '4' : '3',
				'-vendor',
				'apl0',
				'-pix_fmt',
				alpha ? 'yuva444p10le' : 'yuv422p10le',
				'-threads',
				String(Math.max(1, ctx.slots)),
				'-f',
				'mov',
				out,
			];
		} else {
			const scale = `scale=w=-2:h='min(${PROXY_HEIGHT},ih)':flags=bicubic`;
			if (alpha) {
				const opus = this.deps.encoders?.has('libopus') ?? false;
				args = [
					...common,
					...(opus ? ['-map', '0:a:0?'] : ['-an']),
					'-vf',
					[...filters, scale, 'format=yuva420p'].join(','),
					'-c:v',
					'libvpx-vp9',
					'-pix_fmt',
					'yuva420p',
					'-b:v',
					'0',
					'-crf',
					'30',
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
					out,
				];
			} else {
				const choice = this.deps.encoders
					? this.deps.encoders.select({ purpose: 'proxy' })
					: ({ codec: 'h264', encoder: 'libx264', audioEncoder: 'aac', container: 'mp4' } as const);
				if (!choice) throw new JobError('ENCODER_UNAVAILABLE', 'No usable video encoder for proxies', false);
				const srcW = vs?.type === 'video' ? vs.width : 1280;
				const srcH = vs?.type === 'video' ? vs.height : 720;
				const outH = Math.min(PROXY_HEIGHT, srcH);
				const outW = Math.max(2, Math.round((srcW * outH) / srcH / 2) * 2);
				const enc = videoEncodeArgs(choice, {
					crf: 23,
					speed: 'balanced',
					width: outW,
					height: outH,
					fps: rate,
					gop: 15,
					realtime: true,
					threads: ctx.slots,
				});
				args = [
					...enc.pre,
					...common,
					'-map',
					'0:a:0?',
					'-vf',
					[...filters, scale, ...enc.filters].join(','),
					...enc.video,
					...audioEncodeArgs('aac', 128),
					'-ac',
					'2',
					'-ar',
					'48000',
					'-movflags',
					'+faststart',
					'-f',
					'mp4',
					out,
				];
			}
		}
		await this.deps.ff.run(args, {
			signal: ctx.signal,
			onSpawn: ctx.trackChild,
			nice: 10,
			onProgress: (pr) => {
				if (dur > 0) ctx.progress(Math.min(1, pr.outTimeUs / 1e6 / dur));
			},
		});
	}
}
