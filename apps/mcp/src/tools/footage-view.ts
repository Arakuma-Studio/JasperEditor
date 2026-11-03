// view_media_range (spec 18 §2.3 AF-VIEW-001…003; docs/wp-notes/agent-footage-view.md): one PNG of a media or sequence
// range — filmstrip, RMS waveform, words, silence bands, ruler — and the same facts as text. Media frames come from the
// engine's media frames route (registered media, local protocols, scaled during decode), sequence frames from the
// Program render path (`captureStill`, like render_frame); audio levels and voice classes from the engine's range-audio
// routes (the cached voice analysis when there is one); words from the document's transcripts. Media time is the
// media's content time (the transcript's timeline); a frame-rate or loop interpretation maps it to file time.
import {
	type MediaFramesResponse,
	RANGE_AUDIO_MAX_FILE_SECONDS,
	RANGE_VIEW_MAX_SECONDS,
	type RangeAudioResponse,
} from '@jasper/api';
import {
	FLICKS_PER_SECOND,
	filePieces,
	flicksPerFrame,
	type MediaAsset,
	type MediaTimeMap,
	mediaDurationFlicks,
	mediaTimeMap,
	type ProjectDocument,
	type Sequence,
	sequenceDuration,
	sequenceWords,
	transcriptForMedia,
} from '@jasper/project';
import { z } from 'zod';
import { ProjectIdArg, parseFriendlyTime } from '../arguments.ts';
import {
	captureStill,
	defineTool,
	type Extra,
	loadDoc,
	progressReporter,
	READ_ONLY,
	type ToolContext,
} from '../context.ts';
import { toolEnvelope } from '../envelope.ts';
import { ToolError } from '../errors.ts';
import { pickSequence, sequenceName } from '../format.ts';
import { decodePng, encodePng } from '../png.ts';
import {
	drawRangeView,
	frameBox,
	rangeSummary,
	silenceBands,
	slotTimes,
	VIEW_DEFAULT_FRAMES,
	VIEW_DEFAULT_WIDTH,
	VIEW_MAX_FRAMES,
	VIEW_MAX_WIDTH,
	VIEW_MIN_FRAMES,
	VIEW_MIN_WIDTH,
	type ViewAudio,
	type ViewFrame,
	type ViewWord,
} from '../range-view.ts';
import { failedJobError, renderToolError } from './templates.ts';

const F = FLICKS_PER_SECOND;
const TIME_HELP = 'Seconds (a number, e.g. 12.5) or "12.5s", "250ms", "1:02" (M:SS), "1:02:03" (H:MM:SS)';
const TimeArg = z.union([z.number().finite().min(0), z.string().min(1).max(32)]);
/** Kinds with a time range this tool views. */
const TIMED_KINDS = new Set(['video', 'audio', 'animated-image']);

/** Seconds of a time argument (never negative), or a coded error. */
export function secondsArg(v: number | string, name: string): number {
	const s = typeof v === 'number' ? v : parseFriendlyTime(v.trim());
	if (s === null || !Number.isFinite(s) || s < 0)
		throw new ToolError(
			'E_INVALID_PARAM',
			`${name}: not a time (${String(v).slice(0, 40)})`,
			`${TIME_HELP}.`,
		);
	return s;
}

/**
 * The requested range clamped to `[0, duration]`: `end` must be after `start`, the clamped range must not be empty
 * and at most RANGE_VIEW_MAX_SECONDS long.
 */
export function clampRange(
	start: number,
	end: number,
	duration: number,
	what: string,
): { start: number; end: number } {
	if (!(end > start))
		throw new ToolError(
			'E_INVALID_PARAM',
			`end (${end} s) must be after start (${start} s)`,
			'Give a range with end > start.',
		);
	const s = Math.max(0, Math.min(start, duration));
	const e = Math.min(end, duration);
	if (!(e > s))
		throw new ToolError(
			'E_INVALID_PARAM',
			`The range ${start}-${end} s is outside the ${what} (${Math.round(duration * 1000) / 1000} s long)`,
			`Pick a range inside 0-${Math.round(duration * 1000) / 1000} s.`,
		);
	if (e - s > RANGE_VIEW_MAX_SECONDS + 1e-9)
		throw new ToolError(
			'E_INVALID_PARAM',
			`The range is ${Math.round((e - s) * 100) / 100} s long; at most ${RANGE_VIEW_MAX_SECONDS} s at once`,
			`View it in windows of up to ${RANGE_VIEW_MAX_SECONDS} s (the digest or transcript tells you where to look).`,
		);
	return { start: s, end: e };
}

