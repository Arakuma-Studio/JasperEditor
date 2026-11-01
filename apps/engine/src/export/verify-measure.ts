// Measurements of an exported file for its verification (spec 18 AF-VER-001; docs/wp-notes/agent-footage-verify.md
// "How it measures"): ffprobe (format, streams, stream ends from the last packets), one decode of the picture (mean
// luma of every frame, kept around the cuts) and one decode of the sound (BS.1770 loudness and true peak through the
// audio DSP's meter, digital-silence spans, the samples around each cut for the click detector). Every ffmpeg input is
// restricted to local protocols; memory stays bounded (frames are reduced to one number, sound is streamed in blocks
// and only the windows around cuts are kept).
import type { ChildProcess } from 'node:child_process';
import { stat } from 'node:fs/promises';
import type { ExportOutputInfo, ExportOutputStream } from '@jasper/api';
import { LoudnessMeter } from '@jasper/audio-dsp';
import { z } from 'zod';
import { PcmStreamReader } from '../audio/decode.ts';
import type { Ffmpeg } from '../tools/ffmpeg.ts';
import { LOCAL_PROTOCOLS } from '../tools/protocols.ts';
import { type CutClick, detectCutClick, type FrameLuma, VERIFY_THRESHOLDS } from './verify.ts';

type RunOpts = { signal?: AbortSignal | undefined; onSpawn?: ((c: ChildProcess) => void) | undefined };
const spawnOpts = (o: RunOpts) => ({
	...(o.signal ? { signal: o.signal } : {}),
	...(o.onSpawn ? { onSpawn: o.onSpawn } : {}),
});

const num = (v: unknown): number | undefined => {
	const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
	return Number.isFinite(n) ? n : undefined;
};
const rate = (v: unknown): number | undefined => {
	if (typeof v !== 'string') return undefined;
	const [a, b] = v.split('/').map(Number) as [number, number | undefined];
	const r = b === undefined ? a : b ? a / b : Number.NaN;
	return Number.isFinite(r) && r > 0 ? r : undefined;
};

const ProbeSchema = z.object({
	format: z.looseObject({ format_name: z.string().optional(), duration: z.unknown().optional() }).optional(),
	streams: z
		.array(
			z.looseObject({
				index: z.number().int(),
				codec_type: z.string().optional(),
				codec_name: z.string().optional(),
				width: z.number().int().optional(),
				height: z.number().int().optional(),
				avg_frame_rate: z.string().optional(),
				r_frame_rate: z.string().optional(),
				pix_fmt: z.string().optional(),
				color_range: z.string().optional(),
				sample_rate: z.unknown().optional(),
				channels: z.number().int().optional(),
				bits_per_raw_sample: z.unknown().optional(),
				bits_per_sample: z.unknown().optional(),
				nb_read_packets: z.unknown().optional(),
			}),
		)
		.max(1000)
		.optional(),
});
const PacketsSchema = z.object({
	packets: z
		.array(
			z.looseObject({
				stream_index: z.number().int(),
				pts_time: z.unknown().optional(),
				duration_time: z.unknown().optional(),
			}),
		)
		.optional(),
});

/** Seconds of packets read at the end of the file for the stream ends (from the keyframe before). */
const TAIL_SEC = 10;

const STREAM_TYPES = new Set(['video', 'audio', 'subtitle', 'data', 'attachment']);

/** `rgbVideo`: the picture is RGB or palette (a GIF): luma is computed from RGB, full range. */
export type ProbedOutput = { info: ExportOutputInfo; fullRangeVideo: boolean; rgbVideo: boolean };

