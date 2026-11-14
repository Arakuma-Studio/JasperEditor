// Caption clips own their words (`mediaId: null` transcripts, see captions/model.ts);
// clip-level edits (move, trim, ripple delete, sync lock) are the ordinary clip commands.
import type { Draft } from 'immer';
import {
	type CaptionDocument,
	type CaptionFileFormat,
	type Cue,
	decodeCaptionText,
	readCaptionFile,
	snapCaptionDocument,
} from '../../captions/formats/index.ts';
import {
	activeCaptionTrack,
	CAPTION_CONTENT_ORIGIN,
	captionClipName,
	captionClipsOf,
	captionClipWords,
	clipContentRange,
	defaultCaptionStyle,
	findCaptionPreset,
	styleFromVttSettings,
} from '../../captions/model.ts';
import { retimeCaptionText, tokenizeCaptionText } from '../../captions/retime.ts';
import {
	type CaptionBlock,
	type CaptionRules,
	captionBlocks,
	DEFAULT_CAPTION_RULES,
	fillerRanges,
	findFillers,
	findPauses,
	mergeRanges,
	type SeqWord,
	sequenceWords,
	speakerName,
	wordRangeFrames,
} from '../../captions/sequence-transcript.ts';
import {
	normalizeWords,
	replaceWordRange,
	spreadTokens,
	stretchedWordsWarning,
	tokenizeText,
} from '../../captions/words.ts';
import { languageFillerHits } from '../../cleanup/fillers.ts';
import { buildClipsPayload } from '../../clipboard/build.ts';
import { anim, createTrack, defaultTransform } from '../../factories.ts';
import type { ProjectDocument } from '../../schema/document.ts';
import type { Transcript, TranscriptWord } from '../../schema/media.ts';
import type { CaptionStyle, CaptionsClip, Clip, Sequence, Track } from '../../schema/sequence.ts';
import { CaptionStyleSchema } from '../../schema/sequence.ts';
import { FLICKS_PER_SECOND, flicksPerFrame, type Rational, secondsToFlicks } from '../../time.ts';
import type { DClip, DDoc, DSeq, DTrack, HandlerContext } from '../context.ts';
import { cutSnapLevels, snapCutRange } from '../cut-snap.ts';
import { cutRanges } from '../multi-range.ts';
import {
	allTracksIn,
	assertUnlocked,
	cleanupSequence,
	clearRange,
	end,
	findTrackIn,
	relinkSplits,
	removeClip,
	setClipRange,
	splitClipAt,
	trackClips,
} from '../placement.ts';
import type { CaptionRulesInput, CommandOf } from '../schemas/index.ts';
import { levelPauseRanges, voiceArgument } from './cleanup.ts';
import { commonFields, ensureDefaultFont } from './clip-common.ts';
import { clipEditHandlers } from './clip-edit.ts';
import { clipboardHandlers } from './clipboard.ts';
import { type HandlerMap, idList, clone as plain } from './util.ts';

type DCaption = Draft<CaptionsClip>;

function setActive(seq: DSeq, id: string | null): void {
	(seq as { activeCaptionTrackId?: string | null }).activeCaptionTrackId = id;
}

export function addCaptionTrack(
	doc: DDoc,
	seq: DSeq,
	h: HandlerContext,
	opts: {
		name?: string | null;
		language?: string;
		standard?: Track['captionStandard'];
		index?: number;
		active?: boolean;
	},
): DTrack {
	const t = createTrack(h.ids, 'caption', opts.name ?? null);
	if (opts.language) t.language = opts.language;
	if (opts.standard) t.captionStandard = opts.standard;
	t.styleDefaults = defaultCaptionStyle(ensureDefaultFont(doc, h), seq.settings.height);
	const index = Math.min(opts.index ?? seq.captionTracks.length, seq.captionTracks.length);
	seq.captionTracks.splice(index, 0, t as DTrack);
	if (opts.active !== false || seq.captionTracks.length === 1) setActive(seq, t.id);
	return seq.captionTracks.find((x) => x.id === t.id)!;
}

/** A caption track for new captions: a ref, `"new"`, or the active track (created when there is none). */
export function targetCaptionTrack(
	doc: DDoc,
	seq: DSeq,
	ref: string | undefined,
	h: HandlerContext,
	newTrack: { name?: string | null; language?: string; standard?: Track['captionStandard'] } = {},
): DTrack {
	let t: DTrack;
	if (ref === 'new') t = addCaptionTrack(doc, seq, h, newTrack);
	else if (ref === undefined) {
		const active = activeCaptionTrack(seq as Sequence);
		t = active ? seq.captionTracks.find((x) => x.id === active.id)! : addCaptionTrack(doc, seq, h, newTrack);
	} else {
		t = h.track(seq, ref);
		if (t.kind !== 'caption')
			h.fail('E_TRACK_KIND', `Track ${ref} is not a caption track`, { blocking: [t.id] });
	}
	assertUnlocked(t, h);
	return t;
}

function captionClip(
	doc: DDoc,
	clipId: string,
	h: HandlerContext,
): { seq: DSeq; clip: DCaption; track: DTrack } {
	const { seq, clip } = h.clip(doc, clipId);
	if (clip.kind !== 'captions') h.fail('E_INVALID_PARAM', `Clip ${clipId} is not a caption`);
	const track = findTrackIn(seq, clip.trackId)!.track;
	return { seq, clip: clip as DCaption, track };
}

/** Speaker keys for names (reusing keys of names already present). */
function speakerKeyFor(speakers: Record<string, { name: string }>, name: string): string {
	for (const [k, v] of Object.entries(speakers)) if (v.name === name || k === name) return k;
	let n = Object.keys(speakers).length + 1;
	while (speakers[`s${n}`]) n++;
	const key = `s${n}`;
	speakers[key] = { name };
	return key;
}

/** A block to place as one caption clip: sequence frames and words in sequence time (flicks). */
export type PlacedBlock = {
	start: number;
	end: number;
	words: Array<Omit<TranscriptWord, 'speaker'> & { speakerName: string | null }>;
	cue?: { id?: string | null; settings?: string };
	style?: Partial<CaptionStyle>;
};

/**
 * Places caption clips on a caption track (overwrite: captions under them are cut), each owning a new transcript
 * whose words are in clip content time starting at CAPTION_CONTENT_ORIGIN. Returns the clip ids.
 */
export function placeCaptionClips(
	doc: DDoc,
	seq: DSeq,
	track: DTrack,
	blocks: readonly PlacedBlock[],
	h: HandlerContext,
	opts: { language?: string; origin?: Transcript['origin']; style?: Partial<CaptionStyle> } = {},
): string[] {
	const F = flicksPerFrame(seq.settings.frameRate);
	const ids: string[] = [];
	const language = opts.language ?? track.language ?? 'und';
	for (const b of blocks) {
		if (b.end <= b.start) continue;
		const splits = clearRange(seq, track.id, b.start, b.end, h);
		relinkSplits(seq, splits, h);
		const speakers: Record<string, { name: string }> = {};
		const words: TranscriptWord[] = b.words.map((w) => ({
			text: w.text,
			start: Math.max(0, CAPTION_CONTENT_ORIGIN + (w.start - b.start * F)),
			end: Math.max(0, CAPTION_CONTENT_ORIGIN + (w.end - b.start * F)),
			confidence: w.confidence,
			speaker: w.speakerName ? speakerKeyFor(speakers, w.speakerName) : null,
			breakBefore: w.breakBefore,
		}));
		const trsId = h.ids.next('trs');
		doc.transcripts[trsId] = {
			id: trsId,
			mediaId: null,
			language,
			origin: opts.origin ?? 'manual',
			words: normalizeWords(words),
			speakers,
		};
		const id = h.ids.next('clp');
		const frame = { width: seq.settings.width, height: seq.settings.height };
		const text = words.map((w) => w.text).join(' ');
		const style = { ...(opts.style ?? {}), ...(b.style ?? {}) };
		seq.clips[id] = {
			...commonFields(
				id,
				track.id,
				b.start,
				b.end - b.start,
				CAPTION_CONTENT_ORIGIN,
				captionClipName(text),
				'mango',
			),
			kind: 'captions',
			transcriptId: trsId,
			style,
			transform: defaultTransform(frame, frame, 'none'),
			opacity: anim(100),
			...(b.cue && (b.cue.id || b.cue.settings) ? { cue: { ...b.cue } } : {}),
		} as DClip;
		ids.push(id);
	}
	cleanupSequence(seq, h);
	return ids;
}

