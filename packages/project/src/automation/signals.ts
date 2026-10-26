// What in an edit can trigger or constrain the overlay passes (spec 15 EA-023…EA-026): the picture cuts to snap to,
// transcript words that call to action or exclaim (editable lists per language), sequence markers, stretches where face
// tracking sees no face on the A-roll ("speaker not visible"), the screen regions of subtitles (spec 13 caption groups,
// read defensively: the subtitles work merges in parallel), "!" phrases and peaks of the momentary loudness. Pure;
// never throws for damaged documents (bad data reads as "no signal").
import { captionClipText } from '../captions/model.ts';
import { sequenceWords } from '../captions/sequence-transcript.ts';
import { clipsOnTrack } from '../derive/index.ts';
import { intrinsicBoxOf } from '../registry/properties.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Clip, Sequence, Track } from '../schema/sequence.ts';
import { CutMapError, pictureCuts } from '../structure/cuts.ts';
import { FLICKS_PER_SECOND, flicksPerFrame } from '../time.ts';
import { AutomationInputError, fpsValue, frameGeometry, videoTrackOf } from './common.ts';

// ---------------------------------------------------------------------------------------------------------------
// Cuts

/** Picture cuts (frame and track; sorted, one per frame) of the sequence, or of one video track; `[]` on damaged data. */
export function pictureCutList(
	doc: ProjectDocument,
	seq: Sequence,
	trackRef?: string,
): { frame: number; trackId: string }[] {
	const trackIds = trackRef !== undefined ? [videoTrackOf(seq, trackRef).id] : undefined;
	try {
		const cuts = pictureCuts(doc, seq.id, {
			...(trackIds ? { trackIds } : {}),
			includeJumpCuts: true,
			includeOverlays: false,
		});
		const out: { frame: number; trackId: string }[] = [];
		for (const c of [...cuts].sort((a, b) => a.frame - b.frame))
			if (!out.length || out[out.length - 1]!.frame !== c.frame)
				out.push({ frame: c.frame, trackId: c.trackId });
		return out;
	} catch (e) {
		if (e instanceof CutMapError && e.code === 'E_NOT_FOUND')
			throw new AutomationInputError(e.code, e.message);
		return [];
	}
}

/** Picture cut frames (sorted, unique); see `pictureCutList`. */
export function cutFrames(doc: ProjectDocument, seq: Sequence, trackRef?: string): number[] {
	return pictureCutList(doc, seq, trackRef).map((c) => c.frame);
}

/** The cut nearest `frame` within `maxFrames` (ties: the earlier one), or null. `after`: only cuts ≥ `frame`. */
export function nearestCut(
	cuts: readonly number[],
	frame: number,
	maxFrames: number,
	opts: { after?: boolean } = {},
): number | null {
	let best: number | null = null;
	let lo = 0;
	let hi = cuts.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (cuts[mid]! < frame - maxFrames) lo = mid + 1;
		else hi = mid;
	}
	for (let i = lo; i < cuts.length && cuts[i]! <= frame + maxFrames; i++) {
		const c = cuts[i]!;
		if (opts.after && c < frame) continue;
		if (best === null || Math.abs(c - frame) < Math.abs(best - frame)) best = c;
	}
	return best;
}

// ---------------------------------------------------------------------------------------------------------------
// Words

/**
 * Built-in trigger word lists (generic vocabulary, not taken from anyone's videos): calls to action and exclamations,
 * matched on normalised words (lower case, accents and punctuation removed); a phrase matches consecutive words. Any
 * word written with "!" / "¡" is an exclamation too.
 */
export const REACTION_WORD_LISTS: Record<
	string,
	{ cta: readonly string[]; exclamations: readonly string[] }