/** Format, streams and stream ends of a file (the `fast` checks' measurements). */
export async function probeOutput(ff: Ffmpeg, file: string, o: RunOpts = {}): Promise<ProbedOutput> {
	const sizeBytes = (await stat(file)).size;
	let raw = ProbeSchema.safeParse(
		await ff.probeJson([...LOCAL_PROTOCOLS, '-show_format', '-show_streams', file], spawnOpts(o)),
	);
	if (!raw.success) throw new Error('ffprobe returned an unexpected shape');
	// a GIF's frame count (its packets; a demux of the file, no decode) is what the export promises
	if (raw.data.format?.format_name === 'gif')
		raw = ProbeSchema.safeParse(
			await ff.probeJson(
				[...LOCAL_PROTOCOLS, '-count_packets', '-show_format', '-show_streams', file],
				spawnOpts(o),
			),
		);
	if (!raw.success) throw new Error('ffprobe returned an unexpected shape');
	const fmt = raw.data.format;
	const durationSec = num(fmt?.duration) ?? null;
	const streams: ExportOutputStream[] = (raw.data.streams ?? []).map((s) => {
		const type = (
			STREAM_TYPES.has(s.codec_type ?? '') ? s.codec_type : 'unknown'
		) as ExportOutputStream['type'];
		// a GIF's average rate is estimated from its centisecond delays (15 fps reads 50/3): its base rate is the written one
		const fr =
			type === 'video'
				? s.codec_name === 'gif'
					? (rate(s.r_frame_rate) ?? rate(s.avg_frame_rate))
					: (rate(s.avg_frame_rate) ?? rate(s.r_frame_rate))
				: undefined;
		const sr = num(s.sample_rate);
		const bits = num(s.bits_per_raw_sample) || num(s.bits_per_sample) || undefined;
		const packets = num(s.nb_read_packets);
		return {
			index: s.index,
			type,
			codec: s.codec_name ?? 'unknown',
			...(s.width !== undefined ? { width: s.width } : {}),
			...(s.height !== undefined ? { height: s.height } : {}),
			...(fr !== undefined ? { frameRate: fr } : {}),
			...(s.pix_fmt ? { pixFmt: s.pix_fmt } : {}),
			...(type === 'audio' && sr !== undefined ? { sampleRate: Math.round(sr) } : {}),
			...(type === 'audio' && s.channels !== undefined ? { channels: s.channels } : {}),
			...(type === 'audio' && bits ? { bitDepth: Math.round(bits) } : {}),
			...(packets !== undefined ? { frames: Math.round(packets) } : {}),
		};
	});
	// stream ends: the last packets of each stream (pts + duration), read from near the end only; FFmpeg 7.1's ffprobe
	// lists no packets for -read_intervals together with -protocol_whitelist, so a stream without an end there is read
	// whole (compact CSV, bounded by the tool's 64 MB stdout cap: ≈ 8 h of 30 fps video with audio)
	const ends = new Map<number, number>();
	const note = (index: unknown, ptsV: unknown, durV: unknown) => {
		const pts = num(ptsV);
		const i = typeof index === 'number' ? index : num(index);
		if (pts === undefined || i === undefined) return;
		const end = pts + (num(durV) ?? 0);
		if (end > (ends.get(i) ?? Number.NEGATIVE_INFINITY)) ends.set(i, end);
	};
	if (durationSec !== null) {
		const packets = PacketsSchema.safeParse(
			await ff.probeJson(
				[
					...LOCAL_PROTOCOLS,
					'-read_intervals',
					`${Math.max(0, durationSec - TAIL_SEC).toFixed(3)}%`,
					'-show_entries',
					'packet=stream_index,pts_time,duration_time',
					file,
				],
				spawnOpts(o),
			),
		);
		for (const p of packets.success ? (packets.data.packets ?? []) : [])
			note(p.stream_index, p.pts_time, p.duration_time);
	}
	if (streams.some((s) => (s.type === 'video' || s.type === 'audio') && !ends.has(s.index))) {
		const csv = await ff
			.probeText(
				[
					...LOCAL_PROTOCOLS,
					'-show_entries',
					'packet=stream_index,pts_time,duration_time',
					'-of',
					'csv=p=0',
					file,
				],
				spawnOpts(o),
			)
			.catch(() => '');
		for (const line of csv.split('\n')) {
			const [i, pts, dur] = line.split(',');
			note(i, pts, dur);
		}
	}
	for (const s of streams) {
		const e = ends.get(s.index);
		if (e !== undefined) s.endSec = Math.round(e * 1e6) / 1e6;
	}
	const v = raw.data.streams?.find((s) => s.codec_type === 'video');
	return {
		rgbVideo:
			/^(gif|png|apng)$/.test(v?.codec_name ?? '') ||
			/^(rgb|bgr|argb|abgr|rgba|bgra|pal8|gbr)/.test(v?.pix_fmt ?? ''),
		info: {
			container: (fmt?.format_name ?? 'unknown').slice(0, 100),
			durationSec,
			sizeBytes,
			streams,
		},
		fullRangeVideo: v?.color_range === 'pc' || v?.color_range === 'jpeg' || /^yuvj/.test(v?.pix_fmt ?? ''),
	};
}

