// Spec 13 SH-002 / AS-003: subtitles as text clips — the schema v10 fields.
//
// - `TextClip.caption` = {groupId, words, speaker?, anchorIn?}: the words a subtitle shows with
//   their timing in the clip's CONTENT time (flicks, the keyframe axis: sequence time t ↔ content
//   `sourceIn + (t − start·F)·speed`), so moves, trims and ripples keep them in place; a razor cut divides them
//   (`splitCaptionWords`) and a text edit re-times the unchanged ones (LCS, `normalizeSubtitleClips`).
//   `anchorIn`: the content time of the In the template's animation keys were laid out from; the effect instances
//   the template added carry `EffectInstance.subtitleTemplate`, and their keys follow the In after trims and splits.
// - `Sequence.captionGroups[id]` = {name, templateId, rules, text, language, cutAware, sourceRef, range, trackId,
//   highlight}: one generated subtitle group (its members are the text clips whose `caption.groupId` is the id).
// - `ProjectDocument.subtitleTemplates[id]`: templates copied into the project when used (templates.ts).
// All three are read leniently (any value loads); INV-SUBTITLE checks them, `repairSubtitleSequence` / `repairSubtitleTemplates` repair them on load.
import { z } from 'zod';
import { idPrefixOf, isValidId } from '../../ids.ts';
import { RGBASchema } from '../../schema/common.ts';
import type { ProjectDocument } from '../../schema/document.ts';
import type { Clip, Sequence } from '../../schema/sequence.ts';
import {
	type CutAwareOptions,
	DEFAULT_CUT_AWARE,
	GENERIC_SUBTITLE_RULES,
	GENERIC_SUBTITLE_TEXT,
	StoredCutAwareSchema,
	StoredSubtitleRulesSchema,
	StoredSubtitleTextSchema,
	type SubtitleRules,
	type SubtitleText,
} from './rules.ts';

export const CAPTION_GROUP_PREFIX = 'cgp';
/** Most words one subtitle clip keeps (bounds work on untrusted documents). */
export const MAX_CAPTION_WORDS = 2000;
/** Most subtitle groups per sequence / templates per project. */
export const MAX_CAPTION_GROUPS = 1000;
export const MAX_PROJECT_TEMPLATES = 500;
export const MAX_GROUP_NAME = 120;

export type CaptionWord = { text: string; start: number; end: number };

export type TextClipCaption = {
	groupId: string;
	words: CaptionWord[];
	speaker?: string | null;
	anchorIn?: number;
};

export const CaptionWordSchema = z.looseObject({
	text: z.string().max(2000),
	start: z.number().int().min(0),
	end: z.number().int().min(0),
});

export const TextClipCaptionSchema = z.looseObject({
	groupId: z.string().min(1),
	words: z.array(CaptionWordSchema).max(MAX_CAPTION_WORDS),
	speaker: z.string().max(200).nullable().optional(),
	anchorIn: z.number().int().optional(),
});

export const HIGHLIGHT_MODES = ['none', 'word', 'karaoke', 'keywords'] as const;
export type HighlightMode = (typeof HIGHLIGHT_MODES)[number];
export const SubtitleHighlightSchema = z.strictObject({
	mode: z.enum(HIGHLIGHT_MODES),
	color: RGBASchema,
	/** `keywords`: words shown in the highlight colour (case and punctuation ignored); empty = the longest word. */
	keywords: z.array(z.string().trim().min(1).max(64)).max(500).optional(),
});
export type SubtitleHighlight = {
	mode: HighlightMode;
	color: [number, number, number, number];
	keywords?: string[];
};
export const NO_HIGHLIGHT: SubtitleHighlight = { mode: 'none', color: [1, 0.84, 0, 1] };

export const SubtitleSourceRefSchema = z.union([
	z.strictObject({ kind: z.literal('sequence-transcript') }),
	z.strictObject({ kind: z.literal('media'), mediaId: z.string().min(1) }),
	z.strictObject({ kind: z.literal('clips'), clipIds: z.array(z.string().min(1)).min(1).max(20_000) }),
]);
export type SubtitleSourceRef = z.infer<typeof SubtitleSourceRefSchema>;

export const CaptionGroupSchema = z.looseObject({
	id: z.string(),
	name: z.string().min(1).max(MAX_GROUP_NAME),
	templateId: z.string().min(1).nullable(),
	rules: StoredSubtitleRulesSchema,
	text: StoredSubtitleTextSchema,
	language: z.string().min(1).max(35),
	cutAware: StoredCutAwareSchema,
	sourceRef: SubtitleSourceRefSchema,
	range: z.strictObject({ start: z.number().int().min(0), end: z.number().int().min(0) }).nullable(),
	trackId: z.string().min(1).nullable().optional(),
	highlight: SubtitleHighlightSchema.optional(),
	createdAt: z.string().max(64).optional(),
});

