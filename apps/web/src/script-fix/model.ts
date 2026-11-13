// Spec 17 in the editor (scweb; docs/wp-notes/script-correction.md "Editor UI"), the pure part: when Fix Transcript can
// run and why not (SC-081), the Script drawer's summary (SC-002), what a dry run reports in words (SC-081), the review
// row's meta read leniently with its confidence label (SC-082), the words a fix proposal marks in the Transcript tab
// (SC-083), the patch report after accepting (SC-053 / SC-084), the "Replace all N" / "Remember" offer after a manual
// edit (SC-071 / SC-085) and the names carried into a transcription prompt (SC-074). Nothing here touches the session,
// the engine or the DOM, and nothing throws on malformed input.
import {
	cleanGlossaryText,
	cleanupNorm,
	findReplaceAllInSequence,
	flicksPerFrame,
	type ProjectDocument,
	type ReplaceAllPlan,
	readSequenceCleanup,
	type Sequence,
	scriptFixRejected,
	scriptFixSettingsOf,
	sequenceMediaTranscripts,
} from '@jasper/project';
import {
	functionWords,
	isEnglishWord,
	isNumericToken,
	parseScript,
	type ScriptSummary,
	scriptFixLanguage,
} from '@jasper/project/script-fix';
import { z } from 'zod';
import { t } from '../i18n/runtime.ts';

/** The proposal feature of Fix Transcript (SC-060). */
export const FIX_FEATURE = 'transcript-correction';

export type FixSource = 'script' | 'glossary';
export type FixScope = 'recordings' | 'used' | 'inOut';
export type FixStrictness = 'careful' | 'standard' | 'generous';
export type FixSettings = { sources: FixSource[]; scope: FixScope; strictness: FixStrictness };

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const S = 705_600_000;

// ── What the sequence has (SC-081) ───────────────────────────────────────────────────────────────────────────────

export type FixInputs = {
	/** Media transcripts the sequence's audio clips play, and their words in all. */
	transcripts: number;
	words: number;
	/** Their languages (base codes, distinct). */
	languages: string[];
	script: { name: string; text: string } | null;
	settings: FixSettings;
	/** Fixes the user rejected in this sequence (SC-055). */
	rejected: number;
	hasInOut: boolean;
};

/** What Fix Transcript would work from in a sequence. Never throws. */
export function fixInputs(doc: ProjectDocument, seq: Sequence): FixInputs {
	let transcripts: ReturnType<typeof sequenceMediaTranscripts> = [];
	try {
		transcripts = sequenceMediaTranscripts(doc, seq.id).filter((x) => x.words.length > 0);
	} catch {
		transcripts = [];
	}
	const languages = [
		...new Set(
			transcripts
				.map((x) => (typeof x.language === 'string' ? x.language.toLowerCase().split(/[-_]/)[0]! : ''))
				.filter(Boolean),
		),
	];
	let script: FixInputs['script'] = null;
	try {
		const s = readSequenceCleanup(seq).script;
		script = s?.text.trim() ? { name: s.name, text: s.text } : null;
	} catch {
		script = null;
	}
	return {
		transcripts: transcripts.length,
		words: transcripts.reduce((n, x) => n + x.words.length, 0),
		languages,
		script,
		settings: scriptFixSettingsOf(seq) as FixSettings,
		rejected: scriptFixRejected(seq).size,
		hasInOut: seq.inPoint !== null || seq.outPoint !== null,
	};
}

export type SpeechModelLite = { id: string; installed: boolean; multilingual?: boolean };

/**
 * Why Fix Transcript cannot run (null: it can), in the order the user fixes them (SC-081): no transcript; no script and
 * no glossary (or only switched-off ones); no speech model installed (the dry run still counts; Run needs the audio
 * check). `models` null = not known yet (not a reason); `glossaryEntries` null = unknown (assumed none).
 */
