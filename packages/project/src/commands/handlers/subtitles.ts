// Spec 13 AS-001…AS-012 / AS-020: automatic subtitles. `captions.generate` lays out the transcript (rules, text
// transforms, cut awareness — captions/subtitles/layout.ts) and places every subtitle in ONE command (text clips with
// their words, or caption clips); `captions.regenerate` rebuilds a group from the current transcript keeping the
// clips that still match; `captions.alignToCuts` re-runs the cut steps on existing subtitles; `captions.convert`
// turns a text-clip group into a caption track and back; `subtitleTemplate.*` stores, saves and applies templates.
import { current, type Draft, isDraft } from 'immer';
import { plainCaptionText } from '../../captions/formats/core.ts';
import {
	CAPTION_CONTENT_ORIGIN,
	captionClipWords,
	captionPages,
	resolveCaptionStyle,
} from '../../captions/model.ts';
import { type SeqWord, sequenceWords } from '../../captions/sequence-transcript.ts';
import {
	applyHighlight,
	captionCuesForGroup,
	isTemplateEffect,
	locateWords,
	nameOf,
	wordsInSequence,
	wordsToContent,
} from '../../captions/subtitles/clips.ts';
import { subtitleCutEvents } from '../../captions/subtitles/cuts.ts';
import {
	alignToCutEvents,
	countCrossings,
	emptyStats,
	finishTiming,
	type LayoutStats,
	type LayoutWord,
	layoutSubtitles,
	prepareCutEvents,
	type WorkCaption,
	workCaptionText,
} from '../../captions/subtitles/layout.ts';
import {
	type CaptionGroup,
	type CaptionWord,
	captionGroupOf,
	captionOf,
	groupClips,
	MAX_CAPTION_WORDS,
	MAX_PROJECT_TEMPLATES,
	NO_HIGHLIGHT,
	type SubtitleHighlight,
	type SubtitleSourceRef,
	type TextClipCaption,
} from '../../captions/subtitles/model.ts';
import {
	type CutAwareOptions,
	resolveCutAware,
	resolveSubtitleRules,
	resolveSubtitleText,
	type SubtitleRules,
} from '../../captions/subtitles/rules.ts';
import {
	aspectKeyOf,
	builtinSubtitleTemplate,
	findSubtitleTemplate,
	parseSubtitleTemplate,
	SUBTITLE_TEMPLATE_FORMAT,
	SUBTITLE_TEMPLATE_VERSION,
	type SubtitleTemplate,
	styleAtReference,
	templatePosition,
	templateStyle,
} from '../../captions/subtitles/templates.ts';
import { normalizeWord } from '../../captions/words.ts';
import { buildEffectPreset } from '../../effect-presets/build.ts';
import { createFontRef, createTrack, defaultTransform } from '../../factories.ts';
import type { ProjectDocument } from '../../schema/document.ts';
import {
	type CaptionStyle,
	type Clip,
	type Sequence,
	type TextBox,
	type TextContent,
	type TextStyle,
	TextStyleSchema,
} from '../../schema/sequence.ts';
import { CutMapError } from '../../structure/cuts.ts';
import { type ProjectTextStyle, ProjectTextStyleSchema, textStyleById } from '../../text-styles/model.ts';
import { diffStyle } from '../../text-styles/patch.ts';
import { flicksPerFrame, type Rational } from '../../time.ts';
import type { DClip, DDoc, DSeq, DTrack, HandlerContext } from '../context.ts';
import { latest } from '../draft-read.ts';
import {
	assertUnlocked,
	cleanupSequence,
	clearRange,
	end,
	findTrackIn,
	relinkSplits,
	removeClip,
	setClipRange,
	splitClipAt,
	trackCandidates,
} from '../placement.ts';
import type { CommandOf, TimeInput } from '../schemas/index.ts';
import { addCaptionTrack, type PlacedBlock, placeCaptionClips } from './captions.ts';
import { commonFields, ensureDefaultFont, visualFields } from './clip-common.ts';
import { estimateTextBox, layoutText } from './clip-core.ts';
import { presetHandlers } from './preset.ts';
import { structureHandlers } from './structure.ts';
import { applyInitialTextAnimation } from './text-animation.ts';
import { type HandlerMap, idList } from './util.ts';

export const SUBTITLES_OWNER = 'subtitles' as const;

type DText = Draft<Extract<Clip, { kind: 'text' }>>;
type TextClip = Extract<Clip, { kind: 'text' }>;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const plainDoc = (doc: DDoc) => latest(doc) as ProjectDocument;
const plainSeq = (seq: DSeq) => latest(seq) as Sequence;
const DEFAULT_TEMPLATE_ID = 'builtin:subtitles';
/** Subtitles listed by a dry run. */
const PREVIEW_COUNT = 50;

/** Stats as commands return them (AS-001). */
function publicStats(s: LayoutStats) {
	return {
		count: s.count,
		snappedToCuts: s.snappedToCuts,
		splitAtCuts: s.splitAtCuts,
		belowMinimum: s.belowMinimum,
		merged: s.merged,
		dropped: s.dropped,
		crossing: s.crossing,
		warnings: [...s.warnings],
	};
}

function warnAll(h: HandlerContext, s: LayoutStats): void {
	for (const w of s.warnings.slice(0, 20)) h.warn('W_SUBTITLES', w);
}

// ---------------------------------------------------------------------------------------------------------------
// Templates and fonts

/** A template by id (project copy, else built-in) or an inline object (validated). */
function resolveTemplate(doc: DDoc, ref: string | Record<string, unknown> | undefined, h: HandlerContext) {
	if (ref === undefined) return builtinSubtitleTemplate(DEFAULT_TEMPLATE_ID)!;
	if (typeof ref === 'string') {
		const t = findSubtitleTemplate(plainDoc(doc), ref);
		if (!t) return h.fail('E_NOT_FOUND', `Subtitle template not found: ${ref}`, { path: ['template'] });
		return t;
	}
	const r = parseSubtitleTemplate(ref);
	if (!r.ok) return h.fail(r.code, `Invalid subtitle template: ${r.message}`, { path: ['template'] });
	return r.template;
}

/** Copies a template into the project (AS-020 "copied into the project when used"); same id = replaced. */
function storeTemplateChecked(doc: DDoc, t: SubtitleTemplate, h: HandlerContext): void {
	const d = doc as { subtitleTemplates?: Record<string, SubtitleTemplate> };
	const cur = d.subtitleTemplates ? latest(d.subtitleTemplates)[t.id] : undefined;
	if (cur && JSON.stringify(latest(cur)) === JSON.stringify(t)) return;
	if (!cur && Object.keys(latest(d.subtitleTemplates ?? {})).length >= MAX_PROJECT_TEMPLATES)
		h.fail('E_LIMIT', `A project holds at most ${MAX_PROJECT_TEMPLATES} subtitle templates`);
	d.subtitleTemplates ??= {};
	d.subtitleTemplates[t.id] = clone(t);
}

/** The project font for a family (case-insensitive), registered when missing (resolved at render time). */
function fontIdFor(doc: DDoc, family: string, h: HandlerContext): string {
	const f = Object.values(doc.fonts).find((x) => x.family.toLowerCase() === family.trim().toLowerCase());
	if (f) return f.id;
	const font = createFontRef(h.ids, family.trim());
	doc.fonts[font.id] = font as never;
	return font.id;
}

/**
 * SH-002 linking (AS-003): the template's style becomes a project text style (one per template and frame size,
 * found again by those) and the clips are linked to it, so later edits of that style restyle every subtitle. The
 * project style wins when it exists (it may have been edited since). Returns the effective style.
 */
