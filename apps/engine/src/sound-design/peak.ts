// Detect Peak on the engine (spec 12 §2.7, the clip menu's "Detect Peak" for project audio): the same measurement the
// editor makes in the browser (`apps/web/src/sound/detect-peak.ts`) — the part of the media the clip uses (at most
// SOUND_PEAK_MAX_SECONDS, through the media's interpreted time map), `analyzeSound`'s peak (the centre of the loudest
// 2 ms RMS window) — so an agent without an editor window can give project audio a peak (MCP `detect_sound_peak`, which
// writes it with `soundDesign.setPeak`). Read-only: nothing is stored here.
import { SOUND_PEAK_MAX_SECONDS, type SoundPeakResponse } from '@jasper/api';
import { analyzeSound } from '@jasper/audio-fx';
import {
	type AudioClip,
	type FilePiece,
	FLICKS_PER_SECOND,
	filePieces,
	flicksPerFrame,
	type MediaAsset,
	mediaTimeMap,
	type ProjectDocument,
	type Rational,
} from '@jasper/project';
import { JobError } from '../jobs/types.ts';
import { readPlanar } from '../sounds/decode.ts';
import type { Ffmpeg } from '../tools/ffmpeg.ts';
import { LOCAL_PROTOCOLS } from '../tools/protocols.ts';
import { HttpError } from '../tools/reply.ts';
import { engineMediaKey } from './voice.ts';

/** The analysis rate (the library's highest analysis rate). */
export const PEAK_RATE = 48_000;
const DECODE_TIMEOUT_MS = 120_000;

/** What to decode for a clip's peak: the media's file pieces of the clip's content span (≤ the cap). */
export type PeakPlan = {
	sequenceId: string;
	clipId: string;
	mediaKey: string;
	streamIndex: number | null;
	/** Content flicks from the media start: where the analysed span starts and ends. */
	c0: number;
	c1: number;
	/** Interpreted time scale (content → file); the pieces all have it. */
	scale: number;
	pieces: FilePiece[];
	truncated: boolean;
};

/**
 * The span of a clip to analyse, or a typed refusal (`HttpError`): unknown sequence or clip, not an audio clip, a reversed
 * clip (it has no peak to align: the editor refuses it too), media outside the engine store, an empty clip. Pure.
 */
export function peakPlan(doc: ProjectDocument, sequenceId: string | undefined, clipId: string): PeakPlan {
	const seqId = sequenceId ?? Object.keys(doc.sequences ?? {})[0];
	const seq = seqId !== undefined && Object.hasOwn(doc.sequences, seqId) ? doc.sequences[seqId] : undefined;
	if (!seq || seqId === undefined)
		throw new HttpError(
			404,
			'SEQUENCE_NOT_FOUND',
			sequenceId ? `Sequence not found: ${sequenceId}` : 'The project has no sequence',
		);
	const clip = Object.hasOwn(seq.clips, clipId) ? seq.clips[clipId] : undefined;
	if (!clip) throw new HttpError(404, 'CLIP_NOT_FOUND', `No clip ${clipId} in the sequence`);
	if (clip.kind !== 'audio') throw new HttpError(400, 'NOT_AUDIO', `${clip.name} is not an audio clip`);
	const a = clip as AudioClip;
	if (a.speed?.reverse) throw new HttpError(400, 'REVERSED', 'A reversed clip has no peak to detect');
	const asset = doc.media?.[a.mediaId] as MediaAsset | undefined;
	const mediaKey = engineMediaKey(asset);
	if (!asset || !mediaKey)
		throw new HttpError(409, 'NOT_IN_ENGINE', `${clip.name}: its media is not in the engine's media store`);
	const rate = Number.isFinite(a.speed?.rate) && a.speed.rate > 0 ? a.speed.rate : 1;
	const frame = flicksPerFrame(seq.settings.frameRate as Rational);
	const c0 = Math.max(0, Number.isFinite(a.sourceIn) ? a.sourceIn : 0);
	const span = Math.max(0, a.duration) * frame * rate;
	const cap = SOUND_PEAK_MAX_SECONDS * FLICKS_PER_SECOND;
	const c1 = c0 + Math.min(span, cap);
	if (!(c1 > c0)) throw new HttpError(400, 'EMPTY_CLIP', 'The clip is empty');
	const map = mediaTimeMap(asset);
	return {
		sequenceId: seqId,
		clipId,
		mediaKey,
		streamIndex: Number.isSafeInteger(a.channels?.streamIndex) ? a.channels.streamIndex : null,
		c0,
		c1,
		scale: map?.scale && map.scale > 0 ? map.scale : 1,
		pieces: filePieces(map, c0, c1, 64),
		truncated: span > cap,
	};
}