export function fixBlocker(
	inputs: FixInputs,
	sources: readonly FixSource[],
	glossaryEntries: number | null,
	models: readonly SpeechModelLite[] | null,
	opts: { forRun: boolean } = { forRun: true },
): string | null {
	if (!inputs.transcripts)
		return t('The sequence has no transcript yet: generate or import one in Text ▸ Transcript first');
	const script = !!inputs.script;
	const glossary = (glossaryEntries ?? 0) > 0;
	if (!script && !glossary)
		return t('Attach the video script (Script…) or add names to your speech glossary first');
	const usable = (sources.includes('script') && script) || (sources.includes('glossary') && glossary);
	if (!usable)
		return sources.includes('script')
			? t('No script is attached: attach one (Script…) or use the personal glossary')
			: t(
					'Your speech glossary is empty: add names in Preferences ▸ Transcription ▸ Glossary or use the script',
				);
	if (opts.forRun && models && !models.some((m) => m.installed))
		return t('No speech model is installed: download one in Preferences ▸ Transcription');
	return null;
}

/** The request settings a set of choices makes (sources the sequence cannot use are left out). */
export function requestSources(
	sources: readonly FixSource[],
	inputs: FixInputs,
	glossaryEntries: number | null,
): FixSource[] {
	const out = sources.filter((s) => (s === 'script' ? !!inputs.script : (glossaryEntries ?? 0) > 0));
	return out.length ? out : [...sources];
}

// ── The Script drawer's summary (SC-002) ────────────────────────────────────────────────────────────────────────

/** The parsed summary of a script text (null for an empty one). Never throws. */
export function scriptSummary(text: string, language: string | null): ScriptSummary | null {
	if (!text.trim()) return null;
	try {
		return parseScript(text, { language }).summary;
	} catch {
		return null;
	}
}

/** "3 sections · 412 words read · 6 directions (21 words) and 3 headings skipped". */
export function scriptSummaryText(s: ScriptSummary): string {
	const sections = s.sections.length === 1 ? t('1 section') : t('{0} sections', s.sections.length);
	const words = s.words === 1 ? t('1 word read') : t('{0} words read', s.words);
	const directions =
		s.directions === 1
			? t('1 direction ({0} words)', s.directionTokens)
			: t('{0} directions ({1} words)', s.directions, s.directionTokens);
	const headings = s.headingLines === 1 ? t('1 heading') : t('{0} headings', s.headingLines);
	return t('{0} · {1} · {2} and {3} skipped', sections, words, directions, headings);
}

// ── Dry run in words (SC-081) ───────────────────────────────────────────────────────────────────────────────────

/** The report fields the dialog reads (the engine's `TranscriptFixReport`, read leniently). */
export type FixReportLite = {
	perMedia: Array<{
		name: string;
		words: number;
		wordsInScope: number;
		alignment: { transcriptTokens: number; alignedShare: number; offScriptShare: number } | null;
		unscored?: { code: string; message: string };
	}>;
	candidates: { total: number; byGroup: Record<string, number>; byCategory: Record<string, number> };
	skipped: Record<string, number>;
	patch: {
		edits: number;
		patched: number;
		skipped: Array<{ clipId: string; reason: string }>;
		stale: number;
	};
	speech: { model: string | null; problem?: string };
	estimate?: { seconds: number; basis: 'measured' | 'reference' };
	warnings: Array<{ code: string; message: string }>;
};

/** Aligned and off-script shares over every aligned media, weighted by its transcript tokens (null: no alignment). */
export function alignmentShares(r: FixReportLite): { aligned: number; offScript: number } | null {
	let n = 0;
	let a = 0;
	let o = 0;
	for (const m of r.perMedia) {
		const al = m.alignment;
		if (!al || !finite(al.transcriptTokens) || al.transcriptTokens <= 0) continue;
		n += al.transcriptTokens;
		a += (finite(al.alignedShare) ? al.alignedShare : 0) * al.transcriptTokens;
		o += (finite(al.offScriptShare) ? al.offScriptShare : 0) * al.transcriptTokens;
	}
	return n > 0 ? { aligned: a / n, offScript: o / n } : null;
}

export const pct = (x: number) => `${Math.round(Math.max(0, Math.min(1, x)) * 100)} %`;