/** Content seconds → file seconds of a media (its frame-rate / loop interpretation). */
function fileTimeOf(map: MediaTimeMap | null): (t: number) => number {
	if (!map) return (t) => t;
	return (t) => {
		const p = filePieces(map, t * F, t * F + 1, 1)[0];
		return p ? p.fileFrom / F : t;
	};
}

/** The engine's 10 ms frames resampled onto the view's own 10 ms grid from `start` (`toSource`: view → source time). */
export function audioOnGrid(
	r: RangeAudioResponse,
	start: number,
	end: number,
	toSource: (t: number) => number,
): ViewAudio {
	const frameSec = 0.01;
	const n = Math.max(1, Math.ceil((end - start) / frameSec - 1e-9));
	const srcLevel = Buffer.from(r.level, 'base64');
	const srcClasses = Buffer.from(r.classes, 'base64');
	const count = Math.min(r.frameCount, srcLevel.length, srcClasses.length);
	const level = new Uint8Array(n);
	const classes = new Uint8Array(n);
	for (let i = 0; i < n; i++) {
		const j = Math.floor((toSource(start + (i + 0.5) * frameSec) - r.start) / r.frameSec);
		if (j >= 0 && j < count) {
			level[i] = srcLevel[j]!;
			classes[i] = srcClasses[j]!;
		}
	}
	return { start, frameSec, level, classes };
}

function engineKey(asset: MediaAsset, mediaId: string): string {
	const loc = asset.locators.find((l) => l.type === 'engine-store') as { key?: string } | undefined;
	if (!loc?.key)
		throw new ToolError(
			'E_INVALID_PARAM',
			`Media ${mediaId} is not stored by the engine`,
			'Re-import it with import_media.',
		);
	return loc.key;
}

/** Words of a transcript (flicks) that overlap `[start, end)` seconds, in seconds. */
function wordsIn(
	words: readonly { text: string; start: number; end: number }[],
	start: number,
	end: number,
): ViewWord[] {
	const out: ViewWord[] = [];
	for (const w of words) {
		const s = w.start / F;
		const e = Math.max(s, w.end / F);
		if (s < end && (e > start || (e === s && s >= start))) out.push({ text: w.text, start: s, end: e });
	}
	return out.sort((a, b) => a.start - b.start);
}

type View = {
	title: string;
	timeline: string;
	start: number;
	end: number;
	frames: ViewFrame[] | null;
	audio: ViewAudio | null;
	audioSource: { source: string; note?: string } | null;
	words: ViewWord[] | null;
};

const SOURCE_NAMES: Record<RangeAudioResponse['source'], string> = {
	'voice-analysis': 'the cached voice analysis',
	range: 'an analysis of this range',
	mix: 'the sequence mix (before loudness normalisation)',
};

function audioNote(r: RangeAudioResponse): { source: string; note?: string } {
	const lv = r.levels;
	return {
		source: SOURCE_NAMES[r.source],
		...(lv
			? {
					note: `noise floor ${Math.round(lv.floorDb)} dBFS, speech ${Math.round(lv.speechDb)} dBFS, speech threshold ${Math.round(lv.speechThresholdDb)} dBFS`,
				}
			: { note: 'digital silence' }),
	};
}

