// Media range view (spec 18 §2.3 AF-VIEW-002; docs/wp-notes/agent-footage-view.md): frames of a registered media at
// file times, and the 10 ms audio levels and voice classes of a media range or of a sequence's mix — what the MCP tool
// `view_media_range` draws. Every FFmpeg input is restricted to local protocols; frames are scaled to the requested
// box inside FFmpeg (display aspect: rotation and pixel aspect applied; never upscaled), one process per frame, in
// order, stopped by the caller's signal; audio is decoded to 16 kHz mono and reduced while it streams (no buffer of the
// whole range), with the voice analysis' own feature extractor and classifier (spec 14 TC-001).
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type MediaFrame,
	RANGE_AUDIO_FRAME_SEC,
	RANGE_AUDIO_MAX_FILE_SECONDS,
	type RangeAudioResponse,
} from '@jasper/api';
import {
	classifyVoiceFrames,
	VOICE_HOP,
	VOICE_SAMPLE_RATE,
	VOICE_WINDOW_LEAD,
	VOICE_WINDOW_TAIL,
	VoiceFeatureExtractor,
	type VoiceFeaturePlanes,
} from '@jasper/audio-dsp';
import type { ProjectDocument, Sequence } from '@jasper/project';
import { FLICKS_PER_SECOND, flicksPerFrame, sequenceDuration } from '@jasper/project';
import { renderMixdown } from '../audio/mixdown.ts';
import { audioWorld } from '../sound-design/bed.ts';
import type { Ffmpeg } from '../tools/ffmpeg.ts';
import { LOCAL_PROTOCOLS } from '../tools/protocols.ts';
import { HttpError } from '../tools/reply.ts';
import type { VoiceAnalysisService } from '../voice/service.ts';
import type { MediaRecord } from './registry.ts';

/** One frame's decode (seek, decode, scale, PNG): a broken file must not hold the request. */
const FRAME_TIMEOUT_MS = 30_000;
/** All frames of a request, under the MCP's 180 s per engine request; frames past it are listed as timed out. */
const FRAMES_BUDGET_MS = 160_000;
/**
 * A range's audio (decode and analysis; for a sequence also its mix): one budget, under the MCP's 180 s per engine
 * request, so a slow range is a coded timeout here rather than a dropped connection there.
 */
const AUDIO_TIMEOUT_MS = 170_000;
/** A PNG of at most 960 × 1080 RGB is far below this; anything larger is not a frame we asked for. */
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
/** How far before the asked time the second try seeks when the first produced no frame (the end of a file). */
const END_RETRY_SEC = 0.5;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const r4 = (x: number) => Math.round(x * 10_000) / 10_000;

/** Kinds whose frames this extracts: one file FFmpeg decodes (stills give their one picture at every time). */
const FRAME_KINDS = new Set(['video', 'image', 'animated-image']);

function cancelled(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

/** Collects a child's stdout (≤ `max` bytes; more is an error) and stderr tail. */
function collect(
	child: ChildProcess,
	max: number,
): Promise<{ code: number | null; out: Buffer; stderr: string }> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let have = 0;
		let over = false;
		let stderr = '';
		child.stdout!.on('data', (c: Buffer) => {
			if (over) return;
			have += c.length;
			if (have > max) {
				over = true;
				child.kill('SIGKILL');
				return;
			}
			chunks.push(c);
		});
		child.stderr?.setEncoding('utf8').on('data', (c: string) => {
			stderr = (stderr + c).slice(-2000);
		});
		child.on('error', (e) => reject(new HttpError(503, 'BINARY_MISSING', `Cannot run ffmpeg: ${e.message}`)));
		child.on('close', (code) => {
			if (over) reject(new HttpError(422, 'FRAME_TOO_LARGE', 'The decoded frame exceeds the size limit'));
			else resolve({ code, out: Buffer.concat(chunks, have), stderr });
		});
	});
}