function linkTemplateStyle(
	doc: DDoc,
	seq: DSeq,
	t: SubtitleTemplate,
	style: TextStyle,
	clipIds: readonly string[],
	h: HandlerContext,
): TextStyle {
	const d = doc as {
		textStyles?: Record<string, ProjectTextStyle & { templateId?: string; frame?: string }>;
	};
	const frame = `${seq.settings.width}x${seq.settings.height}`;
	let found: (ProjectTextStyle & { templateId?: string; frame?: string }) | null = null;
	for (const [k, v] of Object.entries(latest(d.textStyles ?? {}))) {
		const s = textStyleById(plainDoc(doc), k);
		if (s && (v as { templateId?: string }).templateId === t.id && (v as { frame?: string }).frame === frame)
			found = latest(v) as ProjectTextStyle & { templateId?: string; frame?: string };
	}
	if (!found) {
		const names = new Set(Object.values(latest(d.textStyles ?? {})).map((s) => s.name.toLowerCase()));
		let name = t.name.slice(0, 110);
		if (names.has(name.toLowerCase()))
			name = `${t.name.slice(0, 100)} ${seq.settings.width}×${seq.settings.height}`;
		for (let i = 2; names.has(name.toLowerCase()); i++) name = `${t.name.slice(0, 100)} ${i}`;
		if (Object.keys(latest(d.textStyles ?? {})).length >= 1000) return style;
		const id = h.ids.next('tsy');
		found = { id, name, style: clone(style), templateId: t.id, frame };
		if (!ProjectTextStyleSchema.safeParse(found).success) return style;
		d.textStyles ??= {};
		d.textStyles[id] = found;
	}
	const linked = clone(found.style) as TextStyle;
	if (!doc.fonts[linked.fontId]) return style;
	for (const id of clipIds) {
		const c = seq.clips[id] as DText | undefined;
		if (c?.kind !== 'text') continue;
		(c as { styleId?: string }).styleId = found.id;
		delete (c as { styleOverrides?: unknown }).styleOverrides;
		c.content.style = clone(linked) as DText['content']['style'];
	}
	return linked;
}

// ---------------------------------------------------------------------------------------------------------------
// Sources

type SourceWords = {
	words: LayoutWord[];
	language: string;
	warnings: string[];
	sourceRef: SubtitleSourceRef;
};

function rangeFrames(seq: DSeq, r: { start: TimeInput; end: TimeInput } | undefined, h: HandlerContext) {
	if (!r) return null;
	const start = h.frame(seq, r.start);
	const stop = h.frame(seq, r.end);
	if (start < 0 || stop <= start) h.fail('E_INVALID_PARAM', 'range.end must be after range.start (and ≥ 0)');
	return { start, end: stop };
}

/** Transcript words heard through the sequence for a source (sequence flicks), with the language. */
function sourceWords(
	doc: DDoc,
	seq: DSeq,
	source: CommandOf<'captions.generate'>['source'],
	range: { start: number; end: number } | null,
	h: HandlerContext,
	explicitLanguage?: string,
): SourceWords {
	const pdoc = plainDoc(doc);
	const pseq = plainSeq(seq);
	const all = sequenceWords(pdoc, pseq);
	const warnings: string[] = [];
	let ws: SeqWord[] = all;
	let sourceRef: SubtitleSourceRef = { kind: 'sequence-transcript' };
	if (source && typeof source === 'object' && 'mediaId' in source) {
		if (!pdoc.media[source.mediaId]) h.fail('E_NOT_FOUND', `Media not found: ${source.mediaId}`);
		ws = all.filter((w) => w.mediaId === source.mediaId);
		sourceRef = { kind: 'media', mediaId: source.mediaId };
		if (!ws.length)
			h.fail('E_INVALID_PARAM', `No transcribed audio clip of the sequence plays media ${source.mediaId}`);
	} else if (source && typeof source === 'object' && 'clipIds' in source) {
		const ids = new Set<string>();
		for (const id of source.clipIds) {
			const c = pseq.clips[id];
			if (!c) h.fail('E_NOT_FOUND', `Clip not found in the sequence: ${id}`);
			ids.add(id);
			// a video clip stands for its linked audio
			if (c.linkId) for (const m of pseq.links[c.linkId]?.members ?? []) ids.add(m);
		}
		ws = all.filter((w) => ids.has(w.clipId));
		sourceRef = { kind: 'clips', clipIds: [...source.clipIds] };
		if (!ws.length) h.fail('E_INVALID_PARAM', 'The clips have no transcribed dialogue');
	}
	if (range) {
		const F = flicksPerFrame(pseq.settings.frameRate);
		const a = range.start * F;
		const b = range.end * F;
		ws = ws.filter((w) => {
			const m = w.start + Math.floor((w.end - w.start) / 2);
			return m >= a && m < b;
		});
	}
	if (!all.length) h.fail('E_INVALID_PARAM', 'The sequence has no transcribed dialogue');
	if (!ws.length) h.fail('E_INVALID_PARAM', 'No transcribed words fall in the range');
	// AS-013: reversed / time-remapped A-roll gives no words (reported)
	let reversed = 0;
	let remapped = 0;
	for (const c of Object.values(pseq.clips)) {
		if (
			c.kind === 'audio' &&
			c.enabled &&
			c.speed.reverse &&
			pdoc.transcripts &&
			hasTranscript(pdoc, c.mediaId)
		)
			reversed++;
		if (c.kind === 'video' && (c as { timeRemap?: unknown }).timeRemap && c.linkId) remapped++;
	}
	if (reversed)
		warnings.push(`${reversed} reversed audio clip(s) give no words (reversed speech is not subtitled)`);
	if (remapped)
		warnings.push(
			`${remapped} time-remapped video clip(s): their subtitles follow the linked audio's timing, not the remapped picture`,
		);
	const t0 = pdoc.transcripts[ws[0]!.transcriptId];
	const language = explicitLanguage ?? t0?.language ?? 'und';
	const words: LayoutWord[] = ws.map((w) => ({
		text: w.text,
		start: w.start,
		end: w.end,
		speaker: w.speaker,
		breakBefore: pdoc.transcripts[w.transcriptId]?.words[w.index]?.breakBefore,
	}));
	return { words, language, warnings, sourceRef };
}

function hasTranscript(doc: ProjectDocument, mediaId: string): boolean {
	for (const t of Object.values(doc.transcripts)) if (t.mediaId === mediaId) return true;
	return false;
}

// ---------------------------------------------------------------------------------------------------------------
// Placement

/** A video track for text-clip subtitles: an existing one (unlocked, video) or a new top track. */
function subtitleVideoTrack(seq: DSeq, ref: string | undefined, name: string, h: HandlerContext): DTrack {
	if (ref && ref !== 'new') {
		const t = h.track(seq, ref);
		if (t.kind !== 'video')
			h.fail('E_TRACK_KIND', `Track ${ref} is not a video track (text-clip subtitles go on video tracks)`, {
				blocking: [t.id],
			});
		assertUnlocked(t, h);
		return t;
	}
	const t = createTrack(h.ids, 'video', name);
	seq.videoTracks.push(t as DTrack);
	return seq.videoTracks[seq.videoTracks.length - 1]!;
}

/** The output track of the cut map for a target track: none (new top track) = every video track counts. */
function outputTrackFor(seq: DSeq, ref: string | undefined, h: HandlerContext): string | null {
	if (!ref || ref === 'new') return null;
	const t = h.track(seq, ref);
	return t.id;
}

function cutEventsOrFail(
	doc: DDoc,
	seq: DSeq,
	outputTrackId: string | null,
	opts: CutAwareOptions,
	h: HandlerContext,
) {
	try {
		// a plain snapshot: the cut map's per-track indexes are cached by record identity, never on drafts
		const snap = (isDraft(doc) ? current(doc) : doc) as ProjectDocument;
		return subtitleCutEvents(snap, snap.sequences[seq.id]!, outputTrackId, opts);
	} catch (e) {
		if (e instanceof CutMapError) return h.fail(e.code, e.message, { path: ['cutAware'] });
		throw e;
	}
}

type Layout = { box: TextBox; position: [number, number] };

/** Box and box-centre position of a template on a sequence (the box height follows the text). */
function templateLayout(t: SubtitleTemplate, seq: DSeq, content: TextContent): Layout {
	const W = seq.settings.width;
	const H = seq.settings.height;
	const width = Math.max(1, Math.round((W * t.box.widthPct) / 100));
	const est = estimateTextBox(content, W);
	const lines = Math.max(1, content.text.split('\n').length);
	const height = Math.max(est.height, Math.ceil(lines * content.style.sizePx * content.style.lineHeight));
	const p = templatePosition(t, W, H);
	return { box: { width, height, autoSize: 'height' }, position: [p.x * W, p.y * H] };
}