const GROUP_TEXT: Record<string, string> = {
	fix: 'Fixes',
	spelling: 'Spelling',
	maybe: 'Maybe (offered unselected)',
	keep: 'Kept as transcribed',
	pending: 'To check against the audio',
};
const CATEGORY_TEXT: Record<string, string> = {
	proper: 'Names',
	english: 'English words',
	function: 'Short words',
	other: 'Other words',
};

/** "Fixes 4 · Spelling 1 · To check against the audio 12" in a stable order (zero counts left out). */
export function groupCountsText(byGroup: Record<string, number>): string {
	const order = ['fix', 'spelling', 'maybe', 'pending', 'keep'];
	const keys = [
		...order,
		...Object.keys(byGroup)
			.filter((k) => !order.includes(k))
			.sort(),
	];
	return keys
		.filter((k) => finite(byGroup[k]) && byGroup[k]! > 0)
		.map((k) => `${GROUP_TEXT[k] ?? k} ${byGroup[k]}`)
		.join(' · ');
}

/** "Names 3 · English words 1 · Other words 9". */
export function categoryCountsText(byCategory: Record<string, number>): string {
	const order = ['proper', 'english', 'function', 'other'];
	const keys = [
		...order,
		...Object.keys(byCategory)
			.filter((k) => !order.includes(k))
			.sort(),
	];
	return keys
		.filter((k) => finite(byCategory[k]) && byCategory[k]! > 0)
		.map((k) => `${CATEGORY_TEXT[k] ?? k} ${byCategory[k]}`)
		.join(' · ');
}

/** "≈ 42 s on this computer (measured)" / "≈ 1 min 10 s (estimated from a reference machine)". */
export function estimateText(
	e: { seconds: number; basis: 'measured' | 'reference' } | undefined,
): string | null {
	if (!e || !finite(e.seconds) || e.seconds < 0) return null;
	const s = Math.max(1, Math.round(e.seconds));
	const time = s < 60 ? t('{0} s', s) : t('{0} min {1} s', Math.floor(s / 60), s % 60);
	return e.basis === 'measured'
		? t('≈ {0} for the audio check on this computer (measured on earlier runs)', time)
		: t('≈ {0} for the audio check (estimated from a reference machine; measured after the first run)', time);
}

const SKIP_REASON_TEXT: Record<string, string> = {
	edited: 'edited by hand',
	'source-text-keyframes': 'Source Text keyframes',
	expression: 'text made by an expression',
	locked: 'on a locked track',
	reversed: 'reversed clip',
	split: 'words split across subtitles',
};

/** "edited by hand" for a patch skip reason. */
export function skipReasonText(reason: string): string {
	return SKIP_REASON_TEXT[reason] ?? reason;
}

/** "2 edited by hand, 1 on a locked track" (one reason: just its text). */
export function skipReasonsText(skipped: ReadonlyArray<{ reason: string }>): string {
	const by = new Map<string, number>();
	for (const s of skipped) by.set(s.reason, (by.get(s.reason) ?? 0) + 1);
	if (by.size === 1) return skipReasonText([...by.keys()][0]!);
	return [...by.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([r, n]) => `${n} ${skipReasonText(r)}`)
		.join(', ');
}

// ── Review rows (SC-082) ────────────────────────────────────────────────────────────────────────────────────────

const Words = z.array(z.string().max(512)).max(256).catch([]);
const FixMetaSchema = z.object({
	group: z.string().max(32).catch('fix'),
	kind: z.string().max(32).catch('sub'),
	category: z.string().max(32).catch('other'),
	asr: Words,
	script: Words,
	deltaTok: z.number().finite().nullable().catch(null),
	rule: z.string().max(64).catch(''),
	mediaId: z.string().max(256).catch(''),
	start: z.number().finite().catch(Number.NaN),
	end: z.number().finite().catch(Number.NaN),
	contextBefore: Words,
	contextAfter: Words,
	fingerprint: z.string().max(512).catch(''),
});
export type FixMeta = z.infer<typeof FixMetaSchema>;