async function mediaView(
	ctx: ToolContext,
	extra: Extra,
	doc: ProjectDocument,
	mediaId: string,
	req: { start: number; end: number; frames: number; width: number },
): Promise<View> {
	const asset = (Object.hasOwn(doc.media, mediaId) ? doc.media[mediaId] : undefined) as
		| MediaAsset
		| undefined;
	if (!asset)
		throw new ToolError(
			'E_NOT_FOUND',
			`No media ${mediaId} in this project`,
			'Call list_media for media ids.',
		);
	if (!TIMED_KINDS.has(asset.kind))
		throw new ToolError(
			'E_UNSUPPORTED',
			`${asset.originalName} is ${asset.kind === 'image' ? 'a still image' : `a ${asset.kind}`}: it has no time range to view`,
			asset.kind === 'image'
				? 'Use render_frame on a sequence that shows it.'
				: 'Pick a video or audio media (list_media).',
		);
	const durFl = mediaDurationFlicks(asset);
	if (durFl === null || !(durFl > 0))
		throw new ToolError(
			'E_UNSUPPORTED',
			`${asset.originalName} has no duration`,
			'Pick a video or audio media.',
		);
	const hasVideo = asset.kind !== 'audio' && asset.probe.streams.some((s) => s.type === 'video');
	const hasAudio = asset.probe.streams.some((s) => s.type === 'audio');
	if (!hasVideo && !hasAudio)
		throw new ToolError(
			'E_UNSUPPORTED',
			`${asset.originalName} has neither picture nor sound`,
			'Pick another media.',
		);
	const { start, end } = clampRange(req.start, req.end, durFl / F, 'media');
	const mediaKey = engineKey(asset, mediaId);
	const map = mediaTimeMap(asset);
	const toFile = fileTimeOf(map);
	const report = progressReporter(extra);
	let frames: ViewFrame[] | null = null;
	if (hasVideo) {
		report(0, 3, 'Extracting frames');
		const times = slotTimes(start, end, req.frames);
		const r: MediaFramesResponse = await ctx.engine((c) =>
			c.call('mediaFrames', {
				params: { mediaKey },
				body: { times: times.map((t) => Math.max(0, toFile(t))), ...frameBox(req.width, req.frames) },
				signal: extra.signal,
			}),
		);
		frames = times.map((time, i) => {
			const f = r.frames[i];
			if (!f) return { time, image: null, note: 'missing' };
			if (!('png' in f)) return { time, image: null, note: f.error.code };
			try {
				return { time, image: decodePng(Buffer.from(f.png, 'base64')) };
			} catch {
				return { time, image: null, note: 'undecodable' };
			}
		});
	}
	let audio: ViewAudio | null = null;
	let audioSource: View['audioSource'] = null;
	if (hasAudio) {
		report(1, 3, 'Reading the audio levels');
		const pieces = filePieces(map, start * F, end * F, 4096);
		const fa = Math.min(...pieces.map((p) => p.fileFrom)) / F;
		const fb = Math.max(...pieces.map((p) => p.fileTo)) / F;
		if (fb - fa > RANGE_AUDIO_MAX_FILE_SECONDS)
			throw new ToolError(
				'E_INVALID_PARAM',
				`This range is ${Math.round(fb - fa)} s of the file (the media's frame-rate interpretation); at most ${RANGE_AUDIO_MAX_FILE_SECONDS} s`,
				'View a shorter range.',
			);
		const r: RangeAudioResponse = await ctx.engine((c) =>
			c.call('mediaRangeAudio', {
				params: { mediaKey },
				body: { start: Math.max(0, fa), end: Math.max(fa + 0.01, fb) },
				signal: extra.signal,
			}),
		);
		audio = audioOnGrid(r, start, end, toFile);
		audioSource = audioNote(r);
	}
	report(2, 3, 'Drawing');
	const tr = transcriptForMedia(doc, mediaId);
	return {
		title: `${asset.originalName} (${mediaId})`,
		timeline: map ? 'media time, interpreted' : 'media time',
		start,
		end,
		frames,
		audio,
		audioSource,
		words: tr ? wordsIn(tr.words, start, end) : null,
	};
}

/** Whether an enabled audio clip of the sequence plays inside frames `[a, b)`. */
function hasAudioIn(seq: Sequence, a: number, b: number): boolean {
	return Object.values(seq.clips).some(
		(c) => c.kind === 'audio' && c.enabled && c.start < b && c.start + c.duration > a,
	);
}