/** Sets a text clip's box and position from a layout (anchor = box centre), then lays the text out. */
function setLayout(clip: DText, l: Layout, seq: DSeq, h: HandlerContext): void {
	clip.box = { ...l.box } as DText['box'];
	layoutText(clip, h, seq.settings.width);
	clip.transform.position.value = [l.position[0], l.position[1]];
	clip.transform.anchor.value = [clip.box.width / 2, clip.box.height / 2];
}

type PlaceOpts = {
	template: SubtitleTemplate;
	groupId: string;
	style: TextStyle;
	highlight: SubtitleHighlight;
};

/** Creates one text clip per subtitle (overwrite on the track) with words in content time. Returns their ids. */
function placeTextSubtitles(
	seq: DSeq,
	track: DTrack,
	caps: readonly WorkCaption[],
	o: PlaceOpts,
	h: HandlerContext,
	origin: number,
): string[] {
	const rate = seq.settings.frameRate as Rational;
	const frame = { width: seq.settings.width, height: seq.settings.height };
	const ids: string[] = [];
	// perf: the track's clips under the subtitles are found once (the subtitles never overlap each other)
	const lo = Math.min(...caps.map((c) => c.start));
	const hi = Math.max(...caps.map((c) => c.end));
	const pool = caps.length ? trackCandidates(seq, new Map([[track.id, { lo, hi }]])).get(track.id) : undefined;
	for (const c of caps) {
		if (c.end <= c.start) continue;
		relinkSplits(seq, clearRange(seq, track.id, c.start, c.end, h, new Set(), pool), h);
		const id = h.ids.next('clp');
		const text = workCaptionText(c);
		const content: TextContent = { text, style: clone(o.style) };
		const l = templateLayout(o.template, seq, content);
		const transform = defaultTransform(l.box, frame, 'none');
		const timing = {
			start: c.start,
			duration: c.end - c.start,
			sourceIn: origin,
			speed: { rate: 1, reverse: false },
		};
		const caption: TextClipCaption = {
			groupId: o.groupId,
			words: wordsToContent(timing as never, c.words, rate).slice(0, MAX_CAPTION_WORDS),
			...(c.speaker ? { speaker: c.speaker } : {}),
			anchorIn: origin,
		};
		seq.clips[id] = {
			...commonFields(id, track.id, c.start, c.end - c.start, origin, nameOf(text), 'lavender'),
			kind: 'text',
			content,
			box: l.box,
			...visualFields(transform),
			caption,
		} as DClip;
		setLayout(seq.clips[id] as DText, l, seq, h);
		ids.push(id);
	}
	return ids;
}

/** Template animation, effects and highlight on text clips (one pass; keys anchored to each In). */
function applyTemplateMotion(
	doc: DDoc,
	seq: DSeq,
	ids: readonly string[],
	t: SubtitleTemplate,
	h: HandlerContext,
): void {
	if (!ids.length) return;
	const fps = seq.settings.frameRate.num / seq.settings.frameRate.den;
	const ta = t.animation?.textAnimation;
	const input = ta
		? {
				...(ta.in
					? {
							in: {
								preset: ta.in.preset,
								...(ta.in.version !== undefined ? { version: ta.in.version } : {}),
								...(ta.in.seconds !== undefined
									? { durationFrames: Math.max(1, Math.round(ta.in.seconds * fps)) }
									: {}),
								...(ta.in.params ? { params: ta.in.params } : {}),
							},
						}
					: {}),
				...(ta.out
					? {
							out: {
								preset: ta.out.preset,
								...(ta.out.version !== undefined ? { version: ta.out.version } : {}),
								...(ta.out.seconds !== undefined
									? { durationFrames: Math.max(1, Math.round(ta.out.seconds * fps)) }
									: {}),
								...(ta.out.params ? { params: ta.out.params } : {}),
							},
						}
					: {}),
			}
		: undefined;
	for (const id of ids) {
		const c = seq.clips[id] as DText;
		delete c.textAnimation;
		if (input && (input.in || input.out)) applyInitialTextAnimation(seq, c as DClip, input, h);
	}
	const preset = t.animation?.preset;
	if (preset?.effects?.length) {
		const r = presetHandlers['effect.applyPreset'](
			doc,
			{ type: 'effect.applyPreset', preset: preset as never, clipIds: [...ids] },
			h,
		) as { effectInstanceIds: Record<string, string[]> };
		for (const id of ids) {
			const c = seq.clips[id] as DText;
			const made = new Set(r.effectInstanceIds[id] ?? []);
			for (const fx of c.effects)
				if (made.has(fx.id)) (fx as { subtitleTemplate?: string }).subtitleTemplate = t.id;
			const cap = c.caption as TextClipCaption | undefined;
			if (cap) c.caption = { ...cap, anchorIn: c.sourceIn } as never;
		}
	}
}

/** Removes the effects a template added earlier (re-applying a template replaces its animation). */
function removeTemplateEffects(clip: DText): void {
	if (!clip.effects.some((fx) => isTemplateEffect(fx as { subtitleTemplate?: unknown }))) return;
	clip.effects = clip.effects.filter(
		(fx) => !isTemplateEffect(fx as { subtitleTemplate?: unknown }),
	) as DText['effects'];
}

function newGroup(
	h: HandlerContext,
	f: {
		name: string;
		templateId: string | null;
		rules: SubtitleRules;
		text: CaptionGroup['text'];
		language: string;
		cutAware: CutAwareOptions;
		sourceRef: SubtitleSourceRef;
		range: { start: number; end: number } | null;
		trackId: string | null;
		highlight: SubtitleHighlight;
	},
): CaptionGroup {
	return { id: h.ids.next('cgp'), ...f, createdAt: h.ctx.now() };
}

function setGroup(seq: DSeq, g: CaptionGroup): void {
	const s = seq as { captionGroups?: Record<string, CaptionGroup> };
	s.captionGroups ??= {};
	s.captionGroups[g.id] = clone(g);
}

function groupOrFail(seq: DSeq, id: string, h: HandlerContext): CaptionGroup {
	const g = captionGroupOf(plainSeq(seq), id);
	if (!g) return h.fail('E_NOT_FOUND', `Subtitle group not found: ${id}`);
	return clone(g);
}

/** The sequence holding a group (the active one first). */
function sequenceOfGroup(doc: DDoc, groupId: string, h: HandlerContext): DSeq {
	try {
		const seq = h.sequence(doc);
		if (captionGroupOf(plainSeq(seq), groupId)) return seq;
	} catch {
		// no active sequence: search below
	}
	for (const [sid, s] of Object.entries(latest(doc.sequences)))
		if (captionGroupOf(latest(s) as Sequence, groupId)) return doc.sequences[sid]!;
	return h.fail('E_NOT_FOUND', `Subtitle group not found: ${groupId}`);
}

// ---------------------------------------------------------------------------------------------------------------
// captions.generate (AS-001…AS-004)

/** Caption-track style of a template (AS-004): text style fields, box width, block position, highlight. */
function captionStyleOfTemplate(
	t: SubtitleTemplate,
	style: TextStyle,
	seq: DSeq,
	rules: SubtitleRules,
	hl: SubtitleHighlight,
): Partial<CaptionStyle> {
	const W = seq.settings.width;
	const H = seq.settings.height;
	const p = templatePosition(t, W, H);
	const blockH = rules.lines * style.sizePx * style.lineHeight;
	return {
		...clone(style),
		boxWidthPct: Math.min(100, Math.max(1, t.box.widthPct)),
		maxCharsPerLine: rules.maxChars,
		maxLines: rules.lines,
		maxSegmentMs: Math.round(rules.maxSeconds * 1000),
		highlight: {
			mode: hl.mode === 'word' ? 'word' : hl.mode === 'karaoke' ? 'karaoke' : 'none',
			color: [...hl.color] as never,
		},
		linePct: Math.min(100, Math.max(0, ((p.y * H - blockH / 2) / H) * 100)),
		positionPct: Math.min(100, Math.max(0, p.x * 100)),
	};
}

/** Placed caption blocks from laid-out subtitles (line breaks from their line starts). */
function placedBlocks(caps: readonly WorkCaption[]): PlacedBlock[] {
	return caps.map((c) => ({
		start: c.start,
		end: c.end,
		words: c.words.map((w, k) => ({
			text: w.text,
			start: w.start,
			end: w.end,
			confidence: null,
			speakerName: c.speaker,
			breakBefore: k > 0 && c.lineStarts.includes(k) ? ('line' as const) : ('none' as const),
		})),
	}));
}