function rulesFrom(input: CaptionRulesInput | undefined, style?: Partial<CaptionStyle>): CaptionRules {
	const d = DEFAULT_CAPTION_RULES;
	return {
		maxChars: input?.maxChars ?? style?.maxCharsPerLine ?? d.maxChars,
		lines: input?.lines ?? style?.maxLines ?? d.lines,
		minDuration: input?.minSeconds !== undefined ? secondsToFlicks(input.minSeconds) : d.minDuration,
		maxDuration:
			input?.maxSeconds !== undefined
				? secondsToFlicks(input.maxSeconds)
				: style?.maxSegmentMs !== undefined
					? Math.round((style.maxSegmentMs * FLICKS_PER_SECOND) / 1000)
					: d.maxDuration,
		gapFrames: input?.gapFrames ?? d.gapFrames,
		breakPause:
			input?.breakPauseSeconds !== undefined ? secondsToFlicks(input.breakPauseSeconds) : d.breakPause,
	};
}

type TimedWord = {
	text: string;
	start: number;
	end: number;
	speaker: string | null;
	confidence: number | null;
	breakBefore?: string;
};

/** Caption blocks → placed blocks (frames, words with line breaks). */
function blocksToPlaced(
	blocks: readonly CaptionBlock[],
	words: readonly TimedWord[],
	F: number,
	paged: boolean,
): PlacedBlock[] {
	const toPlaced = (b: CaptionBlock, first: TranscriptWord['breakBefore']): PlacedBlock['words'] =>
		words.slice(b.words[0], b.words[1]).map((w, k) => ({
			text: w.text,
			start: w.start,
			end: w.end,
			confidence: w.confidence,
			speakerName: w.speaker,
			breakBefore: k === 0 ? first : b.lineStarts.includes(k) ? 'line' : 'none',
		}));
	if (!paged) return blocks.map((b) => ({ start: b.start / F, end: b.end / F, words: toPlaced(b, 'none') }));
	if (!blocks.length) return [];
	return [
		{
			start: blocks[0]!.start / F,
			end: blocks[blocks.length - 1]!.end / F,
			words: blocks.flatMap((b, i) => toPlaced(b, i === 0 ? 'none' : 'segment')),
		},
	];
}

function wordSpan(words: readonly SeqWord[], from: number, to: number, h: HandlerContext): [number, number] {
	if (!words.length) h.fail('E_INVALID_PARAM', 'The sequence has no transcribed dialogue');
	if (from > to) [from, to] = [to, from];
	if (to >= words.length)
		h.fail('E_INVALID_PARAM', `Word ${to} is out of range (the sequence has ${words.length} words)`);
	return [from, to];
}

/**
 * Ripple-delete frame ranges on every unlocked track (FilmCraft `ripple_delete_ranges`): the result of one
 * `range.extract` per range, right to left, computed in one pass (`cutRanges`, spec 14 TC-031), with edge micro-fades
 * on the audio cuts (`fadeMs`; default 0 = hard cuts).
 */
function rippleDeleteRanges(
	doc: DDoc,
	seq: DSeq,
	ranges: Array<[number, number]>,
	h: HandlerContext,
	fadeMs = 0,
): number {
	const merged = mergeRanges(ranges).filter(([a, b]) => b > a);
	if (!merged.length) return 0;
	const tracks = new Set(
		allTracksIn(seq)
			.filter((t) => !t.locked)
			.map((t) => t.id),
	);
	return cutRanges(doc, seq, h, { ranges: merged, trackIds: tracks, ripple: true, fadeMs }).frames;
}

function cueWords(c: Cue, F: number, offsetFrames: number): PlacedBlock['words'] {
	const toks = tokenizeText(c.text);
	const start = c.start + offsetFrames * F;
	return spreadTokens(toks, start, c.end + offsetFrames * F).map((w) => ({
		...w,
		speakerName: c.speaker ?? null,
	})) as PlacedBlock['words'];
}

function base64ToBytes(b64: string, h: HandlerContext): Uint8Array {
	const clean = b64.replace(/\s+/g, '');
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) h.fail('E_INVALID_PARAM', 'contentBase64 is not base64');
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
	const out: number[] = [];
	let buf = 0;
	let bits = 0;
	for (const ch of clean.replace(/=+$/, '')) {
		buf = (buf << 6) | alphabet.indexOf(ch);
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			out.push((buf >> bits) & 0xff);
		}
	}
	return Uint8Array.from(out);
}

function fileInput(
	cmd: { content?: string; contentBase64?: string },
	h: HandlerContext,
): Uint8Array | string {
	if (cmd.content !== undefined && cmd.contentBase64 !== undefined)
		h.fail('E_INVALID_PARAM', 'Give content or contentBase64, not both');
	if (cmd.contentBase64 !== undefined) return base64ToBytes(cmd.contentBase64, h);
	if (cmd.content !== undefined) return cmd.content;
	return h.fail('E_INVALID_PARAM', 'content or contentBase64 is required');
}

function extOf(fileName: string | undefined): string | null {
	const m = fileName ? /\.([A-Za-z0-9]+)$/.exec(fileName) : null;
	return m ? m[1]!.toLowerCase() : null;
}

function readCaptions(
	input: Uint8Array | string,
	format: CaptionFileFormat | undefined,
	fileName: string | undefined,
	rate: Rational | null,
	h: HandlerContext,
): CaptionDocument {
	const r = readCaptionFile(input, { format: format ?? null, ext: extOf(fileName), snapRate: rate });
	if (!r.ok) return h.fail('E_INVALID_PARAM', `Cannot read captions: ${r.error}`);
	for (const w of r.doc.warnings.slice(0, 20)) h.warn('W_CAPTION_FILE', w);
	return r.doc;
}

type JsonWord = {
	text: string;
	start: number;
	end: number;
	confidence?: number | null;
	speaker?: string | null;
};

/**
 * Transcript JSON: our schema (`{words: [{text, start, end}]}` in flicks), FilmCraft's (ticks, numeric speaker
 * indices with a `speakers` list), `@remotion/captions` `Caption[]` (`startMs`/`endMs`, leading spaces), Whisper /
 * whisper.cpp JSON (`segments[].words[]` with seconds, or `transcription[].tokens[]` offsets in ms), and plain
 * `{text, start, end}` lists in seconds (`seconds: true` or times with fractions).
 */