export type CaptionGroup = {
	id: string;
	name: string;
	templateId: string | null;
	rules: SubtitleRules;
	text: SubtitleText;
	language: string;
	cutAware: CutAwareOptions;
	sourceRef: SubtitleSourceRef;
	range: { start: number; end: number } | null;
	trackId?: string | null;
	highlight?: SubtitleHighlight;
	createdAt?: string;
};

const isPlain = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

/** Why caption words are unreadable (sorted, non-overlapping, integer, start ≤ end), or null. */
export function captionWordsProblem(words: readonly CaptionWord[]): string | null {
	let prevEnd = Number.NEGATIVE_INFINITY;
	for (let i = 0; i < words.length; i++) {
		const w = words[i]!;
		if (!(w.end >= w.start)) return `word ${i} ends before it starts`;
		if (w.start < prevEnd) return `word ${i} overlaps the previous word`;
		prevEnd = w.end;
	}
	return null;
}

/** Why a clip's `caption` field is unreadable (null when readable or absent). */
export function clipCaptionProblem(clip: Clip): string | null {
	const v = (clip as { caption?: unknown }).caption;
	if (v === undefined) return null;
	if (clip.kind !== 'text') return `a ${clip.kind} clip cannot carry subtitle words`;
	for (const fx of clip.effects)
		if (
			(fx as { subtitleTemplate?: unknown }).subtitleTemplate !== undefined &&
			typeof (fx as { subtitleTemplate?: unknown }).subtitleTemplate !== 'string'
		)
			return `effect ${fx.id}: unreadable subtitle template mark`;
	const r = TextClipCaptionSchema.safeParse(v);
	if (!r.success) {
		const i = r.error.issues[0]!;
		return `caption ${i.path.join('.') || ''}: ${i.message}`.replace(' :', ':');
	}
	if (!isValidId(r.data.groupId) || idPrefixOf(r.data.groupId) !== CAPTION_GROUP_PREFIX)
		return `caption: malformed group id ${r.data.groupId}`;
	return captionWordsProblem(r.data.words as CaptionWord[]);
}

/** The readable subtitle data of a clip, or null (not a subtitle, or unreadable). */
export function captionOf(clip: Clip | undefined | null): TextClipCaption | null {
	if (clip?.kind !== 'text') return null;
	const v = (clip as { caption?: unknown }).caption;
	if (v === undefined) return null;
	return clipCaptionProblem(clip) ? null : (v as TextClipCaption);
}

/** Why one stored group is unreadable (key = record key), or null. */
export function captionGroupProblem(key: string, v: unknown): string | null {
	const r = CaptionGroupSchema.safeParse(v);
	if (!r.success) {
		const i = r.error.issues[0]!;
		return `${i.path.join('.') || 'group'}: ${i.message}`;
	}
	if (r.data.id !== key) return `record key ${key} differs from id ${r.data.id}`;
	if (!isValidId(key) || idPrefixOf(key) !== CAPTION_GROUP_PREFIX) return `malformed id ${key}`;
	if (!r.data.name.trim()) return 'empty name';
	return null;
}

/** The readable subtitle groups of a sequence, by id (unreadable entries skipped; the invariant reports them). */
export function captionGroupsOf(seq: Pick<Sequence, 'id'>): Record<string, CaptionGroup> {
	const rec = (seq as { captionGroups?: unknown }).captionGroups;
	const out: Record<string, CaptionGroup> = {};
	if (!isPlain(rec)) return out;
	for (const [k, v] of Object.entries(rec)) if (!captionGroupProblem(k, v)) out[k] = v as CaptionGroup;
	return out;
}

export function captionGroupOf(
	seq: Pick<Sequence, 'id'>,
	id: string | null | undefined,
): CaptionGroup | null {
	if (!id) return null;
	const rec = (seq as { captionGroups?: unknown }).captionGroups;
	if (!isPlain(rec) || !Object.hasOwn(rec, id)) return null;
	return captionGroupProblem(id, rec[id]) ? null : (rec[id] as CaptionGroup);
}

/** The text clips of a group, sorted by start (then track order, then id). */
export function groupClips(seq: Sequence, groupId: string): Clip[] {
	const out: Clip[] = [];
	for (const c of Object.values(seq.clips)) if (captionOf(c)?.groupId === groupId) out.push(c);
	return out.sort(
		(a, b) => a.start - b.start || a.trackId.localeCompare(b.trackId) || a.id.localeCompare(b.id),
	);
}

