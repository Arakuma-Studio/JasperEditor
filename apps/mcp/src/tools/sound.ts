// Sound library tools (spec 12 §2.10, Phase 1: P1-R6 and the MCP part of P1-R8; wp-note "WP1.3 MCP tools"): status,
// search with an optional contact sheet, one sound in detail, contact sheets of chosen sounds, importing sounds into
// a project's "Sound Effects" bin, inserting one peak-aligned on the timeline, credits, and the user's sound folders.
// Agents cannot hear: every result carries the measured descriptors, and the pictures show where the energy is.
import {
	type EngineJob,
	type RegisterSoundResponse,
	SOUND_EFFECTS_BIN,
	SOUND_ROOT_LICENSES,
	SOUND_SOURCE_TYPES,
	type SoundEntry,
	type SoundLibraryStatus,
	type SoundRoot,
	type SoundSearchRequest,
	type SoundSearchResponse,
	type SoundVisual,
} from '@jasper/api';
import { EngineError } from '@jasper/engine-client';
import {
	FLICKS_PER_SECOND,
	FRAME_EPS,
	flicksPerFrame,
	isCommercialSafe as isCommercialSafeLicense,
	isSoundTypeId,
	type MediaAsset,
	mediaDurationFlicks,
	type ProjectDocument,
	peakAlignedStart,
	type Rational,
	readLibraryProvenance,
	requiresAttribution,
	type Sequence,
	SOUND_FAMILIES,
	SOUND_TYPES,
	type SoundAlign,
	sequenceTimecode,
	soundCredits,
	TimeInputSchema,
	trackLabel,
	VISUAL_KINDS,
} from '@jasper/project';
import { z } from 'zod';
import { ProjectIdArg, SequenceIdArg, TIME_FORMATS } from '../arguments.ts';
import {
	DESTRUCTIVE_IDEMPOTENT,
	defineTool,
	EDIT,
	EDIT_IDEMPOTENT,
	type Extra,
	frameOf,
	jobBody,
	loadDoc,
	progressReporter,
	READ_ONLY,
	requireOk,
	type ToolContext,
	transact,
	txBody,
	waitJob,
} from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';
import { pickSequence } from '../format.ts';
import { mediaRegisterCommand } from '../media.ts';
import { composeGrid, encodePng } from '../png.ts';
import { drawSoundCell, drawSoundDetail, isTruncated, type RgbaImage } from '../sound-sheet.ts';
import { livePlayhead } from './color.ts';

export const SOUND_GUIDE = `Sound library (sound effects; spec 12). You cannot hear audio. Judge sounds only by their measured descriptors and by pictures, and never claim that something "sounds good", "sounds right" or "fits": say what the numbers and pictures show and ask the user to listen.
- Where sounds come from: the bundled starter kit (real CC0 recordings by Kenney), installed packs, the user's own folders (add_sound_folder; their licence is the user's declaration) and Jasper Synth (procedural, generated here). Synth sounds are a deterministic fallback of lower quality: they always rank after real recordings; prefer a recording whenever one fits.
- Find: search_sounds {q, types, visualKind, length/tone/attack/weight/texture, license, sources, similarTo, limit ≤ 24} → rows with soundId, types, durationSec, peakSec, riseMs, decayMs, centroidHz, below150Share, flatness, pitchMidi, the judge (ok, score, reasons such as boomy, hissy, soft-attack, non-decaying, clipped, multi-hit) and the licence. Words in titles rank first, then type synonyms ("swoosh" finds whooshes). Read the numbers: a hit should peak within a few ms (small peakSec and riseMs) and decay; a riser builds to its end; "boomy" means most energy under 150 Hz, "hissy" above 6 kHz.
- Look: contactSheet: true on search_sounds, or view_sounds {soundIds}, gives ONE PNG grid: each cell is numbered, prints the id, title, length, peak ms, decay ms, centroid and judge, and draws the waveform (cyan) over a 64-band spectrogram (low frequencies at the bottom) with the peak as a red line and the end of the decay (−20 dB) as a dashed yellow one; the cells JSON repeats the numbers. get_sound {soundId} gives one sound with every descriptor and a larger picture with a time axis and the onset (green dashed).
- Use: insert_sound {projectId, soundId, at} places a sound so that its aligned point lands exactly on \`at\` (a frame, {seconds}, a timecode or "playhead"): hits, booms, lands and impacts align their PEAK; risers and reverses align their END (they lead into the moment); UI blips their start (align "auto" picks this from the sound's type). It goes on a free audio track over its span (an existing "SFX" track first) or a new "SFX n" track; it never overwrites audio. One undo step registers the sound, adds it to the project's "Sound Effects" bin, places the clip and tags it Essential Sound ▸ SFX. errorFlicks says how late the aligned point plays (0 when the sound's quiet head absorbs the sub-frame rest; otherwise under one frame). import_sounds {projectId, soundIds} only adds sounds to the bin (one undo step; sounds already in the project are reused); place them yourself with add_clip.
- Licences: search defaults to commercial-safe licences (CC0, CC-BY, CC-BY-SA, open licences, the user's royalty-free folders); license "any" also shows user-provided (undeclared) and other sounds — do not use those in work the user will publish without asking. CC-BY sounds need a credit: list_sound_credits {projectId, format md|txt|csv} gives the credit lines of every library sound the project (or a sequence) uses, with warnings for non-commercial, no-derivatives, unknown or undeclared licences; give the credits to the user when CC-BY sounds are used.
- Library: sound_library_status shows the sources, counts per type, source and licence, the folders and whether an index job runs. rescan_sound_library re-indexes (a job; wait: true waits). add_sound_folder / remove_sound_folder change the user's folders and need the user's approval in an open editor window (E_APPROVAL_DENIED: they said no or no window was open; do not retry without asking).`;

const SoundIdArg = z.string().regex(/^snd_[0-9a-f]{16}$/, 'a sound id: snd_ + 16 hex digits');
const MAX_SHEET = 24;
const CELL_WIDTH = 360;
const CELL_PLOT_HEIGHT = 120;
const SHEET_GAP = 6;