async function sequenceView(
	ctx: ToolContext,
	extra: Extra,
	loaded: Awaited<ReturnType<typeof loadDoc>>,
	projectId: string,
	seq: Sequence,
	req: { start: number; end: number; frames: number; width: number },
): Promise<View> {
	const { doc } = loaded;
	const fpf = flicksPerFrame(seq.settings.frameRate);
	const total = sequenceDuration(seq);
	if (!(total > 0))
		throw new ToolError(
			'E_INVALID_PARAM',
			`${sequenceName(doc, seq.id)} is empty`,
			'Add clips to the sequence first.',
		);
	const { start, end } = clampRange(req.start, req.end, (total * fpf) / F, 'sequence');
	const frameAt = (t: number) => Math.max(0, Math.min(total - 1, Math.floor((t * F) / fpf + 1e-6)));
	const times = slotTimes(start, end, req.frames);
	const width = Math.max(64, Math.min(1280, frameBox(req.width, req.frames).width));
	const report = progressReporter(extra);
	const steps = times.length + 2;
	const frames: ViewFrame[] = [];
	for (const [i, time] of times.entries()) {
		report(i, steps, `Rendering frame ${i + 1}/${times.length}`);
		const r = await captureStill(
			ctx,
			{ projectId, frame: frameAt(time), width, sequenceId: seq.id },
			extra,
			loaded,
			(job) => failedJobError(ctx, job, 'Check get_timeline; engine_status shows the render setup.'),
		).catch((e) => renderToolError(ctx, e));
		try {
			frames.push({ time, image: decodePng(r.bytes) });
		} catch {
			frames.push({ time, image: null, note: 'undecodable' });
		}
	}
	const startFrame = Math.floor((start * F) / fpf + 1e-6);
	const endFrame = Math.max(startFrame + 1, Math.min(total, Math.ceil((end * F) / fpf - 1e-6)));
	let audio: ViewAudio | null = null;
	let audioSource: View['audioSource'] = null;
	if (hasAudioIn(seq, startFrame, endFrame)) {
		report(times.length, steps, 'Mixing the sequence audio');
		const r: RangeAudioResponse = await ctx.engine((c) =>
			c.call('sequenceRangeAudio', {
				body: { envelope: toolEnvelope(doc, loaded.revision), sequenceId: seq.id, startFrame, endFrame },
				signal: extra.signal,
			}),
		);
		audio = audioOnGrid(r, start, end, (t) => t);
		audioSource = audioNote(r);
	}
	report(times.length + 1, steps, 'Drawing');
	const hasTranscript = Object.values(seq.clips).some(
		(c) => c.kind === 'audio' && transcriptForMedia(doc, (c as { mediaId: string }).mediaId) !== null,
	);
	return {
		title: `${sequenceName(doc, seq.id)} (${seq.id})`,
		timeline: 'sequence time',
		start,
		end,
		frames,
		audio,
		audioSource,
		words: hasTranscript ? wordsIn(sequenceWords(doc, seq), start, end) : null,
	};
}

export function registerFootageViewTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'view_media_range',
		{
			title: 'View media range',
			description:
				'One PNG of a media or sequence range (at most 600 s): filmstrip, waveform, words, silences. For decision points, after reading the transcript.',
			input: {
				projectId: ProjectIdArg,
				mediaId: z.string().min(1).optional().describe('View raw media, in media time.'),
				sequenceId: z.string().min(1).optional().describe('View the edit, in sequence time.'),
				start: TimeArg.describe(`Range start. ${TIME_HELP}`),
				end: TimeArg.describe(
					`Range end (after start; at most ${RANGE_VIEW_MAX_SECONDS} s later). ${TIME_HELP}`,
				),
				frames: z
					.number()
					.int()
					.min(VIEW_MIN_FRAMES)
					.max(VIEW_MAX_FRAMES)
					.optional()
					.describe(`Default ${VIEW_DEFAULT_FRAMES}.`),
				width: z
					.number()
					.int()
					.min(VIEW_MIN_WIDTH)
					.max(VIEW_MAX_WIDTH)
					.optional()
					.describe(`Default ${VIEW_DEFAULT_WIDTH}.`),
			},
			annotations: READ_ONLY,
		},
		async (a, extra) => {
			if ((a.mediaId === undefined) === (a.sequenceId === undefined))
				throw new ToolError(
					'E_INVALID_PARAM',
					'Give exactly one of mediaId or sequenceId',
					'list_media lists media ids; get_project lists sequence ids.',
				);
			const req = {
				start: secondsArg(a.start, 'start'),
				end: secondsArg(a.end, 'end'),
				frames: a.frames ?? VIEW_DEFAULT_FRAMES,
				width: a.width ?? VIEW_DEFAULT_WIDTH,
			};
			const loaded = await loadDoc(ctx, a.projectId);
			const view = a.mediaId
				? await mediaView(ctx, extra, loaded.doc, a.mediaId, req)
				: await sequenceView(ctx, extra, loaded, a.projectId, pickSequence(loaded.doc, a.sequenceId), req);
			const silences = view.audio ? silenceBands(view.audio, view.start, view.end) : null;
			const { image, layout } = drawRangeView({
				width: req.width,
				start: view.start,
				end: view.end,
				title: view.title,
				frames: view.frames,
				audio: view.audio,
				words: view.words,
				silences: silences ?? [],
			});
			const text = rangeSummary({
				title: view.title,
				start: view.start,
				end: view.end,
				timeline: view.timeline,
				frames: view.frames,
				audio: view.audioSource,
				silences,
				words: view.words,
				wordsDrawn: layout.wordsDrawn,
				image: { width: image.width, height: image.height },
			});
			return {
				content: [
					{ type: 'text', text },
					{ type: 'image', data: encodePng(image).toString('base64'), mimeType: 'image/png' },
				],
			};
		},
	);
}