function generate(doc: DDoc, cmd: CommandOf<'captions.generate'>, h: HandlerContext) {
	const seq = h.sequence(doc, cmd.sequenceId);
	const template = resolveTemplate(doc, cmd.template, h);
	// AS-003: text clips by default; a template chosen explicitly may default to a caption track (Subtitles)
	const output = cmd.output ?? (cmd.template !== undefined ? template.output : undefined) ?? 'text-clips';
	const rules = resolveSubtitleRules(cmd.rules, template.rules ?? {});
	const text = resolveSubtitleText(cmd.text, (template.text ?? {}) as never);
	const cutAware = resolveCutAware(cmd.cutAware, (template.cutAware ?? {}) as never);
	const range = rangeFrames(seq, cmd.range, h);
	if (cmd.trackId && cmd.trackId !== 'new') {
		const t = h.track(seq, cmd.trackId);
		if (output === 'caption-track' ? t.kind !== 'caption' : t.kind !== 'video')
			h.fail(
				'E_TRACK_KIND',
				`Track ${cmd.trackId} is not a ${output === 'caption-track' ? 'caption' : 'video'} track`,
				{
					blocking: [t.id],
				},
			);
		assertUnlocked(t, h);
	}
	const src = sourceWords(doc, seq, cmd.source, range, h, cmd.language);
	const outputTrack = output === 'caption-track' ? null : outputTrackFor(seq, cmd.trackId, h);
	const cuts = cutAware.enabled ? cutEventsOrFail(doc, seq, outputTrack, cutAware, h) : null;
	const layout = layoutSubtitles({
		words: src.words,
		rules,
		text,
		language: src.language,
		rate: seq.settings.frameRate as Rational,
		cuts: cuts?.events ?? null,
		cutAware,
		...(range ? { limit: range } : {}),
	});
	layout.stats.warnings.unshift(...src.warnings, ...(cuts?.warnings ?? []));
	const stats = publicStats(layout.stats);
	if (cmd.dryRun)
		return {
			dryRun: true,
			output,
			templateId: template.id,
			stats,
			rules,
			text,
			cutAware,
			language: src.language,
			captions: layout.captions.slice(0, PREVIEW_COUNT).map((c) => ({
				start: c.start,
				end: c.end,
				text: workCaptionText(c),
			})),
		};
	warnAll(h, layout.stats);
	const highlight = template.highlight ?? NO_HIGHLIGHT;
	const fontId = fontIdFor(doc, template.fontFamily, h);
	const style = templateStyle(template, fontId, seq.settings.width, seq.settings.height);
	storeTemplateChecked(doc, template, h);
	if (output === 'caption-track') {
		const name = cmd.trackName ?? cmd.name ?? template.name;
		const track =
			cmd.trackId && cmd.trackId !== 'new'
				? h.track(seq, cmd.trackId)
				: addCaptionTrack(doc, seq, h, { name, language: src.language });
		const cstyle = captionStyleOfTemplate(template, style, seq, rules, highlight);
		track.styleDefaults = { ...(clone(track.styleDefaults) ?? {}), ...cstyle } as never;
		const clipIds = placeCaptionClips(doc, seq, track, placedBlocks(layout.captions), h, {
			language: src.language,
			origin: 'manual',
		});
		h.defineRef(cmd.ref, track.id);
		return { output, trackId: track.id, clipIds, count: clipIds.length, stats, templateId: template.id };
	}
	const track = subtitleVideoTrack(seq, cmd.trackId, cmd.trackName ?? 'Subtitles', h);
	const group = newGroup(h, {
		name: cmd.name ?? template.name,
		templateId: template.id,
		rules,
		text,
		language: src.language,
		cutAware,
		sourceRef: src.sourceRef,
		range,
		trackId: track.id,
		highlight,
	});
	setGroup(seq, group);
	// content time of a subtitle's In: one hour, like caption clips (room to extend heads by trims and alignment)
	const origin = CAPTION_CONTENT_ORIGIN;
	const ids = placeTextSubtitles(
		seq,
		track,
		layout.captions,
		{ template, groupId: group.id, style, highlight },
		h,
		origin,
	);
	applyTemplateMotion(doc, seq, ids, template, h);
	const linked = linkTemplateStyle(doc, seq, template, style, ids, h);
	for (const id of ids) {
		const c = seq.clips[id] as DText;
		if (JSON.stringify(latest(c.content.style)) !== JSON.stringify(linked))
			c.content.style = clone(linked) as never;
		applyHighlight(c as unknown as TextClip, highlight, () => h.ids.next('kf'));
	}
	cleanupSequence(seq, h);
	let nestedSequenceId: string | null = null;
	if (cmd.nest && ids.length) {
		const r = structureHandlers['clip.nest'](
			doc,
			{ type: 'clip.nest', clipIds: ids, name: `${group.name} (subtitles)` },
			h,
		) as { sequenceId?: string };
		nestedSequenceId = r.sequenceId ?? null;
		if (nestedSequenceId && doc.sequences[nestedSequenceId]) {
			const inner = doc.sequences[nestedSequenceId]!;
			setGroup(inner, { ...group, trackId: inner.videoTracks[0]?.id ?? null });
			delete (seq as { captionGroups?: Record<string, CaptionGroup> }).captionGroups?.[group.id];
		}
		h.warn(
			'W_SUBTITLES_NESTED',
			'The subtitles are in a nested sequence: they do not follow later ripple edits of this sequence',
		);
	}
	h.defineRef(cmd.ref, group.id);
	return {
		output,
		groupId: group.id,
		trackId: track.id,
		clipIds: ids,
		count: ids.length,
		stats,
		templateId: template.id,
		...(nestedSequenceId ? { nestedSequenceId } : {}),
	};
}

// ---------------------------------------------------------------------------------------------------------------
// captions.regenerate (AS-006)

const normText = (s: string) => s.split(/\s+/).map(normalizeWord).filter(Boolean).join(' ');

