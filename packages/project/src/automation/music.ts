// Music bed planner (spec 15 EA-025, EA-030, EA-032): a playlist (the user's songs from a bin or folder) laid end to
// end on a "Music" audio track. Measured on the user's projects (FINDINGS §3): long form ≈ 7 beds of ≈ 52 s switching
// on A-roll cuts (74 %), constant −33 dB clip gain, no ducking; shorts one bed, often −25 dB until the first cut, then
// −33 dB. A bed switches at the first picture cut at least `bedSeconds` (52) after it started (waiting at most
// `maxSwitchDelaySeconds` for one, else at `bedSeconds`); a song that ends earlier hands over at its last cut, else
// at its end; vertical sequences default to one bed per song. The shorts intro step is the first bed split at the
// first cut (`introGain` before it, `gainDb` after: the same samples, one step), so the optional Essential Sound
// ducking (`audio.autoDuck` under the dialogue stretches, which writes the beds' volume keyframes) never fights it.
// Exports natively. Pure.
import { resolveTrackRef, trackLabel } from '../derive/index.ts';
import type { ProposalItemInput } from '../proposals/schema.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Sequence } from '../schema/sequence.ts';
import { dialogueSpans, type VoiceActivity } from '../sound/cues/dialogue.ts';
import { flicksPerFrame } from '../time.ts';
import { type FolderAsset, type PassAsset, resolveAssets } from './assets.ts';
import {
	AutomationInputError,
	automationSequence,
	fpsValue,
	frameGeometry,
	spanFree,
	timecodeOf,
	trackSpans,
} from './common.ts';
import { AUTOMATION_DEFAULTS, MusicParamsSchema } from './params.ts';
import { itemSeed, seededRandom } from './rng.ts';
import { pictureCutList } from './signals.ts';

export const MUSIC_PASS = 'music' as const;

export type BedPart = {
	/** Sequence frames [start, end) and the song's content frames it plays from. */
	start: number;
	end: number;
	sourceInFlicks: number;
	gainDb: number;
	intro: boolean;
};

export type BedPlacement = {
	/** Proposal item id: `bed:<n>` (n = position in the playlist run). */
	id: string;
	index: number;
	frame: number;
	end: number;
	timecode: string;
	seed: number;
	song: PassAsset;
	parts: BedPart[];
	/** How the bed ends: on a cut, where the song ends, at `bedSeconds` (no cut came), or at the range end. */
	switchAt: 'cut' | 'song-end' | 'bed-seconds' | 'end';
	/** Other songs for this bed (Review ⇄), each cut to the bed's span (or its own length). */
	alternatives: { song: PassAsset; parts: BedPart[] }[];
	/** Dialogue stretches under the bed (flicks), ducked when ducking is on. */
	duckRegions: [number, number][];
	/** The cut the bed switches on (anchor), or null. */
	cut: { trackId: string; frame: number } | null;
};

export type ResolvedMusicParams = {
	order: 'playlist' | 'shuffle';
	bedFrames: number | null;
	maxDelayFrames: number;
	gainDb: number;
	intro: { enabled: boolean; gainDb: number };
	duck: { enabled: boolean; amountDb: number; fadeMs: number };
	seed: number;
	track?: string;
	musicTrack?: string;
	range?: { start: number; end: number };
};

export type MusicPlan = {
	pass: typeof MUSIC_PASS;
	sequenceId: string;
	seed: number;
	beds: BedPlacement[];
	/** Songs in the playlist. */
	considered: number;
	songs: PassAsset[];
	setup: ProposalItemInput[];
	musicTrack: { trackId: string; label: string; create: false } | { create: true; name: string };
	duck: ResolvedMusicParams['duck'];
	skipped: { frame: number; timecode: string; code: string; reason: string }[];
	warnings: { code: string; message: string }[];
};

export type MusicContext = {
	folder?: readonly FolderAsset[];
	/** The engine's voice activity of dialogue clips without words (ducking regions); absent = whole clips. */
	voice?: VoiceActivity | null;
};