/** The review meta of a `transcript-correction` item (SC-061), read leniently; null when it is not one. */
export function fixMetaOf(meta: unknown): FixMeta | null {
	if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
	const r = FixMetaSchema.safeParse(meta);
	if (!r.success) return null;
	const m = r.data;
	if (!m.asr.length && !m.script.length) return null;
	return m;
}

/** Category names in the row ("Name", "English word", …). */
export const FIX_CATEGORY_LABELS: Record<string, string> = {
	proper: 'Name',
	english: 'English word',
	function: 'Short word',
	other: 'Word',
};

/** The decision rules in words (`FixRule` of the model). */
export const FIX_RULE_LABELS: Record<string, string> = {
	audio: 'Audio check',
	spelling: 'Spelling rule: a name or English word that sounds alike',
	del: 'Audio check: a word the transcript missed',
	gap: 'Script word in a voiced gap the transcript left (not confirmed by the audio check)',
	join: 'Script spelling of a split or glued name (no audio check)',
	'glossary-spelling': 'Your glossary’s spelling (no audio check)',
	maybe: 'Below the fix margin: listen and decide',
	'below-margin': 'Below the fix margin',
	unscored: 'Not checked against the audio',
};

/**
 * The confidence label of a fix from Δ_tok (SC-033: how much more likely, per token, the audio makes the script
 * reading than the transcript's). Bands (assumption, documented in the wp-note): Δ_tok ≥ 0 High (the audio prefers the
 * script reading), ≥ −1.5 (the Standard fix margin, SC-034) Medium, lower Low; no Δ (decided without audio) is
 * "No audio check".
 */
export function confidenceOf(deltaTok: number | null): {
	level: 'high' | 'medium' | 'low' | 'none';
	label: string;
} {
	if (deltaTok === null || !finite(deltaTok)) return { level: 'none', label: t('No audio check') };
	if (deltaTok >= 0) return { level: 'high', label: t('High confidence') };
	if (deltaTok >= -1.5) return { level: 'medium', label: t('Medium confidence') };
	return { level: 'low', label: t('Low confidence') };
}

/** "Δ +2.3 per token" (null without a Δ). */
export function deltaText(deltaTok: number | null): string | null {
	if (deltaTok === null || !finite(deltaTok)) return null;
	const v = Math.round(deltaTok * 10) / 10;
	return t('Δ {0} per token', `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}`);
}

/** The rule line of a row: "High confidence · Audio check · Δ +2.3 per token". */
export function ruleLine(m: Pick<FixMeta, 'deltaTok' | 'rule'>): {
	confidence: string;
	rule: string;
	tooltip: string;
} {
	const c = confidenceOf(m.deltaTok);
	const rule = FIX_RULE_LABELS[m.rule] ?? (m.rule || FIX_RULE_LABELS.audio!);
	const d = deltaText(m.deltaTok);
	return {
		confidence: c.label,
		rule: d ? `${rule} · ${d}` : rule,
		tooltip: t(
			'Confidence from the audio check: Δ = how much more likely the script reading is than the transcript’s, per token (High ≥ 0, Medium ≥ −1.5, Low below). Fixes, Spelling and Maybe follow the strictness you chose.',
		),
	};
}

/** The before / after words of a row ("+" when words are inserted, "∅" when removed). */
export function rowDiff(m: FixMeta): {
	before: string[];
	after: string[];
	contextBefore: string;
	contextAfter: string;
} {
	return {
		before: m.asr,
		after: m.script,
		contextBefore: m.contextBefore.slice(-3).join(' '),
		contextAfter: m.contextAfter.slice(0, 3).join(' '),
	};
}

/**
 * The sequence frame where a fix is heard (its media time through the audio clip that plays it, the first such clip
 * in timeline order), or null when the sequence does not play that part of the recording (scope "Whole recordings").
 */