function regenerate(doc: DDoc, cmd: CommandOf<'captions.regenerate'>, h: HandlerContext) {
	const seq = sequenceOfGroup(doc, cmd.groupId, h);
	const group = groupOrFail(seq, cmd.groupId, h);
	const rate = seq.settings.frameRate as Rational;
	const template =
		(group.templateId ? findSubtitleTemplate(plainDoc(doc), group.templateId) : null) ??
		builtinSubtitleTemplate(DEFAULT_TEMPLATE_ID)!;
	const rules = resolveSubtitleRules(cmd.rules, group.rules);
	const text = resolveSubtitleText(cmd.text, group.text);
	const cutAware = resolveCutAware(cmd.cutAware, group.cutAware);
	const range = rangeFrames(seq, cmd.range, h) ?? group.range;
	const source =
		group.sourceRef.kind === 'media'
			? { mediaId: group.sourceRef.mediaId }
			: group.sourceRef.kind === 'clips'
				? { clipIds: group.sourceRef.clipIds.filter((id) => !!plainSeq(seq).clips[id]) }
				: 'sequence-transcript';
	if (typeof source === 'object' && 'clipIds' in source && !source.clipIds?.length)
		h.fail('E_NOT_FOUND', 'The clips the group was made from are gone');
	const src = sourceWords(doc, seq, source as never, range, h, group.language);
	const old = groupClips(plainSeq(seq), group.id).filter(
		(c) => !range || (c.start < range.end && c.start + c.duration > range.start),
	);
	const trackId =
		group.trackId && findTrackIn(seq, group.trackId) ? group.trackId : (old[0]?.trackId ?? null);
	const cuts = cutAware.enabled ? cutEventsOrFail(doc, seq, trackId, cutAware, h) : null;
	const layout = layoutSubtitles({
		words: src.words,
		rules,
		text,
		language: src.language,
		rate,
		cuts: cuts?.events ?? null,
		cutAware,
		...(range ? { limit: range } : {}),
	});
	layout.stats.warnings.unshift(...src.warnings, ...(cuts?.warnings ?? []));
	// keep clips that still match: same words (case and punctuation ignored) overlapping in time
	const used = new Set<string>();
	const reuse = new Map<number, string>();
	layout.captions.forEach((c, i) => {
		const want = normText(workCaptionText(c));
		const hit = old.find(
			(o) =>
				!used.has(o.id) &&
				o.kind === 'text' &&
				normText(o.content.text) === want &&
				o.start < c.end &&
				o.start + o.duration > c.start,
		);
		if (hit) {
			used.add(hit.id);
			reuse.set(i, hit.id);
		}
	});
	const removed = old.filter((o) => !used.has(o.id));
	if (cmd.dryRun)
		return {
			dryRun: true,
			stats: publicStats(layout.stats),
			kept: reuse.size,
			created: layout.captions.length - reuse.size,
			removed: removed.length,
		};
	for (const o of removed) {
		const t = findTrackIn(seq, o.trackId)?.track;
		if (t) assertUnlocked(t, h);
	}
	for (const o of [...used]) {
		const t = findTrackIn(seq, seq.clips[o]!.trackId)?.track;
		if (t) assertUnlocked(t, h);
	}
	warnAll(h, layout.stats);
	for (const o of removed) removeClip(seq, o.id, h);
	const kept: string[] = [];
	const fresh: WorkCaption[] = [];
	layout.captions.forEach((c, i) => {
		const id = reuse.get(i);
		if (!id) {
			fresh.push(c);
			return;
		}
		const clip = seq.clips[id] as DText;
		setClipRange(seq, clip as DClip, c.start, c.end);
		const cap = clip.caption as TextClipCaption;
		clip.caption = {
			...cap,
			words: wordsToContent(latest(clip) as never, c.words, rate),
			...(c.speaker ? { speaker: c.speaker } : {}),
		} as never;
		kept.push(id);
	});
	let created: string[] = [];
	if (fresh.length) {
		let track = trackId ? findTrackIn(seq, trackId)?.track : undefined;
		if (!track) track = subtitleVideoTrack(seq, undefined, 'Subtitles', h);
		assertUnlocked(track, h);
		const fontId = fontIdFor(doc, template.fontFamily, h);
		const style = templateStyle(template, fontId, seq.settings.width, seq.settings.height);
		const hl = group.highlight ?? NO_HIGHLIGHT;
		created = placeTextSubtitles(
			seq,
			track,
			fresh,
			{ template, groupId: group.id, style, highlight: hl },
			h,
			CAPTION_CONTENT_ORIGIN,
		);
		applyTemplateMotion(doc, seq, created, template, h);
		const linked = linkTemplateStyle(doc, seq, template, style, created, h);
		for (const id of created) {
			const c = seq.clips[id] as DText;
			c.content.style = clone(linked) as never;
			applyHighlight(c as unknown as TextClip, hl, () => h.ids.next('kf'));
		}
	}
	setGroup(seq, { ...group, rules, text, cutAware, range: cmd.range ? group.range : range });
	cleanupSequence(seq, h);
	return {
		groupId: group.id,
		stats: publicStats(layout.stats),
		kept: kept.length,
		created: created.length,
		removed: removed.length,
		clipIds: [...kept, ...created],
	};
}

// ---------------------------------------------------------------------------------------------------------------
// captions.alignToCuts (AS-012)

function textClipsOf(
	doc: DDoc,
	cmd: { groupId?: string; clipIds?: readonly string[] | '$selection' },
	h: HandlerContext,
) {
	if ((cmd.groupId === undefined) === (cmd.clipIds === undefined))
		h.fail('E_INVALID_PARAM', 'Give groupId or clipIds (one of them)');
	if (cmd.groupId !== undefined) {
		const seq = sequenceOfGroup(doc, cmd.groupId, h);
		const group = groupOrFail(seq, cmd.groupId, h);
		const clips = groupClips(plainSeq(seq), group.id);
		if (!clips.length) h.fail('E_NOT_FOUND', `Subtitle group ${cmd.groupId} has no clips`);
		return { seq, group, clips };
	}
	const ids = idList(cmd.clipIds);
	if (!ids.length) h.fail('E_INVALID_PARAM', 'clipIds is empty');
	const { seq } = h.clipsOf(doc, ids);
	const pseq = plainSeq(seq);
	const clips = ids.map((id) => pseq.clips[id]!).sort((a, b) => a.start - b.start);
	const bad = clips.filter((c) => c.kind !== 'text');
	if (bad.length)
		h.fail(
			'E_INVALID_PARAM',
			`Not text clips: ${bad
				.slice(0, 8)
				.map((c) => `${c.id} (${c.kind})`)
				.join(', ')}`,
			{
				blocking: bad.map((c) => c.id),
			},
		);
	const gid = captionOf(clips[0]!)?.groupId;
	const group = gid ? captionGroupOf(pseq, gid) : null;
	return { seq, group: group ? clone(group) : null, clips };
}

function alignToCuts(doc: DDoc, cmd: CommandOf<'captions.alignToCuts'>, h: HandlerContext) {
	const { seq, group, clips } = textClipsOf(doc, cmd, h);
	const rate = seq.settings.frameRate as Rational;
	const opts = resolveCutAware({ ...(cmd.options ?? {}), enabled: true }, group?.cutAware ?? {});
	const rules = group?.rules ?? resolveSubtitleRules(undefined);
	for (const c of clips) assertUnlocked(findTrackIn(seq, c.trackId)!.track, h);
	const stats = emptyStats();
	const byTrack = new Map<string, Clip[]>();
	for (const c of clips) {
		const l = byTrack.get(c.trackId) ?? [];
		l.push(c);
		byTrack.set(c.trackId, l);
	}
	type Plan = { clipId: string; pieces: WorkCaption[] };
	const plans: Plan[] = [];
	const fps = rate.num / rate.den;
	let warnings: string[] = [];
	for (const [trackId, list] of byTrack) {
		const cuts = cutEventsOrFail(doc, seq, trackId, opts, h);
		warnings = [...warnings, ...cuts.warnings];
		const events = prepareCutEvents(cuts.events, Math.max(1, Math.round(rules.minSeconds * fps)), stats);
		const work: WorkCaption[] = list.map((c) => {
			const words = wordsInSequence(c, rate);
			return {
				start: c.start,
				end: c.start + c.duration,
				words,
				speaker: captionOf(c)?.speaker ?? null,
				lineStarts: [],
				key: c.id,
				wordStart: c.start,
				...(words.length ? {} : { wordless: true }),
			};
		});
		// other clips on the track bound how far a subtitle may grow
		const others = Object.values(plainSeq(seq).clips)
			.filter((x) => x.trackId === trackId && !list.some((c) => c.id === x.id))
			.sort((a, b) => a.start - b.start);
		let out = alignToCutEvents(work, events, opts, rate, stats);
		out = finishTiming(out, events, rules, rate, stats, { hold: false, minimum: true });
		for (const p of out) {
			const before = others.filter((o) => o.start + o.duration <= p.wordStart).pop();
			const after = others.find((o) => o.start >= p.wordStart);
			if (before) p.start = Math.max(p.start, before.start + before.duration);
			if (after) p.end = Math.min(p.end, after.start);
			if (p.end <= p.start) p.end = p.start + 1;
		}
		stats.crossing += countCrossings(out, events);
		const by = new Map<string, WorkCaption[]>();
		for (const p of out) {
			const id = p.key.split(':')[0]!;
			const l = by.get(id) ?? [];
			l.push(p);
			by.set(id, l);
		}
		for (const c of list)
			plans.push({ clipId: c.id, pieces: (by.get(c.id) ?? []).sort((a, b) => a.start - b.start) });
	}
	let moved = 0;
	let snapped = 0;
	let removed = 0;
	const changes: Array<{ clipId: string; start: number; end: number }> = [];
	for (const p of plans) {
		const orig = clips.find((c) => c.id === p.clipId)!;
		if (!p.pieces.length) {
			removed++;
			continue;
		}
		const first = p.pieces[0]!;
		if (first.start !== orig.start || p.pieces[p.pieces.length - 1]!.end !== orig.start + orig.duration)
			moved++;
		if (first.start !== orig.start && first.start !== first.wordStart) snapped++;
		for (const piece of p.pieces) changes.push({ clipId: p.clipId, start: piece.start, end: piece.end });
	}
	stats.snappedToCuts = Math.max(stats.snappedToCuts, snapped);
	stats.warnings.push(...warnings);
	const report = {
		...publicStats(stats),
		count: changes.length,
		moved,
		removed,
		clips: clips.length,
	};
	if (cmd.dryRun) return { dryRun: true, ...report };
	warnAll(h, stats);
	// apply: split at the pieces' starts (right to left), then set every piece's range (the handler's
	// intermediate states are not checked; the invariants run on the result)
	const resultIds: string[] = [];
	const pendingRanges: Array<{ clip: DClip; piece: WorkCaption }> = [];
	for (const p of plans) {
		if (!p.pieces.length) {
			removeClip(seq, p.clipId, h);
			continue;
		}
		const clip = seq.clips[p.clipId]!;
		const pieceClips: DClip[] = [clip];
		for (let k = p.pieces.length - 1; k >= 1; k--) {
			const at = p.pieces[k]!.start;
			if (clip.start < at && at < end(clip)) pieceClips.splice(1, 0, splitClipAt(seq, clip, at, h));
		}
		pieceClips.forEach((pc, k) => {
			const piece = p.pieces[k] ?? p.pieces[p.pieces.length - 1]!;
			resultIds.push(pc.id);
			if (pc.start !== piece.start || end(pc) !== piece.end) pendingRanges.push({ clip: pc, piece });
		});
	}
	for (const { clip, piece } of pendingRanges) setClipRange(seq, clip, piece.start, piece.end);
	cleanupSequence(seq, h);
	return { ...report, clipIds: resultIds };
}