export function resolveMusicParams(
	raw: unknown,
	geo: { fps: { num: number; den: number }; vertical: boolean },
): ResolvedMusicParams & { assets: unknown } {
	const parsed = MusicParamsSchema.safeParse(raw ?? {});
	if (!parsed.success)
		throw new AutomationInputError(
			'E_INVALID_PARAM',
			parsed.error.issues.map((i) => `${i.path.join('.') || 'params'}: ${i.message}`).join('; '),
		);
	const p = parsed.data;
	const fps = fpsValue(geo.fps);
	const D = AUTOMATION_DEFAULTS;
	const bed = p.bedSeconds === undefined ? (geo.vertical ? null : D.musicBedSeconds) : p.bedSeconds;
	return {
		assets: p.assets,
		order: p.order ?? 'playlist',
		bedFrames: bed === null ? null : Math.max(1, Math.round(bed * fps)),
		maxDelayFrames: Math.round((p.maxSwitchDelaySeconds ?? D.musicMaxSwitchDelaySeconds) * fps),
		gainDb: p.gainDb ?? D.musicGainDb,
		intro: { enabled: p.intro?.enabled ?? geo.vertical, gainDb: p.intro?.gainDb ?? D.musicIntroGainDb },
		duck: {
			enabled: p.duck?.enabled ?? false,
			amountDb: p.duck?.amountDb ?? D.musicDuckDb,
			fadeMs: p.duck?.fadeMs ?? D.musicDuckFadeMs,
		},
		seed: p.seed ?? D.seed,
		...(p.track !== undefined ? { track: p.track } : {}),
		...(p.musicTrack !== undefined ? { musicTrack: p.musicTrack } : {}),
		...(p.range ? { range: p.range } : {}),
	};
}

/** The first cut in [lo, hi], or the last one when `last`. */
function cutIn(cuts: readonly number[], lo: number, hi: number, last = false): number | null {
	let found: number | null = null;
	for (const c of cuts) {
		if (c < lo) continue;
		if (c > hi) break;
		if (!last) return c;
		found = c;
	}
	return found;
}

/** The parts of a bed [start, end) of `song` from its beginning: split at `introCut` with the intro gain. */
function partsOf(
	start: number,
	end: number,
	F: number,
	p: ResolvedMusicParams,
	introCut: number | null,
): BedPart[] {
	if (introCut !== null && introCut > start && introCut < end)
		return [
			{ start, end: introCut, sourceInFlicks: 0, gainDb: p.intro.gainDb, intro: true },
			{ start: introCut, end, sourceInFlicks: (introCut - start) * F, gainDb: p.gainDb, intro: false },
		];
	return [{ start, end, sourceInFlicks: 0, gainDb: p.gainDb, intro: false }];
}

const songFrames = (s: PassAsset, F: number) =>
	s.durationFlicks && s.durationFlicks > 0 ? Math.floor(s.durationFlicks / F) : 0;