export function fixFrame(
	seq: Sequence | undefined,
	m: Pick<FixMeta, 'mediaId' | 'start' | 'end'>,
): number | null {
	if (!seq || !finite(m.start) || !m.mediaId) return null;
	const F = flicksPerFrame(seq.settings.frameRate);
	if (!finite(F) || F <= 0) return null;
	let best: number | null = null;
	for (const c of Object.values(seq.clips)) {
		if (c.kind !== 'audio' || c.mediaId !== m.mediaId || !c.enabled) continue;
		const rate = c.speed?.rate;
		if (c.speed?.reverse || !finite(rate) || rate <= 0) continue;
		const mediaEnd = c.sourceIn + c.duration * F * rate;
		if (m.start < c.sourceIn || m.start >= mediaEnd) continue;
		const frame = c.start + Math.floor((m.start - c.sourceIn) / rate / F);
		if (best === null || frame < best) best = frame;
	}
	return best;
}

/** "0:12.4" of a media time (flicks), for rows outside the sequence. */
export function mediaTimeText(flicks: number): string {
	if (!finite(flicks)) return '—';
	const s = Math.max(0, flicks / S);
	return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
}

// ── Marks in the Transcript tab (SC-083) ────────────────────────────────────────────────────────────────────────

export type FixMark = {
	itemId: string;
	transcriptId: string;
	/** The edit's media-time span (flicks). */
	start: number;
	end: number;
	before: string;
	after: string;
	group: string;
	/** An insertion (nothing replaced: `del` candidates into a gap): marks the word after the gap. */
	insert: boolean;
};

type ItemLike = { id: string; state?: string; meta?: unknown; commands?: readonly unknown[] };

/** The marks of a fix proposal's open items (pending, accepted not applied, stale), by transcript, in time order. */
export function fixMarks(items: readonly ItemLike[], states: Record<string, string>): Map<string, FixMark[]> {
	const out = new Map<string, FixMark[]>();
	for (const it of items.slice(0, 20_000)) {
		const state = states[it.id] ?? it.state ?? 'pending';
		if (state !== 'pending' && state !== 'accepted' && state !== 'stale') continue;
		const m = fixMetaOf(it.meta);
		const cmd = it.commands?.[0] as { type?: unknown; transcriptId?: unknown; edits?: unknown } | undefined;
		if (!m || !cmd || cmd.type !== 'transcript.replaceWords' || typeof cmd.transcriptId !== 'string')
			continue;
		const edit = (Array.isArray(cmd.edits) ? cmd.edits[0] : null) as {
			start?: unknown;
			end?: unknown;
			expect?: unknown;
		} | null;
		const start = finite(edit?.start) ? edit.start : m.start;
		const end = finite(edit?.end) ? edit.end : m.end;
		if (!finite(start) || !finite(end)) continue;
		const expect = Array.isArray(edit?.expect) ? edit.expect : m.asr;
		const mark: FixMark = {
			itemId: it.id,
			transcriptId: cmd.transcriptId,
			start,
			end,
			before: m.asr.join(' ') || '+',
			after: m.script.join(' ') || '∅',
			group: m.group,
			insert: expect.length === 0,
		};
		const list = out.get(mark.transcriptId);
		if (list) list.push(mark);
		else out.set(mark.transcriptId, [mark]);
	}
	for (const list of out.values()) list.sort((a, b) => a.start - b.start || a.end - b.end);
	return out;
}

/**
 * Which words of a transcript (media time, sorted) the marks fall on: index → mark. A replacement marks the words
 * overlapping its span (a zero-length word when it starts inside it); an insertion marks the first word starting at
 * or after its gap (else the last word). Binary searches; never throws.
 */
export function markedWords(
	words: ReadonlyArray<{ start: number; end: number }>,
	marks: readonly FixMark[] | undefined,
): Map<number, FixMark> {
	const out = new Map<number, FixMark>();
	if (!marks?.length || !words.length) return out;
	const firstEndingAfter = (x: number) => {
		let lo = 0;
		let hi = words.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (Math.max(words[mid]!.end, words[mid]!.start + 1) <= x) lo = mid + 1;
			else hi = mid;
		}
		return lo;
	};
	for (const m of marks) {
		if (m.insert) {
			let i = firstEndingAfter(m.end - 1);
			while (i < words.length && words[i]!.start < m.end - 1) i++;
			const at = Math.min(i, words.length - 1);
			if (!out.has(at)) out.set(at, m);
			continue;
		}
		for (let i = firstEndingAfter(m.start); i < words.length; i++) {
			const w = words[i]!;
			if (w.start >= m.end) break;
			const hit =
				w.end <= w.start ? w.start >= m.start && w.start < m.end : w.start < m.end && w.end > m.start;
			if (hit && !out.has(i)) out.set(i, m);
		}
	}
	return out;
}