/** Width × height of the reduced frames the luma is measured on (an area average of the luma plane). */
const LUMA_W = 64;
const LUMA_H = 36;
const MAX_ERROR_LINES = 20;

const errorLines = (s: string) =>
	s
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean)
		.slice(0, MAX_ERROR_LINES);

/**
 * Decodes the first video stream once: normalised luma (0 = black level, 1 = white level; limited-range video maps
 * Y 16…235) of the frames in `keep` — the frame's mean and its brightest cell of the `blackGrid` grid —, the decoded frame count and the decoder's error lines.
 */
export async function measureVideo(
	ff: Ffmpeg,
	file: string,
	keep: ReadonlySet<number>,
	fullRange: boolean,
	o: RunOpts = {},
	/** RGB / palette pictures (GIF): luma from RGB (BT.601 weights of swscale), full range. */
	rgb = false,
): Promise<{ luma: Map<number, FrameLuma>; frames: number; errors: string[] }> {
	const child = ff.spawnRaw(
		[
			...LOCAL_PROTOCOLS,
			'-i',
			file,
			'-map',
			'0:v:0',
			'-fps_mode',
			'passthrough',
			'-vf',
			rgb
				? `scale=${LUMA_W}:${LUMA_H}:flags=area,format=gray`
				: `extractplanes=y,scale=${LUMA_W}:${LUMA_H}:flags=area,format=gray`,
			'-f',
			'rawvideo',
			'pipe:1',
		],
		spawnOpts(o),
	);
	let stderr = '';
	child.stderr?.setEncoding('utf8').on('data', (c: string) => {
		stderr = (stderr + c).slice(-16_000);
	});
	const exited = new Promise<number | null>((resolve) => {
		child.once('close', (code) => resolve(code));
		child.once('error', () => resolve(-1));
	});
	const frameBytes = LUMA_W * LUMA_H;
	const luma = new Map<number, FrameLuma>();
	const grid = VERIFY_THRESHOLDS.blackGrid;
	const cellW = LUMA_W / grid;
	const cellH = LUMA_H / grid;
	const full = fullRange || rgb;
	const norm = (y: number) => Math.min(1, Math.max(0, full ? y / 255 : (y - 16) / 219));
	const cells = new Float64Array(grid * grid);
	let frames = 0;
	let pending: Buffer = Buffer.alloc(0);
	for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
		pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
		let off = 0;
		while (pending.length - off >= frameBytes) {
			if (keep.has(frames)) {
				let sum = 0;
				cells.fill(0);
				for (let y = 0; y < LUMA_H; y++)
					for (let x = 0; x < LUMA_W; x++) {
						const p = pending[off + y * LUMA_W + x]!;
						sum += p;
						cells[Math.floor(y / cellH) * grid + Math.floor(x / cellW)]! += p;
					}
				let peak = 0;
				for (const c of cells) peak = Math.max(peak, c / (cellW * cellH));
				luma.set(frames, { mean: norm(sum / frameBytes), peakCell: norm(peak) });
			}
			frames++;
			off += frameBytes;
		}
		pending = pending.subarray(off);
	}
	const code = await exited;
	if (o.signal?.aborted) throw new Error('cancelled');
	const errors = errorLines(stderr);
	if (code !== 0 && !errors.length) errors.push(`The video decoder exited ${code}`);
	return { luma, frames, errors };
}

export type AudioMeasurements = {
	loudness: { integratedLufs: number | null; truePeakDbtp: number | null };
	silences: { startSec: number; endSec: number }[];
	/** Per cut time (same order as given): the click found, or null. */
	clicks: ((CutClick & { sec: number }) | null)[];
	errors: string[];
	samples: number;
};

/** Most silent spans kept (longer lists are rare and only counted by the rows). */
const MAX_SILENCES = 1000;
const BLOCK = 48_000;

/**
 * Decodes the first audio stream once (its own rate and channels): loudness and true peak (BS.1770-4 meter of the
 * audio DSP package), digital-silence spans and the click detector at each cut time in `cutSecs`.
 */