/** Plans the music beds of a sequence (see the file comment). */
export function planMusicBed(
	doc: ProjectDocument,
	sequenceId: string | null | undefined,
	rawParams: unknown,
	ctx: MusicContext = {},
): MusicPlan {
	const seq = automationSequence(doc, sequenceId);
	const geo = frameGeometry(seq);
	const p = resolveMusicParams(rawParams, geo);
	const F = flicksPerFrame(geo.fps);
	const res = resolveAssets(doc, p.assets as never, 'audio', {
		...(ctx.folder ? { folder: ctx.folder } : {}),
		binName: 'Music',
		prefix: 'music',
	});
	const warnings = [...res.warnings];
	const skipped: MusicPlan['skipped'] = [];
	const songs = res.assets.filter((s) => {
		if (songFrames(s, F) >= 1) return true;
		warnings.push({ code: 'W_SONG_LENGTH', message: `"${s.name}" has no readable length and is left out` });
		return false;
	});
	let order = songs;
	if (p.order === 'shuffle') {
		const rng = seededRandom(itemSeed(p.seed, MUSIC_PASS, 'order'));
		order = songs
			.map((s) => ({ s, r: rng() }))
			.sort((a, b) => a.r - b.r)
			.map((x) => x.s);
	}
	const cuts = pictureCutList(doc, seq, p.track);
	const cutFrames = cuts.map((c) => c.frame);
	const start0 = Math.max(0, p.range?.start ?? 0);
	const endAll = Math.min(p.range?.end ?? geo.duration, geo.duration);
	const beds: BedPlacement[] = [];
	const minBed = Math.max(1, Math.round(fpsValue(geo.fps)));
	let pos = start0;
	let i = 0;
	const MAX_BEDS = 500;
	if (!order.length && !warnings.some((w) => w.code === 'W_NO_ASSETS'))
		warnings.push({ code: 'W_NO_ASSETS', message: 'No songs in the chosen source' });
	while (order.length && endAll - pos >= minBed && beds.length < MAX_BEDS) {
		const song = order[i % order.length]!;
		const len = songFrames(song, F);
		const songEnd = pos + len;
		let end: number;
		let switchAt: BedPlacement['switchAt'];
		if (p.bedFrames !== null && pos + p.bedFrames < endAll && pos + p.bedFrames <= songEnd) {
			const target = pos + p.bedFrames;
			const c = cutIn(cutFrames, target, Math.min(target + p.maxDelayFrames, songEnd, endAll - 1));
			end = c ?? target;
			switchAt = c !== null ? 'cut' : 'bed-seconds';
		} else if (songEnd < endAll) {
			// the song ends first: hand over at its last cut close to its end, else where it ends
			const c = cutIn(cutFrames, Math.max(pos + minBed, songEnd - p.maxDelayFrames), songEnd, true);
			end = c ?? songEnd;
			switchAt = c !== null ? 'cut' : 'song-end';
		} else {
			end = endAll;
			switchAt = 'end';
		}
		if (end - pos < 1) break;
		const seed = itemSeed(p.seed, MUSIC_PASS, beds.length);
		const introCut =
			beds.length === 0 && p.intro.enabled ? (cutIn(cutFrames, pos + 1, end - 1) ?? null) : null;
		if (beds.length === 0 && p.intro.enabled && introCut === null)
			warnings.push({
				code: 'W_NO_INTRO_CUT',
				message: 'No cut inside the first bed: the intro step is left out',
			});
		const rng = seededRandom(seed);
		const alts = order
			.filter((s) => s.key !== song.key)
			.map((s) => ({ s, r: rng() }))
			.sort((a, b) => a.r - b.r)
			.slice(0, 3)
			.map(({ s }) => {
				const e = Math.min(end, pos + songFrames(s, F));
				return { song: s, parts: partsOf(pos, e, F, p, introCut !== null && introCut < e ? introCut : null) };
			});
		const cut = switchAt === 'cut' ? (cuts.find((c) => c.frame === end) ?? null) : null;
		beds.push({
			id: `bed:${beds.length}`,
			index: beds.length,
			frame: pos,
			end,
			timecode: timecodeOf(seq, pos),
			seed,
			song,
			parts: partsOf(pos, end, F, p, introCut),
			switchAt,
			alternatives: alts,
			duckRegions: [],
			cut: cut ? { trackId: cut.trackId, frame: cut.frame } : null,
		});
		pos = end;
		i++;
	}
	if (p.duck.enabled && beds.length) {
		const spans = dialogueSpans(doc, seq, { voice: ctx.voice ?? null });
		if (!spans.length)
			warnings.push({
				code: 'W_NO_DIALOGUE',
				message: 'No dialogue found to duck under (tag dialogue clips or transcribe)',
			});
		for (const b of beds)
			b.duckRegions = spans
				.filter((s) => s.end > b.frame && s.start < b.end)
				.map((s) => [Math.max(s.start, b.frame) * F, Math.min(s.end, b.end) * F] as [number, number]);
	}
	return {
		pass: MUSIC_PASS,
		sequenceId: seq.id,
		seed: p.seed,
		beds,
		considered: order.length,
		songs: order,
		setup: res.setup,
		musicTrack: musicTrackOf(seq, p.musicTrack, beds),
		duck: p.duck,
		skipped,
		warnings,
	};
}