> = {
	es: {
		cta: [
			'suscribete',
			'suscribanse',
			'suscribirte',
			'descargalo',
			'descargatelo',
			'descarga',
			'dale like',
			'dale a like',
			'deja tu like',
			'comenta',
			'comentad',
			'comparte',
			'compartid',
			'activa la campanita',
			'link en la descripcion',
			'enlace en la descripcion',
			'sigueme',
		],
		exclamations: [
			'wow',
			'guau',
			'hala',
			'ala',
			'madre mia',
			'dios mio',
			'increible',
			'brutal',
			'que fuerte',
			'no puede ser',
			'en serio',
			'ostras',
			'jajaja',
			'jaja',
			'xd',
			'ay',
			'uy',
			'vaya',
		],
	},
	en: {
		cta: [
			'subscribe',
			'download',
			'hit like',
			'smash that like',
			'like and subscribe',
			'comment',
			'share',
			'link in the description',
			'follow me',
			'turn on notifications',
		],
		exclamations: [
			'wow',
			'whoa',
			'omg',
			'oh my god',
			'no way',
			'insane',
			'incredible',
			'crazy',
			'what',
			'haha',
			'hahaha',
			'lol',
			'oh no',
			'yikes',
		],
	},
};

/** Lower case, accents and punctuation removed (`¡Suscríbete!` → `suscribete`). */
export function normalizeTriggerWord(s: string): string {
	return s
		.normalize('NFD')
		.replace(/\p{M}+/gu, '')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]+/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/** A transcript word in sequence frames. */
export type FrameWord = { text: string; start: number; end: number; clipId: string; index: number };

/** The sequence transcript in frames (sorted); `[]` without words or on damaged data. */
export function frameWords(doc: ProjectDocument, seq: Sequence): FrameWord[] {
	try {
		const F = flicksPerFrame(frameGeometry(seq).fps);
		return sequenceWords(doc, seq).map((w) => ({
			text: w.text,
			start: Math.floor(w.start / F),
			end: Math.max(Math.floor(w.start / F) + 1, Math.ceil(w.end / F)),
			clipId: w.clipId,
			index: w.index,
		}));
	} catch {
		return [];
	}
}

/** The language of the sequence's transcript words (the most used transcript's), or null. */
export function wordsLanguage(doc: ProjectDocument, seq: Sequence): string | null {
	try {
		const n = new Map<string, number>();
		for (const w of sequenceWords(doc, seq)) {
			const lang = doc.transcripts?.[w.transcriptId]?.language;
			if (typeof lang === 'string' && lang) n.set(lang, (n.get(lang) ?? 0) + 1);
		}
		let best: string | null = null;
		for (const [k, v] of n) if (best === null || v > (n.get(best) ?? 0)) best = k;
		return best ? best.toLowerCase().split(/[-_]/)[0]! : null;
	} catch {
		return null;
	}
}

export type WordTrigger = {
	kind: 'cta' | 'exclamation';
	/** First frame of the phrase. */
	frame: number;
	end: number;
	/** The words as written (for the why-line and refresh). */
	text: string;
	clipId: string;
	/** Index of the first word in its transcript. */
	index: number;
};

/** The word lists in effect: the given ones, else the built-ins of `language` (both languages when unknown). */
export function wordLists(
	language: string | null,
	custom: { cta?: readonly string[]; exclamations?: readonly string[] } = {},
): { cta: string[][]; exclamations: string[][] } {
	const builtIn =
		language && REACTION_WORD_LISTS[language]
			? [REACTION_WORD_LISTS[language]!]
			: Object.values(REACTION_WORD_LISTS);
	const split = (l: readonly string[]) =>
		[...new Set(l.map(normalizeTriggerWord).filter(Boolean))].map((p) => p.split(' '));
	return {
		cta: split(custom.cta ?? builtIn.flatMap((b) => b.cta)),
		exclamations: split(custom.exclamations ?? builtIn.flatMap((b) => b.exclamations)),
	};
}

/**
 * Calls to action and exclamations in the transcript: phrases of the lists (longest first, no overlap; a call to action
 * wins over an exclamation on the same words) and words written with "!" / "¡".
 */
