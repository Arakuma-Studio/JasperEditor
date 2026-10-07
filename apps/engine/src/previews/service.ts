// Render previews (workstream `previews`, docs/wp-notes/previews.md): Sequence ▸ Render Effects In to Out / Render In
// to Out / Render Selection / Render Audio, Delete Render Files, and the files the render bar turns green for.
//
// A video preview is the export of one segment (`previewSegments`, @jasper/project) through the export service's own
// paths (native, hybrid, Remotion — the picture the export would write), picture only, in the sequence's preview
// format; an audio preview is the offline mix of one audio segment as a float WAV. Files are named by the segment's
// content hash and live in one directory per preview format and renderer version:
//
//   <appdir>/cache/previews/<formatKey>/<hash>.mp4 | <hash>.webm | <hash>.wav
//
// Writes are atomic: the render goes to `<hash>.part.<ext>`, is flushed to disk, then renamed — a crash or a cancel
// never leaves a file that looks valid (the cache scan sweeps the partials). An edit changes the hashes of the
// segments it touches, so their files are simply no longer asked for; undo asks for them again.
import { createHash } from 'node:crypto';
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type {
	EngineJob,
	ExportStartRequest,
	PreviewDeleteRequest,
	PreviewRenderRequest,
	PreviewRenderResult,
	PreviewSettings,
	PreviewStatus,
	PreviewStatusRequest,
} from '@jasper/api';
import { PreviewRenderRequestSchema, PreviewSettingsSchema, PreviewStatusRequestSchema } from '@jasper/api';
import {
	audioPreviewSegments,
	isPreviewHash,
	PREVIEW_HASH_VERSION,
	type ProjectDocument,
	previewSegments,
	previewSettingsOf,
	type RenderAudioPreviewSegment,
	type RenderPreviewSegment,
} from '@jasper/project';
import type { Broadcaster } from '../events/broadcaster.ts';
import type { ExportService } from '../export/service.ts';
import type { JobQueue } from '../jobs/queue.ts';
import { type JobContext, JobError } from '../jobs/types.ts';
import { ENGINE_VERSION } from '../version.ts';

/** Bits per pixel of a preview's video bitrate (I-frame-only needs ≈ 2.5× a 15-frame GOP for the same quality). */
const BPP = { 'h264-iframe': 0.6, h264: 0.25, vp9: 0.2 } as const;

/** Warnings of a segment's plan that would make its preview differ from the document once they clear. */
const UNSTABLE_WARNINGS: Record<string, string> = {
	OFFLINE_MEDIA: 'media offline',
	FONT_FALLBACK: 'a font is missing',
	UNKNOWN_TEXT_ANIMATION: 'a text animation is not installed',
	NEST_UNAVAILABLE: 'a nested sequence is unavailable',
};

type Deps = {
	cacheDir: string;
	exports: ExportService;
	queue: JobQueue;
	broadcaster: Broadcaster;
};

type Planned = {
	sequenceId: string;
	projectId?: string;
	settings: PreviewSettings;
	formatKey: string;
	video: { startFrame: number; frames: number; hash: string }[];
	audio: { startFrame: number; frames: number; hash: string }[];
	skipped: { startFrame: number; frames: number; reason: string }[];
	existing: number;
	envelope: PreviewRenderRequest['envelope'];
};

/** The preview file format key: settings, the hash layout and the renderer (an engine update re-renders). */
export function previewFormatKey(settings: PreviewSettings, rendererVersion = ENGINE_VERSION): string {
	return createHash('sha256')
		.update(
			JSON.stringify([
				PREVIEW_HASH_VERSION,
				rendererVersion,
				settings.format,
				settings.size,
				settings.quality,
			]),
		)
		.digest('hex')
		.slice(0, 16);
}

export function previewContainer(settings: Pick<PreviewSettings, 'format'>): 'mp4' | 'webm' {
	return settings.format === 'vp9' ? 'webm' : 'mp4';
}

const FILE_RE = /^([0-9a-f]{32})\.(mp4|webm|wav)$/;
const FORMAT_RE = /^[0-9a-f]{16}$/;

export class PreviewService {
	/** Hashes known to exist per format directory (filled from a directory listing, kept current by writes). */
	private readonly known = new Map<string, { names: Set<string>; at: number }>();

	constructor(private readonly deps: Deps) {}

	get root(): string {
		return join(this.deps.cacheDir, 'previews');
	}

	dirOf(formatKey: string): string {
		return join(this.root, formatKey);
	}

	/** The served path of a preview file. */
	urlOf(formatKey: string, name: string): string {
		return `/renders/previews/${formatKey}/${name}`;
	}