/** Width and height of a PNG (its IHDR), or null when the bytes are not one. */
export function pngSize(png: Uint8Array): { width: number; height: number } | null {
	const b = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
	if (b.length < 24 || !b.subarray(0, 8).equals(PNG_SIGNATURE) || b.toString('latin1', 12, 16) !== 'IHDR')
		return null;
	const width = b.readUInt32BE(16);
	const height = b.readUInt32BE(20);
	return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * The scale filter of a frame box: display width = coded width × sample aspect ratio (after FFmpeg's automatic
 * rotation), the picture fitted inside `w × h` and never enlarged; `area` averaging for the downscale; square pixels,
 * 8-bit RGB (what the MCP PNG decoder reads).
 */
function frameFilter(w: number, h: number): string {
	const f = `min(min(${w}/(iw*sar)\\,${h}/ih)\\,1)`;
	return `scale=w='max(1\\,round(iw*sar*${f}))':h='max(1\\,round(ih*${f}))':flags=area,setsar=1,format=rgb24`;
}

async function decodeFrame(
	ff: Ffmpeg,
	path: string,
	at: number | null,
	box: { width: number; height: number },
	signal: AbortSignal | undefined,
	budget: AbortSignal,
): Promise<Buffer | null> {
	const sig = AbortSignal.any([AbortSignal.timeout(FRAME_TIMEOUT_MS), budget, ...(signal ? [signal] : [])]);
	const child = ff.spawnRaw(
		[
			...LOCAL_PROTOCOLS,
			...(at !== null ? ['-ss', at.toFixed(6)] : []),
			...['-i', path, '-map', '0:v:0', '-an', '-sn', '-dn', '-frames:v', '1'],
			...['-vf', frameFilter(box.width, box.height)],
			...['-c:v', 'png', '-f', 'image2pipe', 'pipe:1'],
		],
		{ signal: sig },
	);
	const r = await collect(child, MAX_FRAME_BYTES);
	if (cancelled(signal)) throw new HttpError(499, 'CANCELLED', 'The client went away');
	if (sig.aborted)
		throw new HttpError(504, 'FRAME_TIMEOUT', `Decoding the frame took over ${FRAME_TIMEOUT_MS / 1000} s`);
	if (r.code !== 0)
		throw new HttpError(
			422,
			'DECODE_FAILED',
			`ffmpeg could not decode the frame: ${r.stderr.trim().slice(-300)}`,
		);
	return r.out.length > 0 && pngSize(r.out) ? r.out : null;
}

/** The video stream's frame rate (fps), or null when unknown. */
function videoFps(record: Pick<MediaRecord, 'probe'>): number | null {
	const v = record.probe.streams.find((s) => s.type === 'video');
	const r = v?.type === 'video' ? v.frameRate : null;
	const fps = r && r.den > 0 ? r.num / r.den : Number.NaN;
	return Number.isFinite(fps) && fps > 0 && fps <= 1000 ? fps : null;
}

/**
 * The start of the frame shown at `t` (frame ⌊t · fps⌋), floored to the microsecond: FFmpeg's accurate seek returns the
 * first frame that starts at or after the seek time, so seeking to `t` itself would give the NEXT frame whenever `t`
 * falls inside a frame. Without a known rate (VFR files report their average) `t` is used as is.
 */
export function frameStart(t: number, fps: number | null): number {
	const at = fps ? Math.floor(t * fps + 1e-6) / fps : t;
	return Math.floor(at * 1e6) / 1e6;
}

/**
 * Frames of a media at file times, in order: the frame shown at each time (`at` = its start). A time is clamped to the
 * media; when nothing decodes there (the last frames of some files), the frame END_RETRY_SEC earlier is taken and `at`
 * says so. A frame that still fails (or is not reached within FRAMES_BUDGET_MS) is listed with its error;
 * cancellation and a missing ffmpeg end the whole request.
 */
export async function extractFrames(o: {
	ff: Ffmpeg;
	path: string;
	record: Pick<MediaRecord, 'kind' | 'durationSec' | 'probe'>;
	times: readonly number[];
	box: { width: number; height: number };
	signal?: AbortSignal;
}): Promise<MediaFrame[]> {
	if (!FRAME_KINDS.has(o.record.kind) || !o.record.probe.streams.some((s) => s.type === 'video'))
		throw new HttpError(422, 'NO_VIDEO', 'This media has no picture');
	const dur =
		o.record.durationSec !== null && Number.isFinite(o.record.durationSec) && o.record.durationSec > 0
			? o.record.durationSec
			: null;
	const still = o.record.kind === 'image' || dur === null;
	const fps = videoFps(o.record);
	const budget = AbortSignal.timeout(FRAMES_BUDGET_MS);
	const out: MediaFrame[] = [];
	for (const time of o.times) {
		if (cancelled(o.signal)) throw new HttpError(499, 'CANCELLED', 'The client went away');
		const t = still ? 0 : frameStart(Math.min(Math.max(0, time), dur!), fps);
		if (budget.aborted) {
			out.push({
				time,
				error: { code: 'FRAME_TIMEOUT', message: `Not decoded: ${FRAMES_BUDGET_MS / 1000} s spent` },
			});
			continue;
		}
		try {
			let at = t;
			let png = await decodeFrame(o.ff, o.path, still ? null : t, o.box, o.signal, budget);
			if (!png && !still && t > 0) {
				at = frameStart(Math.max(0, t - END_RETRY_SEC), fps);
				png = await decodeFrame(o.ff, o.path, at, o.box, o.signal, budget);
			}
			if (!png) {
				out.push({ time, error: { code: 'NO_FRAME', message: `No frame decodes at ${r4(t)} s` } });
				continue;
			}
			const size = pngSize(png)!;
			out.push({ time, at: r4(at), ...size, png: png.toString('base64') });
		} catch (e) {
			const err = e as HttpError;
			if (err.code === 'CANCELLED' || err.code === 'BINARY_MISSING' || cancelled(o.signal)) throw e;
			out.push({
				time,
				error: {
					code: typeof err.code === 'string' ? err.code : 'DECODE_FAILED',
					message: String(err.message ?? e).slice(0, 300),
				},
			});
		}
	}
	return out;
}

/**
 * Streams 16 kHz mono samples into the voice analysis' feature planes of frames `[0, count)`. Frame 0 starts at the
 * range's origin; `signalStart` is the sample index (≤ 0) of the first sample pushed, relative to that origin, so the
 * first frames see their lead-in like the cached analysis does. Only the samples a frame window still needs are kept.
 */
export class StreamingVoiceFeatures {
	readonly planes: VoiceFeaturePlanes;
	private readonly fx = new VoiceFeatureExtractor();
	private buf = new Float32Array(0);
	/** Sample index (relative to the origin) of buf[0]. */
	private bufStart: number;
	private next = 0;

	constructor(
		readonly count: number,
		signalStart: number,
	) {
		this.planes = {
			level: new Uint8Array(count),
			voicing: new Uint8Array(count),
			flatness: new Uint8Array(count),
		};
		this.bufStart = signalStart;
	}

	push(samples: Float32Array): void {
		if (!samples.length || this.next >= this.count) return;
		const joined = new Float32Array(this.buf.length + samples.length);
		joined.set(this.buf, 0);
		joined.set(samples, this.buf.length);
		this.buf = joined;
		const end = this.bufStart + this.buf.length;
		// frame k needs samples up to k·HOP + TAIL (exclusive)
		const ready = Math.min(this.count, Math.floor((end - VOICE_WINDOW_TAIL) / VOICE_HOP) + 1);
		this.compute(ready);
	}

	/** Computes the remaining frames (samples past the end count as zero, like the end of a file). */
	finish(): VoiceFeaturePlanes {
		this.compute(this.count);
		this.buf = new Float32Array(0);
		return this.planes;
	}

	private compute(upTo: number): void {
		if (upTo <= this.next) return;
		this.fx.compute(this.buf, this.bufStart, this.next, upTo - this.next, this.planes, this.next);
		this.next = upTo;
		const keepFrom = this.next * VOICE_HOP - VOICE_WINDOW_LEAD;
		const drop = Math.max(0, Math.min(this.buf.length, keepFrom - this.bufStart));
		if (drop > 0) {
			this.buf = this.buf.slice(drop);
			this.bufStart += drop;
		}
	}
}

/** Stops work when the client goes away (`cancel`) or the budget runs out (`deadline`). */
type Stop = { cancel: AbortSignal | undefined; deadline: AbortSignal };

function stopOf(cancel: AbortSignal | undefined): Stop {
	return { cancel, deadline: AbortSignal.timeout(AUDIO_TIMEOUT_MS) };
}

/** The error of stopped work, or null when it was not stopped. */
function stoppedError(stop: Stop): HttpError | null {
	if (cancelled(stop.cancel)) return new HttpError(499, 'CANCELLED', 'The client went away');
	if (stop.deadline.aborted)
		return new HttpError(504, 'AUDIO_TIMEOUT', `Reading the audio took over ${AUDIO_TIMEOUT_MS / 1000} s`);
	return null;
}

/** Decodes file seconds `[from, from + seconds)` of an audio stream to 16 kHz mono f32, pushing samples as they come. */
function decodeMono16k(
	ff: Ffmpeg,
	input: { path: string; streamIndex: number | null },
	from: number,
	seconds: number,
	onSamples: (s: Float32Array) => void,
	stop: Stop,
): Promise<void> {
	const sig = AbortSignal.any([stop.deadline, ...(stop.cancel ? [stop.cancel] : [])]);
	return new Promise((resolve, reject) => {
		let child: ChildProcess;
		try {
			child = ff.spawnRaw(
				[
					...LOCAL_PROTOCOLS,
					...(from > 0 ? ['-ss', from.toFixed(6)] : []),
					...['-t', seconds.toFixed(6), '-i', input.path],
					...['-map', input.streamIndex === null ? '0:a:0' : `0:${input.streamIndex}`, '-vn', '-sn', '-dn'],
					...['-ac', '1', '-ar', String(VOICE_SAMPLE_RATE), '-f', 'f32le', 'pipe:1'],
				],
				{ signal: sig },
			);
		} catch (e) {
			reject(new HttpError(503, 'BINARY_MISSING', `Cannot run ffmpeg: ${(e as Error).message}`));
			return;
		}
		let carry = Buffer.alloc(0);
		let stderr = '';
		const out = child.stdout!;
		out.on('data', (c: Buffer) => {
			if (sig.aborted) return;
			const data = carry.length ? Buffer.concat([carry, c]) : c;
			const usable = data.length - (data.length % 4);
			if (usable > 0) {
				const s = new Float32Array(usable / 4);
				for (let i = 0; i < s.length; i++) s[i] = data.readFloatLE(i * 4);
				onSamples(s);
			}
			carry = Buffer.from(data.subarray(usable));
			// the analysis is CPU work on the engine's event loop: let other requests (and the client's hang-up) in
			// between chunks
			out.pause();
			setImmediate(() => out.resume());
		});
		child.stderr?.setEncoding('utf8').on('data', (c: string) => {
			stderr = (stderr + c).slice(-2000);
		});
		child.on('error', (e) => reject(new HttpError(503, 'BINARY_MISSING', `Cannot run ffmpeg: ${e.message}`)));
		child.on('close', (code) => {
			const stopped = stoppedError(stop);
			if (stopped) reject(stopped);
			else if (code !== 0)
				reject(
					new HttpError(
						422,
						'DECODE_FAILED',
						`ffmpeg could not decode the audio: ${stderr.trim().slice(-300)}`,
					),
				);
			else resolve();
		});
	});
}

/** Analyses file seconds `[start, end)` now: frame 0 at `start`, its lead-in decoded too. */
async function analyseFileRange(
	ff: Ffmpeg,
	input: { path: string; streamIndex: number | null },
	start: number,
	end: number,
	stop: Stop,
): Promise<{ planes: VoiceFeaturePlanes; classes: Uint8Array; levels: RangeAudioResponse['levels'] }> {
	const count = Math.max(1, Math.ceil((end - start) / RANGE_AUDIO_FRAME_SEC - 1e-9));
	const lead = Math.min(start, VOICE_WINDOW_LEAD / VOICE_SAMPLE_RATE);
	const from = start - lead;
	const signalStart = -Math.round(lead * VOICE_SAMPLE_RATE);
	const stream = new StreamingVoiceFeatures(count, signalStart);
	const seconds = end - from + VOICE_WINDOW_TAIL / VOICE_SAMPLE_RATE;
	await decodeMono16k(ff, input, from, seconds, (s) => stream.push(s), stop);
	const planes = stream.finish();
	const { classes, levels } = classifyVoiceFrames(planes);
	return {
		planes,
		classes,
		levels: levels
			? {
					floorDb: levels.floorDb,
					speechDb: levels.speechDb,
					speechThresholdDb: levels.speechThresholdDb,
				}
			: null,
	};
}

const b64 = (u: Uint8Array) => Buffer.from(u.buffer, u.byteOffset, u.byteLength).toString('base64');

/**
 * Levels and voice classes of file seconds `[start, end)` of a media's audio stream (clamped to the media). The
 * media's cached voice analysis when there is one (classes against the whole stream), else analysed now over the range
 * (classes against the range's own levels).
 */
export async function mediaRangeAudio(o: {
	ff: Ffmpeg;
	path: string;
	record: MediaRecord;
	start: number;
	end: number;
	streamIndex?: number;
	voice?: Pick<VoiceAnalysisService, 'read'> | null;
	signal?: AbortSignal;
}): Promise<RangeAudioResponse> {
	const audio = o.record.probe.streams.filter((s) => s.type === 'audio');
	if (!audio.length) throw new HttpError(422, 'NO_AUDIO', `${o.record.originalName} has no audio stream`);
	const stream = o.streamIndex === undefined ? audio[0]! : audio.find((s) => s.index === o.streamIndex);
	if (!stream)
		throw new HttpError(
			400,
			'VALIDATION_FAILED',
			`Stream ${o.streamIndex} is not an audio stream (audio streams: ${audio.map((s) => s.index).join(', ')})`,
		);
	const dur =
		o.record.durationSec !== null && Number.isFinite(o.record.durationSec) && o.record.durationSec > 0
			? o.record.durationSec
			: null;
	const end = dur !== null ? Math.min(o.end, dur) : o.end;
	const start = Math.max(0, o.start);
	if (!(end > start))
		throw new HttpError(422, 'EMPTY_RANGE', `The range is outside the media (${dur ?? '?'} s long)`);
	if (end - start > RANGE_AUDIO_MAX_FILE_SECONDS)
		throw new HttpError(400, 'RANGE_TOO_LONG', `At most ${RANGE_AUDIO_MAX_FILE_SECONDS} s at once`);
	// the frames of the 10 ms grid that cover the range
	const k0 = Math.floor(start / RANGE_AUDIO_FRAME_SEC + 1e-9);
	const k1 = Math.max(k0 + 1, Math.ceil(end / RANGE_AUDIO_FRAME_SEC - 1e-9));
	const gridStart = r4(k0 * RANGE_AUDIO_FRAME_SEC);
	const cached = o.voice ? await o.voice.read(o.record, stream.index).catch(() => null) : null;
	if (cached && cached.frameCount > k0) {
		const hi = Math.min(k1, cached.frameCount);
		const lv = cached.levels;
		return {
			start: gridStart,
			end: r4(hi * RANGE_AUDIO_FRAME_SEC),
			frameSec: RANGE_AUDIO_FRAME_SEC,
			frameCount: hi - k0,
			level: b64(cached.level.subarray(k0, hi)),
			classes: b64(cached.classes.subarray(k0, hi)),
			source: 'voice-analysis',
			streamIndex: stream.index,
			levels:
				lv.floorDb !== null && lv.speechDb !== null && lv.speechThresholdDb !== null
					? { floorDb: lv.floorDb, speechDb: lv.speechDb, speechThresholdDb: lv.speechThresholdDb }
					: null,
		};
	}
	const a = await analyseFileRange(
		o.ff,
		{ path: o.path, streamIndex: stream.index },
		gridStart,
		k1 * RANGE_AUDIO_FRAME_SEC,
		stopOf(o.signal),
	);
	return {
		start: gridStart,
		end: r4(k1 * RANGE_AUDIO_FRAME_SEC),
		frameSec: RANGE_AUDIO_FRAME_SEC,
		frameCount: a.planes.level.length,
		level: b64(a.planes.level),
		classes: b64(a.classes),
		source: 'range',
		streamIndex: stream.index,
		levels: a.levels,
	};
}

/**
 * Levels and voice classes of a sequence's mix over frames `[startFrame, endFrame)` (clamped to the sequence): the
 * export's offline mixer renders the range in mono (clip effects, strips, Mix; not the loudness normalisation) to a
 * scratch WAV, analysed like a media range. Times are sequence seconds.
 */
export async function sequenceRangeAudio(o: {
	ff: Ffmpeg;
	doc: ProjectDocument;
	seq: Sequence;
	startFrame: number;
	endFrame: number;
	maxSeconds: number;
	registry: Parameters<typeof audioWorld>[2];
	signal?: AbortSignal;
}): Promise<RangeAudioResponse> {
	const rate = o.seq.settings.frameRate;
	const fps = rate.num / rate.den;
	const total = sequenceDuration(o.seq);
	const startFrame = Math.max(0, Math.min(o.startFrame, total));
	const endFrame = Math.min(o.endFrame, total);
	if (!(endFrame > startFrame))
		throw new HttpError(422, 'EMPTY_RANGE', `The range is outside the sequence (${total} frames long)`);
	if (!(fps > 0) || (endFrame - startFrame) / fps > o.maxSeconds + 1e-6)
		throw new HttpError(400, 'RANGE_TOO_LONG', `At most ${o.maxSeconds} s at once`);
	const secOf = (f: number) => (f * flicksPerFrame(rate)) / FLICKS_PER_SECOND;
	const start = secOf(startFrame);
	const end = secOf(endFrame);
	const world = await audioWorld(o.doc, o.seq.id, o.registry);
	const dir = await mkdtemp(join(tmpdir(), 'jasper-range-mix-'));
	const stop = stopOf(o.signal);
	const sig = AbortSignal.any([stop.deadline, ...(o.signal ? [o.signal] : [])]);
	try {
		let path: string | null;
		try {
			path = (
				await renderMixdown({
					ff: o.ff,
					snapshot: world.snapshot,
					media: world.media,
					range: { start: startFrame, end: endFrame },
					outputLayout: 'mono',
					withoutLoudness: true,
					meter: false,
					scratchDir: dir,
					signal: sig,
				})
			).path;
		} catch (e) {
			const stopped = stoppedError(stop);
			if (stopped) throw stopped;
			throw new HttpError(
				422,
				'MIX_FAILED',
				`The sequence audio could not be mixed: ${String((e as Error).message ?? e).slice(0, 300)}`,
			);
		}
		if (!path) throw new HttpError(422, 'MIX_FAILED', 'The sequence mix produced no audio');
		const a = await analyseFileRange(o.ff, { path, streamIndex: null }, 0, end - start, stop);
		return {
			start: r4(start),
			end: r4(start + a.planes.level.length * RANGE_AUDIO_FRAME_SEC),
			frameSec: RANGE_AUDIO_FRAME_SEC,
			frameCount: a.planes.level.length,
			level: b64(a.planes.level),
			classes: b64(a.classes),
			source: 'mix',
			streamIndex: null,
			levels: a.levels,
		};
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => undefined);
	}
}