/** Group id → clip ids of every subtitle group of a sequence (groups without clips included). */
export function captionGroupMembers(seq: Sequence): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const id of Object.keys(captionGroupsOf(seq))) out.set(id, []);
	for (const c of Object.values(seq.clips)) {
		const g = captionOf(c)?.groupId;
		if (!g) continue;
		const list = out.get(g);
		if (list) list.push(c.id);
		else out.set(g, [c.id]);
	}
	return out;
}

/** A group record with defaults for a group whose record is missing (pasted subtitles, repaired documents). */
export function defaultCaptionGroup(id: string, name = 'Subtitles', language = 'und'): CaptionGroup {
	return {
		id,
		name,
		templateId: null,
		rules: { ...GENERIC_SUBTITLE_RULES },
		text: { ...GENERIC_SUBTITLE_TEXT },
		language,
		cutAware: { ...DEFAULT_CUT_AWARE },
		sourceRef: { kind: 'sequence-transcript' },
		range: null,
		trackId: null,
	};
}

/** INV-SUBTITLE (sequence level): the stored `captionGroups` record and the groups clips name. */
export function sequenceSubtitleIssues(seq: Sequence): [string, string[]][] {
	const out: [string, string[]][] = [];
	const rec = (seq as { captionGroups?: unknown }).captionGroups;
	if (rec !== undefined) {
		if (!isPlain(rec)) out.push(['captionGroups must be an object of groups by id', ['captionGroups']]);
		else {
			const keys = Object.keys(rec);
			if (keys.length > MAX_CAPTION_GROUPS)
				out.push([`more than ${MAX_CAPTION_GROUPS} subtitle groups`, ['captionGroups']]);
			for (const k of keys) {
				const bad = captionGroupProblem(k, rec[k]);
				if (bad) out.push([`Subtitle group ${k}: ${bad}`, ['captionGroups', k]]);
			}
		}
	}
	const groups = captionGroupsOf(seq);
	for (const c of Object.values(seq.clips)) {
		const cap = captionOf(c);
		if (cap && !groups[cap.groupId])
			out.push([`Clip ${c.id}: subtitle group ${cap.groupId} is missing`, ['clips', c.id, 'caption']]);
	}
	return out;
}

/** New ids for every subtitle group of a sequence (a duplicated sequence); its clips follow. Mutates. */
export function reidCaptionGroups(seq: Sequence, newId: () => string): void {
	const rec = (seq as { captionGroups?: unknown }).captionGroups;
	if (!isPlain(rec)) return;
	const map = new Map<string, string>();
	for (const k of Object.keys(rec)) {
		const v = rec[k];
		const next = newId();
		map.set(k, next);
		delete rec[k];
		rec[next] = isPlain(v) ? { ...v, id: next } : v;
	}
	for (const c of Object.values(seq.clips)) {
		const cap = (c as { caption?: { groupId?: unknown } }).caption;
		if (cap && typeof cap.groupId === 'string' && map.has(cap.groupId))
			(c as { caption: TextClipCaption }).caption = {
				...(cap as TextClipCaption),
				groupId: map.get(cap.groupId)!,
			};
	}
}

type Note = (action: string, entity: string, detail: string) => void;

/**
 * Load repair of the sequence-level and clip-level fields (mutates; idempotent): unreadable group records dropped
 * (their clips keep their text and words under a recreated default group), keys and ids made equal, caption fields
 * on other clip kinds removed, unreadable caption fields removed (the text stays), unsorted / overlapping words
 * sorted and trimmed, groups named by clips but missing recreated with default rules.
 */