export function parseTranscriptJson(
	text: string,
): { words: JsonWord[]; speakers: Record<string, { name: string }>; language?: string } | string {
	let v: unknown;
	try {
		v = JSON.parse(decodeCaptionText(text));
	} catch (e) {
		return `not JSON: ${e instanceof Error ? e.message : String(e)}`;
	}
	const speakers: Record<string, { name: string }> = {};
	const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
	const language = typeof o.language === 'string' ? o.language : undefined;
	const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
	const str = (x: unknown) => (typeof x === 'string' ? x : null);
	// speakers: object map, or list (FilmCraft)
	const spk = o.speakers;
	const speakerKeyOf = (x: unknown): string | null => {
		if (typeof x === 'string') {
			if (!speakers[x]) speakers[x] = { name: x };
			return x;
		}
		if (typeof x === 'number' && Number.isInteger(x)) {
			const key = `s${x + 1}`;
			if (!speakers[key]) speakers[key] = { name: `Speaker ${x + 1}` };
			return key;
		}
		return null;
	};
	if (Array.isArray(spk))
		spk.forEach((s, i) => {
			const name = str((s as { name?: unknown })?.name) ?? (typeof s === 'string' ? s : null);
			if (name) speakers[`s${i + 1}`] = { name };
		});
	else if (spk && typeof spk === 'object')
		for (const [k, s] of Object.entries(spk as Record<string, unknown>)) {
			const name = str((s as { name?: unknown })?.name) ?? (typeof s === 'string' ? s : null);
			if (name) speakers[k] = { name };
		}
	let raw: unknown[] | null = null;
	let unit = 'auto' as 'flicks' | 'ticks' | 'ms' | 's' | 'auto';
	if (Array.isArray(v)) raw = v;
	else if (Array.isArray(o.words)) {
		raw = o.words;
		if (o.source !== undefined || Array.isArray(o.speakers)) unit = 'ticks';
	} else if (Array.isArray(o.segments)) {
		raw = (o.segments as Array<Record<string, unknown>>).flatMap((s) =>
			Array.isArray(s.words)
				? (s.words as Array<Record<string, unknown>>).map((w) => ({ ...w, speaker: w.speaker ?? s.speaker }))
				: [{ text: s.text, start: s.start, end: s.end, speaker: s.speaker }],
		);
		unit = 's';
	} else if (Array.isArray(o.transcription)) {
		raw = (o.transcription as Array<Record<string, unknown>>).flatMap((s) =>
			Array.isArray(s.tokens)
				? (s.tokens as Array<Record<string, unknown>>)
						.filter((t) => typeof t.text === 'string' && !/^\[_/.test(t.text as string))
						.map((t) => ({
							text: t.text,
							startMs: (t.offsets as { from?: number })?.from,
							endMs: (t.offsets as { to?: number })?.to,
						}))
				: [
						{
							text: s.text,
							startMs: (s.offsets as { from?: number })?.from,
							endMs: (s.offsets as { to?: number })?.to,
						},
					],
		);
	}
	if (!raw) return 'no words found (expected words, segments, transcription or a list)';
	if (o.seconds === true) unit = 's';
	const words: JsonWord[] = [];
	for (const r of raw) {
		const w = (r ?? {}) as Record<string, unknown>;
		const text = str(w.text) ?? str(w.word);
		if (text === null) continue;
		let start: number | null;
		let endT: number | null;
		if (num(w.startMs) !== null) {
			start = Math.round(num(w.startMs)! * 705_600);
			endT = Math.round((num(w.endMs) ?? num(w.startMs)!) * 705_600);
		} else {
			const a = num(w.start);
			const b = num(w.end);
			if (a === null) continue;
			const u: 'flicks' | 'ticks' | 'ms' | 's' =
				unit === 'auto'
					? Number.isInteger(a) && Number.isInteger(b ?? a) && a + (b ?? 0) > 1e6
						? 'flicks'
						: 's'
					: unit;
			const k = u === 'flicks' ? 1 : u === 'ticks' ? 1 / 360 : u === 'ms' ? 705_600 : FLICKS_PER_SECOND;
			start = Math.round(a * k);
			endT = Math.round((b ?? a) * k);
		}
		words.push({
			text,
			start: Math.max(0, start),
			end: Math.max(0, endT ?? start),
			confidence: num(w.confidence) ?? num(w.probability) ?? num(w.p),
			speaker: speakerKeyOf(w.speaker),
		});
	}
	return { words, speakers, ...(language ? { language } : {}) };
}

const KEEP_STYLE_KEYS = new Set(Object.keys(CaptionStyleSchema.shape));

function validStylePatch(
	style: Partial<CaptionStyle> | undefined,
	doc: DDoc,
	h: HandlerContext,
): Partial<CaptionStyle> {
	if (!style) return {};
	if (style.fontId !== undefined && !doc.fonts[style.fontId])
		h.fail('E_NOT_FOUND', `Font not found: ${style.fontId}`);
	return plain(style);
}

function trackStyleOf(doc: DDoc, seq: DSeq, t: DTrack, h: HandlerContext): CaptionStyle {
	return (
		(plain(t.styleDefaults) as CaptionStyle | undefined) ??
		defaultCaptionStyle(ensureDefaultFont(doc, h), seq.settings.height)
	);
}

function applyStyle(
	doc: DDoc,
	seq: DSeq,
	h: HandlerContext,
	target: { trackId?: string; clipIds?: readonly string[] | '$selection' },
	style: Partial<CaptionStyle>,
	reset: boolean | string[] | undefined,
): { trackId?: string; clipIds?: string[] } {
	const clipIds = idList(target.clipIds);
	if ((target.trackId === undefined) === (clipIds.length === 0))
		h.fail('E_INVALID_PARAM', 'Give trackId (track style) or clipIds (per-caption overrides)');
	for (const k of Object.keys(style))
		if (!KEEP_STYLE_KEYS.has(k)) h.fail('E_INVALID_PARAM', `Unknown caption style field: ${k}`);
	if (target.trackId !== undefined) {
		const t = h.track(seq, target.trackId);
		if (t.kind !== 'caption') h.fail('E_TRACK_KIND', `Track ${target.trackId} is not a caption track`);
		assertUnlocked(t, h);
		const defaults = defaultCaptionStyle(ensureDefaultFont(doc, h), seq.settings.height) as Record<
			string,
			unknown
		>;
		let next = trackStyleOf(doc, seq, t, h) as Record<string, unknown>;
		if (reset === true) next = { ...defaults };
		else if (Array.isArray(reset)) for (const k of reset) next[k] = defaults[k];
		next = { ...next, ...style };
		if (style.highlight) next.highlight = { ...(next.highlight as object), ...style.highlight };
		const parsed = CaptionStyleSchema.safeParse(next);
		if (!parsed.success)
			h.fail('E_INVALID_PARAM', `Invalid caption style: ${parsed.error.issues[0]?.message ?? ''}`);
		t.styleDefaults = parsed.data as CaptionStyle;
		return { trackId: t.id };
	}
	for (const id of clipIds) {
		const { clip, track } = captionClip(doc, id, h);
		assertUnlocked(track, h);
		const cur = { ...(plain(clip.style) as Record<string, unknown>) };
		if (reset === true) for (const k of Object.keys(cur)) delete cur[k];
		else if (Array.isArray(reset)) for (const k of reset) delete cur[k];
		const next = { ...cur, ...style };
		const parsed = CaptionStyleSchema.partial().safeParse(next);
		if (!parsed.success)
			h.fail('E_INVALID_PARAM', `Invalid caption style: ${parsed.error.issues[0]?.message ?? ''}`);
		clip.style = parsed.data as Partial<CaptionStyle>;
	}
	return { clipIds };
}

function addCaptions(doc: DDoc, cmd: CommandOf<'clip.addCaptions'>, h: HandlerContext) {
	const seq = h.sequence(doc, cmd.sequenceId);
	const tr = doc.transcripts[cmd.transcriptId];
	if (!tr) h.fail('E_NOT_FOUND', `Transcript not found: ${cmd.transcriptId}`);
	const track = targetCaptionTrack(doc, seq, cmd.track, h, { language: tr.language });
	const F = flicksPerFrame(seq.settings.frameRate);
	let words: TimedWord[];
	if (cmd.alignToClipId) {
		const { clip } = h.clip(doc, cmd.alignToClipId);
		const c = clip as Clip & { mediaId?: string };
		if (!c.mediaId || c.mediaId !== tr.mediaId)
			h.fail('E_INVALID_PARAM', `Clip ${cmd.alignToClipId} does not play the transcript's media`);
		if (c.speed.reverse) h.fail('E_INVALID_PARAM', 'Reversed clips cannot be captioned');
		const rate = c.speed.rate;
		const [a, b] = clipContentRange(c, seq.settings.frameRate);
		const cs = c.start * F;
		const ce = (c.start + c.duration) * F;
		words = [];
		for (const w of tr.words) {
			if (w.end <= a || w.start >= b) continue;
			const s = cs + Math.round((w.start - c.sourceIn) / rate);
			const e = cs + Math.round((w.end - c.sourceIn) / rate);
			const mid = s + Math.floor((e - s) / 2);
			if (mid < cs || mid >= ce) continue;
			words.push({
				text: w.text,
				start: Math.max(s, cs),
				end: Math.min(e, ce),
				speaker: speakerName(tr as Transcript, w.speaker),
				confidence: w.confidence,
				breakBefore: w.breakBefore,
			});
		}
	} else if (tr.mediaId && sequenceWords(doc, seq).some((w) => w.transcriptId === tr.id)) {
		words = sequenceWords(doc, seq)
			.filter((w) => w.transcriptId === tr.id)
			.map((w) => ({
				text: w.text,
				start: w.start,
				end: w.end,
				speaker: w.speaker,
				confidence: w.confidence,
				breakBefore: tr.words[w.index]?.breakBefore,
			}));
	} else {
		// transcript time = sequence time
		words = tr.words.map((w) => ({
			...w,
			speaker: speakerName(tr as Transcript, w.speaker),
			breakBefore: w.breakBefore,
		}));
	}
	if (cmd.range) {
		const from = h.frame(seq, cmd.range.from) * F;
		const to = h.frame(seq, cmd.range.to) * F;
		words = words
			.filter((w) => w.end > from && w.start < to)
			.map((w) => ({ ...w, start: Math.max(w.start, from), end: Math.min(w.end, to) }));
	}
	if (!words.length) h.fail('E_INVALID_PARAM', 'No transcript words fall in the captioned range');
	const style = validStylePatch(cmd.style, doc, h);
	const blocks = captionBlocks(words, rulesFrom(cmd.rules, style), seq.settings.frameRate);
	const clipIds = placeCaptionClips(
		doc,
		seq,
		track,
		blocksToPlaced(blocks, words, F, cmd.split === false),
		h,
		{
			language: tr.language,
			origin: tr.origin,
			style,
		},
	);
	h.defineRef(cmd.ref, clipIds[0]!);
	return { trackId: track.id, clipIds };
}

function createCaptionsFromTranscript(
	doc: DDoc,
	cmd: CommandOf<'transcript.createCaptions'>,
	h: HandlerContext,
) {
	const seq = h.sequence(doc, cmd.sequenceId);
	const all = sequenceWords(doc, seq);
	if (!all.length) h.fail('E_INVALID_PARAM', 'The sequence has no transcribed dialogue');
	let [from, to] = [cmd.fromWord ?? 0, cmd.toWord ?? all.length - 1];
	[from, to] = wordSpan(all, from, to, h);
	const words = all.slice(from, to + 1);
	const lang = cmd.language ?? (words[0] ? doc.transcripts[words[0].transcriptId]?.language : undefined);
	const track = targetCaptionTrack(doc, seq, cmd.track ?? 'new', h, {
		name: cmd.name ?? 'Subtitles',
		language: lang,
	});
	const style = validStylePatch(cmd.style, doc, h);
	const F = flicksPerFrame(seq.settings.frameRate);
	const timed = words.map((w) => ({
		text: w.text,
		start: w.start,
		end: w.end,
		speaker: w.speaker,
		confidence: w.confidence,
	}));
	const blocks = captionBlocks(timed, rulesFrom(cmd.rules), seq.settings.frameRate);
	const clipIds = placeCaptionClips(doc, seq, track, blocksToPlaced(blocks, timed, F, false), h, {
		language: lang,
		style,
	});
	const stretched = stretchedWordsWarning(words, FLICKS_PER_SECOND);
	if (stretched) h.warn('W_STRETCHED_WORDS', stretched);
	h.defineRef(cmd.ref, track.id);
	return { trackId: track.id, clipIds, captions: clipIds.length };
}

function importCaptions(doc: DDoc, cmd: CommandOf<'caption.import'>, h: HandlerContext) {
	const seq = h.sequence(doc, cmd.sequenceId);
	const rate = seq.settings.frameRate;
	const F = flicksPerFrame(rate);
	let parsed: CaptionDocument;
	let format: CaptionFileFormat | null = cmd.format ?? null;
	if (cmd.cues) {
		if (cmd.content !== undefined || cmd.contentBase64 !== undefined)
			h.fail('E_INVALID_PARAM', 'Give cues or a file content, not both');
		parsed = {
			cues: cmd.cues.map((c) => ({
				start: h.frame(seq, c.start) * F,
				end: h.frame(seq, c.end) * F,
				text: c.text,
				speaker: c.speaker ?? null,
				id: c.id ?? null,
				settings: c.settings ?? '',
			})),
			blocks: [],
			warnings: [],
		};
		snapCaptionDocument(parsed, rate);
	} else {
		const input = fileInput(cmd, h);
		const r = readCaptionFile(input, { format, ext: extOf(cmd.fileName), snapRate: rate });
		if (!r.ok) h.fail('E_INVALID_PARAM', `Cannot read captions: ${r.error}`);
		parsed = r.doc;
		format = r.format;
		for (const w of parsed.warnings.slice(0, 20)) h.warn('W_CAPTION_FILE', w);
	}
	const offset = cmd.offset !== undefined ? h.frame(seq, cmd.offset) : 0;
	const name =
		cmd.name ?? (cmd.fileName ? cmd.fileName.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '') : null);
	const standard =
		format === 'scc' ? 'cea-608' : format === 'mcc' ? 'cea-708' : format === 'stl' ? 'teletext' : 'subtitle';
	const track = targetCaptionTrack(doc, seq, cmd.track ?? 'new', h, {
		name,
		language: cmd.language,
		standard,
	});
	if (cmd.language && !track.language) track.language = cmd.language;
	if (cmd.replace) for (const c of trackClips(seq, track.id)) removeClip(seq, c.id, h);
	if (parsed.blocks.length) track.vttBlocks = [...parsed.blocks];
	const blocks: PlacedBlock[] = parsed.cues
		.map((c) => {
			const start = Math.round(c.start / F) + offset;
			const endF = Math.round(c.end / F) + offset;
			return {
				start,
				end: endF,
				words: cueWords(c, F, offset),
				...(c.id || c.settings
					? { cue: { ...(c.id ? { id: c.id } : {}), ...(c.settings ? { settings: c.settings } : {}) } }
					: {}),
				...(c.settings ? { style: styleFromVttSettings(c.settings) } : {}),
			};
		})
		.filter((b) => b.start >= 0 && b.end > b.start);
	const dropped = parsed.cues.length - blocks.length;
	if (dropped > 0) h.warn('W_CLIP_SKIPPED', `${dropped} cue(s) before the sequence start were skipped`);
	const clipIds = placeCaptionClips(doc, seq, track, blocks, h, {
		language: cmd.language ?? track.language,
		origin: 'subtitle-file',
	});
	h.defineRef(cmd.ref, track.id);
	return { trackId: track.id, clipIds, format, cues: clipIds.length };
}