// ── Patch report after accepting (SC-053 / SC-084) ──────────────────────────────────────────────────────────────

const PatchResultSchema = z.object({
	edits: z.number().int().min(0).catch(0),
	patched: z
		.array(z.looseObject({ clipId: z.string(), sequenceId: z.string() }))
		.max(100_000)
		.catch([]),
	skipped: z
		.array(
			z.looseObject({
				clipId: z.string(),
				sequenceId: z.string(),
				reason: z.string(),
				kind: z.string().catch('subtitle'),
			}),
		)
		.max(100_000)
		.catch([]),
});

export type FixPatchReport = {
	fixes: number;
	edits: number;
	patched: number;
	skipped: Array<{ clipId: string; sequenceId: string; reason: string; kind: string }>;
};

/**
 * The patch report of an accept transaction: the `transcript.replaceWords` results among `results` (other commands
 * of the transaction — the remembered rejections — are ignored); clips counted once.
 */
export function patchReportOf(results: readonly unknown[], fixes: number): FixPatchReport {
	let edits = 0;
	const patched = new Set<string>();
	const skipped = new Map<string, FixPatchReport['skipped'][number]>();
	for (const r of results.slice(0, 100_000)) {
		if (!r || typeof r !== 'object' || !('skipped' in r) || !('patched' in r)) continue;
		const p = PatchResultSchema.safeParse(r);
		if (!p.success) continue;
		edits += p.data.edits;
		for (const c of p.data.patched) patched.add(`${c.sequenceId}/${c.clipId}`);
		for (const s of p.data.skipped) {
			const k = `${s.sequenceId}/${s.clipId}`;
			if (!skipped.has(k))
				skipped.set(k, { clipId: s.clipId, sequenceId: s.sequenceId, reason: s.reason, kind: s.kind });
		}
	}
	for (const k of skipped.keys()) patched.delete(k);
	return { fixes: Math.max(0, fixes), edits, patched: patched.size, skipped: [...skipped.values()] };
}

/** "142 fixes applied · 3 subtitles not updated: edited by hand" (SC-053). */
export function patchReportText(r: FixPatchReport): string {
	const fixes = r.fixes === 1 ? t('1 fix applied') : t('{0} fixes applied', r.fixes);
	if (!r.skipped.length) return fixes;
	const n = r.skipped.length;
	const subs =
		n === 1
			? t('1 subtitle not updated: {0}', skipReasonsText(r.skipped))
			: t('{0} subtitles not updated: {1}', n, skipReasonsText(r.skipped));
	return `${fixes} · ${subs}`;
}

// ── Manual-edit offers (SC-071 / SC-085) ────────────────────────────────────────────────────────────────────────

export type EditOffer = {
	/** What the recogniser wrote and what the user typed (cleaned, edge punctuation removed). */
	from: string;
	to: string;
	/** The transcript language (base code), for the glossary entry. */
	lang: string | null;
	plan: ReplaceAllPlan;
	/** "Remember" is possible (a spelling the glossary can hold). */
	canRemember: boolean;
};