	/** The file behind a served name (validated), or null. */
	async file(formatKey: string, name: string): Promise<string | null> {
		if (!FORMAT_RE.test(formatKey) || !FILE_RE.test(name)) return null;
		const p = join(this.dirOf(formatKey), name);
		try {
			return (await stat(p)).isFile() ? p : null;
		} catch {
			return null;
		}
	}

	/**
	 * The file names of a format directory. Listings are reused for a second (the render bar asks on every commit);
	 * renders add to them, deletions and cache cleaning invalidate them.
	 */
	private async names(formatKey: string): Promise<Set<string>> {
		const hit = this.known.get(formatKey);
		if (hit && Date.now() - hit.at < 1000) return hit.names;
		const names = new Set<string>();
		try {
			for (const n of await readdir(this.dirOf(formatKey))) if (FILE_RE.test(n)) names.add(n);
		} catch {
			// no previews of this format yet
		}
		this.known.set(formatKey, { names, at: Date.now() });
		return names;
	}

	/** Forgets the directory listings (the cache removed files). */
	invalidate(): void {
		this.known.clear();
	}

	async status(body: PreviewStatusRequest): Promise<PreviewStatus> {
		const req = PreviewStatusRequestSchema.parse(body);
		const key = previewFormatKey(req.settings);
		const names = await this.names(key);
		const container = previewContainer(req.settings);
		const video = req.video.filter((h) => names.has(`${h}.${container}`));
		const audio = req.audio.filter((h) => names.has(`${h}.wav`));
		return {
			formatKey: key,
			video,
			audio,
			videoUrl: this.urlOf(key, `{hash}.${container}`),
			audioUrl: this.urlOf(key, '{hash}.wav'),
			container,
			size: req.settings.size,
		};
	}

	/** Every preview hash present (any format), for Delete Render Files and the cache references. */
	async delete(body: PreviewDeleteRequest): Promise<{ deleted: number; bytes: number }> {
		let deleted = 0;
		let bytes = 0;
		let formats: string[] = [];
		try {
			formats = (await readdir(this.root)).filter((f) => FORMAT_RE.test(f));
		} catch {
			return { deleted, bytes };
		}
		const want = 'all' in body ? null : new Set(body.hashes);
		for (const f of formats) {
			let names: string[] = [];
			try {
				names = await readdir(this.dirOf(f));
			} catch {
				continue;
			}
			for (const n of names) {
				const m = FILE_RE.exec(n);
				if (!m || (want && !want.has(m[1]!))) continue;
				const p = join(this.dirOf(f), n);
				try {
					const size = (await stat(p)).size;
					await rm(p, { force: true });
					deleted++;
					bytes += size;
				} catch {
					// raced with the cache
				}
			}
		}
		this.invalidate();
		this.deps.broadcaster.publish('previews.changed', { deleted });
		return { deleted, bytes };
	}

	/** Plans which segments a render command renders (everything else is reported, nothing is written). */
	async plan(body: PreviewRenderRequest): Promise<Planned> {
		const req = PreviewRenderRequestSchema.parse(body);
		const doc = req.envelope.document as unknown as ProjectDocument;
		const seq = doc?.sequences?.[req.sequenceId];
		if (!seq) throw new JobError('VALIDATION_FAILED', `Sequence ${req.sequenceId} not found`, false);
		const settings = PreviewSettingsSchema.parse(req.settings ?? previewSettingsOf(seq));
		const formatKey = previewFormatKey(settings);
		const names = await this.names(formatKey);
		const container = previewContainer(settings);
		const end = Object.values(seq.clips).reduce((m, c) => Math.max(m, c.start + c.duration), 0);
		const range = req.range ?? { start: seq.inPoint ?? 0, end: seq.outPoint ?? end };
		if (!(range.end > range.start))
			throw new JobError('VALIDATION_FAILED', 'The render range is empty', false);
		const inRange = (s: { startFrame: number; frames: number }) =>
			s.startFrame < range.end && s.startFrame + s.frames > range.start;
		let video: RenderPreviewSegment[] = [];
		let audio: RenderAudioPreviewSegment[] = [];
		let existing = 0;
		if (req.mode === 'audio') {
			audio = audioPreviewSegments(doc, req.sequenceId).filter(inRange);
			existing = audio.filter((s) => names.has(`${s.hash}.wav`)).length;
			audio = audio.filter((s) => !names.has(`${s.hash}.wav`));
		} else {
			const all = previewSegments(doc, req.sequenceId);
			const selected = new Set(req.clipIds ?? []);
			video = all.filter((s) =>
				req.mode === 'selection'
					? s.clipIds.some((id) => selected.has(id))
					: inRange(s) && (req.mode === 'all' || s.need !== 'none'),
			);
			existing = video.filter((s) => names.has(`${s.hash}.${container}`)).length;
			video = video.filter((s) => !names.has(`${s.hash}.${container}`));
		}
		// One file per hash: identical segments (copies) render once.
		const uniq = <T extends { hash: string }>(list: T[]) => {
			const seen = new Set<string>();
			return list.filter((s) => (seen.has(s.hash) ? false : (seen.add(s.hash), true)));
		};
		const pick = (s: { startFrame: number; frames: number; hash: string }) => ({
			startFrame: s.startFrame,
			frames: s.frames,
			hash: s.hash,
		});
		return {
			sequenceId: req.sequenceId,
			...(typeof doc.projectId === 'string' ? { projectId: doc.projectId } : {}),
			settings,
			formatKey,
			video: uniq(video).map(pick),
			audio: uniq(audio).map(pick),
			skipped: [],
			existing,
			envelope: req.envelope,
		};
	}