export async function measureAudio(
	ff: Ffmpeg,
	file: string,
	stream: { sampleRate: number; channels: number },
	cutSecs: readonly number[],
	o: RunOpts = {},
): Promise<AudioMeasurements> {
	const sr = stream.sampleRate;
	const ch = Math.max(1, Math.min(64, stream.channels));
	const child = ff.spawnRaw(
		[
			...LOCAL_PROTOCOLS,
			'-i',
			file,
			'-map',
			'0:a:0',
			'-f',
			'f32le',
			'-ac',
			String(ch),
			'-ar',
			String(sr),
			'pipe:1',
		],
		spawnOpts(o),
	);
	const reader = new PcmStreamReader(ch, child);
	const meter = new LoudnessMeter(sr, ch);
	const silenceThr = 10 ** (VERIFY_THRESHOLDS.silenceDbfs / 20);
	const silenceMin = Math.round(VERIFY_THRESHOLDS.silenceMinSec * sr);
	const silences: { startSec: number; endSec: number }[] = [];
	let silentFrom = -1;
	// click windows: the cut sample ± (search window + RMS half window + 1)
	const pad =
		Math.round(VERIFY_THRESHOLDS.clickWindowSec * sr) +
		Math.round((VERIFY_THRESHOLDS.clickRmsWindowSec / 2) * sr) +
		2;
	const order = cutSecs
		.map((s, i) => ({ i, center: Math.round(s * sr) }))
		.sort((a, b) => a.center - b.center);
	const clicks: ((CutClick & { sec: number }) | null)[] = cutSecs.map(() => null);
	const open: { i: number; center: number; start: number; buf: Float32Array[] }[] = [];
	let next = 0;
	const block = Array.from({ length: ch }, () => new Float32Array(BLOCK));
	let pos = 0;
	const errors: string[] = [];
	const finishWindow = (w: (typeof open)[number], filled: number) => {
		const planar = w.buf.map((b) => b.subarray(0, filled));
		const c = detectCutClick(planar, sr, w.center - w.start);
		if (c) clicks[w.i] = { ...c, sec: (w.start + c.sample) / sr };
	};
	try {
		for (;;) {
			const n = await reader.read(block, BLOCK);
			if (n <= 0) break;
			meter.process(block, 0, n);
			for (let k = 0; k < n; k++) {
				let silent = true;
				for (let c = 0; c < ch; c++)
					if (Math.abs(block[c]![k]!) > silenceThr) {
						silent = false;
						break;
					}
				if (silent) {
					if (silentFrom < 0) silentFrom = pos + k;
				} else if (silentFrom >= 0) {
					if (pos + k - silentFrom > silenceMin && silences.length < MAX_SILENCES)
						silences.push({ startSec: silentFrom / sr, endSec: (pos + k) / sr });
					silentFrom = -1;
				}
			}
			const end = pos + n;
			while (next < order.length && order[next]!.center - pad < end) {
				const c = order[next++]!;
				const start = Math.max(0, c.center - pad);
				open.push({
					...c,
					start,
					buf: Array.from({ length: ch }, () => new Float32Array(c.center + pad - start)),
				});
			}
			for (let w = open.length - 1; w >= 0; w--) {
				const win = open[w]!;
				const len = win.buf[0]!.length;
				const from = Math.max(win.start, pos);
				const to = Math.min(win.start + len, end);
				for (let c = 0; c < ch; c++)
					if (to > from) win.buf[c]!.set(block[c]!.subarray(from - pos, to - pos), from - win.start);
				if (win.start + len <= end) {
					finishWindow(win, len);
					open.splice(w, 1);
				}
			}
			pos = end;
			if (n < BLOCK) break;
		}
	} catch (e) {
		if (o.signal?.aborted) throw e;
		errors.push((e as Error).message.slice(0, 800));
	} finally {
		reader.close();
	}
	// windows cut short by the end of the file
	for (const w of open) finishWindow(w, Math.max(0, Math.min(w.buf[0]!.length, pos - w.start)));
	if (silentFrom >= 0 && pos - silentFrom > silenceMin && silences.length < MAX_SILENCES)
		silences.push({ startSec: silentFrom / sr, endSec: pos / sr });
	if (!errors.length) errors.push(...errorLines(reader.errors));
	meter.flush();
	const s = meter.summary();
	return {
		loudness: {
			integratedLufs: Number.isFinite(s.integrated) ? s.integrated : null,
			truePeakDbtp: Number.isFinite(s.truePeakDb) ? s.truePeakDb : null,
		},
		silences,
		clicks,
		errors,
		samples: pos,
	};
}