export function wordTriggers(
	words: readonly FrameWord[],
	lists: { cta: string[][]; exclamations: string[][] },
): WordTrigger[] {
	const norm = words.map((w) => normalizeTriggerWord(w.text));
	const out: WordTrigger[] = [];
	const used = new Uint8Array(words.length);
	const scan = (kind: WordTrigger['kind'], phrases: string[][]) => {
		const sorted = [...phrases].sort((a, b) => b.length - a.length);
		for (let i = 0; i < words.length; i++) {
			if (used[i]) continue;
			for (const p of sorted) {
				if (i + p.length > words.length) continue;
				let ok = true;
				for (let k = 0; k < p.length && ok; k++) ok = !used[i + k] && norm[i + k] === p[k];
				if (!ok) continue;
				for (let k = 0; k < p.length; k++) used[i + k] = 1;
				const last = words[i + p.length - 1]!;
				out.push({
					kind,
					frame: words[i]!.start,
					end: last.end,
					text: words
						.slice(i, i + p.length)
						.map((w) => w.text)
						.join(' ')
						.slice(0, 120),
					clipId: words[i]!.clipId,
					index: words[i]!.index,
				});
				break;
			}
		}
	};
	scan('cta', lists.cta);
	scan('exclamation', lists.exclamations);
	for (let i = 0; i < words.length; i++) {
		if (used[i] || !/[!¡]/.test(words[i]!.text)) continue;
		used[i] = 1;
		const w = words[i]!;
		out.push({
			kind: 'exclamation',
			frame: w.start,
			end: w.end,
			text: w.text.slice(0, 120),
			clipId: w.clipId,
			index: w.index,
		});
	}
	return out.sort((a, b) => a.frame - b.frame || a.index - b.index);
}

// ---------------------------------------------------------------------------------------------------------------
// Markers

export type MarkerTrigger = { frame: number; markerId: string; name: string };

/** Sequence markers whose name contains `match` (case and accents ignored) or equals one of `names`. */
export function markerTriggers(seq: Sequence, match: string, names: readonly string[] = []): MarkerTrigger[] {
	const m = normalizeTriggerWord(match);
	const set = new Set(names.map(normalizeTriggerWord).filter(Boolean));
	const out: MarkerTrigger[] = [];
	for (const mk of Array.isArray(seq.markers) ? seq.markers : []) {
		if (!mk || typeof mk.frame !== 'number' || !Number.isFinite(mk.frame) || mk.frame < 0) continue;
		const n = normalizeTriggerWord(typeof mk.name === 'string' ? mk.name : '');
		if (!n) continue;
		if ((m && n.includes(m)) || set.has(n))
			out.push({
				frame: Math.round(mk.frame),
				markerId: String(mk.id ?? ''),
				name: String(mk.name).slice(0, 120),
			});
	}
	return out.sort((a, b) => a.frame - b.frame);
}

// ---------------------------------------------------------------------------------------------------------------
// Faces ("speaker not visible")

type FacesRoto = {
	kind?: string;
	rate?: { num: number; den: number };
	result?: { faces?: { startFrame: number; poses: number[]; present: number[] }[] } | null;
};

function facesRotos(c: Clip): FacesRoto[] {
	const rotos = (c as { rotos?: unknown[] }).rotos;
	if (!Array.isArray(rotos)) return [];
	return (rotos as FacesRoto[]).filter(
		(r) =>
			r &&
			r.kind === 'faces' &&
			Array.isArray(r.result?.faces) &&
			!!r.rate &&
			r.rate.num > 0 &&
			r.rate.den > 0,
	);
}

/** Whether face tracking sees a face on `c` at sequence `frame`; null when the clip has no face tracking. */
export function faceVisibleAt(seq: Sequence, c: Clip, frame: number): boolean | null {
	const rotos = facesRotos(c);
	if (!rotos.length) return null;
	const F = flicksPerFrame(frameGeometry(seq).fps);
	const rate = (c as { speed?: { rate?: number } }).speed?.rate ?? 1;
	const t = (c as { sourceIn?: number }).sourceIn ?? 0;
	const ct = t + (frame - c.start) * F * (Number.isFinite(rate) && rate > 0 ? rate : 1);
	for (const r of rotos) {
		const mf = Math.floor((ct * r.rate!.num) / (r.rate!.den * FLICKS_PER_SECOND) + 1e-6);
		for (const face of r.result!.faces!) {
			const i = mf - face.startFrame;
			if (i >= 0 && Array.isArray(face.present) && face.present[i] === 1) return true;
		}
	}
	return false;
}

export type HiddenSpeaker = { frame: number; end: number; clipId: string };

/**
 * Stretches of at least `minFrames` where the A-roll's face tracking sees no face (sampled every `step` frames), and
 * whether any A-roll clip in the range has face tracking at all.
 */