	/** Submits a `preview` job (or returns null when everything in the range is already rendered). */
	async render(body: PreviewRenderRequest): Promise<{ job: EngineJob | null; planned: Planned }> {
		const planned = await this.plan(body);
		if (planned.video.length === 0 && planned.audio.length === 0) return { job: null, planned };
		const n = planned.video.length + planned.audio.length;
		const job = this.deps.queue.submit({
			kind: 'preview',
			title:
				planned.audio.length > 0
					? `Render Audio – ${n} segment${n === 1 ? '' : 's'}`
					: `Render Previews – ${n} segment${n === 1 ? '' : 's'}`,
			priority: 'user',
			cpuSlots: this.deps.queue.totalSlots,
			minSlots: Math.max(1, Math.ceil(this.deps.queue.totalSlots / 2)),
			...(planned.projectId ? { projectId: planned.projectId } : {}),
			stage: 'Queued',
			input: planned,
		});
		return { job, planned };
	}

	registerRunner(): void {
		this.deps.queue.registerRunner('preview', (ctx) => this.run(ctx));
	}

	/** The export request of one video segment in the preview format. */
	private segmentRequest(p: Planned, seg: { startFrame: number; frames: number }): ExportStartRequest {
		const doc = p.envelope.document as unknown as ProjectDocument;
		const seq = doc.sequences[p.sequenceId]!;
		const half = p.settings.size === 'half';
		const even = (x: number) => Math.max(2, Math.round(x / 2) * 2);
		const width = half ? even(seq.settings.width / 2) : even(seq.settings.width);
		const height = half ? even(seq.settings.height / 2) : even(seq.settings.height);
		const fps = seq.settings.frameRate;
		const bpp = BPP[p.settings.format] * (p.settings.quality === 'high' ? 1.8 : 1);
		const kbps = Math.round((width * height * (fps.num / fps.den) * bpp) / 1000);
		return {
			envelope: p.envelope,
			sequenceId: p.sequenceId,
			settings: {
				sequenceId: p.sequenceId,
				range: { type: 'custom', startFrame: seg.startFrame, endFrame: seg.startFrame + seg.frames },
				container: previewContainer(p.settings),
				video: {
					codec: p.settings.format === 'vp9' ? 'vp9' : 'h264',
					width,
					height,
					frameRate: { num: fps.num, den: fps.den },
					scaling: 'stretch',
					quality: { mode: 'crf', value: p.settings.quality === 'high' ? 12 : 17 },
					bitrateKbps: Math.min(500_000, Math.max(100, kbps)),
					encoderSpeed: 'fast',
					colorTags: 'rec709',
					keyframeInterval: p.settings.format === 'h264-iframe' ? 1 : 15,
				},
				engine: 'auto',
				destination: { type: 'download' },
				videoOnly: true,
			},
		} as ExportStartRequest;
	}

	/** The audio export request of one audio segment: stereo at the sequence rate (what the monitor plays). */
	private audioRequest(p: Planned, seg: { startFrame: number; frames: number }): ExportStartRequest {
		const doc = p.envelope.document as unknown as ProjectDocument;
		const seq = doc.sequences[p.sequenceId]!;
		const sr = (seq.settings as { sampleRate?: number }).sampleRate;
		return {
			envelope: p.envelope,
			sequenceId: p.sequenceId,
			settings: {
				sequenceId: p.sequenceId,
				range: { type: 'custom', startFrame: seg.startFrame, endFrame: seg.startFrame + seg.frames },
				container: 'mov',
				audio: {
					codec: 'pcm',
					sampleRate: sr === 44100 || sr === 96000 ? sr : 48000,
					channels: 2,
				},
				engine: 'auto',
				destination: { type: 'download' },
			},
		} as ExportStartRequest;
	}