// ---------------------------------------------------------------------------------------------------------------
// captions.convert (AS-005)

const TEXT_STYLE_KEYS = Object.keys(TextStyleSchema.shape) as (keyof TextStyle)[];

function textStyleFromCaption(cs: CaptionStyle): TextStyle {
	const out: Record<string, unknown> = {};
	for (const k of TEXT_STYLE_KEYS)
		if ((cs as Record<string, unknown>)[k] !== undefined) out[k] = clone((cs as Record<string, unknown>)[k]);
	return out as TextStyle;
}

/** What a caption track cannot show of a text clip (AS-005 report). */
function unrepresentable(c: TextClip): string[] {
	const out: string[] = [];
	const r = c as Record<string, unknown>;
	if (c.effects.length) out.push('effects');
	if (c.textAnimation?.in || c.textAnimation?.out) out.push('text animation');
	if ((c.animators ?? []).length) out.push('text animators');
	const keyed = [c.transform.position, c.transform.scale, c.transform.rotation, c.opacity].some(
		(a) => a.keyframes.length,
	);
	if (keyed) out.push('keyframes');
	if ((r.masks as unknown[] | undefined)?.length) out.push('masks');
	if (c.blendMode !== 'normal') out.push('blend mode');
	if (c.content.runs?.some((x) => !(x as { tag?: string }).tag)) out.push('styled runs');
	if (c.transform.scale.value !== 100 || c.transform.rotation.value !== 0) out.push('scale / rotation');
	const st = (c as { sourceTextKeyframes?: { tag?: string }[] }).sourceTextKeyframes;
	if (st?.length && !st.every((k) => k.tag)) out.push('source text keyframes');
	if ((r.threeD as { enabled?: boolean } | undefined)?.enabled) out.push('3D');
	return out;
}

function convertToCaptionTrack(doc: DDoc, cmd: CommandOf<'captions.convert'>, h: HandlerContext) {
	const { seq, group, clips } = textClipsOf(doc, cmd, h);
	const rate = seq.settings.frameRate as Rational;
	const W = seq.settings.width;
	const H = seq.settings.height;
	const texts = clips.filter((c): c is TextClip => c.kind === 'text');
	if (!cmd.keepSource) for (const c of texts) assertUnlocked(findTrackIn(seq, c.trackId)!.track, h);
	const first = texts[0]!;
	const name = cmd.trackName ?? group?.name ?? 'Subtitles';
	const track = addCaptionTrack(doc, seq, h, { name, language: group?.language ?? 'und' });
	const box = first.box;
	const pos = first.transform.position.value;
	const anchor = first.transform.anchor.value;
	const topY = pos[1] - anchor[1];
	const hl = group?.highlight;
	track.styleDefaults = {
		...(clone(track.styleDefaults) ?? {}),
		...clone(first.content.style),
		boxWidthPct: Math.min(100, Math.max(1, (box.width / W) * 100)),
		...(group ? { maxCharsPerLine: group.rules.maxChars, maxLines: group.rules.lines } : {}),
		linePct: Math.min(100, Math.max(0, (topY / H) * 100)),
		positionPct: Math.min(100, Math.max(0, ((pos[0] - anchor[0] + box.width / 2) / W) * 100)),
		highlight: {
			mode: hl?.mode === 'word' ? 'word' : hl?.mode === 'karaoke' ? 'karaoke' : 'none',
			color: [...(hl?.color ?? NO_HIGHLIGHT.color)],
		},
	} as never;
	const report = new Map<string, number>();
	const blocks: PlacedBlock[] = texts.map((c) => {
		for (const f of unrepresentable(c)) report.set(f, (report.get(f) ?? 0) + 1);
		const words = wordsInSequence(c, rate);
		const textNow = plainCaptionText(c.content.text);
		const ws: CaptionWord[] = words.length
			? words
			: textNow
					.split(/\s+/)
					.filter(Boolean)
					.map((t, i, a) => {
						const F = flicksPerFrame(rate);
						const s = c.start * F;
						const d = c.duration * F;
						return {
							text: t,
							start: s + Math.round((d * i) / a.length),
							end: s + Math.round((d * (i + 1)) / a.length),
						};
					});
		// line breaks of the text kept
		const pos2 = locateWords(c.content.text, ws);
		const breaks = new Set<number>();
		if (pos2)
			pos2.forEach(([a], i) => {
				if (i > 0 && c.content.text.slice(pos2[i - 1]![1], a).includes('\n')) breaks.add(i);
			});
		const diff = diffStyle(first.content.style, c.content.style);
		return {
			start: c.start,
			end: c.start + c.duration,
			words: ws.map((w, i) => ({
				text: w.text,
				start: w.start,
				end: w.end,
				confidence: null,
				speakerName: captionOf(c)?.speaker ?? null,
				breakBefore: breaks.has(i) ? ('line' as const) : ('none' as const),
			})),
			...(Object.keys(diff).length ? { style: diff as Partial<CaptionStyle> } : {}),
		};
	});
	if (!cmd.keepSource) for (const c of texts) removeClip(seq, c.id, h);
	const clipIds = placeCaptionClips(doc, seq, track, blocks, h, {
		language: group?.language ?? 'und',
		origin: 'manual',
	});
	if (!cmd.keepSource && group && !groupClips(plainSeq(seq), group.id).length)
		delete (seq as { captionGroups?: Record<string, CaptionGroup> }).captionGroups?.[group.id];
	const lost = [...report].map(([feature, clips]) => ({ feature, clips }));
	if (lost.length)
		h.warn(
			'W_SUBTITLES_CONVERT',
			`A caption track cannot show: ${lost.map((x) => `${x.feature} (${x.clips} clip${x.clips === 1 ? '' : 's'})`).join(', ')}`,
		);
	h.defineRef(cmd.ref, track.id);
	return { to: 'caption-track', trackId: track.id, clipIds, count: clipIds.length, unrepresentable: lost };
}