export function hiddenSpeakerRuns(
	seq: Sequence,
	track: Track,
	minFrames: number,
	range?: { start: number; end: number },
): { runs: HiddenSpeaker[]; tracked: boolean } {
	const step = Math.max(1, Math.round(fpsValue(frameGeometry(seq).fps) / 5));
	const runs: HiddenSpeaker[] = [];
	let tracked = false;
	for (const c of clipsOnTrack(seq, track.id)) {
		if (c.enabled === false) continue;
		const a = Math.max(c.start, range?.start ?? 0);
		const b = Math.min(c.start + c.duration, range?.end ?? Number.POSITIVE_INFINITY);
		if (b <= a || !facesRotos(c).length) continue;
		tracked = true;
		let run = -1;
		for (let f = a; f <= b; f += step) {
			const hidden = f < b && faceVisibleAt(seq, c, Math.min(f, b - 1)) === false;
			if (hidden && run < 0) run = f;
			else if (!hidden && run >= 0) {
				const end = Math.min(f, b);
				if (end - run >= minFrames) runs.push({ frame: run, end, clipId: c.id });
				run = -1;
			}
		}
		if (run >= 0 && b - run >= minFrames) runs.push({ frame: run, end: b, clipId: c.id });
	}
	return { runs: runs.sort((x, y) => x.frame - y.frame), tracked };
}

// ---------------------------------------------------------------------------------------------------------------
// Subtitle regions

/** An axis-aligned rectangle in sequence pixels. */
export type ScreenRect = { x0: number; y0: number; x1: number; y1: number };
export type ScreenRegion = { start: number; end: number; rect: ScreenRect; clipId: string };

export const rectsOverlap = (a: ScreenRect, b: ScreenRect) =>
	a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const staticOf = (p: unknown) =>
	p && typeof p === 'object' && 'value' in (p as Record<string, unknown>)
		? (p as { value: unknown }).value
		: undefined;

/** The on-screen rectangle of a visual clip from its box and static Motion (rotation ignored), or null. */
export function clipRect(doc: ProjectDocument, seq: Sequence, c: Clip): ScreenRect | null {
	let box: { width: number; height: number };
	try {
		box = intrinsicBoxOf({ clip: c, doc, seq } as never);
	} catch {
		return null;
	}
	if (!(box.width > 0 && box.height > 0)) return null;
	const tr = (c as { transform?: Record<string, unknown> }).transform;
	const geo = frameGeometry(seq);
	const pos = staticOf(tr?.position) as number[] | undefined;
	const anc = staticOf(tr?.anchor) as number[] | undefined;
	const s = num(staticOf(tr?.scale), 100) / 100;
	const sw = tr?.uniformScale === false ? num(staticOf(tr?.scaleWidth), 100) / 100 : s;
	const px = num(pos?.[0], geo.width / 2);
	const py = num(pos?.[1], geo.height / 2);
	const ax = num(anc?.[0], box.width / 2);
	const ay = num(anc?.[1], box.height / 2);
	const x0 = px - ax * sw;
	const y0 = py - ay * s;
	return { x0, y0, x1: x0 + box.width * sw, y1: y0 + box.height * s };
}

/**
 * Where subtitles are on screen and when: text clips of a subtitle group (spec 13: `TextClip.caption.groupId`,
 * `Sequence.captionGroups`). Read defensively — the groups may not exist in this build's documents. Empty when the
 * sequence has no subtitle group.
 */
export function subtitleRegions(doc: ProjectDocument, seq: Sequence): ScreenRegion[] {
	const groups = (seq as { captionGroups?: unknown }).captionGroups;
	const groupIds =
		groups && typeof groups === 'object' && !Array.isArray(groups) ? new Set(Object.keys(groups)) : null;
	const out: ScreenRegion[] = [];
	for (const c of Object.values(seq.clips ?? {})) {
		if (c.kind !== 'text' || c.enabled === false) continue;
		const cap = (c as { caption?: { groupId?: unknown } }).caption;
		const gid = cap && typeof cap === 'object' && typeof cap.groupId === 'string' ? cap.groupId : null;
		if (!gid || (groupIds && groupIds.size > 0 && !groupIds.has(gid))) continue;
		const rect = clipRect(doc, seq, c);
		if (!rect) continue;
		out.push({ start: c.start, end: c.start + c.duration, rect, clipId: c.id });
	}
	return out.sort((a, b) => a.start - b.start);
}