/** Planar samples of `[from, to)` seconds of a file's audio stream at PEAK_RATE (at most stereo). */
async function decodePiece(
	ff: Ffmpeg,
	path: string,
	streamIndex: number | null,
	channels: number,
	from: number,
	to: number,
	signal?: AbortSignal,
): Promise<Float32Array[]> {
	const dur = Math.max(0, to - from);
	const sig = AbortSignal.any([AbortSignal.timeout(DECODE_TIMEOUT_MS), ...(signal ? [signal] : [])]);
	const child = ff.spawnRaw(
		[
			...LOCAL_PROTOCOLS,
			...['-ss', from.toFixed(6), '-t', dur.toFixed(6), '-i', path],
			...['-map', streamIndex === null ? '0:a:0' : `0:${streamIndex}`, '-vn'],
			...['-ac', String(channels), '-ar', String(PEAK_RATE), '-f', 'f32le', 'pipe:1'],
		],
		{ signal: sig },
	);
	return readPlanar(child, channels, Math.ceil(dur * PEAK_RATE) + PEAK_RATE, sig);
}

/**
 * The audio of file pieces at PEAK_RATE (at most stereo), decoded and joined (pieces of one time scale: the joined
 * samples map linearly onto content time), with its loudest absolute sample. Decode failures are `HttpError`s.
 */
export async function decodePieces(
	pieces: readonly FilePiece[],
	deps: { ff: Ffmpeg; path: string; channels: number },
	streamIndex: number | null,
	signal?: AbortSignal,
): Promise<{ data: Float32Array[]; loud: number }> {
	const ch = Math.max(1, Math.min(2, Math.round(deps.channels) || 1));
	const parts: Float32Array[][] = [];
	try {
		for (const p of pieces)
			parts.push(
				await decodePiece(
					deps.ff,
					deps.path,
					streamIndex,
					ch,
					p.fileFrom / FLICKS_PER_SECOND,
					p.fileTo / FLICKS_PER_SECOND,
					signal,
				),
			);
	} catch (e) {
		if (signal?.aborted) throw new HttpError(499, 'CANCELLED', 'The client went away');
		const err = e as JobError;
		throw new HttpError(
			err instanceof JobError && err.code === 'BINARY_MISSING' ? 503 : 422,
			err instanceof JobError ? err.code : 'DECODE_FAILED',
			`The audio could not be decoded: ${String((e as Error).message ?? e).slice(0, 300)}`,
		);
	}
	const n = parts.reduce((s, p) => s + (p[0]?.length ?? 0), 0);
	const data = Array.from({ length: ch }, () => new Float32Array(n));
	let at = 0;
	let loud = 0;
	for (const p of parts) {
		const len = p[0]?.length ?? 0;
		for (let c = 0; c < ch; c++) {
			const src = p[c] ?? p[0]!;
			data[c]!.set(src.subarray(0, len), at);
			for (let i = 0; i < len; i++) {
				const v = Math.abs(src[i]!);
				if (v > loud && Number.isFinite(v)) loud = v;
			}
		}
		at += len;
	}
	return { data, loud };
}

/**
 * Measures the peak of a planned span: its file pieces decoded and joined (`decodePieces`), `analyzeSound` on them.
 * `SILENT` when nothing sounds.
 */
export async function measurePeak(
	plan: PeakPlan,
	deps: { ff: Ffmpeg; path: string; channels: number },
	revision: number | null,
	signal?: AbortSignal,
): Promise<SoundPeakResponse> {
	const { data, loud } = await decodePieces(plan.pieces, deps, plan.streamIndex, signal);
	if ((data[0]?.length ?? 0) === 0)
		throw new HttpError(422, 'DECODE_FAILED', 'The clip’s audio could not be decoded');
	if (!(loud > 0)) throw new HttpError(422, 'SILENT', 'No peak found (the clip is silent)');
	const d = analyzeSound(data, PEAK_RATE);
	// joined file seconds → content seconds (÷ scale)
	const peakSec = d.peakSec / plan.scale;
	const onsetSec = d.onsetSec / plan.scale;
	const peakFlicks = Math.min(plan.c1, Math.round(plan.c0 + peakSec * FLICKS_PER_SECOND));
	return {
		sequenceId: plan.sequenceId,
		clipId: plan.clipId,
		peakFlicks,
		peakSec: Math.round(peakSec * 10_000) / 10_000,
		onsetSec: Math.round(onsetSec * 10_000) / 10_000,
		analysedSec: Math.round(((plan.c1 - plan.c0) / FLICKS_PER_SECOND) * 1000) / 1000,
		truncated: plan.truncated,
		revision,
	};
}