/** Hints for the sound routes' error codes (the generic ones live in errors.ts). */
const SOUND_HINTS: Record<string, string> = {
	SOUND_NOT_FOUND: 'Unknown sound id. Find ids with search_sounds (the library may have been re-indexed).',
	NOT_FOUND:
		'Unknown sound or folder id. Find sound ids with search_sounds and folders with sound_library_status.',
	SOUND_FILE_MISSING:
		"The sound's file is gone from its folder or pack. Run rescan_sound_library, then search again.",
	SOUND_CHANGED: 'The file changed since it was indexed. Run rescan_sound_library, then search again.',
	LOCAL_MODE_ONLY: 'Sound folders only work with a local engine (the engine on this computer).',
	BAD_PATH: 'Give an absolute path of an existing folder on the engine’s computer.',
	NOT_A_FOLDER: 'The path is a file, not a folder. Give the folder that holds the sounds.',
	DUPLICATE_FOLDER: 'That folder (or the same folder through a link) is already in the library.',
	PERMISSION_DENIED: 'The engine cannot read that folder. Check its permissions.',
	PROJECT_NOT_FOUND: 'Unknown projectId. Call list_projects.',
	NOT_A_SOUND: 'Only audio files can be served from the library.',
};

/** Runs an engine call; sound-route errors get their hint (approval and transaction codes pass through). */
async function soundCall<T>(ctx: ToolContext, fn: Parameters<ToolContext['engine']>[0]): Promise<T> {
	try {
		return (await ctx.engine(fn)) as T;
	} catch (e) {
		if (e instanceof EngineError) {
			const inner = (e.detail as { code?: unknown } | undefined)?.code;
			if (typeof inner !== 'string' && SOUND_HINTS[e.code])
				throw new ToolError(
					e.code,
					e.message,
					SOUND_HINTS[e.code],
					e.status ? { httpStatus: e.status } : undefined,
				);
		}
		throw e;
	}
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const r1 = (x: number) => Math.round(x * 10) / 10;

/** The search row an agent reads: identity, the key descriptors, the judge and the licence. */
function soundRow(e: SoundEntry) {
	const d = e.descriptors;
	return {
		soundId: e.id,
		title: e.title,
		types: e.types,
		durationSec: r3(e.format.durationSec),
		peakSec: r3(d.peakSec),
		riseMs: r1(d.riseMs),
		decayMs: d.decays ? r1(d.decayMs) : null,
		centroidHz: Math.round(d.centroidHz),
		below150Share: r3(d.below150Share),
		flatness: r3(d.flatness),
		pitchMidi: d.pitchMidi === null ? null : r1(d.pitchMidi),
		judge: e.judge ? { ok: e.judge.ok, score: r3(e.judge.score), reasons: e.judge.reasons } : null,
		license: e.license,
		author: e.author,
		credit: e.attribution,
		creditRequired: requiresAttribution(e.license),
		source: { type: e.source.type },
	};
}

/** Contact-sheet cells: where each sound is and the numbers drawn on it. */
function sheetCell(e: SoundEntry, i: number, columns: number, visual: SoundVisual | null) {
	const d = e.descriptors;
	return {
		cell: i + 1,
		row: Math.floor(i / columns) + 1,
		column: (i % columns) + 1,
		soundId: e.id,
		title: e.title,
		types: e.types,
		durationSec: r3(e.format.durationSec),
		peakMs: Math.round(d.peakSec * 1000),
		decayMs: d.decays ? Math.round(d.decayMs) : null,
		centroidHz: Math.round(d.centroidHz),
		judge: e.judge ? { ok: e.judge.ok, score: r3(e.judge.score), reasons: e.judge.reasons } : null,
		...(visual
			? isTruncated(visual.coveredSec, e.format.durationSec)
				? { shownSec: r3(visual.coveredSec) }
				: {}
			: { visual: 'unavailable' }),
	};
}

/** Fetches the visual data of each entry (null where the engine has none: the cell says so). */
async function visualsOf(
	ctx: ToolContext,
	entries: SoundEntry[],
	extra: Extra,
): Promise<(SoundVisual | null)[]> {
	const report = progressReporter(extra);
	const out: (SoundVisual | null)[] = [];
	for (const [i, e] of entries.entries()) {
		report(i, entries.length, `Drawing ${e.title || e.id} (${i + 1}/${entries.length})`);
		try {
			out.push(await ctx.engine((c) => c.getSoundVisual(e.id)));
		} catch {
			out.push(null);
		}
	}
	return out;
}

/** ONE PNG grid of the entries (numbered cells) and its cells JSON. */
async function contactSheet(
	ctx: ToolContext,
	entries: SoundEntry[],
	columns: number | undefined,
	extra: Extra,
) {
	const visuals = await visualsOf(ctx, entries, extra);
	const cols = Math.max(1, Math.min(columns ?? 3, entries.length));
	const images: RgbaImage[] = entries.map((e, i) =>
		drawSoundCell(e, visuals[i] ?? null, i + 1, { width: CELL_WIDTH, plotHeight: CELL_PLOT_HEIGHT }),
	);
	const sheet = composeGrid(images, cols, SHEET_GAP, [8, 8, 10]);
	return {
		json: {
			columns: cols,
			rows: sheet.rows,
			sheet: { width: sheet.width, height: sheet.height },
			legend:
				'Each cell: waveform (cyan, normalised to the sound’s own maximum) over a 64-band log spectrogram (20 Hz at the bottom); red line = peak, dashed yellow = end of the decay (peak + decayMs, −20 dB). Time runs left to right over the whole sound.',
			cells: entries.map((e, i) => sheetCell(e, i, cols, visuals[i] ?? null)),
		},
		image: { type: 'image' as const, data: encodePng(sheet).toString('base64'), mimeType: 'image/png' },
	};
}

const SearchArgs = {
	q: z
		.string()
		.max(500)
		.optional()
		.describe('Free text: title words, tags and type names or synonyms ("punch", "swoosh")'),
	types: z
		.array(z.string().min(1).max(32))
		.max(32)
		.optional()
		.describe(
			'Keep only these types (ids or synonyms): hit, boom, riser, reverse, transition, whoosh, swish, glitch, ui, click, key, tick, tap, pop, thump, paper, chime, shimmer, zap, ambience, roomtone',
		),
	family: z.enum(SOUND_FAMILIES).optional().describe('Keep only one family of types'),
	visualKind: z
		.enum(VISUAL_KINDS)
		.optional()
		.describe('The picture event the sound is for: types that suit it rank higher'),
	windowSec: z
		.number()
		.positive()
		.max(600)
		.optional()
		.describe('Length of the moment it must fill (a transition, the build before a hit), seconds'),
	length: z.enum(['short', 'medium', 'long']).optional().describe('short < 0.3 s ≤ medium ≤ 1.5 s < long'),
	tone: z.enum(['dark', 'bright']).optional().describe('dark: centroid ≤ 1 kHz; bright: ≥ 3 kHz'),
	attack: z.enum(['punchy', 'soft']).optional().describe('punchy: rise ≤ 10 ms; soft: ≥ 50 ms'),
	weight: z
		.enum(['light', 'heavy'])
		.optional()
		.describe('light: ≤ 5 % of the energy under 150 Hz; heavy: ≥ 30 %'),
	texture: z.enum(['clean', 'noisy']).optional().describe('clean: flatness ≤ 0.1 (tonal); noisy: ≥ 0.25'),
	license: z
		.enum(['commercial-safe', 'any'])
		.optional()
		.describe('Default commercial-safe; "any" also lists user-provided and other licences'),
	sources: z
		.array(z.enum(SOUND_SOURCE_TYPES))
		.min(1)
		.max(4)
		.optional()
		.describe('Only these sources: starter, pack, folder, synth'),
	similarTo: SoundIdArg.optional().describe('Rank by similarity to this sound (left out of the results)'),
	limit: z.number().int().min(1).max(MAX_SHEET).optional().describe(`Results (1…${MAX_SHEET}, default 12)`),
	offset: z.number().int().min(0).max(100_000).optional().describe('Skip this many results (paging)'),
};

/** Folders as the tools show them. */
const rootView = (r: SoundRoot) => ({
	rootId: r.id,
	path: r.path,
	label: r.label,
	license: r.license,
	enabled: r.enabled,
	...(r.author ? { author: r.author } : {}),
	...(r.attributionTemplate ? { attributionTemplate: r.attributionTemplate } : {}),
});

/** The project's root "Sound Effects" bin, or null. */
function soundEffectsBin(doc: ProjectDocument): string | null {
	for (const id of doc.rootItems) {
		const it = doc.items[id];
		if (it?.kind === 'bin' && it.name === SOUND_EFFECTS_BIN) return it.id;
	}
	return null;
}

/** The media in the (live) document for a registered sound: the engine's match, else the same file not derived. */
function existingMediaFor(doc: ProjectDocument, reg: RegisterSoundResponse): string | null {
	const byEngine = reg.existingMediaId;
	if (byEngine && Object.hasOwn(doc.media, byEngine) && !doc.media[byEngine]!.derivation) return byEngine;
	for (const m of Object.values(doc.media))
		if (m.fingerprint === reg.fingerprint && !m.derivation && m.kind === reg.kind) return m.id;
	return null;
}

type Registered = { soundId: string; reg: RegisterSoundResponse; title: string };

/**
 * The commands that make each registered sound a media of the project: reuse the project's copy (adding the
 * provenance when it lacks one) or register it into the "Sound Effects" bin (created when missing). Refs `$s<i>`.
 */
function importCommands(doc: ProjectDocument, sounds: Registered[]) {
	const commands: Record<string, unknown>[] = [];
	const media: { soundId: string; mediaId: string | null; ref: string | null; reused: boolean }[] = [];
	let binId = soundEffectsBin(doc);
	const seen = new Map<string, number>();
	sounds.forEach(({ soundId, reg, title }, i) => {
		const existing = existingMediaFor(doc, reg);
		if (existing) {
			if (!readLibraryProvenance((doc.media[existing] as { library?: unknown }).library))
				commands.push({ type: 'media.setLibraryInfo', mediaId: existing, library: reg.library });
			media.push({ soundId, mediaId: existing, ref: null, reused: true });
			return;
		}
		const dup = seen.get(reg.fingerprint);
		if (dup !== undefined) {
			media.push({ ...media[dup]!, soundId });
			return;
		}
		if (!binId) {
			commands.push({ type: 'bin.create', name: SOUND_EFFECTS_BIN, ref: '$sfxBin' });
			binId = '$sfxBin';
		}
		const base = mediaRegisterCommand(reg, `$s${i}`, `$si${i}`, title);
		commands.push({ ...base, asset: { ...base.asset, library: reg.library }, binId });
		seen.set(reg.fingerprint, media.length);
		media.push({ soundId, mediaId: null, ref: `$s${i}`, reused: false });
	});
	return { commands, media };
}

const SFX_NAME = /^sfx\b/i;

function nextSfxTrackName(seq: Sequence): string {
	const used = new Set(seq.audioTracks.map((t) => (t.name ?? '').trim().toLowerCase()));
	for (let n = 1; n < 1000; n++) if (!used.has(`sfx ${n}`)) return `SFX ${n}`;
	return 'SFX';
}

/** Clips on an audio track over [start, start + frames), and whether it is locked. */
function trackState(seq: Sequence, trackId: string, start: number, frames: number) {
	const t = seq.audioTracks.find((x) => x.id === trackId);
	const end = start + frames;
	const blocking = Object.values(seq.clips).filter(
		(c) => c.trackId === trackId && c.start < end && start < c.start + c.duration,
	);
	return { exists: !!t, locked: !!t?.locked, blocking };
}

/** Resolves an explicit track argument ("A3", a track id or name) to an audio track id. */
function resolveAudioTrack(seq: Sequence, ref: string): string {
	const m = /^A(\d+)$/i.exec(ref);
	if (m) {
		const t = seq.audioTracks[Number(m[1]) - 1];
		if (t) return t.id;
	}
	const byId = seq.audioTracks.find((t) => t.id === ref);
	if (byId) return byId.id;
	const byName = seq.audioTracks.find(
		(t) => (t.name ?? '').trim().toLowerCase() === ref.trim().toLowerCase(),
	);
	if (byName) return byName.id;
	if (/^V\d+$/i.test(ref) || seq.videoTracks.some((t) => t.id === ref || t.name === ref))
		throw new ToolError(
			'E_TRACK_KIND',
			`${ref} is not an audio track`,
			'Sounds go on audio tracks ("A1", "A2"…).',
		);
	throw new ToolError(
		'E_NOT_FOUND',
		`No audio track ${ref}`,
		'get_timeline lists the tracks; or pass track "auto".',
	);
}

type TrackPick = { kind: 'existing'; trackId: string } | { kind: 'new'; name: string };

/** track "auto": a free "SFX…" track, else the first free audio track, else a new "SFX n" (never overwrites). */
function autoTrack(seq: Sequence, start: number, frames: number): TrackPick {
	const free = (id: string) => {
		const s = trackState(seq, id, start, frames);
		return s.exists && !s.locked && s.blocking.length === 0;
	};
	for (const t of seq.audioTracks)
		if (SFX_NAME.test(t.name ?? '') && free(t.id)) return { kind: 'existing', trackId: t.id };
	for (const t of seq.audioTracks) if (free(t.id)) return { kind: 'existing', trackId: t.id };
	return { kind: 'new', name: nextSfxTrackName(seq) };
}

/** The alignment a sound uses by default: its first known type's (`SOUND_TYPES[type].defaultAlign`), else peak. */
function defaultAlignOf(e: Pick<SoundEntry, 'types'>): SoundAlign {
	for (const t of e.types) if (isSoundTypeId(t)) return SOUND_TYPES[t].defaultAlign;
	return 'peak';
}

export function registerSoundTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'sound_library_status',
		{
			title: 'Sound library status',
			description:
				"The sound library shared by every project: its sources (bundled starter kit, installed packs, the user's folders, Jasper Synth), how many sounds each has, counts per type and licence class, the folders with their declared licences, whether the library was indexed (indexedAt, needsIndex, a running index job) and whether Jasper Synth is available. Read it before searching when results look empty.",
			input: {},
			annotations: READ_ONLY,
		},
		async () => {
			const status = await soundCall<SoundLibraryStatus>(ctx, (c) => c.soundLibraryStatus());
			const [roots, all] = await Promise.all([
				soundCall<{ roots: SoundRoot[]; local: boolean }>(ctx, (c) => c.getSoundRoots()),
				soundCall<SoundSearchResponse>(ctx, (c) => c.searchSounds({ license: 'any', limit: 1 })),
			]);
			const base = ctx.link.target?.url ?? '';
			return jsonResult({
				sounds: status.sounds,
				bySource: status.bySource,
				byType: all.facets.types,
				byFamily: all.facets.families,
				byLicense: all.facets.licenses,
				starterKit: status.starter,
				packs: status.packs,
				folders: roots.roots.map(rootView),
				foldersAllowed: roots.local,
				synth: status.synth,
				snapshotHash: status.snapshotHash,
				indexedAt: status.indexedAt,
				needsIndex: status.needsIndex,
				...(status.recovered ? { recovered: true } : {}),
				indexing: status.indexing ? jobBody(status.indexing, base) : null,
				...(status.sounds === 0
					? {
							note: status.indexing
								? 'The library is being indexed; wait_for_job with indexing.jobId, then search.'
								: 'The library is empty: run rescan_sound_library {wait: true}.',
						}
					: {}),
			});
		},
	);

	defineTool(
		ctx,
		'search_sounds',
		{
			title: 'Search sounds',
			description: `Searches the sound library (ranked: real recordings before Jasper Synth, title words before type synonyms, then type fit, length fit, the judge and licence preference). Returns rows with soundId, title, types, durationSec, peakSec, riseMs, decayMs (null when it does not decay), centroidHz, below150Share, flatness, pitchMidi, judge {ok, score, reasons}, license, author, credit (the line a CC-BY licence asks for), creditRequired and source.type, plus facets (counts per type, family, licence class and source) and total. Licences default to commercial-safe. contactSheet: true also returns ONE PNG with a numbered cell per result (waveform over spectrogram, red peak line, dashed decay end, id and numbers printed) and its cells JSON.`,
			input: {
				...SearchArgs,
				contactSheet: z.boolean().optional().describe('Also return a PNG contact sheet of the results'),
				columns: z
					.number()
					.int()
					.min(1)
					.max(6)
					.optional()
					.describe('Contact-sheet cells per row (default 3)'),
			},
			annotations: READ_ONLY,
		},
		async (a, extra) => {
			const req: SoundSearchRequest = {
				...(a.q !== undefined ? { q: a.q } : {}),
				...(a.types ? { types: a.types } : {}),
				...(a.family ? { family: a.family } : {}),
				...(a.visualKind ? { visualKind: a.visualKind } : {}),
				...(a.windowSec !== undefined ? { windowSec: a.windowSec } : {}),
				...(a.length ? { length: a.length } : {}),
				...(a.tone ? { tone: a.tone } : {}),
				...(a.attack ? { attack: a.attack } : {}),
				...(a.weight ? { weight: a.weight } : {}),
				...(a.texture ? { texture: a.texture } : {}),
				license: a.license ?? 'commercial-safe',
				...(a.sources ? { sources: a.sources } : {}),
				...(a.similarTo ? { similarTo: a.similarTo } : {}),
				limit: a.limit ?? 12,
				...(a.offset ? { offset: a.offset } : {}),
			};
			const res = await soundCall<SoundSearchResponse>(ctx, (c) => c.searchSounds(req, extra.signal));
			const entries = res.results.map((r) => r.sound);
			const body = {
				total: res.total,
				offset: res.offset,
				librarySize: res.librarySize,
				...(res.indexing ? { indexing: true } : {}),
				results: res.results.map((r, i) => ({
					rank: res.offset + i + 1,
					...soundRow(r.sound),
					score: r3(r.score),
				})),
				facets: res.facets,
				...(res.librarySize === 0
					? {
							note: 'The library is empty: run rescan_sound_library {wait: true}, or check sound_library_status.',
						}
					: {}),
			};
			if (!a.contactSheet || entries.length === 0) return jsonResult(body);
			const sheet = await contactSheet(ctx, entries, a.columns, extra);
			return jsonResult({ ...body, contactSheet: sheet.json }, [sheet.image]);
		},
	);

	defineTool(
		ctx,
		'get_sound',
		{
			title: 'Get sound',
			description:
				'One library sound in full: title, types, tags, source, licence, author, credit line, format and every descriptor (peakSec, onsetSec, riseMs, decayMs, tailSec, centroidHz, rolloff85Hz, below150Share, above6kShare, flatness, octaveBandsDb 125 Hz…8 kHz, pitchMidi, onsetCount, integrated / max momentary LUFS, true peak, stereoWidth, headQuietSec, loopable), the judge, plus a PNG: waveform over spectrogram with a time axis (ms), frequency labels, the onset (green dashed), peak (red) and decay end (yellow dashed).',
			input: {
				soundId: SoundIdArg.describe('Sound id from search_sounds'),
				width: z
					.number()
					.int()
					.min(320)
					.max(1600)
					.optional()
					.describe('Picture width in pixels (default 960)'),
			},
			annotations: READ_ONLY,
		},
		async ({ soundId, width }) => {
			const e = await soundCall<SoundEntry>(ctx, (c) => c.getSound(soundId));
			const visual = await soundCall<SoundVisual>(ctx, (c) => c.getSoundVisual(soundId)).catch(() => null);
			const body = {
				...e,
				defaultAlign: defaultAlignOf(e),
				creditRequired: requiresAttribution(e.license),
				...(visual ? {} : { visual: 'unavailable' }),
			};
			if (!visual) return jsonResult(body);
			const W = width ?? 960;
			const img = drawSoundDetail(e, visual, { width: W, height: Math.round(W * 0.42) });
			return jsonResult(body, [
				{ type: 'image', data: encodePng(img).toString('base64'), mimeType: 'image/png' },
			]);
		},
	);

	defineTool(
		ctx,
		'view_sounds',
		{
			title: 'View sounds (contact sheet)',
			description: `ONE PNG contact sheet of up to ${MAX_SHEET} library sounds, in the order given: numbered cells, each the waveform (cyan, normalised) over a 64-band log spectrogram (low at the bottom) with the peak as a red line and the decay end (−20 dB) as a dashed yellow line, the id, title, length, peak ms, decay ms, centroid and judge printed above. Plus cells JSON (cell, row, column, soundId, peakMs, decayMs, centroidHz, judge reasons). Use it to compare candidates: you cannot hear them.`,
			input: {
				soundIds: z.array(SoundIdArg).min(1).max(MAX_SHEET).describe('Sound ids from search_sounds'),
				columns: z.number().int().min(1).max(6).optional().describe('Cells per row (default 3)'),
			},
			annotations: READ_ONLY,
		},
		async ({ soundIds, columns }, extra) => {
			const ids = [...new Set(soundIds)];
			const entries: SoundEntry[] = [];
			for (const id of ids) entries.push(await soundCall<SoundEntry>(ctx, (c) => c.getSound(id)));
			const sheet = await contactSheet(ctx, entries, columns, extra);
			return jsonResult(sheet.json, [sheet.image]);
		},
	);

	defineTool(
		ctx,
		'import_sounds',
		{
			title: 'Import sounds',
			description: `Adds library sounds to a project as media in its "${SOUND_EFFECTS_BIN}" bin (created when missing), with their provenance (licence, author, credit, descriptors), in ONE transaction (one undo step). Starter-kit, pack and synth files are copied into the project's managed media; folder sounds are referenced in place. Sounds the project already has are reused (reused: true), never duplicated. All or nothing: an unknown or changed sound fails the call and imports nothing. Returns one mediaId per sound; place them with add_clip, or use insert_sound to import and place peak-aligned in one go.`,
			input: {
				projectId: ProjectIdArg,
				soundIds: z.array(SoundIdArg).min(1).max(50).describe('Sound ids from search_sounds (up to 50)'),
			},
			annotations: EDIT,
		},
		async ({ projectId, soundIds }, extra) => {
			const ids = [...new Set(soundIds)];
			const report = progressReporter(extra);
			const registered: Registered[] = [];
			for (const [i, id] of ids.entries()) {
				report(i, ids.length, `Registering ${id} (${i + 1}/${ids.length})`);
				const reg = await soundCall<RegisterSoundResponse>(ctx, (c) => c.registerSound(id, projectId));
				registered.push({ soundId: id, reg, title: reg.library.title || reg.originalName });
			}
			const { doc, revision } = await loadDoc(ctx, projectId);
			const plan = importCommands(doc, registered);
			let tx: (ReturnType<typeof txBody> & { historyLabel: string }) | null = null;
			let refs: Record<string, string> = {};
			if (plan.commands.length) {
				const label =
					ids.length === 1 ? `Import Sound ${registered[0]!.title}` : `Import ${ids.length} Sounds`;
				const res = await transact(
					ctx,
					projectId,
					{
						label,
						commands: plan.commands,
						...(revision !== undefined ? { expectedRevision: revision } : {}),
					},
					extra,
				);
				const r = requireOk(res);
				refs = r.refs;
				tx = { ...txBody(res, r), historyLabel: label };
			}
			const sounds = plan.media.map((m, i) => ({
				soundId: m.soundId,
				title: registered.find((x) => x.soundId === m.soundId)?.title ?? registered[i]?.title,
				mediaId: m.mediaId ?? (m.ref ? refs[m.ref] : undefined) ?? null,
				reused: m.reused,
			}));
			return jsonResult({
				...(tx ?? { ok: true, changed: [], note: 'Every sound was already in the project.' }),
				sounds,
				bin: SOUND_EFFECTS_BIN,
			});
		},
	);

	defineTool(
		ctx,
		'insert_sound',
		{
			title: 'Insert sound (peak-aligned)',
			description: `Puts a library sound on the timeline so that its aligned point lands exactly on \`at\` — the agent version of the Sound Library's Insert. align "auto" (default) uses the sound type's: peak for hits, booms, impacts, whooshes; end for risers and reverses (they lead into the moment); start for UI blips; or give peak | start | end. The sub-frame rest is trimmed from the sound's quiet head, so the aligned point is exact to the flick when the head is quiet; otherwise it plays under one frame late (errorFlicks). A sound that would start before frame 0 starts at 0 with its head trimmed (trimmedHeadSec). track "auto" (default) picks a free "SFX…" audio track over the clip's span, else the first free audio track, else adds "SFX n"; an explicit track must be free there (E_OVERLAP otherwise): it never overwrites audio. ONE undo step registers and imports the sound (into the "${SOUND_EFFECTS_BIN}" bin, reusing the project's copy), adds the track if needed, places the clip, tags it Essential Sound ▸ SFX and sets gainDb. Returns the clip, its track, start, the aligned frame and errorFlicks.`,
			input: {
				projectId: ProjectIdArg,
				soundId: SoundIdArg.describe('Sound id from search_sounds'),
				at: z
					.union([z.literal('playhead'), TimeInputSchema])
					.describe(`Where the aligned point lands: "playhead" (the open editor's) or ${TIME_FORMATS}`),
				align: z
					.enum(['auto', 'peak', 'start', 'end'])
					.optional()
					.describe('Which point of the sound lands on `at` (default auto: by its type)'),
				track: z
					.string()
					.min(1)
					.max(200)
					.optional()
					.describe(
						'"auto" (default), or an audio track ("A3", a track id or name) that is free over the span',
					),
				gainDb: z.number().min(-96).max(96).optional().describe('Clip gain in dB (default 0)'),
				sequenceId: SequenceIdArg,
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			const entry = await soundCall<SoundEntry>(ctx, (c) => c.getSound(a.soundId));
			const reg = await soundCall<RegisterSoundResponse>(ctx, (c) => c.registerSound(a.soundId, a.projectId));
			const title = entry.title || reg.library.title || reg.originalName;
			const align: SoundAlign = !a.align || a.align === 'auto' ? defaultAlignOf(entry) : a.align;
			// One retry when the project changed between reading it and applying (never place on a stale view).
			for (let attempt = 0; ; attempt++) {
				const { doc, revision } = await loadDoc(ctx, a.projectId);
				const seq = pickSequence(doc, a.sequenceId);
				let cue: number;
				if (a.at === 'playhead') {
					const ph = await livePlayhead(ctx, a.projectId, seq.id);
					if (ph === null)
						throw new ToolError(
							'E_NO_SESSION',
							'"playhead" needs an editor window showing this sequence',
							'Call open_project_in_editor, or give at as a frame, {"seconds": x} or a timecode.',
						);
					cue = ph;
				} else cue = frameOf(seq, a.at);
				const fps = seq.settings.frameRate as Rational;
				const F = flicksPerFrame(fps);
				const { commands, media } = importCommands(doc, [{ soundId: a.soundId, reg, title }]);
				const existing = media[0]!.mediaId;
				const durFlicks =
					(existing ? mediaDurationFlicks(doc.media[existing] as MediaAsset) : reg.probe.durationFlicks) ??
					Math.round(entry.format.durationSec * FLICKS_PER_SECOND);
				if (!(durFlicks > 0))
					throw new ToolError('E_INVALID_PARAM', 'This sound has no length', 'Pick another sound.');
				const d = entry.descriptors;
				const place = peakAlignedStart({
					cueFrame: cue,
					peakSec: Math.min(d.peakSec, durFlicks / FLICKS_PER_SECOND),
					onsetSec: Math.min(d.onsetSec, durFlicks / FLICKS_PER_SECOND),
					durationSec: durFlicks / FLICKS_PER_SECOND,
					headQuietSec: d.headQuietSec,
					fps,
					align,
					clampStart: true,
				});
				if (!place.ok)
					throw new ToolError(place.code, place.message, 'Check `at` and the sound (get_sound).');
				// What clip.place makes of [In, end of media).
				const frames = Math.max(1, Math.floor(durFlicks / F - place.sourceInFlicks / F + FRAME_EPS));
				let pick: TrackPick;
				if (!a.track || a.track.toLowerCase() === 'auto') pick = autoTrack(seq, place.start, frames);
				else {
					const id = resolveAudioTrack(seq, a.track);
					const s = trackState(seq, id, place.start, frames);
					if (s.locked)
						throw new ToolError('E_TRACK_LOCKED', `${a.track} is locked`, 'Unlock it, or use track "auto".');
					if (s.blocking.length)
						throw new ToolError(
							'E_OVERLAP',
							`${a.track} has audio between frames ${place.start} and ${place.start + frames} (${s.blocking.map((c) => c.id).join(', ')}); insert_sound never overwrites`,
							'Use track "auto" (a free or new SFX track), another track, or move the other clip.',
							{
								blocking: s.blocking.map((c) => ({
									clipId: c.id,
									start: c.start,
									end: c.start + c.duration,
								})),
							},
						);
					pick = { kind: 'existing', trackId: id };
				}
				let trackRef: string;
				if (pick.kind === 'new') {
					commands.push({
						type: 'track.add',
						sequenceId: seq.id,
						kind: 'audio',
						name: pick.name,
						ref: '$sfxTrack',
					});
					trackRef = '$sfxTrack';
				} else trackRef = pick.trackId;
				const mediaRef = existing ?? media[0]!.ref!;
				commands.push(
					{
						type: 'clip.place',
						sequenceId: seq.id,
						source: { mediaId: mediaRef },
						sourceRange: { in: { flicks: place.sourceInFlicks }, out: { flicks: durFlicks } },
						at: place.start,
						tracks: { audio: trackRef },
						mode: 'overwrite',
						video: false,
						ref: '$soundClip',
					},
					{ type: 'essentialSound.setType', clipIds: ['$soundClip'], audioType: 'sfx' },
				);
				if (a.gainDb !== undefined && a.gainDb !== 0)
					commands.push({ type: 'clip.update', clipId: '$soundClip', patch: { gainDb: a.gainDb } });
				const res = await transact(
					ctx,
					a.projectId,
					{
						label: `Add Sound ${title}`,
						commands,
						sequenceId: seq.id,
						...(revision !== undefined ? { expectedRevision: revision } : {}),
					},
					extra,
				);
				if (
					!res.result.ok &&
					attempt === 0 &&
					res.result.errors.some((e) => e.code === 'E_REVISION_MISMATCH')
				)
					continue;
				const r = requireOk(res);
				const clipId = r.refs.$soundClip;
				const after = (await loadDoc(ctx, a.projectId)).doc;
				const aseq = after.sequences[seq.id];
				const clip = clipId ? aseq?.clips[clipId] : undefined;
				if (!aseq || !clip)
					throw new ToolError(
						'INTERNAL',
						'The sound was added but its clip was not found',
						'Call get_timeline.',
					);
				const mediaId = (clip as { mediaId?: string }).mediaId ?? existing;
				const notes: string[] = [];
				if (entry.source.type === 'synth')
					notes.push(
						'This is a Jasper Synth (procedural) sound: a fallback; prefer a recording if one fits.',
					);
				if (requiresAttribution(entry.license))
					notes.push('Its licence requires a credit: list_sound_credits gives the line.');
				if (!isCommercialSafeLicense(entry.license))
					notes.push(
						`Its licence (${entry.license}) is not commercial-safe: ask the user before publishing.`,
					);
				return jsonResult({
					...txBody(res, r),
					historyLabel: `Add Sound ${title}`,
					clipId,
					mediaId,
					soundId: a.soundId,
					title,
					track: trackLabel(aseq, clip.trackId) ?? clip.trackId,
					trackCreated: pick.kind === 'new',
					start: { frame: clip.start, timecode: sequenceTimecode(aseq, clip.start) },
					end: {
						frame: clip.start + clip.duration,
						timecode: sequenceTimecode(aseq, clip.start + clip.duration),
					},
					align,
					alignedFrame: { frame: cue, timecode: sequenceTimecode(aseq, cue) },
					...(align === 'peak' ? { peakFrame: cue } : {}),
					sourceInFlicks: place.sourceInFlicks,
					alignFlicks: place.alignFlicks,
					errorFlicks: place.errorFlicks,
					errorMs: r3((place.errorFlicks / FLICKS_PER_SECOND) * 1000),
					...(place.trimmedHeadSec > 0
						? {
								trimmedHeadSec: place.trimmedHeadSec,
								warning: `The sound would have started before frame 0: ${place.trimmedHeadSec} s of its head is cut.`,
							}
						: {}),
					...(a.gainDb ? { gainDb: a.gainDb } : {}),
					...(requiresAttribution(entry.license) ? { credit: entry.attribution } : {}),
					...(notes.length ? { notes } : {}),
				});
			}
		},
	);

	defineTool(
		ctx,
		'list_sound_credits',
		{
			title: 'List sound credits',
			description:
				'The library sounds a project uses (or one sequence and every sequence nested in it), with title, author, licence, licence URL, source URL, the credit line the licence asks for, requiresAttribution and the clips that use each; plus the credits as text in the chosen format (md, the default; txt; csv) and warnings for non-commercial, no-derivatives, unknown or undeclared (user-provided) licences and incomplete credits. Give the text to the user when CC-BY sounds are used.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: z
					.string()
					.optional()
					.describe('Sequence id ("seq_…"): only what it (with its nests) uses; default: the whole project'),
				format: z.enum(['md', 'txt', 'csv']).optional().describe('Text format (default md)'),
			},
			annotations: READ_ONLY,
		},
		async ({ projectId, sequenceId, format }) => {
			const { doc } = await loadDoc(ctx, projectId);
			if (sequenceId !== undefined && !Object.hasOwn(doc.sequences, sequenceId))
				throw new ToolError(
					'E_NOT_FOUND',
					`Sequence not found: ${sequenceId}`,
					'Call get_project for sequence ids.',
				);
			const c = soundCredits(doc, sequenceId);
			const fmt = format ?? 'md';
			return jsonResult({
				scope: sequenceId ? { sequenceId } : 'project',
				count: c.rows.length,
				attributionRequired: c.rows.filter((r) => r.requiresAttribution).length,
				rows: c.rows,
				format: fmt,
				text: fmt === 'md' ? c.markdown : fmt === 'csv' ? c.csv : c.text,
				warnings: c.warnings,
			});
		},
	);

	/** Writes the folder list; the engine asks the user first when an agent adds, removes or relicenses one. */
	async function putRoots(roots: Record<string, unknown>[], what: string, extra: Extra) {
		const report = progressReporter(extra);
		let n = 0;
		const tick = () =>
			report(n++, undefined, `Waiting for the user to approve "${what}" in the JasperEditor window…`);
		tick();
		const timer = setInterval(tick, 5000);
		try {
			return await soundCall<{ roots: SoundRoot[]; job: EngineJob | null; removedSounds: number }>(ctx, (c) =>
				c.putSoundRoots({ roots: roots as never }),
			);
		} finally {
			clearInterval(timer);
		}
	}

	const asItem = (r: SoundRoot) => ({
		id: r.id,
		path: r.path,
		label: r.label,
		license: r.license,
		enabled: r.enabled,
		...(r.author ? { author: r.author } : {}),
		...(r.attributionTemplate ? { attributionTemplate: r.attributionTemplate } : {}),
	});

	async function maybeWait(job: EngineJob | null, wait: boolean | undefined, extra: Extra) {
		if (!job) return null;
		if (!wait) return jobBody(job, ctx.link.target?.url ?? '');
		const { job: done, timedOut } = await waitJob(ctx, job.id, 600_000, extra, { cancelJobOnAbort: false });
		return { ...jobBody(done, ctx.link.target?.url ?? ''), ...(timedOut ? { timedOut: true } : {}) };
	}

	defineTool(
		ctx,
		'add_sound_folder',
		{
			title: 'Add sound folder',
			description:
				"Adds a folder of the user's own sounds to the library (indexed in place, never copied; local engines only), with a licence declaration: LicenseRef-UserProvided (default: undeclared, flagged in credits and hidden by the commercial-safe filter), LicenseRef-UserRoyaltyFree, CC0-1.0, CC-BY-3.0/4.0 or CC-BY-SA-3.0/4.0. Needs the user's approval on a card in an open editor window (they decide which files and which licence): E_APPROVAL_DENIED when they say no or no window is open — do not retry without asking. Starts an index job (wait: true waits for it).",
			input: {
				path: z.string().min(1).max(4096).describe('Absolute folder path on the engine’s computer'),
				label: z.string().max(200).optional().describe('Display name (default: the folder name)'),
				license: z
					.enum(SOUND_ROOT_LICENSES)
					.optional()
					.describe('Licence of its sounds (default LicenseRef-UserProvided)'),
				author: z.string().max(200).optional().describe('Author or copyright holder (for credits)'),
				attributionTemplate: z
					.string()
					.max(1000)
					.optional()
					.describe(
						'Credit line for its sounds; {title}, {file}, {folder}, {author} and {license} are filled in',
					),
				wait: z.boolean().optional().describe('Wait for the index job (default false)'),
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			const before = await soundCall<{ roots: SoundRoot[]; local: boolean }>(ctx, (c) => c.getSoundRoots());
			if (!before.local)
				throw new ToolError(
					'LOCAL_MODE_ONLY',
					'This engine does not allow sound folders',
					SOUND_HINTS.LOCAL_MODE_ONLY,
				);
			const out = await putRoots(
				[
					...before.roots.map(asItem),
					{
						path: a.path,
						...(a.label !== undefined ? { label: a.label } : {}),
						...(a.license ? { license: a.license } : {}),
						...(a.author !== undefined ? { author: a.author } : {}),
						...(a.attributionTemplate !== undefined ? { attributionTemplate: a.attributionTemplate } : {}),
					},
				],
				'Add a sound folder',
				extra,
			);
			const old = new Set(before.roots.map((r) => r.id));
			const added = out.roots.find((r) => !old.has(r.id)) ?? null;
			return jsonResult({
				ok: true,
				folder: added ? rootView(added) : null,
				folders: out.roots.map(rootView),
				job: await maybeWait(out.job, a.wait, extra),
			});
		},
	);

	defineTool(
		ctx,
		'remove_sound_folder',
		{
			title: 'Remove sound folder',
			description:
				"Removes one of the user's sound folders from the library (by rootId from sound_library_status, or its path): its sounds leave the library at once; the files themselves are never touched, and projects keep the media they imported. Needs the user's approval on a card in an open editor window (E_APPROVAL_DENIED: they said no or no window was open; do not retry without asking).",
			input: {
				rootId: z
					.string()
					.regex(/^root_[0-9a-f]{12}$/)
					.optional()
					.describe('Folder id ("root_…")'),
				path: z.string().min(1).max(4096).optional().describe('Or the folder path as listed'),
			},
			annotations: DESTRUCTIVE_IDEMPOTENT,
		},
		async (a, extra) => {
			if ((a.rootId === undefined) === (a.path === undefined))
				throw new ToolError(
					'E_INVALID_PARAM',
					'Give rootId or path',
					'sound_library_status lists the folders.',
				);
			const before = await soundCall<{ roots: SoundRoot[]; local: boolean }>(ctx, (c) => c.getSoundRoots());
			const target = before.roots.find((r) => (a.rootId ? r.id === a.rootId : r.path === a.path));
			if (!target)
				throw new ToolError(
					'E_NOT_FOUND',
					`No sound folder ${a.rootId ?? a.path}`,
					before.roots.length
						? `The folders are: ${before.roots.map((r) => `${r.id} (${r.path})`).join(', ')}.`
						: 'The library has no user folders.',
				);
			const out = await putRoots(
				before.roots.filter((r) => r.id !== target.id).map(asItem),
				'Remove a sound folder',
				extra,
			);
			return jsonResult({
				ok: true,
				removed: rootView(target),
				removedSounds: out.removedSounds,
				folders: out.roots.map(rootView),
			});
		},
	);

	defineTool(
		ctx,
		'rescan_sound_library',
		{
			title: 'Rescan sound library',
			description:
				"Re-indexes the sound library (starter kit, installed packs, the user's folders, Jasper Synth): new and changed files are analysed (descriptors, judge, pictures), removed ones leave. Unchanged files reuse their analysis unless full: true. Returns the `sound-index` job (an index job already queued or running is joined); wait: true waits for it with progress (cancelling the request does not cancel the shared job; cancel_job does). The result counts sounds, files, analysed, reused, added, removed and per-file errors.",
			input: {
				full: z.boolean().optional().describe('Re-analyse every file (default false)'),
				wait: z.boolean().optional().describe('Wait for the job (default false)'),
				timeoutSeconds: z
					.number()
					.int()
					.min(1)
					.max(3600)
					.optional()
					.describe('How long to wait (default 600)'),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async (a, extra) => {
			const job = await soundCall<EngineJob>(ctx, (c) => c.indexSounds(a.full ? { full: true } : {}));
			if (!a.wait) return jsonResult(jobBody(job, ctx.link.target?.url ?? ''));
			const { job: done, timedOut } = await waitJob(ctx, job.id, (a.timeoutSeconds ?? 600) * 1000, extra, {
				cancelJobOnAbort: false,
			});
			return jsonResult({
				...jobBody(done, ctx.link.target?.url ?? ''),
				...(timedOut ? { timedOut: true } : {}),
			});
		},
	);
}
