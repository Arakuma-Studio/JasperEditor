// Whooshes cut from one media of the project (Decorate Cuts `sfx.media`, spec 15 EA-020; docs/wp-notes/edit-automation.md
// "Decorate Cuts inputs"): the given slices, or without them the sounds separated by quiet in the media's first
// MAX_ANALYSIS_SECONDS (`soundSegments`: whooshes swell in, so attack-led take detection misses them) — each with its peak
// (`analyzeSound`: the centre of the loudest 2 ms, the same measurement as Detect Peak), decoded from the media's file
// through its interpreted time map (`decodePieces`). The pure planner assigns the slices to the kits and places them
// through sound design (`soundDesign.place` layer `slice`). Read-only: nothing is stored here.
import { analyzeSound, MAX_ANALYSIS_SECONDS, soundSegments } from '@jasper/audio-fx';
import {
	FLICKS_PER_SECOND,
	filePieces,
	MAX_WHOOSH_SLICES,
	type MediaAsset,
	mediaDurationFlicks,
	mediaTimeMap,
	type ProjectDocument,
	type WhooshMedia,
	type WhooshSlice,
} from '@jasper/project';
import type { MediaRegistry } from '../media/registry.ts';
import { decodePieces, PEAK_RATE } from '../sound-design/peak.ts';
import { engineMediaKey } from '../sound-design/voice.ts';
import type { Ffmpeg } from '../tools/ffmpeg.ts';
import { HttpError } from '../tools/reply.ts';

/** What measuring needs from the engine: ffmpeg and the media store. */
export type WhooshAudio = { ff: Ffmpeg; registry: Pick<MediaRegistry, 'get' | 'resolvePath'> };

const r4 = (v: number) => Math.round(v * 10_000) / 10_000;
const refuse = (status: number, code: string, message: string, detail: string): never => {
	throw new HttpError(status, code, message, { code: detail });
};

/**
 * The slices of `media` with their peaks (seconds of the media's content), in time order. Silent slices are left out
 * (warned); unusable media is an `HttpError` naming the fix.
 */
export async function measureWhooshSlices(
	audio: WhooshAudio | undefined,
	doc: ProjectDocument,
	media: WhooshMedia,
	signal?: AbortSignal,
): Promise<{ slices: WhooshSlice[]; warnings: { code: string; message: string }[] }> {
	if (!audio) return refuse(503, 'NOT_AVAILABLE', 'The media service is not running', 'E_NOT_IMPLEMENTED');
	const asset = (Object.hasOwn(doc.media ?? {}, media.mediaId) ? doc.media[media.mediaId] : undefined) as
		| MediaAsset
		| undefined;
	const key = engineMediaKey(asset);
	if (!asset || !key)
		return refuse(
			409,
			'NOT_IN_ENGINE',
			`sfx.media: ${media.mediaId} is not in the engine's media store (import it with import_media)`,
			'E_INVALID_PARAM',
		);
	const rec = audio.registry.get(key);
	const stream = rec?.probe.streams.find((s) => s.type === 'audio');
	if (!rec || !stream)
		return refuse(400, 'NO_AUDIO_STREAM', `sfx.media: ${media.mediaId} has no sound`, 'E_INVALID_PARAM');
	const path = await audio.registry.resolvePath(key);
	if (!path)
		return refuse(409, 'MEDIA_OFFLINE', `sfx.media: ${media.mediaId} is offline (relink it)`, 'E_MEDIA');
	const channels = stream.type === 'audio' && Number.isFinite(stream.channels) ? stream.channels : 2;
	const map = mediaTimeMap(asset);
	const scale = map?.scale && map.scale > 0 ? map.scale : 1;
	const durSec = (mediaDurationFlicks(asset) ?? 0) / FLICKS_PER_SECOND;
	if (!(durSec > 0))
		return refuse(400, 'VALIDATION_FAILED', `sfx.media: ${media.mediaId} has no length`, 'E_INVALID_PARAM');
	const deps = { ff: audio.ff, path, channels };
	/** Content seconds [a, b) decoded (joined file samples at PEAK_RATE ↔ content time ÷ scale). */
	const decode = async (a: number, b: number) => {
		const pieces = filePieces(map, Math.round(a * FLICKS_PER_SECOND), Math.round(b * FLICKS_PER_SECOND), 64);
		return decodePieces(pieces, deps, null, signal);
	};
	const warnings: { code: string; message: string }[] = [];
	const slices: WhooshSlice[] = [];
	if (media.slices === undefined) {
		const end = Math.min(durSec, MAX_ANALYSIS_SECONDS);
		const { data, loud } = await decode(0, end);
		if (!(loud > 0) || !(data[0]?.length ?? 0))
			return refuse(422, 'SILENT', `sfx.media: ${media.mediaId} is silent`, 'E_INVALID_PARAM');
		for (const g of soundSegments(data, PEAK_RATE, MAX_WHOOSH_SLICES)) {
			const part = data.map((c) => c.subarray(g.startSample, g.endSample));
			const from = g.startSample / PEAK_RATE / scale;
			slices.push({
				from: r4(from),
				to: r4(Math.min(end, g.endSample / PEAK_RATE / scale)),
				peak: r4(from + analyzeSound(part, PEAK_RATE).peakSec / scale),
			});
		}
		if (!slices.length)
			return refuse(422, 'SILENT', `sfx.media: no sound found in ${media.mediaId}`, 'E_INVALID_PARAM');
		if (durSec > end)
			warnings.push({
				code: 'W_WHOOSH_MEDIA_LONG',
				message: `Only the first ${end} s of the whoosh media were searched for sounds`,
			});
		return { slices, warnings };
	}
	for (const s of media.slices) {
		const from = Math.min(s.from, durSec);
		const to = Math.min(s.to, durSec);
		if (!(to > from)) {
			warnings.push({
				code: 'W_WHOOSH_SLICE',
				message: `Slice ${s.from}–${s.to} s is past the end of the media`,
			});
			continue;
		}
		const { data, loud } = await decode(from, to);
		if (!(loud > 0) || !(data[0]?.length ?? 0)) {
			warnings.push({ code: 'W_WHOOSH_SLICE', message: `Slice ${s.from}–${s.to} s is silent` });
			continue;
		}
		slices.push({
			from: r4(from),
			to: r4(to),
			peak: r4(from + analyzeSound(data, PEAK_RATE).peakSec / scale),
		});
	}
	if (!slices.length)
		return refuse(
			422,
			'SILENT',
			'sfx.media: none of the slices has sound (check from / to)',
			'E_INVALID_PARAM',
		);
	return { slices, warnings };
}