function addCaption(doc: DDoc, cmd: CommandOf<'caption.add'>, h: HandlerContext) {
	const seq = h.sequence(doc, cmd.sequenceId);
	const track = targetCaptionTrack(doc, seq, cmd.track, h);
	const at = cmd.at !== undefined ? h.frame(seq, cmd.at) : 0;
	if (at < 0) h.fail('E_INVALID_PARAM', 'Caption start must be >= 0');
	const rate = seq.settings.frameRate;
	const F = flicksPerFrame(rate);
	const want =
		cmd.duration !== undefined ? h.durationFrames(seq, cmd.duration) : Math.round((3 * rate.num) / rate.den);
	const clips = trackClips(seq, track.id);
	if (clips.some((c) => c.start <= at && at < end(c)))
		h.fail('E_OVERLAP', 'A caption already covers this time');
	const next = Math.min(Number.POSITIVE_INFINITY, ...clips.filter((c) => c.start > at).map((c) => c.start));
	const dur = Math.min(want, next - at);
	if (dur < 1) h.fail('E_INVALID_PARAM', 'Caption duration must be >= 1 frame');
	const style = validStylePatch(cmd.style, doc, h);
	const toks = tokenizeCaptionText(cmd.text);
	const words = spreadTokens(toks, at * F, (at + dur) * F).map((w) => ({
		...w,
		speakerName: cmd.speaker ?? null,
	}));
	const [id] = placeCaptionClips(doc, seq, track, [{ start: at, end: at + dur, words, style }], h);
	h.defineRef(cmd.ref, id!);
	return { clipId: id, trackId: track.id, duration: dur };
}