/** Whether `rect` during [start, end) overlaps a region. */
export function overlapsRegions(
	regions: readonly ScreenRegion[],
	start: number,
	end: number,
	rect: ScreenRect,
): boolean {
	for (const r of regions) {
		if (r.start >= end) break;
		if (r.end > start && rectsOverlap(r.rect, rect)) return true;
	}
	return false;
}

// ---------------------------------------------------------------------------------------------------------------
// "!" phrases

export type ExclaimTrigger = { frame: number; end: number; text: string; source: 'word' | 'subtitle' };

/** Transcript words and subtitle / caption clips written with "!" (or "¡"): where each ends. */
export function exclamationPhrases(
	doc: ProjectDocument,
	seq: Sequence,
	words: readonly FrameWord[],
): ExclaimTrigger[] {
	const out: ExclaimTrigger[] = [];
	for (const w of words)
		if (/[!¡]/.test(w.text))
			out.push({ frame: w.start, end: w.end, text: w.text.slice(0, 120), source: 'word' });
	for (const c of Object.values(seq.clips ?? {})) {
		if (c.enabled === false) continue;
		let text: unknown;
		if (c.kind === 'text') text = (c as { content?: { text?: unknown } }).content?.text;
		else if (c.kind === 'captions')
			try {
				text = captionClipText(doc, c as never, frameGeometry(seq).fps);
			} catch {
				text = undefined;
			}
		if (typeof text === 'string' && /[!¡]/.test(text))
			out.push({ frame: c.start, end: c.start + c.duration, text: text.slice(0, 120), source: 'subtitle' });
	}
	return out.sort((a, b) => a.end - b.end || a.frame - b.frame);
}

// ---------------------------------------------------------------------------------------------------------------
// Loudness peaks

/** Momentary loudness (BS.1770, 400 ms) every `hopSec` from `startSec` of the sequence; null = below the gate. */
export type LoudnessCurve = { startSec: number; hopSec: number; lufs: (number | null)[] };

export type LoudPeak = {
	/** Sequence frames of the loud run (≥ threshold over the local median) and of its loudest point. */
	start: number;
	end: number;
	peak: number;
	/** LU over the local median at the peak. */
	excessLu: number;
};

/** Quickselect-free median of a small sorted copy. */
function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * Runs where the momentary loudness is at least `thresholdLu` over the median of the measurable values within
 * ±`windowSec`/2 (silence below −70 LUFS is left out of the median and never peaks). Frames at the sequence rate.
 */
export function loudPeaks(
	curve: LoudnessCurve,
	fps: number,
	opts: { thresholdLu: number; windowSec: number; floorLufs?: number },
): LoudPeak[] {
	const v = curve.lufs;
	const hop = curve.hopSec > 0 && Number.isFinite(curve.hopSec) ? curve.hopSec : 0.1;
	const half = Math.max(1, Math.round(opts.windowSec / 2 / hop));
	const floor = opts.floorLufs ?? -50;
	const out: LoudPeak[] = [];
	const n = Math.min(v.length, 2_000_000);
	let run: { a: number; b: number; peak: number; ex: number } | null = null;
	const toFrame = (k: number) => Math.max(0, Math.round((curve.startSec + k * hop) * fps));
	// a sliding window of the measurable values (sorted insertion keeps it O(n · w) worst case, w ≤ 1200 hops)
	for (let k = 0; k <= n; k++) {
		let loud = false;
		let ex = 0;
		const x = k < n ? v[k] : null;
		if (typeof x === 'number' && Number.isFinite(x) && x > floor) {
			const win: number[] = [];
			for (let j = Math.max(0, k - half); j <= Math.min(n - 1, k + half); j++) {
				const y = v[j];
				if (typeof y === 'number' && Number.isFinite(y) && y > -70) win.push(y);
			}
			if (win.length >= 3) {
				ex = x - median(win);
				loud = ex >= opts.thresholdLu;
			}
		}
		if (loud) {
			if (!run) run = { a: k, b: k + 1, peak: k, ex };
			else {
				run.b = k + 1;
				if (ex > run.ex) {
					run.ex = ex;
					run.peak = k;
				}
			}
		} else if (run) {
			out.push({
				start: toFrame(run.a),
				end: toFrame(run.b),
				peak: toFrame(run.peak),
				excessLu: Math.round(run.ex * 10) / 10,
			});
			run = null;
		}
	}
	return out;
}