	/** Writes `produce(part)` atomically as `final` (fsync, then rename). */
	private async atomic(
		final: string,
		part: string,
		ctx: JobContext,
		produce: () => Promise<void>,
	): Promise<number> {
		ctx.addPartial(part);
		await rm(part, { force: true });
		await produce();
		const fh = await open(part, 'r');
		try {
			await fh.sync();
		} finally {
			await fh.close();
		}
		const size = (await stat(part)).size;
		await rename(part, final);
		return size;
	}

	private async run(ctx: JobContext): Promise<PreviewRenderResult> {
		const p = ctx.input as Planned;
		const t0 = Date.now();
		const dir = this.dirOf(p.formatKey);
		await mkdir(dir, { recursive: true });
		const names = await this.names(p.formatKey);
		const container = previewContainer(p.settings);
		const rendered: PreviewRenderResult['rendered'] = [];
		const skipped: PreviewRenderResult['skipped'] = [...p.skipped];
		const paths: Record<string, number> = {};
		let frames = 0;
		let bytes = 0;
		const total = [...p.video, ...p.audio].reduce((n, s) => n + s.frames, 0) || 1;
		let done = 0;
		const sub = (k: number, label: string): JobContext => ({
			...ctx,
			progress: (v, extra) =>
				ctx.progress((done + (v ?? 0) * p.video.concat(p.audio)[k]!.frames) / total, {
					...extra,
					stage: `${label} · ${extra?.stage ?? ''}`.replace(/ · $/, ''),
				}),
		});
		const list = [
			...p.video.map((s) => ({ ...s, kind: 'video' as const })),
			...p.audio.map((s) => ({ ...s, kind: 'audio' as const })),
		];
		for (const [k, seg] of list.entries()) {
			if (ctx.signal.aborted) throw new JobError('CANCELLED', 'Cancelled', true);
			const label = `Segment ${k + 1}/${list.length}`;
			const ext = seg.kind === 'audio' ? 'wav' : container;
			const name = `${seg.hash}.${ext}`;
			if (names.has(name)) {
				done += seg.frames;
				continue;
			}
			const final = join(dir, name);
			const part = join(dir, `${seg.hash}.part.${ext}`);
			const req = seg.kind === 'audio' ? this.audioRequest(p, seg) : this.segmentRequest(p, seg);
			// A segment whose picture depends on something unavailable (offline media, a missing font) is not
			// rendered: the file would keep the fallback after the media comes back (its hash would not change).
			const plan = await this.deps.exports.plan(req).catch((e: Error) => e);
			if (plan instanceof Error) {
				skipped.push({ startFrame: seg.startFrame, frames: seg.frames, reason: plan.message });
				done += seg.frames;
				continue;
			}
			const unstable = plan.plan.warnings.find((w) => UNSTABLE_WARNINGS[w.code]);
			if (unstable) {
				skipped.push({
					startFrame: seg.startFrame,
					frames: seg.frames,
					reason: `${UNSTABLE_WARNINGS[unstable.code]}: ${unstable.message}`,
				});
				done += seg.frames;
				continue;
			}
			ctx.log(`${label}: frames ${seg.startFrame}–${seg.startFrame + seg.frames} → ${name}`);
			const size = await this.atomic(final, part, ctx, async () => {
				if (seg.kind === 'audio') {
					await this.deps.exports.mixdownToFile(sub(k, label), req, part);
					paths.mix = (paths.mix ?? 0) + 1;
				} else {
					const r = await this.deps.exports.renderToFile(sub(k, label), req, part);
					paths[r.renderPath] = (paths[r.renderPath] ?? 0) + 1;
					frames += r.frames;
				}
			});
			names.add(name);
			bytes += size;
			done += seg.frames;
			rendered.push({ hash: seg.hash, startFrame: seg.startFrame, frames: seg.frames });
			this.deps.broadcaster.publish(
				'previews.changed',
				{ formatKey: p.formatKey, hash: seg.hash, kind: seg.kind, sequenceId: p.sequenceId },
				p.projectId,
			);
			ctx.progress(done / total, { stage: `${label} done` });
		}
		return {
			formatKey: p.formatKey,
			rendered,
			existing: p.existing,
			skipped,
			frames,
			seconds: (Date.now() - t0) / 1000,
			bytes,
			paths,
		};
	}
}

export { isPreviewHash };