/** The audio track of the beds: explicit, a free "Music" audio track, else a new one. */
function musicTrackOf(
	seq: Sequence,
	ref: string | undefined,
	beds: readonly BedPlacement[],
): MusicPlan['musicTrack'] {
	if (ref !== undefined) {
		const id = resolveTrackRef(seq, ref);
		const t = id ? seq.audioTracks.find((x) => x.id === id) : undefined;
		if (!t)
			throw new AutomationInputError(
				id && seq.videoTracks.some((x) => x.id === id) ? 'E_INVALID_PARAM' : 'E_NOT_FOUND',
				id ? `${ref} is not an audio track` : `Track not found: ${ref}`,
			);
		if (t.locked) throw new AutomationInputError('E_TRACK_LOCKED', `${ref} is locked`);
		return { trackId: t.id, label: trackLabel(seq, t.id) ?? t.id, create: false };
	}
	const spans = beds.map((b) => [b.frame, b.end] as [number, number]);
	for (const t of seq.audioTracks) {
		if (t.locked || !/^music(?: \d+)?$/i.test((t.name ?? '').trim())) continue;
		const taken = trackSpans(seq, t.id);
		if (spans.every(([a, b]) => spanFree(taken, a, b)))
			return { trackId: t.id, label: trackLabel(seq, t.id) ?? t.id, create: false };
	}
	const names = new Set(seq.audioTracks.map((t) => (t.name ?? '').trim().toLowerCase()));
	let name = 'Music';
	for (let n = 2; names.has(name.toLowerCase()) && n < 1000; n++) name = `Music ${n}`;
	return { create: true, name };
}

/** Re-plans single beds (Refresh / Reroll): the bed keeps its span; Reroll draws its song from the playlist. */
export function replanBeds(
	doc: ProjectDocument,
	sequenceId: string | null | undefined,
	rawParams: unknown,
	targets: readonly {
		itemId: string;
		seed: number;
		frame: number;
		end: number;
		songKey: string;
		reroll: boolean;
	}[],
	ctx: MusicContext = {},
): ({ itemId: string; ok: true; bed: BedPlacement } | { itemId: string; ok: false; reason: string })[] {
	const plan = planMusicBed(doc, sequenceId, rawParams, ctx);
	const seq = automationSequence(doc, sequenceId);
	const F = flicksPerFrame(frameGeometry(seq).fps);
	const p = resolveMusicParams(rawParams, frameGeometry(seq));
	return targets.map((t) => {
		const same =
			plan.beds.find((b) => b.frame === t.frame) ?? plan.beds.find((b) => b.frame < t.end && b.end > t.frame);
		if (!same)
			return { itemId: t.itemId, ok: false as const, reason: 'the sequence no longer reaches this bed' };
		let song = plan.songs.find((s) => s.key === t.songKey) ?? same.song;
		if (t.reroll && plan.songs.length > 1) {
			const others = plan.songs.filter((s) => s.key !== song.key);
			song = others[Math.floor(seededRandom(t.seed)() * others.length)]!;
		}
		const end = Math.min(same.end, same.frame + songFrames(song, F));
		const introCut = same.parts.length > 1 ? same.parts[1]!.start : null;
		return {
			itemId: t.itemId,
			ok: true as const,
			bed: {
				...same,
				id: t.itemId,
				seed: t.seed,
				song,
				end,
				parts: partsOf(same.frame, end, F, p, introCut !== null && introCut < end ? introCut : null),
				duckRegions: same.duckRegions.filter(([a]) => a < end * F),
			},
		};
	});
}