function convertToTextClips(doc: DDoc, cmd: CommandOf<'captions.convert'>, h: HandlerContext) {
	const seq = h.sequence(doc);
	let captionIds: string[];
	let trackId: string;
	if (cmd.captionTrackId !== undefined) {
		const t = h.track(seq, cmd.captionTrackId);
		if (t.kind !== 'caption') h.fail('E_TRACK_KIND', `Track ${cmd.captionTrackId} is not a caption track`);
		trackId = t.id;
		captionIds = Object.values(plainSeq(seq).clips)
			.filter((c) => c.trackId === t.id && c.kind === 'captions')
			.sort((a, b) => a.start - b.start)
			.map((c) => c.id);
		if (!captionIds.length) h.fail('E_NOT_FOUND', `Caption track ${cmd.captionTrackId} has no captions`);
	} else {
		const ids = idList(cmd.clipIds);
		if (!ids.length) h.fail('E_INVALID_PARAM', 'Give captionTrackId or caption clipIds');
		const pseq = plainSeq(seq);
		const bad = ids.filter((id) => pseq.clips[id]?.kind !== 'captions');
		if (bad.length)
			h.fail('E_INVALID_PARAM', `Not caption clips: ${bad.slice(0, 8).join(', ')}`, { blocking: bad });
		captionIds = ids;
		trackId = pseq.clips[ids[0]!]!.trackId;
	}
	const ctrack = findTrackIn(seq, trackId)!.track;
	if (!cmd.keepSource) assertUnlocked(ctrack, h);
	const pdoc = plainDoc(doc);
	const pseq = plainSeq(seq);
	const rate = seq.settings.frameRate as Rational;
	const F = flicksPerFrame(rate);
	const W = seq.settings.width;
	const H = seq.settings.height;
	const fallbackFont = ensureDefaultFont(doc, h);
	const template = cmd.template !== undefined ? resolveTemplate(doc, cmd.template, h) : null;
	if (template) storeTemplateChecked(doc, template, h);
	const tstyle = template ? templateStyle(template, fontIdFor(doc, template.fontFamily, h), W, H) : null;
	const vtrack = subtitleVideoTrack(seq, undefined, cmd.trackName ?? ctrack.name ?? 'Subtitles', h);
	const trackStyle = resolveCaptionStyle(ctrack.styleDefaults, undefined, fallbackFont, H);
	const hl: SubtitleHighlight = template?.highlight ?? {
		mode:
			trackStyle.highlight.mode === 'word'
				? 'word'
				: trackStyle.highlight.mode === 'karaoke'
					? 'karaoke'
					: 'none',
		color: [...trackStyle.highlight.color] as SubtitleHighlight['color'],
	};
	const group = newGroup(h, {
		name: cmd.trackName ?? ctrack.name ?? 'Subtitles',
		templateId: template?.id ?? null,
		rules: resolveSubtitleRules({
			maxChars: Math.min(72, Math.max(7, trackStyle.maxCharsPerLine)),
			lines: Math.min(3, Math.max(1, trackStyle.maxLines)),
		}),
		text: resolveSubtitleText(undefined),
		language: ctrack.language ?? 'und',
		cutAware: resolveCutAware(undefined),
		sourceRef: { kind: 'sequence-transcript' },
		range: null,
		trackId: vtrack.id,
		highlight: hl,
	});
	setGroup(seq, group);
	const ids: string[] = [];
	const lost = new Map<string, number>();
	for (const cid of captionIds) {
		const cc = pseq.clips[cid] as Extract<Clip, { kind: 'captions' }>;
		const cs = resolveCaptionStyle(ctrack.styleDefaults, cc.style, fallbackFont, H);
		const style = tstyle ? clone(tstyle) : textStyleFromCaption(cs);
		if (!pdoc.fonts[style.fontId]) style.fontId = fallbackFont;
		const pages = captionPages(pdoc, pseq, cc, cs);
		const words = captionClipWords(pdoc, cc, rate);
		const groups: (typeof words)[] = [];
		for (const w of words) {
			if (!groups.length || (w.breakBefore === 'segment' && groups[groups.length - 1]!.length))
				groups.push([]);
			groups[groups.length - 1]!.push(w);
		}
		const t = cc.transform;
		if (
			t.scale.value !== 100 ||
			t.rotation.value !== 0 ||
			t.scale.keyframes.length ||
			t.position.keyframes.length
		)
			lost.set('caption transform', (lost.get('caption transform') ?? 0) + 1);
		const dx = t.position.value[0] - t.anchor.value[0];
		const dy = t.position.value[1] - t.anchor.value[1];
		pages.forEach((p, k) => {
			const g = groups[k] ?? [];
			const text = plainCaptionText(
				p.lines.map((l) => l.map((w) => (w.space ? ` ${w.text}` : w.text)).join('')).join('\n'),
			);
			if (!text.trim() || p.end <= p.start) return;
			const seqWords: CaptionWord[] = g.map((w) => ({
				text: plainCaptionText(cs.allCaps ? w.text.toUpperCase() : w.text),
				start: cc.start * F + Math.round((w.start - cc.sourceIn) / cc.speed.rate),
				end: cc.start * F + Math.round((w.end - cc.sourceIn) / cc.speed.rate),
			}));
			const content: TextContent = { text, style };
			const lines = Math.max(1, text.split('\n').length);
			const blockH = Math.ceil(lines * style.sizePx * style.lineHeight);
			const boxW = Math.max(1, Math.round((W * cs.boxWidthPct) / 100));
			const safe = 0.1 * H;
			const margin = ((cs.marginPct ?? 0) / 100) * H;
			const cy =
				cs.linePct !== null && cs.linePct !== undefined
					? (cs.linePct / 100) * H + blockH / 2
					: cs.placement === 'top'
						? safe + margin + blockH / 2
						: cs.placement === 'middle'
							? H / 2
							: H - safe - margin - blockH / 2;
			const cx = cs.positionPct !== null && cs.positionPct !== undefined ? (cs.positionPct / 100) * W : W / 2;
			const layout: Layout = template
				? templateLayout(template, seq, content)
				: { box: { width: boxW, height: blockH, autoSize: 'height' }, position: [cx + dx, cy + dy] };
			relinkSplits(seq, clearRange(seq, vtrack.id, p.start, p.end, h), h);
			const id = h.ids.next('clp');
			const timing = {
				start: p.start,
				duration: p.end - p.start,
				sourceIn: CAPTION_CONTENT_ORIGIN,
				speed: { rate: 1, reverse: false },
			};
			seq.clips[id] = {
				...commonFields(
					id,
					vtrack.id,
					p.start,
					p.end - p.start,
					CAPTION_CONTENT_ORIGIN,
					nameOf(text),
					'lavender',
				),
				kind: 'text',
				content,
				box: layout.box,
				...visualFields(defaultTransform(layout.box, { width: W, height: H }, 'none')),
				opacity: clone(cc.opacity),
				caption: {
					groupId: group.id,
					words: wordsToContent(timing as never, seqWords, rate),
					...(p.speaker ? { speaker: p.speaker } : {}),
				},
			} as DClip;
			setLayout(seq.clips[id] as DText, layout, seq, h);
			ids.push(id);
		});
	}
	if (template) {
		applyTemplateMotion(doc, seq, ids, template, h);
		const linked = linkTemplateStyle(doc, seq, template, tstyle!, ids, h);
		for (const id of ids) (seq.clips[id] as DText).content.style = clone(linked) as never;
	}
	for (const id of ids) applyHighlight(seq.clips[id] as unknown as TextClip, hl, () => h.ids.next('kf'));
	if (!cmd.keepSource) {
		for (const cid of captionIds) removeClip(seq, cid, h);
		if (cmd.captionTrackId !== undefined) {
			const i = seq.captionTracks.findIndex((t) => t.id === trackId);
			if (i >= 0 && !Object.values(plainSeq(seq).clips).some((c) => c.trackId === trackId))
				seq.captionTracks.splice(i, 1);
		}
	}
	if (lost.size)
		h.warn(
			'W_SUBTITLES_CONVERT',
			`Not carried over: ${[...lost].map(([f, n]) => `${f} (${n} caption${n === 1 ? '' : 's'})`).join(', ')}`,
		);
	cleanupSequence(seq, h);
	h.defineRef(cmd.ref, group.id);
	return {
		to: 'text-clips',
		groupId: group.id,
		trackId: vtrack.id,
		clipIds: ids,
		count: ids.length,
		unrepresentable: [...lost].map(([feature, clips]) => ({ feature, clips })),
	};
}

function convert(doc: DDoc, cmd: CommandOf<'captions.convert'>, h: HandlerContext) {
	if (cmd.to === 'caption-track') {
		if (cmd.captionTrackId !== undefined) h.fail('E_INVALID_PARAM', 'captionTrackId converts to text clips');
		return convertToCaptionTrack(doc, cmd, h);
	}
	if (cmd.groupId !== undefined) h.fail('E_INVALID_PARAM', 'A subtitle group already is text clips');
	return convertToTextClips(doc, cmd, h);
}

// ---------------------------------------------------------------------------------------------------------------
// Templates (AS-020)