const EDGE = /^[¿¡«“‘"'([]+|[.,;:!?…»”’"')\]]+$/gu;
const core = (s: string) => cleanGlossaryText(s).replace(EDGE, '').trim();

/**
 * The offer after the user corrected `oldWords` to `newText` (the document is the one after the edit; `exclude` the
 * edited span in media time). Null when there is nothing to offer: an empty correction, the same words, or no other
 * occurrence and nothing the glossary could hold.
 */
export function editOffer(
	doc: ProjectDocument,
	sequenceId: string,
	edit: {
		oldWords: readonly string[];
		newText: string;
		transcriptId: string;
		start: number;
		end: number;
		language: string | null;
	},
): EditOffer | null {
	const from = core(edit.oldWords.join(' '));
	const to = core(edit.newText);
	if (!from || !to || from === to) return null;
	let plan: ReplaceAllPlan = { occurrences: [], commands: [], truncated: 0 };
	try {
		plan = findReplaceAllInSequence(doc, sequenceId, {
			oldWords: edit.oldWords,
			newText: edit.newText,
			exclude: { transcriptId: edit.transcriptId, start: edit.start, end: edit.end },
		});
	} catch {
		plan = { occurrences: [], commands: [], truncated: 0 };
	}
	const chars = (s: string) => [...s].length;
	const canRemember =
		from.toLocaleLowerCase() !== to.toLocaleLowerCase() &&
		chars(from) <= 64 &&
		chars(to) <= 64 &&
		/[\p{L}\p{N}]/u.test(to);
	if (!plan.occurrences.length && !canRemember) return null;
	const lang = edit.language ? edit.language.toLowerCase().split(/[-_]/)[0]! : null;
	return { from, to, lang: lang && /^[a-z]{2,3}$/.test(lang) ? lang : null, plan, canRemember };
}

// ── Names carried into a transcription prompt (SC-074) ──────────────────────────────────────────────────────────

export type NamesFrom = 'off' | 'script' | 'script+glossary';
export const MAX_PROMPT_TERMS = 40;
const MAX_TERM_CHARS = 64;

const OUTER = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

/**
 * The terms a transcription carries in its prompt (SC-074): the script's proper nouns and (Spanish scripts) English
 * words, in the script's spelling (the most frequent written form of each), and with `script+glossary` the glossary's
 * right spellings (`to`) for the language; ranked by how often the script says them (a glossary entry adds its taught
 * count), ties in order of appearance; at most 40, each ≤ 64 characters. Numbers and function words never count.
 */
export function promptTerms(
	script: string | null,
	language: string | null,
	mode: NamesFrom,
	glossary: ReadonlyArray<{ to: string; lang?: string; count?: number }> = [],
): string[] {
	if (mode === 'off') return [];
	const lang = scriptFixLanguage(language);
	type Term = { text: string; score: number; order: number; forms: Map<string, number> };
	const terms = new Map<string, Term>();
	let order = 0;
	const add = (key: string, text: string, score: number) => {
		const k = key.toLocaleLowerCase();
		let e = terms.get(k);
		if (!e) {
			e = { text, score: 0, order: order++, forms: new Map() };
			terms.set(k, e);
		}
		e.score += score;
		e.forms.set(text, (e.forms.get(text) ?? 0) + 1);
	};
	if (script?.trim()) {
		try {
			const parsed = parseScript(script.slice(0, 256 * 1024), { language });
			const proper = new Set(parsed.properNorms);
			const stop = functionWords(lang);
			for (const tok of parsed.tokens) {
				if (tok.kind !== 'word' || !tok.norm || isNumericToken(tok.norm)) continue;
				if (!proper.has(tok.norm) && !isEnglishWord(tok.norm, lang, stop)) continue;
				const text = tok.text.replace(OUTER, '');
				if (!text || [...text].length > MAX_TERM_CHARS) continue;
				add(tok.norm, text, 1);
			}
		} catch {
			// an unreadable script carries no names
		}
	}
	if (mode === 'script+glossary') {
		for (const g of glossary.slice(0, 5000)) {
			if (g.lang && lang && g.lang !== lang) continue;
			const text = cleanGlossaryText(String(g.to ?? ''));
			if (!text || [...text].length > MAX_TERM_CHARS) continue;
			add(cleanupNorm(text) || text.replace(/\s+/g, ''), text, Math.max(1, finite(g.count) ? g.count : 0));
		}
	}
	return [...terms.values()]
		.map((e) => {
			// the most frequent written form (first seen on ties)
			let best = e.text;
			let n = 0;
			for (const [f, c] of e.forms) if (c > n) [best, n] = [f, c];
			return { ...e, text: best };
		})
		.sort((a, b) => b.score - a.score || a.order - b.order)
		.slice(0, MAX_PROMPT_TERMS)
		.map((e) => e.text);
}