function setText(doc: DDoc, cmd: CommandOf<'caption.setText'>, h: HandlerContext) {
	const { seq, clip, track } = captionClip(doc, cmd.clipId, h);
	assertUnlocked(track, h);
	const t = doc.transcripts[clip.transcriptId];
	if (!t) return h.fail('E_NOT_FOUND', `Transcript not found: ${clip.transcriptId}`);
	const rate = seq.settings.frameRate;
	const shown = captionClipWords(doc as ProjectDocument, clip as CaptionsClip, rate);
	const i0 = shown.length ? t.words.indexOf(shown[0] as Draft<TranscriptWord>) : -1;
	const [ca, cb] = clipContentRange(clip, rate);
	if (cmd.text !== undefined) {
		const old = plain(shown) as TranscriptWord[];
		const next = retimeCaptionText(
			old,
			cmd.text,
			{ start: ca, end: cb },
			old[0]?.breakBefore ?? 'none',
			old[0]?.speaker ?? null,
		);
		if (i0 >= 0) t.words.splice(i0, shown.length, ...(next as Draft<TranscriptWord>[]));
		else {
			// no words yet: insert where the content range lies
			const at = t.words.findIndex((w) => w.start >= ca);
			t.words.splice(at < 0 ? t.words.length : at, 0, ...(next as Draft<TranscriptWord>[]));
		}
		t.words = normalizeWords(plain(t.words)) as Draft<TranscriptWord>[];
		clip.name = captionClipName(cmd.text);
	}
	if (cmd.speaker !== undefined) {
		const now = captionClipWords(doc as ProjectDocument, clip as CaptionsClip, rate);
		const key = cmd.speaker === null || cmd.speaker === '' ? null : speakerKeyFor(t.speakers, cmd.speaker);
		const set = new Set(now);
		for (const w of t.words) if (set.has(w)) w.speaker = key;
	}
	return {
		clipId: clip.id,
		words: captionClipWords(doc as ProjectDocument, clip as CaptionsClip, rate).length,
	};
}

function splitCaptions(doc: DDoc, cmd: CommandOf<'caption.split'>, h: HandlerContext) {
	const seq = h.sequence(doc, cmd.sequenceId);
	const at = h.frame(seq, cmd.at);
	const ids = idList(cmd.clipIds);
	const targets = (
		ids.length
			? ids.map((id) => captionClip(doc, id, h).clip)
			: (Object.values(seq.clips).filter(
					(c) => c.kind === 'captions' && !findTrackIn(seq, c.trackId)?.track.locked,
				) as DCaption[])
	).filter((c) => c.start < at && at < end(c));
	if (!targets.length) h.fail('E_INVALID_PARAM', `No caption crosses frame ${at}`);
	const created: string[] = [];
	for (const c of targets) {
		assertUnlocked(findTrackIn(seq, c.trackId)!.track, h);
		created.push(splitClipAt(seq, c, at, h).id);
	}
	cleanupSequence(seq, h);
	return { clipIds: created };
}

function mergeCaptions(doc: DDoc, cmd: CommandOf<'caption.merge'>, h: HandlerContext) {
	const ids = idList(cmd.clipIds);
	if (ids.length < 2) h.fail('E_INVALID_PARAM', 'Merge needs at least two captions');
	const { seq } = captionClip(doc, ids[0]!, h);
	const list = ids.map((id) => captionClip(doc, id, h));
	const trackId = list[0]!.clip.trackId;
	if (list.some((x) => x.clip.trackId !== trackId || x.seq !== seq))
		h.fail('E_INVALID_PARAM', 'Captions to merge must be on one track');
	assertUnlocked(list[0]!.track, h);
	const onTrack = captionClipsOf(seq as Sequence, trackId).map((c) => c.id);
	const idx = ids.map((id) => onTrack.indexOf(id)).sort((a, b) => a - b);
	if (idx.some((v, i) => i > 0 && v !== idx[i - 1]! + 1))
		h.fail('E_INVALID_PARAM', 'Captions to merge must be next to each other');
	const ordered = idx.map((i) => seq.clips[onTrack[i]!] as DCaption);
	const rate = seq.settings.frameRate;
	const F = flicksPerFrame(rate);
	const first = ordered[0]!;
	const last = ordered[ordered.length - 1]!;
	const words: PlacedBlock['words'] = [];
	let language = 'und';
	let origin: Transcript['origin'] = 'manual';
	ordered.forEach((c, k) => {
		const t = doc.transcripts[c.transcriptId];
		if (!t) return;
		if (k === 0) {
			language = t.language;
			origin = t.origin;
		}
		const ws = captionClipWords(doc as ProjectDocument, c as CaptionsClip, rate);
		const step = c.speed.rate;
		ws.forEach((w, i) => {
			const s = c.start * F + Math.round((w.start - c.sourceIn) / step);
			const e = c.start * F + Math.round((w.end - c.sourceIn) / step);
			words.push({
				text: w.text,
				start: s,
				end: e,
				confidence: w.confidence,
				speakerName: speakerName(t as Transcript, w.speaker),
				breakBefore:
					i === 0 ? (k === 0 ? 'none' : 'line') : w.breakBefore === 'segment' ? 'line' : w.breakBefore,
			});
		});
	});
	const keep = plain({
		style: first.style,
		transform: first.transform,
		opacity: first.opacity,
		cue: first.cue,
		name: first.name,
		label: first.label,
	});
	const start = first.start;
	const stop = end(last);
	for (const c of ordered) removeClip(seq, c.id, h);
	const [id] = placeCaptionClips(
		doc,
		seq,
		findTrackIn(seq, trackId)!.track,
		[{ start, end: stop, words }],
		h,
		{ language, origin },
	);
	const merged = seq.clips[id!] as DCaption;
	merged.style = keep.style;
	merged.transform = keep.transform;
	merged.opacity = keep.opacity;
	merged.name = keep.name;
	merged.label = keep.label;
	if (keep.cue) merged.cue = keep.cue;
	return { clipId: id };
}