/** Template from a styled text clip (Save as Template…): style, box, position for this aspect, effects, rules. */
function templateFromClip(
	doc: DDoc,
	seq: DSeq,
	clip: TextClip,
	cmd: CommandOf<'subtitleTemplate.save'>,
	h: HandlerContext,
): SubtitleTemplate {
	const W = seq.settings.width;
	const H = seq.settings.height;
	const font = doc.fonts[clip.content.style.fontId];
	const pos = clip.transform.position.value;
	const anchor = clip.transform.anchor.value;
	const cx = pos[0] - anchor[0] + clip.box.width / 2;
	const cy = pos[1] - anchor[1] + clip.box.height / 2;
	const aspect = aspectKeyOf(W, H);
	const cap = captionOf(clip);
	const group = cap ? captionGroupOf(plainSeq(seq), cap.groupId) : null;
	const fx =
		cmd.effects === false
			? []
			: clip.effects.filter((e) => !(e as { internal?: boolean }).internal).map((e) => e.id);
	let preset = null;
	if (fx.length) {
		try {
			preset = buildEffectPreset(plainDoc(doc), clip.id, {
				name: cmd.name,
				type: 'anchor-in',
				sections: { effectIds: fx },
				id: `subtitle.${cmd.id ?? 'saved'}`,
			});
		} catch (e) {
			h.fail('E_INVALID_PARAM', `The clip's effects cannot be saved: ${(e as Error).message}`);
		}
	}
	const ta = clip.textAnimation;
	const fps = seq.settings.frameRate.num / seq.settings.frameRate.den;
	const side = (a: NonNullable<typeof ta>['in']) =>
		a
			? {
					preset: a.preset,
					version: a.version,
					seconds: Math.round((a.durationFrames / fps) * 1000) / 1000,
					params: clone(a.params),
				}
			: null;
	const now = h.ctx.now();
	const style = styleAtReference(clip.content.style as TextStyle, W, H);
	return {
		format: SUBTITLE_TEMPLATE_FORMAT,
		version: SUBTITLE_TEMPLATE_VERSION,
		id: cmd.id ?? h.ids.next('stm'),
		name: cmd.name,
		...(cmd.description ? { description: cmd.description } : {}),
		createdAt: now,
		updatedAt: now,
		output: 'text-clips',
		fontFamily: font?.family ?? 'Source Sans 3',
		style,
		reference: 1080,
		box: { widthPct: Math.min(100, Math.max(5, Math.round((clip.box.width / W) * 1000) / 10)) },
		position: { [aspect]: { x: Math.round((cx / W) * 1000) / 1000, y: Math.round((cy / H) * 1000) / 1000 } },
		animation: {
			...(ta && (ta.in || ta.out) ? { textAnimation: { in: side(ta.in), out: side(ta.out) } } : {}),
			...(preset ? { preset } : {}),
		},
		...(group
			? {
					rules: { ...group.rules },
					text: clone(group.text),
					highlight: clone(group.highlight ?? NO_HIGHLIGHT),
				}
			: {}),
	} as SubtitleTemplate;
}

function applyTemplate(doc: DDoc, cmd: CommandOf<'subtitleTemplate.apply'>, h: HandlerContext) {
	const template = resolveTemplate(doc, cmd.template, h);
	const { seq, group, clips } = textClipsOf(doc, cmd, h);
	const texts = clips.filter((c) => c.kind === 'text');
	for (const c of texts) assertUnlocked(findTrackIn(seq, c.trackId)!.track, h);
	const parts = { style: true, layout: true, animation: true, highlight: true, ...(cmd.parts ?? {}) };
	storeTemplateChecked(doc, template, h);
	const ids = texts.map((c) => c.id);
	const fontId = fontIdFor(doc, template.fontFamily, h);
	const style = templateStyle(template, fontId, seq.settings.width, seq.settings.height);
	const linked = parts.style ? linkTemplateStyle(doc, seq, template, style, ids, h) : style;
	for (const id of ids) {
		const c = seq.clips[id] as DText;
		if (parts.style) c.content.style = clone(linked) as never;
		if (parts.layout) setLayout(c, templateLayout(template, seq, latest(c.content) as TextContent), seq, h);
		else layoutText(c, h, seq.settings.width);
		if (parts.animation) removeTemplateEffects(c);
	}
	if (parts.animation) applyTemplateMotion(doc, seq, ids, template, h);
	const hl = template.highlight ?? NO_HIGHLIGHT;
	if (group && cmd.groupId !== undefined) {
		const next: CaptionGroup = {
			...group,
			templateId: template.id,
			...(parts.highlight ? { highlight: hl } : {}),
		};
		setGroup(seq, next);
	}
	if (parts.highlight)
		for (const id of ids) applyHighlight(seq.clips[id] as unknown as TextClip, hl, () => h.ids.next('kf'));
	return { templateId: template.id, clipIds: ids, count: ids.length };
}

// ---------------------------------------------------------------------------------------------------------------

export const subtitleHandlers = {
	'captions.generate': generate,
	'captions.regenerate': regenerate,
	'captions.alignToCuts': alignToCuts,
	'captions.convert': convert,
	'captions.updateGroup': (doc, cmd, h) => {
		const seq = sequenceOfGroup(doc, cmd.groupId, h);
		const g = groupOrFail(seq, cmd.groupId, h);
		if (cmd.name !== undefined) g.name = cmd.name;
		if (cmd.language !== undefined) g.language = cmd.language;
		setGroup(seq, g);
		return { groupId: g.id };
	},
	'captions.deleteGroup': (doc, cmd, h) => {
		const seq = sequenceOfGroup(doc, cmd.groupId, h);
		groupOrFail(seq, cmd.groupId, h);
		const clips = groupClips(plainSeq(seq), cmd.groupId);
		for (const c of clips) assertUnlocked(findTrackIn(seq, c.trackId)!.track, h);
		for (const c of clips) {
			if (cmd.clips === 'keep') delete (seq.clips[c.id] as { caption?: unknown }).caption;
			else removeClip(seq, c.id, h);
		}
		delete (seq as { captionGroups?: Record<string, CaptionGroup> }).captionGroups![cmd.groupId];
		if (!Object.keys((seq as { captionGroups?: object }).captionGroups ?? {}).length)
			delete (seq as { captionGroups?: object }).captionGroups;
		if (cmd.clips !== 'keep') cleanupSequence(seq, h);
		return { groupId: cmd.groupId, clips: clips.length };
	},
	'subtitleTemplate.save': (doc, cmd, h) => {
		const { seq, clip } = h.clip(doc, cmd.clipId);
		if (clip.kind !== 'text') h.fail('E_INVALID_PARAM', `Clip ${cmd.clipId} is not a text clip`);
		if (cmd.id !== undefined && (cmd.id.startsWith('builtin:') || !/^[\w:.-]+$/.test(cmd.id)))
			h.fail('E_INVALID_PARAM', `Template id ${cmd.id} is reserved or malformed`);
		const t = templateFromClip(doc, seq, latest(clip) as TextClip, cmd, h);
		const r = parseSubtitleTemplate(t);
		if (!r.ok) return h.fail(r.code, `The clip cannot be saved as a template: ${r.message}`);
		storeTemplateChecked(doc, r.template, h);
		return { templateId: r.template.id, template: r.template };
	},
	'subtitleTemplate.add': (doc, cmd, h) => {
		const r = parseSubtitleTemplate(cmd.template);
		if (!r.ok) return h.fail(r.code, `Invalid subtitle template: ${r.message}`, { path: ['template'] });
		storeTemplateChecked(doc, r.template, h);
		return { templateId: r.template.id };
	},
	'subtitleTemplate.delete': (doc, cmd, h) => {
		const rec = (doc as { subtitleTemplates?: Record<string, unknown> }).subtitleTemplates;
		if (!rec?.[cmd.templateId])
			return h.fail('E_NOT_FOUND', `Project subtitle template not found: ${cmd.templateId}`);
		delete rec[cmd.templateId];
		if (!Object.keys(rec).length) delete (doc as { subtitleTemplates?: unknown }).subtitleTemplates;
		return { templateId: cmd.templateId };
	},
	'subtitleTemplate.apply': applyTemplate,
} satisfies HandlerMap;

export { captionCuesForGroup };