export function repairSubtitleSequence(seq: Sequence, newGroupId: () => string, note: Note): void {
	const s = seq as { captionGroups?: unknown };
	if (s.captionGroups !== undefined && !isPlain(s.captionGroups)) {
		delete s.captionGroups;
		note('drop-caption-groups', seq.id, 'unreadable subtitle groups record removed');
	}
	const rec = s.captionGroups as Record<string, unknown> | undefined;
	const remap = new Map<string, string>();
	if (rec) {
		for (const key of Object.keys(rec)) {
			const v = rec[key];
			if (isPlain(v) && (!isValidId(key) || idPrefixOf(key) !== CAPTION_GROUP_PREFIX)) {
				const next = newGroupId();
				delete rec[key];
				rec[next] = v;
				v.id = next;
				remap.set(key, next);
				note('fix-id', next, `subtitle group record key ${JSON.stringify(key)} replaced`);
				continue;
			}
			if (isPlain(v) && v.id !== key) {
				v.id = key;
				note('fix-id', key, 'subtitle group record key and id made equal');
			}
		}
		for (const key of Object.keys(rec)) {
			const v = rec[key];
			if (!captionGroupProblem(key, v)) continue;
			// keep what is readable: the name and language; reset the rest to defaults
			const old = isPlain(v) ? v : {};
			const name =
				typeof old.name === 'string' && old.name.trim()
					? old.name.trim().slice(0, MAX_GROUP_NAME)
					: 'Subtitles';
			const lang = typeof old.language === 'string' && old.language ? old.language.slice(0, 35) : 'und';
			const fixed = defaultCaptionGroup(key, name, lang);
			for (const f of ['rules', 'text', 'cutAware', 'sourceRef', 'range', 'highlight', 'trackId'] as const) {
				const schema = CaptionGroupSchema.shape[f] as z.ZodType;
				if (old[f] !== undefined && schema.safeParse(old[f]).success)
					(fixed as Record<string, unknown>)[f] = old[f];
			}
			if (typeof old.templateId === 'string' && old.templateId) fixed.templateId = old.templateId;
			rec[key] = fixed;
			note('repair-caption-group', key, 'unreadable subtitle group fields reset to the defaults');
		}
		const keys = Object.keys(rec);
		for (const k of keys.slice(MAX_CAPTION_GROUPS)) {
			delete rec[k];
			note('drop-caption-group', k, `more than ${MAX_CAPTION_GROUPS} subtitle groups`);
		}
	}
	for (const c of Object.values(seq.clips)) {
		const r = c as { caption?: unknown };
		if (r.caption === undefined) continue;
		if (c.kind !== 'text' || !isPlain(r.caption)) {
			delete r.caption;
			note(
				'drop-caption',
				c.id,
				`subtitle words removed (${c.kind !== 'text' ? `a ${c.kind} clip` : 'unreadable'})`,
			);
			continue;
		}
		const cap = r.caption;
		if (typeof cap.groupId === 'string' && remap.has(cap.groupId)) cap.groupId = remap.get(cap.groupId);
		if (Array.isArray(cap.words)) {
			const words = cap.words
				.filter(
					(w): w is CaptionWord =>
						isPlain(w) && typeof w.text === 'string' && Number.isFinite(w.start) && Number.isFinite(w.end),
				)
				.slice(0, MAX_CAPTION_WORDS)
				.map((w) => {
					const start = Math.max(0, Math.round(w.start));
					return { ...w, text: w.text.slice(0, 2000), start, end: Math.max(start, Math.round(w.end)) };
				})
				.sort((a, b) => a.start - b.start || a.end - b.end);
			for (let i = 0; i + 1 < words.length; i++)
				if (words[i]!.end > words[i + 1]!.start)
					words[i]!.end = Math.max(words[i]!.start, words[i + 1]!.start);
			if (JSON.stringify(words) !== JSON.stringify(cap.words)) {
				cap.words = words;
				note('repair-caption-words', c.id, 'subtitle words sorted and made non-overlapping');
			}
		}
		for (const fx of (c as { effects?: { id: string; subtitleTemplate?: unknown }[] }).effects ?? [])
			if (fx.subtitleTemplate !== undefined && typeof fx.subtitleTemplate !== 'string') {
				delete fx.subtitleTemplate;
				note('repair-caption', fx.id, 'unreadable subtitle template mark of an effect removed');
			}
		if (cap.anchorIn !== undefined && !Number.isInteger(cap.anchorIn)) {
			delete cap.anchorIn;
			note('repair-caption', c.id, 'unreadable template anchor removed');
		}
		if (clipCaptionProblem(c)) {
			delete r.caption;
			note('drop-caption', c.id, 'unreadable subtitle words removed (the text stays)');
		}
	}
	// groups named by clips but missing (pasted from another sequence or project)
	const groups = captionGroupsOf(seq);
	for (const c of Object.values(seq.clips)) {
		const cap = captionOf(c);
		if (!cap || groups[cap.groupId]) continue;
		const g = defaultCaptionGroup(cap.groupId);
		s.captionGroups ??= {};
		(s.captionGroups as Record<string, unknown>)[g.id] = g;
		groups[g.id] = g;
		note('add-caption-group', g.id, 'missing subtitle group recreated with the default rules');
	}
}

/** Whether a loaded document holds subtitle data the load repair would change (soft problems only). */
export function subtitlesNeedRepair(doc: ProjectDocument): boolean {
	for (const seq of Object.values(doc.sequences)) {
		const groups = captionGroupsOf(seq);
		for (const c of Object.values(seq.clips)) {
			const cap = captionOf(c);
			if (cap && !groups[cap.groupId]) return true;
		}
	}
	return false;
}