function setTimes(doc: DDoc, cmd: CommandOf<'caption.setTimes'>, h: HandlerContext) {
	const { seq, clip, track } = captionClip(doc, cmd.clipId, h);
	assertUnlocked(track, h);
	const s = cmd.start === undefined ? clip.start : h.frame(seq, cmd.start);
	const e = cmd.end === undefined ? end(clip) : h.frame(seq, cmd.end);
	if (s < 0 || e - s < 1)
		h.fail('E_INVALID_PARAM', 'A caption must be at least one frame long and start at or after 0');
	const others = trackClips(seq, clip.trackId).filter((c) => c.id !== clip.id);
	if (others.some((c) => c.start < e && s < end(c))) h.fail('E_OVERLAP', 'Captions would overlap');
	const step = flicksPerFrame(seq.settings.frameRate) * clip.speed.rate;
	if (clip.sourceIn + (s - clip.start) * step < 0)
		h.fail('E_INVALID_PARAM', 'The caption cannot start that early');
	setClipRange(seq, clip, s, e);
	cleanupSequence(seq, h);
	return { start: s, end: e };
}

export const CAPTIONS_OWNER = 'wp-captions';

export const captionHandlers = {
	'transcript.create': (doc, cmd, h) => {
		if (cmd.mediaId !== null && !doc.media[cmd.mediaId])
			h.fail('E_NOT_FOUND', `Media not found: ${cmd.mediaId}`);
		const speakers: Record<string, { name: string }> = { ...(cmd.speakers ?? {}) };
		const words = normalizeWords(
			cmd.words.map((w) => {
				const r = w as Record<string, unknown>;
				if (typeof r.text !== 'string') h.fail('E_INVALID_PARAM', 'Every word needs a text');
				if (typeof r.start !== 'number' || typeof r.end !== 'number')
					h.fail('E_INVALID_PARAM', 'Every word needs numeric start and end (flicks)');
				const speaker = typeof r.speaker === 'string' && r.speaker ? r.speaker : null;
				if (speaker && !speakers[speaker])
					speakers[speaker] = { name: `Speaker ${Object.keys(speakers).length + 1}` };
				return { ...(r as Partial<TranscriptWord>), text: r.text as string, speaker };
			}),
		);
		const id = h.newId(doc, 'trs', cmd.id);
		doc.transcripts[id] = {
			id,
			mediaId: cmd.mediaId,
			language: cmd.language,
			origin: cmd.origin,
			words,
			speakers,
		};
		h.defineRef(cmd.ref, id);
		return { transcriptId: id, words: words.length };
	},
	'transcript.editText': (doc, cmd, h) => {
		const t = doc.transcripts[cmd.transcriptId];
		if (!t) return h.fail('E_NOT_FOUND', `Transcript not found: ${cmd.transcriptId}`);
		if (cmd.fromWord > cmd.toWord || cmd.toWord >= t.words.length)
			h.fail(
				'E_INVALID_PARAM',
				`Invalid word range ${cmd.fromWord}–${cmd.toWord} (the transcript has ${t.words.length} words)`,
			);
		t.words = replaceWordRange(
			plain(t) as Transcript,
			cmd.fromWord,
			cmd.toWord,
			cmd.text,
		) as Draft<TranscriptWord>[];
		return { words: t.words.length };
	},
	'transcript.setBreak': (doc, cmd, h) => {
		const t = doc.transcripts[cmd.transcriptId];
		if (!t) return h.fail('E_NOT_FOUND', `Transcript not found: ${cmd.transcriptId}`);
		const w = t.words[cmd.wordIndex];
		if (!w) return h.fail('E_INVALID_PARAM', `Word ${cmd.wordIndex} is out of range`);
		w.breakBefore = cmd.breakBefore;
		return null;
	},
	'transcript.import': (doc, cmd, h) => {
		let mediaId = cmd.mediaId ?? null;
		let clip: DClip | null = null;
		let seq: DSeq | null = null;
		if (cmd.clipId) {
			const r = h.clip(doc, cmd.clipId);
			clip = r.clip;
			seq = r.seq;
			const m = (r.clip as { mediaId?: string }).mediaId;
			if (!m) h.fail('E_INVALID_PARAM', `Clip ${cmd.clipId} has no media`);
			if (mediaId && mediaId !== m) h.fail('E_INVALID_PARAM', 'mediaId does not match the clip');
			mediaId = m ?? null;
		}
		if (!mediaId) return h.fail('E_INVALID_PARAM', 'transcript.import needs mediaId or clipId');
		if (!doc.media[mediaId]) h.fail('E_NOT_FOUND', `Media not found: ${mediaId}`);
		if (cmd.timeBase === 'sequence' && !clip) h.fail('E_INVALID_PARAM', 'timeBase "sequence" needs clipId');
		const input = fileInput(cmd, h);
		const ext = extOf(cmd.fileName);
		const isJson =
			cmd.format === 'json' ||
			(cmd.format === undefined && (ext === 'json' || (typeof input === 'string' && /^\s*[[{]/.test(input))));
		let words: TranscriptWord[];
		let speakers: Record<string, { name: string }> = {};
		let language = cmd.language;
		let origin: Transcript['origin'] = 'subtitle-file';
		if (isJson) {
			const r = parseTranscriptJson(typeof input === 'string' ? input : decodeCaptionText(input));
			if (typeof r === 'string') return h.fail('E_INVALID_PARAM', `Cannot read the transcript: ${r}`);
			speakers = r.speakers;
			language ??= r.language;
			origin = 'manual';
			words = normalizeWords(r.words.map((w) => ({ ...w, breakBefore: 'none' as const })));
		} else {
			const parsed = readCaptions(
				input,
				cmd.format === 'json' ? undefined : cmd.format,
				cmd.fileName,
				null,
				h,
			);
			words = [];
			for (const c of parsed.cues) {
				const toks = tokenizeText(c.text);
				if (toks.length) toks[0]!.breakBefore = 'segment';
				const sp = c.speaker ? speakerKeyFor(speakers, c.speaker) : null;
				words.push(...spreadTokens(toks, c.start, c.end, { speaker: sp }));
			}
			words = normalizeWords(words);
		}
		if (cmd.timeBase === 'sequence' && clip && seq) {
			// file times are sequence time: map them into the clip's media time
			const F = flicksPerFrame(seq.settings.frameRate);
			const k = clip.speed.rate;
			const cs = clip.start * F;
			words = normalizeWords(
				words
					.map((w) => ({
						...w,
						start: clip.sourceIn + Math.round((w.start - cs) * k),
						end: clip.sourceIn + Math.round((w.end - cs) * k),
					}))
					.filter((w) => w.end > 0),
			);
		}
		if (!words.length) h.fail('E_INVALID_PARAM', 'The file has no words');
		const id = h.ids.next('trs');
		doc.transcripts[id] = { id, mediaId, language: language ?? 'und', origin, words, speakers };
		h.defineRef(cmd.ref, id);
		return { transcriptId: id, words: words.length };
	},
	'transcript.delete': (doc, cmd, h) => {
		for (const id of cmd.transcriptIds) {
			if (!doc.transcripts[id]) h.fail('E_NOT_FOUND', `Transcript not found: ${id}`);
			const users: string[] = [];
			for (const seq of Object.values(doc.sequences))
				for (const c of Object.values(seq.clips))
					if ((c as { transcriptId?: string }).transcriptId === id) users.push(c.id);
			if (users.length)
				h.fail('E_IN_USE', `Transcript ${id} is shown by ${users.length} caption(s)`, { blocking: users });
			delete doc.transcripts[id];
		}
		return null;
	},
	'transcript.renameSpeaker': (doc, cmd, h) => {
		const list = cmd.transcriptId ? [doc.transcripts[cmd.transcriptId]] : Object.values(doc.transcripts);
		if (cmd.transcriptId && !list[0]) h.fail('E_NOT_FOUND', `Transcript not found: ${cmd.transcriptId}`);
		let n = 0;
		for (const t of list) {
			if (!t) continue;
			for (const [key, sp] of Object.entries(t.speakers)) {
				if (
					key === cmd.speaker ||
					sp.name === cmd.speaker ||
					speakerName(t as Transcript, key) === cmd.speaker
				) {
					sp.name = cmd.name;
					n++;
				}
			}
			// a key used by words but missing from the map
			if (!t.speakers[cmd.speaker] && t.words.some((w) => w.speaker === cmd.speaker)) {
				t.speakers[cmd.speaker] = { name: cmd.name };
				n++;
			}
		}
		if (!n) h.fail('E_NOT_FOUND', `Speaker not found: ${cmd.speaker}`);
		return { renamed: n };
	},
	'transcript.setSpeaker': (doc, cmd, h) => {
		const t = doc.transcripts[cmd.transcriptId];
		if (!t) return h.fail('E_NOT_FOUND', `Transcript not found: ${cmd.transcriptId}`);
		const [a, b] = cmd.fromWord <= cmd.toWord ? [cmd.fromWord, cmd.toWord] : [cmd.toWord, cmd.fromWord];
		if (b >= t.words.length) h.fail('E_INVALID_PARAM', `Word ${b} is out of range`);
		const key =
			cmd.speaker === null
				? null
				: t.speakers[cmd.speaker]
					? cmd.speaker
					: speakerKeyFor(t.speakers, cmd.speaker);
		for (let i = a; i <= b; i++) t.words[i]!.speaker = key;
		return { speaker: key };
	},
	'transcript.select': (doc, cmd, h) => {
		const seq = h.sequence(doc, cmd.sequenceId);
		const words = sequenceWords(doc, seq);
		const [a, b] = wordSpan(words, cmd.fromWord, cmd.toWord, h);
		const r = wordRangeFrames(words, a, b, seq.settings.frameRate)!;
		seq.inPoint = r[0];
		seq.outPoint = r[1];
		return { in: r[0], out: r[1] };
	},
	'transcript.extract': (doc, cmd, h) => {
		const seq = h.sequence(doc, cmd.sequenceId);
		const words = sequenceWords(doc, seq);
		const [a, b] = wordSpan(words, cmd.fromWord, cmd.toWord, h);
		const r = wordRangeFrames(words, a, b, seq.settings.frameRate)!;
		// with levels the edges move off speech (default on: a word's decay and attack stay, breaths go; cut-snap.ts)
		const levels = cutSnapLevels(cmd, cmd.snapToSilence ?? !!cmd.levels?.length, h);
		const snapped = levels ? snapCutRange(doc, seq, r[0], r[1], levels) : null;
		if (snapped) [r[0], r[1]] = [snapped.from, snapped.to];
		const cut = clipEditHandlers['range.extract']!(
			doc,
			{ type: 'range.extract', sequenceId: seq.id, from: r[0], to: r[1], joinFades: cmd.joinFades },
			h,
		);
		return {
			from: r[0],
			to: r[1],
			fades: cut.fades,
			...(snapped ? { snapped: { clean: snapped.clean } } : {}),
		};
	},
	'transcript.lift': (doc, cmd, h) => {
		const seq = h.sequence(doc, cmd.sequenceId);
		const words = sequenceWords(doc, seq);
		const [a, b] = wordSpan(words, cmd.fromWord, cmd.toWord, h);
		const r = wordRangeFrames(words, a, b, seq.settings.frameRate)!;
		// with levels the edges move off speech (default on: a word's decay and attack stay, breaths go; cut-snap.ts)
		const levels = cutSnapLevels(cmd, cmd.snapToSilence ?? !!cmd.levels?.length, h);
		const snapped = levels ? snapCutRange(doc, seq, r[0], r[1], levels) : null;
		if (snapped) [r[0], r[1]] = [snapped.from, snapped.to];
		const cut = clipEditHandlers['range.lift']!(
			doc,
			{ type: 'range.lift', sequenceId: seq.id, from: r[0], to: r[1], joinFades: cmd.joinFades },
			h,
		);
		return {
			from: r[0],
			to: r[1],
			fades: cut.fades,
			...(snapped ? { snapped: { clean: snapped.clean } } : {}),
		};
	},
	'transcript.insertInto': (doc, cmd, h) => {
		const seq = h.sequence(doc, cmd.sequenceId);
		if (!doc.sequences[cmd.targetSequenceId])
			h.fail('E_NOT_FOUND', `Sequence not found: ${cmd.targetSequenceId}`);
		if (cmd.targetSequenceId === seq.id) h.fail('E_INVALID_PARAM', 'Insert into another sequence');
		const words = sequenceWords(doc, seq);
		const [a, b] = wordSpan(words, cmd.fromWord, cmd.toWord, h);
		const [from, to] = wordRangeFrames(words, a, b, seq.settings.frameRate)!;
		// a copy of the source sequence holding just [from, to) of its picture and sound clips
		const snap = plain(doc) as ProjectDocument;
		const src = snap.sequences[seq.id]!;
		const keep: string[] = [];
		for (const c of Object.values(src.clips)) {
			const t = findTrackIn(src, c.trackId);
			if (!t || t.kind === 'caption' || !c.enabled) {
				delete src.clips[c.id];
				continue;
			}
			if (end(c) <= from || c.start >= to) {
				delete src.clips[c.id];
				continue;
			}
			setClipRange(src as DSeq, c as DClip, Math.max(c.start, from), Math.min(end(c), to));
			keep.push(c.id);
		}
		if (!keep.length) h.fail('E_INVALID_PARAM', 'Nothing to insert in that range');
		src.transitions = {};
		const payload = buildClipsPayload(snap, seq.id, keep, { linked: false });
		const target = doc.sequences[cmd.targetSequenceId]!;
		const at =
			cmd.at !== undefined
				? h.frame(target, cmd.at)
				: Math.max(0, ...Object.values(target.clips).map((c) => end(c)));
		return clipboardHandlers['clip.paste']!(
			doc,
			{
				type: 'clip.paste',
				payload: payload as unknown as Record<string, unknown>,
				sequenceId: target.id,
				at,
				mode: cmd.mode ?? 'insert',
			},
			h,
		);
	},
	'transcript.removeFillers': (doc, cmd, h) => {
		const seq = h.sequence(doc, cmd.sequenceId);
		const words = sequenceWords(doc, seq);
		const lo = cmd.fromWord ?? 0;
		const hi = Math.min(cmd.toWord ?? words.length - 1, words.length - 1);
		const all = cmd.fillers
			? findFillers(words, cmd.fillers)
			: languageFillerHits(doc, seq, words, cmd.language);
		const hits = all.filter(([a, b]) => a >= lo && b - 1 <= hi);
		const ranges = fillerRanges(words, hits, seq.settings.frameRate);
		const removed = rippleDeleteRanges(doc, seq, ranges, h, cmd.fadeMs);
		return { fillers: hits.length, ranges: mergeRanges(ranges).length, frames: removed };
	},
	'transcript.removePauses': (doc, cmd, h) => {
		const seq = h.sequence(doc, cmd.sequenceId);
		const all = sequenceWords(doc, seq);
		const lo = cmd.fromWord ?? 0;
		const hi = Math.min(cmd.toWord ?? all.length - 1, all.length - 1);
		const words = all.slice(lo, hi + 1);
		const mode = cmd.mode ?? 'transcript';
		const keep = cmd.keepSeconds ?? 0.1;
		let ranges: Array<[number, number]>;
		if (mode === 'level') {
			ranges = levelPauseRanges(
				seq,
				words,
				voiceArgument(cmd.voice, h),
				{
					minSeconds: cmd.minSeconds ?? 1,
					padBefore: cmd.padBefore ?? 0,
					padAfter: cmd.padAfter ?? 0,
					outDb: cmd.outDb ?? 20,
					inDb: cmd.inDb ?? 25,
				},
				h,
			);
		} else {
			if (cmd.voice || cmd.outDb !== undefined || cmd.inDb !== undefined)
				h.fail('E_INVALID_PARAM', 'voice, outDb and inDb are for mode "level"');
			ranges = findPauses(
				words,
				secondsToFlicks(cmd.minSeconds ?? 1),
				secondsToFlicks(cmd.padAfter ?? keep),
				seq.settings.frameRate,
				secondsToFlicks(cmd.padBefore ?? keep),
			);
		}
		const removed = rippleDeleteRanges(doc, seq, ranges, h, cmd.fadeMs);
		return { pauses: ranges.length, frames: removed };
	},
	'transcript.createCaptions': createCaptionsFromTranscript,
	'clip.addCaptions': addCaptions,
	'caption.addTrack': (doc, cmd, h) => {
		const seq = h.sequence(doc, cmd.sequenceId);
		const t = addCaptionTrack(doc, seq, h, {
			name: cmd.name,
			language: cmd.language,
			standard: cmd.standard,
			index: cmd.index,
			active: cmd.active,
		});
		if (cmd.style) applyStyle(doc, seq, h, { trackId: t.id }, validStylePatch(cmd.style, doc, h), undefined);
		h.defineRef(cmd.ref, t.id);
		return { trackId: t.id };
	},
	'caption.setActiveTrack': (doc, cmd, h) => {
		const seq = h.sequence(doc, cmd.sequenceId);
		if (cmd.trackId === null) {
			setActive(seq, null);
			return null;
		}
		const t = h.track(seq, cmd.trackId);
		if (t.kind !== 'caption') h.fail('E_TRACK_KIND', `Track ${cmd.trackId} is not a caption track`);
		setActive(seq, t.id);
		return { trackId: t.id };
	},
	'caption.add': addCaption,
	'caption.import': importCaptions,
	'caption.setText': setText,
	'caption.split': splitCaptions,
	'caption.merge': mergeCaptions,
	'caption.setTimes': setTimes,
	'caption.delete': (doc, cmd, h) => {
		const ids = idList(cmd.clipIds);
		if (!ids.length) h.fail('E_INVALID_PARAM', 'No captions given');
		const list = ids.map((id) => captionClip(doc, id, h));
		for (const x of list) assertUnlocked(x.track, h);
		const removed = list.map((x) => ({
			seq: x.seq,
			trackId: x.clip.trackId,
			start: x.clip.start,
			end: end(x.clip),
		}));
		for (const x of list) removeClip(x.seq, x.clip.id, h);
		if (cmd.ripple) {
			for (const r of removed.sort((a, b) => b.start - a.start)) {
				const n = r.end - r.start;
				for (const c of trackClips(r.seq, r.trackId)) if (c.start >= r.end) c.start -= n;
			}
		}
		for (const seq of new Set(list.map((x) => x.seq))) cleanupSequence(seq, h);
		return { deleted: ids.length };
	},
	'caption.setStyle': (doc, cmd, h) => {
		const seq = h.sequence(doc, cmd.sequenceId);
		return applyStyle(
			doc,
			seq,
			h,
			{ trackId: cmd.trackId, clipIds: cmd.clipIds },
			validStylePatch(cmd.style, doc, h),
			cmd.reset,
		);
	},
	'caption.applyPreset': (doc, cmd, h) => {
		const seq = h.sequence(doc, cmd.sequenceId);
		const preset = findCaptionPreset(doc as ProjectDocument, cmd.presetId);
		if (!preset) return h.fail('E_NOT_FOUND', `Caption style preset not found: ${cmd.presetId}`);
		const style = plain(preset.style) as Partial<CaptionStyle>;
		// sizes in built-in presets are for 1080 lines
		if (cmd.presetId.startsWith('builtin:')) {
			const k = seq.settings.height / 1080;
			if (style.background)
				style.background = { ...style.background, paddingPx: Math.round(style.background.paddingPx * k) };
			if (style.strokes)
				style.strokes = style.strokes.map((s) => ({ ...s, widthPx: Math.max(1, Math.round(s.widthPx * k)) }));
			if (style.shadow)
				style.shadow = {
					...style.shadow,
					distancePx: style.shadow.distancePx * k,
					blurPx: style.shadow.blurPx * k,
					...(style.shadow.spreadPx !== undefined ? { spreadPx: style.shadow.spreadPx * k } : {}),
				};
		}
		if (style.fontId && !doc.fonts[style.fontId]) delete style.fontId;
		return applyStyle(doc, seq, h, { trackId: cmd.trackId, clipIds: cmd.clipIds }, style, undefined);
	},
	'caption.savePreset': (doc, cmd, h) => {
		const seq = h.sequence(doc, cmd.sequenceId);
		let style = cmd.style ? validStylePatch(cmd.style, doc, h) : null;
		if (!style) {
			const t = cmd.trackId
				? h.track(seq, cmd.trackId)
				: (seq.captionTracks.find((x) => x.id === activeCaptionTrack(seq as Sequence)?.id) ?? null);
			if (t?.kind !== 'caption') return h.fail('E_INVALID_PARAM', 'No caption track to save the style of');
			style = trackStyleOf(doc, seq, t, h);
		}
		const id = cmd.id ?? `cps_${h.ids.next('fx').slice(3)}`;
		const list = (doc.settings.captionStylePresets ??= []);
		const existing = list.findIndex((p) => p.id === id || p.name === cmd.name);
		const entry = {
			id: existing >= 0 ? list[existing]!.id : id,
			name: cmd.name,
			style: style as Partial<CaptionStyle>,
		};
		if (existing >= 0) list[existing] = entry;
		else list.push(entry);
		return { presetId: entry.id };
	},
	'caption.deletePreset': (doc, cmd, h) => {
		const list = doc.settings.captionStylePresets ?? [];
		const i = list.findIndex((p) => p.id === cmd.presetId);
		if (i < 0) h.fail('E_NOT_FOUND', `Caption style preset not found: ${cmd.presetId}`);
		list.splice(i, 1);
		return null;
	},
} satisfies HandlerMap;
