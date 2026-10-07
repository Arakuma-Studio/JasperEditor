// Image sequences on the engine (imports workstream): numbered stills become one video media. The frames are
// conformed once into a lossless intermediate (FFV1 in Matroska, every frame a keyframe; 16-bit RGB(A) for deeper
// sources, EXR / HDR through the sRGB transfer like stills) at the chosen frame rate; numbers missing inside the range
// hold the previous frame. The intermediate is then ordinary media for every feature (proxies, filmstrips, retime,
// tracking, every export path) and Interpret Footage can assume another frame rate later.
import { createHash } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type {
	EngineJob,
	ImageSequenceDetectResponse,
	ImageSequenceRequest,
	RegisteredMedia,
} from '@jasper/api';
import {
	groupImageSequences,
	type ImageSequenceGroup,
	type ImageSequenceInfo,
	parseFrameName,
	type Rational,
	sequenceFrameFiles,
} from '@jasper/project';
import type { JobQueue } from '../jobs/queue.ts';
import { type JobContext, JobError } from '../jobs/types.ts';
import { probeWithFfprobe } from '../media/probe.ts';
import type { MediaService } from '../media/service.ts';
import type { Ffmpeg } from '../tools/ffmpeg.ts';
import { safeFileName } from '../tools/fs.ts';
import type { UploadService } from '../uploads/service.ts';
import { decodeFilters, decoderArgs } from './decode.ts';

/** Bump to re-conform cached intermediates. */
const CONFORM_VERSION = 2;
const MAX_DIR_ENTRIES = 1_000_000;

type JobInput = {
	frames: string[];
	group: Pick<ImageSequenceGroup, 'first' | 'last' | 'missing' | 'missingCount' | 'pattern' | 'label'>;
	directory: string | null;
	frameRate: Rational;
	name: string;
	projectId?: string;
	/** Staged uploads to delete afterwards. */
	staging?: string;
};

export class ImageSequenceError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
	) {
		super(message);
		this.name = 'ImageSequenceError';
	}
}

/** The sequence `path` belongs to (its numbered siblings in the same folder). */
export async function detectSequence(
	path: string,
): Promise<{ group: ImageSequenceGroup; directory: string }> {
	const abs = resolve(path);
	const f = parseFrameName(basename(abs));
	if (!f) throw new ImageSequenceError('NOT_A_SEQUENCE', `${basename(abs)} has no frame number`);
	const directory = dirname(abs);
	let names: string[];
	try {
		names = (await readdir(directory)).slice(0, MAX_DIR_ENTRIES);
	} catch {
		throw new ImageSequenceError('ASSET_NOT_FOUND', 'The folder cannot be read', 404);
	}
	const { sequences } = groupImageSequences(names);
	const group = sequences.find((g) => g.frames.some((x) => x.name === basename(abs)));
	if (!group) throw new ImageSequenceError('NOT_A_SEQUENCE', `${basename(abs)} has no numbered siblings`);
	return { group, directory };
}

export function detectResponse(group: ImageSequenceGroup, directory: string): ImageSequenceDetectResponse {
	return {
		pattern: group.label,
		directory,
		first: group.first,
		last: group.last,
		count: group.frames.length,
		missing: group.missing,
	};
}

const validRate = (r: Rational) =>
	Number.isInteger(r.num) &&
	Number.isInteger(r.den) &&
	r.num > 0 &&
	r.den > 0 &&
	r.num / r.den >= 1 &&
	r.num / r.den <= 1000;

export class ImageSequenceService {
	constructor(
		private readonly deps: {
			mediaDir: string;
			ff: Ffmpeg;
			queue: JobQueue;
			media: MediaService;
			uploads: UploadService;
		},
	) {}

	registerRunners(): void {
		this.deps.queue.registerRunner('image-sequence', (ctx) => this.run(ctx));
	}

	/** Resolves the request into frames and queues the conform job. */
	async submit(req: ImageSequenceRequest): Promise<EngineJob> {
		if (!validRate(req.frameRate))
			throw new ImageSequenceError('BAD_REQUEST', 'Frame rate must be 1…1000 fps');
		let group: ImageSequenceGroup;
		let directory: string | null = null;
		let byName: Map<string, string>;
		let staging: string | undefined;
		if (req.path) {
			const d = await detectSequence(req.path);
			group = d.group;
			directory = d.directory;
			byName = new Map(group.frames.map((x) => [x.name, join(d.directory, x.name)]));
		} else if (req.paths) {
			const abs = req.paths.map((p) => resolve(p));
			const { sequences } = groupImageSequences(abs.map((p) => basename(p)));
			if (sequences.length !== 1)
				throw new ImageSequenceError(
					'NOT_A_SEQUENCE',
					sequences.length === 0
						? 'The files are not numbered frames of one sequence'
						: 'The files form several sequences: import them one by one',
				);
			group = sequences[0]!;
			byName = new Map(abs.map((p) => [basename(p), p]));
			const dirs = new Set(abs.map((p) => dirname(p)));
			directory = dirs.size === 1 ? [...dirs][0]! : null;
		} else {
			// Uploaded frames: moved into a staging folder under their own names (decoders detect some formats by name).
			staging = join(
				this.deps.mediaDir,
				'sequences',
				`staging-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
			);
			await mkdir(staging, { recursive: true });
			byName = new Map();
			try {
				for (const id of req.uploadIds ?? []) {
					const t = await this.deps.uploads.take(id, 'sequence-frame');
					const name = safeFileName(t.fileName, 'frame');
					const dest = join(staging, name);
					await rename(t.file, dest);
					await t.release();
					byName.set(name, dest);
				}
			} catch (e) {
				await rm(staging, { recursive: true, force: true });
				throw e;
			}
			const { sequences } = groupImageSequences([...byName.keys()]);
			if (sequences.length !== 1) {
				await rm(staging, { recursive: true, force: true });
				throw new ImageSequenceError(
					'NOT_A_SEQUENCE',
					'The uploaded files are not numbered frames of one sequence',
				);
			}
			group = sequences[0]!;
		}
		const frames = sequenceFrameFiles(group).map((n) => byName.get(n)!);
		const name = req.name ?? group.label;
		return this.deps.queue.submit({
			kind: 'image-sequence',
			title: `Image sequence – ${name}`,
			priority: 'user',
			cpuSlots: 2,
			origin: { type: 'user' },
			...(req.projectId ? { projectId: req.projectId } : {}),
			input: {
				frames,
				group: {
					first: group.first,
					last: group.last,
					missing: group.missing,
					missingCount: group.missingCount,
					pattern: group.pattern,
					label: group.label,
				},
				directory,
				frameRate: { num: req.frameRate.num, den: req.frameRate.den },
				name,
				...(req.projectId ? { projectId: req.projectId } : {}),
				...(staging ? { staging } : {}),
			} satisfies JobInput,
		});
	}

	private async run(ctx: JobContext): Promise<RegisteredMedia> {
		const input = ctx.input as JobInput;
		try {
			return await this.conform(ctx, input);
		} finally {
			if (input.staging) await rm(input.staging, { recursive: true, force: true });
		}
	}

	private async conform(ctx: JobContext, input: JobInput): Promise<RegisteredMedia> {
		const frames = input.frames;
		if (frames.length === 0) throw new JobError('NOT_A_SEQUENCE', 'No frames', false);
		const first = frames[0]!;
		const probe = await probeWithFfprobe(this.deps.ff, first, {
			signal: ctx.signal,
			onSpawn: ctx.trackChild,
		}).catch((e: Error) => {
			throw new JobError(
				'UNSUPPORTED_MEDIA',
				`The first frame cannot be read: ${e.message.slice(0, 300)}`,
				false,
			);
		});
		if (probe.kind !== 'image')
			throw new JobError(
				'UNSUPPORTED_MEDIA',
				`${basename(first)} is not a still image (${probe.kind})`,
				false,
			);
		const vs = probe.probe.streams.find((s) => s.type === 'video');
		if (vs?.type !== 'video')
			throw new JobError('UNSUPPORTED_MEDIA', 'The first frame has no picture', false);
		const record = { kind: 'image', probe: probe.probe };
		// Content address: the frames (path, size, mtime), the rate and the conform version.
		const h = createHash('sha256');
		h.update(JSON.stringify({ v: CONFORM_VERSION, rate: input.frameRate }));
		for (const f of new Set(frames)) {
			const st = await stat(f).catch(() => null);
			if (!st?.isFile()) throw new JobError('ASSET_NOT_FOUND', `Frame missing: ${basename(f)}`, false);
			h.update(`${f}|${st.size}|${Math.round(st.mtimeMs)}\n`);
		}
		const key = h.digest('hex').slice(0, 32);
		const dir = join(this.deps.mediaDir, 'sequences');
		await mkdir(dir, { recursive: true });
		const out = join(dir, `${key}.mkv`);
		const exists = (await stat(out).catch(() => null))?.isFile();
		if (!exists) {
			const list = join(dir, `${key}.${Date.now().toString(36)}.ffconcat`);
			const tmp = join(dir, `${key}.${Date.now().toString(36)}.partial.mkv`);
			ctx.addPartial(list);
			ctx.addPartial(tmp);
			const fps = input.frameRate.num / input.frameRate.den;
			const step = (1 / fps).toFixed(9);
			const quote = (p: string) => `'${p.replace(/'/g, "'\\''")}'`;
			const lines = ['ffconcat version 1.0'];
			for (const f of frames) lines.push(`file ${quote(f)}`, `duration ${step}`);
			await writeFile(list, `${lines.join('\n')}\n`);
			const alpha = probe.probe.hasAlpha;
			const deep =
				vs.bitDepth > 8 || ['exr', 'hdr'].includes(vs.codec) || /(16|f32|f16|48|64)/.test(vs.pixelFormat);
			const gray = /^(gray|ya|monob|monow)/.test(vs.pixelFormat) && !alpha;
			const yuv = /^yuvj?4/.test(vs.pixelFormat) && !alpha && !deep;
			// (8-bit RGB is stored as `bgra`, not `bgr0`: Remotion's compositor cannot read `bgr0` FFV1.)
			const pix = alpha
				? deep
					? 'gbrap16le'
					: 'bgra'
				: deep
					? gray
						? 'gray16le'
						: 'gbrp16le'
					: gray
						? 'gray'
						: yuv
							? vs.pixelFormat.replace('yuvj', 'yuv')
							: 'bgra';
			const W = vs.width;
			const H = vs.height;
			try {
				await this.deps.ff.run(
					[
						...decoderArgs(record),
						'-f',
						'concat',
						'-safe',
						'0',
						'-i',
						list,
						'-map',
						'0:v:0',
						'-vf',
						[
							...decodeFilters(record),
							// Frames of another size are fitted into the first frame's size (transparent / black bars).
							`scale=${W}:${H}:force_original_aspect_ratio=decrease:eval=frame`,
							`pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black@0:eval=frame`,
							`fps=${input.frameRate.num}/${input.frameRate.den}`,
							`format=${pix}`,
						].join(','),
						'-fps_mode',
						'cfr',
						'-r',
						`${input.frameRate.num}/${input.frameRate.den}`,
						'-c:v',
						'ffv1',
						'-level',
						'3',
						'-g',
						'1',
						'-slices',
						'4',
						'-slicecrc',
						'1',
						...(yuv && vs.color.range === 'pc' ? ['-color_range', 'pc'] : []),
						'-frames:v',
						String(frames.length),
						'-f',
						'matroska',
						tmp,
					],
					{
						signal: ctx.signal,
						onSpawn: ctx.trackChild,
						onProgress: (pr) => ctx.progress(Math.min(1, ((pr.outTimeUs / 1e6) * fps) / frames.length)),
					},
				);
				const count = await this.deps.ff.countVideoFrames(tmp, { signal: ctx.signal });
				if (count !== frames.length)
					throw new JobError('FRAME_COUNT_MISMATCH', `Conformed ${count} of ${frames.length} frames`, true);
				await rename(tmp, out);
			} finally {
				await rm(list, { force: true });
				await rm(tmp, { force: true });
			}
		}
		const info: ImageSequenceInfo = {
			pattern: input.group.pattern,
			directory: input.directory,
			first: input.group.first,
			last: input.group.last,
			frames: frames.length,
			missing: input.group.missing,
			format: vs.codec,
			frameRate: input.frameRate,
		};
		const name = safeFileName(input.name, 'sequence').slice(0, 200) || basename(first, extname(first));
		return this.deps.media.registerProduced(out, {
			name,
			...(input.projectId ? { projectId: input.projectId } : {}),
			extras: { imageSequence: info },
		});
	}
}
