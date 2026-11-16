// Document invariants INV-001…INV-016 (S01 §16.3, INV-016 = sim-warp Puppet data; with the ARCHITECTURE §2.3 locked-track change:
// locked tracks never shift, so there is no invariant about them) and conservative load-time repairs
// (S01:PER-004).

import type { Draft } from 'immer';
import { audioMixIssues, repairAudioMix } from './audio/invariants.ts';
import { edgeFadesProblem, readEdgeFades } from './audio-fade.ts';
import { repairStyleRecipes, styleRecipesIssues } from './automation/recipes.ts';
import { agentNotesIssue, repairAgentNotes, repairSequenceBrief, sequenceBriefIssue } from './brief/model.ts';
import { normalizeCaptionOwnership } from './captions/model.ts';
import { mergeRanges } from './captions/sequence-transcript.ts';
import {
	clipCaptionProblem,
	repairSubtitleSequence,
	sequenceSubtitleIssues,
} from './captions/subtitles/model.ts';
import { repairSubtitleTemplates, subtitleTemplatesIssues } from './captions/subtitles/templates.ts';
import { normalizeWords, wordsWellFormed } from './captions/words.ts';
import { repairSequenceCleanup, sequenceCleanupIssue } from './cleanup/schema.ts';
import { colorIssues, repairColor } from './color/model.ts';
import type { Issue } from './commands/types.ts';
import { clipEnd } from './derive/index.ts';
import {
	ESSENTIAL_SLOTS,
	EssentialSoundSchema,
	legacyPanApplied,
	migrateLegacyPan,
	readEssentialSound,
} from './essential/model.ts';
import { readRemixAnchors, remixAnchorsValid } from './essential/ops.ts';
import { expressionIssues, repairExpressions } from './expressions.ts';
import { createFontRef, createTrack, DEFAULT_FONT_FAMILY } from './factories.ts';
import { gapsIssues, repairGaps } from './gaps/index.ts';
import { type IdPrefix, type IdSource, idPrefixOf, isValidId } from './ids.ts';
import { interpretationIssues, mediaDurationFlicks } from './interpret/model.ts';
import { isRovingKey, keySidesIssue, normalizeKeySides, retimeRoving } from './keyframes.ts';
import { MASK_EXPANSION_RANGE, MASK_FEATHER_RANGE, MASK_OPACITY_RANGE } from './masks/model.ts';
import { TRACK_MATTE_EFFECT_ID, TRACK_MATTE_TRACK_PARAMS, trackMatteTracksOf } from './masks/track-matte.ts';
import {
	angleById,
	fixMulticamSelections,
	multicamSourceIssues,
	multicamSourceOf,
	pruneMulticamAngles,
} from './multicam/model.ts';
import {
	clearEffectMedia,
	clearTitleLookMedia,
	clipParamMediaIds,
	effectMediaRefs,
	projectLookMediaIds,
	rewriteParamMedia,
	templateMediaRefs,
	titleLookMediaRefs,
} from './param-media.ts';
import { type BezierPath, isBezierPath, segmentCount } from './path/model.ts';
import type { EffectRegistry, ParamSpec } from './registry/effects.ts';
import { defaultEffectRegistry } from './registry/effects.ts';
import { contentDurationFlicks, isBoundedContent, kindCapabilities, trackKindFor } from './registry/kinds.ts';
import type { MgTemplateRegistry } from './registry/mg.ts';
import { ROTO_OBJECT_PARAMS } from './roto/index.ts';
import { repairSceneBindings, SCENE_EXTENSION_KEY, sceneBindingsIssue } from './scene/bindings.ts';
import { type Animatable, type Keyframe, SPATIAL_INTERPOLATIONS } from './schema/common.ts';
import type { ProjectDocument } from './schema/document.ts';
import { MASK_MODES, type Mask } from './schema/mask.ts';
import { MAX_TRANSCRIPT_REDECODED, mgHtmlPageIssue } from './schema/media.ts';
import { PUPPET_PIN_KINDS, PUPPET_PIN_PROPS, type Puppet } from './schema/puppet.ts';
import type {
	AudioClip,
	Clip,
	ClipRoto,
	EffectInstance,
	Sequence,
	Track,
	Transition,
} from './schema/sequence.ts';
import { isKnownClipKind, SequencePreviewSettingsSchema } from './schema/sequence.ts';
import type { ShapeItem } from './schema/shapes.ts';
import type { ClipCameraTracker } from './schema/three-d.ts';
import { repairSequenceScriptFix, sequenceScriptFixIssue } from './script-fix/sequence-state.ts';
import { libraryProvenanceIssue, readLibraryProvenance } from './sound/provenance.ts';
import {
	clipBedProblem,
	clipSfxProblem,
	markerVerdictProblem,
	repairSoundDesign,
	sequenceSoundDesignIssue,
} from './sound/repair.ts';
import {
	normalizeTranscriptSegments,
	transcriptRedecoded,
	transcriptSegmentsProblem,
} from './speech/index.ts';
import { isNestClip } from './structure/nest.ts';
import { getTextAnimationSpec } from './text-animations.ts';
import { repairTextAnimators, textAnimatorIssues } from './text-animators/validate.ts';
import { clipTextStyles, repairTextStyle, storedTextStyles, textStyleIssues } from './text-style.ts';
import { clipTextStyleIssue, repairTextStyles, textStylesRecordIssues } from './text-styles/model.ts';
import { clipTextContents, repairTextWriting, textWritingIssues } from './text-writing.ts';
import { canBe3d, newLayer3D } from './three-d/model.ts';
import { sanitizeThreeD, threeDProblem } from './three-d/validate.ts';
import {
	contentSpanFlicks,
	FLICKS_PER_SECOND,
	flicksPerFrame,
	isAllowedSequenceRate,
	type Rational,
	supportsDropFrame,
} from './time.ts';
import { remapIssues, repairRemap } from './time-remap/invariants.ts';
import { isRemapped } from './time-remap/model.ts';
import { clipLook, globalLightOf, TITLE_LOOK_EFFECT_ID } from './title-looks/model.ts';
import {
	appearanceProblem,
	clipLookProblem,
	globalLightProblem,
	repairAppearance,
	repairTitleLooks,
	sanitizeAppearances,
	titleLookOf,
	titleLooksOf,
	titleLooksRecordIssues,
} from './title-looks/validate.ts';
import { CUSTOM_FADE, transitionSpec } from './transitions.ts';
import { walkItems } from './vector/defaults.ts';
import { checkShapeItem, duplicateItemIds } from './vector/input.ts';

/** What is wrong with a 3D Camera Tracker's span or solve, or null. */
function cameraTrackerProblem(t: ClipCameraTracker): string | null {
	if (t.span[1] < t.span[0] + 1) return 'span must hold at least two frames';
	const s = t.solve;
	if (!s) return null;
	if (s.span[0] !== t.span[0] || s.span[1] !== t.span[1]) return 'solve is of another span';
	if (s.frames.length !== (s.span[1] - s.span[0] + 1) * 8 || !s.frames.every(Number.isFinite))
		return 'solve frames are malformed';
	if (s.points.some((p) => p.first > p.last || !p.pos.every(Number.isFinite)))
		return 'solve points are malformed';
	return null;
}

const inv = (invariant: string, message: string, path?: string[]): Issue => ({
	commandIndex: -1,
	code: 'E_INVARIANT',
	invariant,
	message: `${invariant}: ${message}`,
	...(path ? { path } : {}),
});

type AnimLike = {
	value: unknown;
	keyframes: { id: string; time: number; value: unknown; spatial?: unknown }[];
};

/** INV-011 (spatial-motion-path, S03:KF-030): spatial data only on vec2 keys, with finite tangents. */
function badSpatial(k: { value: unknown; spatial?: unknown }): boolean {
	if (k.spatial === undefined) return false;
	const s = k.spatial as { mode?: unknown; inTangent?: unknown; outTangent?: unknown } | null;
	const vec = (v: unknown) => Array.isArray(v) && v.length === 2 && v.every((x) => Number.isFinite(x));
	return (
		!s ||
		!SPATIAL_INTERPOLATIONS.includes(s.mode as never) ||
		!vec(s.inTangent) ||
		!vec(s.outTangent) ||
		!vec(k.value)
	);
}
function isAnimLike(v: unknown): v is AnimLike {
	return !!v && typeof v === 'object' && Array.isArray((v as AnimLike).keyframes) && 'value' in (v as object);
}

/** Visits every Animatable (with a path) inside an entity. */
function forEachAnimatable(root: unknown, path: string[], cb: (a: AnimLike, path: string[]) => void): void {
	// previews (perf budgets): one shared path stack instead of a new array per visited node; the callback gets its
	// own copy (issues keep it).
	const stack = [...path];
	const walk = (v: unknown): void => {
		if (isAnimLike(v)) {
			cb(v, stack.slice());
			return;
		}
		if (Array.isArray(v)) {
			for (let i = 0; i < v.length; i++) {
				stack.push(String(i));
				walk(v[i]);
				stack.pop();
			}
		} else if (v && typeof v === 'object') {
			for (const k in v as Record<string, unknown>) {
				if (!Object.hasOwn(v as object, k)) continue;
				stack.push(k);
				walk((v as Record<string, unknown>)[k]);
				stack.pop();
			}
		}
	};
	walk(root);
}

function valueShape(v: unknown): string {
	if (typeof v === 'number') return 'number';
	if (Array.isArray(v)) return `array${v.length}`;
	return typeof v;
}

export type InvariantOptions = {
	effects?: EffectRegistry;
	/** Checks renderer stamps against known templates when given. */
	mgTemplates?: MgTemplateRegistry;
};

// Known templates must match their registry renderer (absent = fframes); preserve unknown templates' stamps.
function templateStampIssue(
	c: { template: { id: string; version: number; renderer?: string } },
	reg: MgTemplateRegistry | undefined,
): string | null {
	const info = reg?.get(c.template.id, c.template.version);
	if (!info) return null;
	const want = info.renderer ?? 'fframes';
	const have = c.template.renderer ?? 'fframes';
	return want === have
		? null
		: `renderer "${have}" contradicts template ${c.template.id}@${c.template.version} ("${want}")`;
}

/**
 * The id-keyed tables of a loaded document as null-prototype objects (golden-fuzz): a reference such as
 * `mediaId: "__proto__"` or `"constructor"` must look up as missing (and be repaired), not as `Object.prototype`.
 * JSON, Immer and every reader treat them as plain records.
 */
export function nullPrototypeRecords(doc: ProjectDocument): ProjectDocument {
	const np = <T extends object>(rec: T): T => Object.assign(Object.create(null) as T, rec);
	const d = doc as unknown as Record<string, Record<string, unknown>>;
	for (const k of ['items', 'media', 'synthetics', 'transcripts', 'fonts', 'sequences'])
		if (d[k] && typeof d[k] === 'object') d[k] = np(d[k]);
	for (const seq of Object.values(doc.sequences) as unknown as Record<string, Record<string, unknown>>[])
		for (const k of ['clips', 'links', 'groups', 'transitions'])
			if (seq[k] && typeof seq[k] === 'object') seq[k] = np(seq[k]);
	return doc;
}

/**
 * Structural repairs found by fuzzing the load pipeline (golden-fuzz): sequence records whose key disagrees with the
 * entity id, tracks listed under the wrong kind, impossible sequence settings and text clips naming a missing font.
 */
function repairStructure(
	doc: ProjectDocument,
	ids: IdSource,
	note: (a: string, e: string, d: string) => void,
): void {
	const prefixOf = { links: 'lnk', groups: 'grp', transitions: 'trn' } as const;
	for (const m of Object.values(doc.media))
		if (m.derivation && !doc.media[m.derivation.fromMediaId]) {
			m.derivation = null;
			note('drop-derivation', m.id, 'the source of this derived media is missing');
		}
	for (const seq of Object.values(doc.sequences) as Sequence[]) {
		for (const kind of ['links', 'groups', 'transitions'] as const) {
			const rec = seq[kind] as Record<string, { id: string }>;
			for (const key of Object.keys(rec)) {
				const v = rec[key]!;
				if (v.id === key) continue;
				const ok = (x: string) => isValidId(x) && idPrefixOf(x) === prefixOf[kind];
				const next = ok(key) ? key : ok(v.id) && !(v.id in rec) ? v.id : ids.next(prefixOf[kind]);
				delete rec[key];
				v.id = next;
				rec[next] = v;
				if (kind !== 'transitions')
					for (const m of (v as unknown as { members: string[] }).members ?? []) {
						const c = seq.clips[m] as Record<string, unknown> | undefined;
						if (c) c[kind === 'links' ? 'linkId' : 'groupId'] = next;
					}
				note('fix-id', next, `${kind} record key ${JSON.stringify(key)} and id made equal`);
			}
		}
		for (const [list, kind] of [
			[seq.videoTracks, 'video'],
			[seq.audioTracks, 'audio'],
			[seq.captionTracks, 'caption'],
		] as const)
			for (const t of list)
				if (t.kind !== kind) {
					note('fix-track-kind', t.id, `track kind ${t.kind} set to its list's kind ${kind}`);
					(t as { kind: string }).kind = kind;
				}
		const st = seq.settings;
		if (!isAllowedSequenceRate(st.frameRate)) {
			st.frameRate = { num: 30, den: 1 };
			note('fix-settings', seq.id, 'frame rate not allowed: set to 30 fps');
		}
		for (const k of ['width', 'height'] as const) {
			const v = st[k];
			if (!Number.isInteger(v) || v % 2 !== 0 || v < 16 || v > 8192) {
				const fixed = Number.isFinite(v)
					? Math.min(8192, Math.max(16, Math.round(v / 2) * 2))
					: k === 'width'
						? 1920
						: 1080;
				st[k] = fixed;
				note('fix-settings', seq.id, `${k} ${v} set to ${fixed}`);
			}
		}
		if (st.dropFrame && !supportsDropFrame(st.frameRate)) {
			st.dropFrame = false;
			note('fix-settings', seq.id, 'drop-frame cleared (only 29.97/59.94)');
		}
		for (const c of Object.values(seq.clips)) {
			repairShapeValues(c, note);
			const op = (c as { opacity?: AnimLike }).opacity;
			if (op && typeof op === 'object' && Array.isArray(op.keyframes)) {
				const fix = (v: unknown) =>
					typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 100;
				const bad = [op.value, ...op.keyframes.map((k) => k.value)].some((v) => fix(v) !== v);
				if (bad) {
					op.value = fix(op.value);
					for (const k of op.keyframes) k.value = fix(k.value);
					note('fix-opacity', c.id, 'opacity values clamped to 0..100');
				}
			}
		}
		repairMediaBounds(doc, seq, note);
		for (const c of Object.values(seq.clips)) {
			const style = (c as { content?: { style?: { fontId?: string } } }).content?.style;
			if (c.kind !== 'text' || !style?.fontId || doc.fonts[style.fontId]) continue;
			let font = Object.values(doc.fonts).find((f) => f.family === DEFAULT_FONT_FAMILY);
			if (!font) {
				font = createFontRef(ids);
				doc.fonts[font.id] = font;
			}
			note('reset-font', c.id, `missing font ${style.fontId} replaced by ${font.family}`);
			style.fontId = font.id;
		}
	}
}

/** Shape geometry and paint values made valid (non-finite / negative → 0, colours clamped to 0..1). */
function repairShapeValues(c: Clip, note: (a: string, e: string, d: string) => void): void {
	const sh = (c as unknown as { shape?: Record<string, unknown> }).shape;
	if (!sh || sh.type === 'vector') return;
	let changed = false;
	const fixNum = (v: unknown, max = Number.POSITIVE_INFINITY) => {
		const n = typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(0, v)) : 0;
		if (n !== v) changed = true;
		return n;
	};
	const each = (a: unknown, fix: (v: unknown) => unknown) => {
		if (!a || typeof a !== 'object' || !Array.isArray((a as AnimLike).keyframes)) return;
		const x = a as AnimLike;
		x.value = fix(x.value);
		for (const k of x.keyframes) k.value = fix(k.value);
	};
	const vec = (n: number, max?: number) => (v: unknown) => {
		if (!Array.isArray(v) || v.length !== n) {
			changed = true;
			return Array.from({ length: n }, (_, i) => (n === 4 && i === 3 ? 1 : 0));
		}
		return v.map((x) => fixNum(x, max));
	};
	each(sh.size, vec(2));
	each(sh.cornerRadius, (v) => fixNum(v));
	const stroke = sh.stroke as { width?: unknown; color?: unknown } | null | undefined;
	if (stroke) {
		each(stroke.width, (v) => fixNum(v));
		each(stroke.color, vec(4, 1));
	}
	if (sh.fill) each(sh.fill, vec(4, 1));
	if (changed) note('fix-shape', c.id, 'invalid shape size, radius, width or colour values made valid');
}

/** Clips longer than their media are shortened (or start at the media's head) so they fit (INV-005). */
function repairMediaBounds(
	doc: ProjectDocument,
	seq: Sequence,
	note: (a: string, e: string, d: string) => void,
): void {
	const rate = seq.settings.frameRate as Rational;
	const fpf = flicksPerFrame(rate);
	for (const c of Object.values(seq.clips)) {
		const id = (c as { mediaId?: unknown }).mediaId;
		const asset = typeof id === 'string' ? doc.media[id] : undefined;
		if (!asset || !isBoundedContent(c) || isRemapped(c)) continue;
		const mediaDur = mediaDurationFlicks(asset);
		if (mediaDur === null) continue;
		if (c.frameHold) {
			if (c.frameHold.flicks >= mediaDur + fpf + 1) {
				c.frameHold.flicks = Math.max(0, mediaDur - fpf);
				note('fix-media-bounds', c.id, 'held frame moved into the media');
			}
			continue;
		}
		const tol = fpf * c.speed.rate + 1;
		if (c.sourceIn + contentSpanFlicks(c.duration, rate, c.speed.rate) <= mediaDur + tol) continue;
		if (c.sourceIn >= mediaDur) c.sourceIn = 0;
		let frames = Math.max(1, Math.floor((mediaDur - c.sourceIn) / (fpf * c.speed.rate)));
		while (frames > 1 && c.sourceIn + contentSpanFlicks(frames, rate, c.speed.rate) > mediaDur + tol)
			frames--;
		note('fix-media-bounds', c.id, `clip shortened from ${c.duration} to ${frames} frames to fit its media`);
		c.duration = frames;
	}
}

/** Premiere port (v8): what is wrong with a transition's `cutPosition` (a number in (0, 1) between two clips). */
function cutPositionIssue(t: Transition): string | null {
	const cp = (t as { cutPosition?: unknown }).cutPosition;
	if (cp === undefined) return null;
	if (typeof cp !== 'number' || !Number.isFinite(cp) || cp <= 0 || cp >= 1)
		return 'has a cut position that is not a number between 0 and 1';
	return !t.outgoingClipId || !t.incomingClipId ? 'is a fade with a cut position' : null;
}

/** Premiere port (v8): whether a Custom Fade param is unreadable (unknown option, out of range, keyframed). */
function customFadeParamBad(t: Transition, p: ParamSpec): boolean {
	const a = t.params[p.name] as { value?: unknown; keyframes?: unknown[] } | undefined;
	if (a === undefined) return false;
	const v = a.value;
	if ((a.keyframes?.length ?? 0) > 0) return true;
	if (p.type === 'enum') return typeof v !== 'string' || !(p.options ?? []).includes(v);
	return (
		typeof v !== 'number' ||
		!Number.isFinite(v) ||
		v < (p.range?.min ?? Number.NEGATIVE_INFINITY) ||
		v > (p.range?.max ?? Number.POSITIVE_INFINITY)
	);
}

/** INV-010 (Premiere port fields): the cut position and the Custom Fade params of a transition. */
function transitionFieldIssues(t: Transition): string[] {
	const out: string[] = [];
	const cp = cutPositionIssue(t);
	if (cp) out.push(cp);
	if (t.effectId === CUSTOM_FADE)
		for (const p of transitionSpec(CUSTOM_FADE)?.params ?? [])
			if (customFadeParamBad(t, p)) out.push(`has an unreadable ${p.label} (${p.name})`);
	return out;
}

/** Transitions that no longer satisfy INV-010 after the other repairs are removed. */
function repairTransitionsFinal(seq: Sequence, note: (a: string, e: string, d: string) => void): void {
	const edges = new Set<string>();
	for (const key of Object.keys(seq.transitions)) {
		const t = seq.transitions[key]!;
		// Premiere port (v8 fields): a bad cut position is dropped (the alignment stays), an unreadable Custom Fade
		// param goes back to its default.
		if (cutPositionIssue(t)) {
			delete (t as { cutPosition?: unknown }).cutPosition;
			note('drop-cut-position', t.id, 'unreadable or misplaced cut position removed (the alignment stays)');
		}
		if (t.effectId === CUSTOM_FADE)
			for (const p of transitionSpec(CUSTOM_FADE)?.params ?? [])
				if (customFadeParamBad(t, p)) {
					delete t.params[p.name];
					note('reset-transition-param', t.id, `unreadable ${p.label} reset to its default`);
				}
		const out = t.outgoingClipId ? seq.clips[t.outgoingClipId] : null;
		const inc = t.incomingClipId ? seq.clips[t.incomingClipId] : null;
		const keys = [out ? `${out.id}:out` : null, inc ? `${inc.id}:in` : null].filter((k): k is string => !!k);
		const bad =
			(!t.outgoingClipId && !t.incomingClipId) ||
			(t.outgoingClipId && !out) ||
			(t.incomingClipId && !inc) ||
			(out && inc && (out.trackId !== inc.trackId || clipEnd(out) !== inc.start)) ||
			[out, inc].some((c) => c && (c.trackId !== t.trackId || t.duration > c.duration)) ||
			keys.some((k) => edges.has(k));
		if (bad) {
			delete seq.transitions[key];
			note('drop-transition', t.id, 'transition no longer fits its clips');
		} else for (const k of keys) edges.add(k);
	}
}

/** Structured form of the INV-001 id issues (for `repairIds`), keyed by the issue object. */
type IdIssue =
	| { kind: 'malformed'; id: string; prefix: IdPrefix; where: string[] }
	| { kind: 'duplicate'; id: string }
	| { kind: 'key'; key: string; id: string; path: string[] };
const ID_ISSUES = new WeakMap<Issue, IdIssue>();

/** Id prefix of the records of a table, by the table's name in a record path. */
const TABLE_PREFIX: Record<string, IdPrefix> = {
	media: 'med',
	synthetics: 'syn',
	transcripts: 'trs',
	fonts: 'fnt',
	sequences: 'seq',
	clips: 'clp',
};

/** Arrays whose strings are entity ids. */
const ID_ARRAYS = new Set(['members', 'rootItems', 'children']);

/**
 * Replaces the id `from` by `to` where ids live (deep, in place): `id` fields, reference fields (`…Id`), id lists
 * (`…Ids`, `members`, `rootItems`, bin `children`) and the keys of the id-keyed tables. Other strings — a text, a
 * kind named like the id — are never touched.
 */
function replaceIdDeep(doc: ProjectDocument, from: string, to: string): void {
	const rekey = (rec: Record<string, unknown> | undefined) => {
		if (rec && Object.hasOwn(rec, from)) {
			rec[to] = rec[from];
			delete rec[from];
		}
	};
	const d = doc as unknown as Record<string, Record<string, unknown>>;
	for (const k of ['items', 'media', 'synthetics', 'transcripts', 'fonts', 'sequences']) rekey(d[k]);
	for (const seq of Object.values(doc.sequences) as unknown as Record<string, Record<string, unknown>>[])
		for (const k of ['clips', 'links', 'groups', 'transitions']) rekey(seq[k]);
	const walk = (v: unknown, key: string): void => {
		if (Array.isArray(v)) {
			const ids = ID_ARRAYS.has(key) || key.endsWith('Ids');
			for (let i = 0; i < v.length; i++) {
				if (ids && v[i] === from) v[i] = to;
				else if (v[i] && typeof v[i] === 'object') walk(v[i], '');
			}
		} else if (v && typeof v === 'object') {
			const o = v as Record<string, unknown>;
			for (const k of Object.keys(o)) {
				const x = o[k];
				if (x === from && (k === 'id' || k.endsWith('Id'))) o[k] = to;
				else if (x && typeof x === 'object') walk(x, k);
			}
		}
	};
	walk(doc, '');
}

/**
 * INV-001 repair (golden-fuzz): record keys that disagree with their entity's id, malformed ids and duplicate ids.
 * A record takes its key when the key is a valid id (references to the entity's own id then dangle and are dropped
 * by the reference repairs that follow), else the entity's id, else a new id. A malformed id is replaced by a new id
 * everywhere it occurs (references included). Every occurrence of a duplicated id after the first gets a new id.
 */
function repairIds(
	doc: ProjectDocument,
	ids: IdSource,
	note: (a: string, e: string, d: string) => void,
): void {
	for (let pass = 0; pass < 4; pass++) {
		const problems = checkInvariants(doc)
			.map((i) => ID_ISSUES.get(i))
			.filter((x): x is IdIssue => !!x);
		if (!problems.length) return;
		const keys = problems.filter((p) => p.kind === 'key');
		for (const p of keys) {
			const rec = p.path.slice(0, -1).reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], doc) as
				| Record<string, { id: string }>
				| undefined;
			const v = rec?.[p.key];
			if (!rec || !v) continue;
			const table = p.path[p.path.length - 2]!;
			const prefix =
				table === 'items' ? ((v as { kind?: string }).kind === 'bin' ? 'bin' : 'itm') : TABLE_PREFIX[table];
			const ok = (x: unknown) =>
				typeof x === 'string' && isValidId(x) && (!prefix || idPrefixOf(x) === prefix);
			if (ok(p.key)) {
				v.id = p.key;
				note('fix-id', p.key, `record id ${JSON.stringify(p.id)} set to its key`);
			} else {
				const next = ok(p.id) && !(p.id in rec) ? p.id : ids.next(prefix ?? 'itm');
				delete rec[p.key];
				v.id = next;
				rec[next] = v;
				note('fix-id', next, `record re-keyed from ${JSON.stringify(p.key)}`);
			}
		}
		if (keys.length) continue;
		const done = new Set<string>();
		for (const p of problems) {
			if (done.has(p.id)) continue;
			done.add(p.id);
			if (p.kind === 'malformed' && p.where.length === 1 && p.where[0] === 'projectId') {
				// Nothing references the project id: replace it in place only. Replaced everywhere, a project id that
				// equals another entity's (valid) id renamed that entity too and the passes ping-ponged (FUZZ=1, verify).
				const next = ids.next('prj');
				doc.projectId = next;
				note('fix-id', next, `malformed project id ${JSON.stringify(p.id)} replaced`);
			} else if (p.kind === 'malformed') {
				const next = ids.next(p.prefix);
				replaceIdDeep(doc, p.id, next);
				note('fix-id', next, `malformed id ${JSON.stringify(p.id)} replaced`);
			} else if (p.kind === 'duplicate') {
				const prefix = idPrefixOf(p.id);
				if (!prefix) continue;
				let first = true;
				const walk = (v: unknown, parent: Record<string, unknown> | null, key: string | null): void => {
					if (Array.isArray(v)) {
						for (const x of v) if (x && typeof x === 'object') walk(x, null, null);
						return;
					}
					if (!v || typeof v !== 'object') return;
					const o = v as Record<string, unknown>;
					if (o.id === p.id) {
						if (first) first = false;
						else {
							const next = ids.next(prefix);
							o.id = next;
							if (parent && key === p.id) {
								delete parent[key];
								parent[next] = o;
							}
							note('fix-id', next, `duplicate id ${p.id} renamed`);
						}
					}
					for (const k of Object.keys(o)) if (o[k] && typeof o[k] === 'object') walk(o[k], o, k);
				};
				walk(doc, null, null);
			}
		}
	}
}

/** What a sequence's findings depend on besides the sequence object itself (compared by identity). */
type SequenceDeps = {
	media: unknown;
	synthetics: unknown;
	transcripts: unknown;
	fonts: unknown;
	items: unknown;
	effects: unknown;
	mgTemplates: unknown;
};
type SequenceMemo = {
	deps: SequenceDeps;
	ids: string[];
	issues: Issue[];
	media: string[];
	synthetics: string[];
	transcripts: string[];
};
const sequenceMemo = new WeakMap<object, SequenceMemo>();
const NO_MEMO = Symbol('checkInvariants.noMemo');

const sameDeps = (a: SequenceDeps, b: SequenceDeps) =>
	a.media === b.media &&
	a.synthetics === b.synthetics &&
	a.transcripts === b.transcripts &&
	a.fonts === b.fonts &&
	a.items === b.items &&
	a.effects === b.effects &&
	a.mgTemplates === b.mgTemplates;

/** A Set that can log what is added (the references one sequence contributes). */
class LoggedSet extends Set<string> {
	log: string[] | null = null;
	override add(v: string): this {
		this.log?.push(v);
		return super.add(v);
	}
}
/** A Map that remembers whether anything was set since `touched` was reset. */
class TouchedMap<K, V> extends Map<K, V> {
	touched = false;
	override set(k: K, v: V): this {
		this.touched = true;
		return super.set(k, v);
	}
}

/** Records an id (INV-001): well-formed with one of the prefixes and claimed once in the document. */
export type Claim = (id: string, prefix: IdPrefix | IdPrefix[], where: string[]) => void;
/** Reports a record key that does not match its entity's id (INV-001). */
export type KeyIssue = (key: string, id: string, path: string[], message: string) => void;

/** What the clip checks collect for the document-wide invariants (INV-009 nesting, INV-014 leaks, caption owners). */
export type ClipFacts = {
	usedMedia: Set<string>;
	usedSyn: Set<string>;
	usedTrs: Set<string>;
	captionTrsUsers: Map<string, number>;
	nestEdges: Map<string, Set<string>>;
};

export const newClipFacts = (): ClipFacts => ({
	usedMedia: new Set(),
	usedSyn: new Set(),
	usedTrs: new Set(),
	captionTrsUsers: new Map(),
	nestEdges: new Map(),
});

/** One sequence's context for the clip checks; `byTrack` collects the clips per existing track (INV-003). */
export type SeqScope = {
	seq: Sequence;
	where: string[];
	tracks: Map<string, Track>;
	rate: Rational;
	byTrack: Map<string, Clip[]>;
};

/**
 * The per-entity checks of checkInvariants (perf-core): the full check runs them over the whole document and the
 * incremental one (invariants-incremental.ts) over what a transaction changed, so both run the same code for
 * every clip, link, clip group and transition.
 */
export function invariantCheckers(
	doc: ProjectDocument,
	opts: InvariantOptions,
	issues: Issue[],
	claim: Claim,
	keyIssue: KeyIssue = (_key, _id, path, message) => issues.push(inv('INV-001', message, path)),
) {
	// wp masks: ids, value ranges and path structure of Opacity / effect masks.
	const masks = (list: readonly Mask[] | undefined, where: string[]) => {
		for (const m of list ?? []) {
			const mw = [...where, m.id];
			claim(m.id, 'msk', mw);
			const problem = maskProblem(m);
			if (problem) issues.push(inv('INV-012', `Mask ${m.id}: ${problem}`, mw));
		}
	};

	const effects = (list: readonly EffectInstance[] | undefined, where: string[], onClip = false) => {
		for (const fx of list ?? []) {
			claim(fx.id, 'fx', [...where, fx.id]);
			// sim-warp: Puppet meshes and pins (clip Puppet effects only).
			if (fx.puppet) {
				const problem = !onClip ? 'puppet data on a track or master effect' : puppetProblem(fx.puppet);
				if (problem) issues.push(inv('INV-016', `Effect ${fx.id}: ${problem}`, [...where, fx.id, 'puppet']));
				else for (const m of fx.puppet.meshes) claim(m.id, 'pms', [...where, fx.id, 'puppet', m.id]);
				if (!problem)
					for (const pin of fx.puppet.pins) claim(pin.id, 'ppn', [...where, fx.id, 'puppet', pin.id]);
			}
			// spec 19 TL-010: a look is a clip effect with a valid appearance, and only a look has one.
			if (fx.appearance !== undefined || fx.effectId === TITLE_LOOK_EFFECT_ID) {
				const look =
					fx.effectId !== TITLE_LOOK_EFFECT_ID
						? 'appearance data on another effect'
						: !onClip
							? 'a look on a track or master effect'
							: appearanceProblem(fx.appearance);
				if (look)
					issues.push(inv('INV-APPEARANCE', `Effect ${fx.id}: ${look}`, [...where, fx.id, 'appearance']));
				// TL-021: a layer's media (pattern tile, reflection image) must exist, like an effect param's (INV-006).
				else
					for (const ref of effectMediaRefs([fx]))
						if (ref.param.startsWith('appearance.') && !doc.media[ref.mediaId])
							issues.push(
								inv('INV-006', `Effect ${fx.id}: ${ref.param} references missing media ${ref.mediaId}`, [
									...where,
									fx.id,
									'appearance',
								]),
							);
			}
			if (fx.masks?.length) {
				if (!onClip)
					issues.push(inv('INV-012', `Effect ${fx.id}: masks apply to clip effects only`, [...where, fx.id]));
				masks(fx.masks, [...where, fx.id, 'masks']);
			}
			const spec = opts.effects?.get(fx.effectId, fx.effectVersion);
			if (!spec) continue; // unknown effects are preserved and exempt (S01:FX-022)
			for (const [name, a] of Object.entries(fx.params)) {
				const p = spec.params.find((x) => x.name === name);
				if (!p) {
					issues.push(
						inv('INV-012', `Effect ${fx.effectId} has no parameter ${name}`, [...where, fx.id, name]),
					);
					continue;
				}
				for (const v of [a.value, ...a.keyframes.map((k) => k.value)]) {
					if (p.type === 'number' && typeof v === 'number') {
						if (
							(p.range?.min !== undefined && v < p.range.min) ||
							(p.range?.max !== undefined && v > p.range.max)
						) {
							issues.push(
								inv('INV-012', `${fx.effectId}.${name} out of range: ${v}`, [...where, fx.id, name]),
							);
						}
					}
					if (p.type === 'media') {
						// M2 (S06:CG-004): `{mediaId: ''}` is "None" (ParamValue has no null).
						const m = (v as { mediaId?: string }).mediaId;
						if (typeof m !== 'string' || (m !== '' && !doc.media[m]))
							issues.push(
								inv('INV-006', `${fx.effectId}.${name} references missing media ${m}`, [...where, fx.id]),
							);
					}
				}
			}
			if (fx.effectId === 'jasper.crop') {
				const val = (n: string) => (fx.params[n]?.value as number) ?? 0;
				if (val('left') + val('right') >= 100 || val('top') + val('bottom') >= 100) {
					issues.push(inv('INV-012', 'Crop leaves no visible pixels', [...where, fx.id]));
				}
			}
		}
	};

	const anims = (entity: unknown, where: string[]) => {
		forEachAnimatable(entity, where, (a, path) => {
			let last = Number.NEGATIVE_INFINITY;
			const shape = valueShape(a.value);
			for (const k of a.keyframes) {
				claim(k.id, 'kf', [...path, k.id]);
				if (!(k.time > last))
					issues.push(inv('INV-011', 'Keyframes must have strictly increasing times', path));
				last = k.time;
				if (valueShape(k.value) !== shape)
					issues.push(inv('INV-011', 'Keyframe value type does not match the parameter', path));
				if (badSpatial(k))
					issues.push(inv('INV-011', 'Spatial interpolation needs a vec2 key and finite tangents', path));
				// keyframe-sides: a readable incoming temporal type.
				const sides = keySidesIssue(k as { interpolation?: unknown; inInterpolation?: unknown });
				if (sides) issues.push(inv('INV-011', `Keyframe ${k.id}: ${sides}`, [...path, k.id]));
			}
			// keyframes-blend: Rove Across Time is never on the first / last key or a hold key.
			const kfs = a.keyframes as unknown as Keyframe<unknown>[];
			kfs.forEach((k, i) => {
				if (k.roving && !isRovingKey(kfs, i))
					issues.push(
						inv('INV-011', 'Only keys between two others that interpolate can rove', [...path, k.id]),
					);
			});
		});
	};

	/** Every per-clip invariant of clip `c`, stored under `key` in `s.seq.clips`. */
	const clip = (s: SeqScope, f: ClipFacts, key: string, c: Clip): void => {
		const { seq, where, tracks, rate, byTrack } = s;
		const { usedMedia, usedSyn, usedTrs, captionTrsUsers, nestEdges } = f;
		const cw = [...where, 'clips', key];
		if (c.id !== key) keyIssue(key, c.id, cw, `Key ${key} does not match clip id ${c.id}`);
		claim(c.id, 'clp', cw);
		const t = tracks.get(c.trackId);
		if (!t) issues.push(inv('INV-002', `Clip ${c.id} is on missing track ${c.trackId}`, cw));
		else {
			const need = trackKindFor(c.kind);
			if (need && need !== t.kind)
				issues.push(inv('INV-002', `A ${c.kind} clip cannot be on ${t.kind} track ${t.id}`, cw));
			const list = byTrack.get(t.id) ?? [];
			list.push(c);
			byTrack.set(t.id, list);
		}
		// INV-004
		if (!Number.isInteger(c.start) || c.start < 0 || !Number.isInteger(c.duration) || c.duration < 1) {
			issues.push(inv('INV-004', `Clip ${c.id} has invalid start/duration`, cw));
		}
		if (!Number.isInteger(c.sourceIn) || c.sourceIn < 0)
			issues.push(inv('INV-004', `Clip ${c.id} has invalid sourceIn`, cw));
		if (!(c.speed.rate >= 0.01 && c.speed.rate <= 100))
			issues.push(inv('INV-004', `Clip ${c.id} speed out of range`, cw));
		for (const k of (c as { timeRemap?: { keyframes: { id: string }[] } }).timeRemap?.keyframes ?? [])
			claim(k.id, 'kf', [...cw, 'timeRemap', k.id]);
		for (const x of remapIssues(c, rate, contentDurationFlicks(doc, c)))
			issues.push(inv(x.code, x.message, [...cw, 'timeRemap']));
		const r = c as Record<string, unknown>;
		// INV-006 references
		if (c.subclipId !== undefined && doc.items[c.subclipId]?.kind !== 'subclip')
			issues.push(inv('INV-006', `Clip ${c.id} references missing subclip ${c.subclipId}`, cw));
		// Template params, a light's environment and effect params use their media like the clip's source (INV-014).
		for (const id of clipParamMediaIds(c)) usedMedia.add(id);
		if (typeof r.mediaId === 'string') {
			usedMedia.add(r.mediaId);
			const asset = doc.media[r.mediaId];
			if (!asset) issues.push(inv('INV-006', `Clip ${c.id} references missing media ${r.mediaId}`, cw));
			else if (c.frameHold && isBoundedContent(c) && mediaDurationFlicks(asset) !== null) {
				// edit-structure: a held clip shows one frame; only that frame must exist.
				if (c.frameHold.flicks >= mediaDurationFlicks(asset)! + flicksPerFrame(rate) + 1)
					issues.push(inv('INV-005', `Clip ${c.id} holds a frame outside its media`, cw));
			} else if (isBoundedContent(c) && mediaDurationFlicks(asset) !== null && !isRemapped(c)) {
				// INV-005 media bounds with one frame of tolerance (imports: the interpreted duration).
				const mediaDur = mediaDurationFlicks(asset)!;
				const span = contentSpanFlicks(c.duration, rate, c.speed.rate);
				const tol = flicksPerFrame(rate) * c.speed.rate + 1;
				if (c.sourceIn + span > mediaDur + tol) {
					issues.push(
						inv('INV-005', `Clip ${c.id} exceeds its media (${c.sourceIn + span} > ${mediaDur})`, cw),
					);
				}
			}
		}
		// S08: a composition clip references its mg-bundle asset and stays inside the composition's length
		// (a composition that disappeared from its bundle is not a violation: it renders a card, MGC-014).
		const comp = r.composition as { mediaId?: unknown } | undefined;
		if (c.kind === 'composition' && typeof comp?.mediaId === 'string') {
			usedMedia.add(comp.mediaId);
			const asset = doc.media[comp.mediaId];
			if (!asset) issues.push(inv('INV-006', `Clip ${c.id} references missing bundle ${comp.mediaId}`, cw));
			else if (asset.kind !== 'mg-bundle')
				issues.push(inv('INV-006', `Clip ${c.id} references ${comp.mediaId}, which is not an mg-bundle`, cw));
			else {
				const dur = contentDurationFlicks(doc, c);
				const span = contentSpanFlicks(c.duration, rate, c.speed.rate);
				if (dur !== null && c.sourceIn + span > dur + flicksPerFrame(rate) + 1)
					issues.push(
						inv('INV-005', `Clip ${c.id} exceeds its composition (${c.sourceIn + span} > ${dur})`, cw),
					);
			}
		}
		if (typeof r.syntheticId === 'string') {
			usedSyn.add(r.syntheticId);
			const syn = doc.synthetics[r.syntheticId];
			if (!syn) issues.push(inv('INV-006', `Clip ${c.id} references missing synthetic`, cw));
			else if (!syntheticFitsClip(c.kind, syn.kind))
				issues.push(inv('INV-006', `A ${c.kind} clip cannot show a ${syn.kind} source`, cw));
		}
		// edit-structure: frame holds are for clips with a picture (not adjustment layers, captions or sound).
		if (c.frameHold !== undefined) {
			const caps = kindCapabilities(c.kind);
			if (caps?.trackKind !== 'video' || c.kind === 'adjustment')
				issues.push(inv('INV-012', `Clip ${c.id} cannot have a frame hold`, cw));
			else if (!Number.isInteger(c.frameHold.flicks) || c.frameHold.flicks < 0)
				issues.push(inv('INV-012', `Clip ${c.id} has an invalid frame hold time`, cw));
		}
		if (typeof r.transcriptId === 'string') {
			usedTrs.add(r.transcriptId);
			const tr = doc.transcripts[r.transcriptId];
			if (!tr) issues.push(inv('INV-006', `Clip ${c.id} references missing transcript`, cw));
			else if (tr.mediaId === null) {
				// wp captions: a caption transcript belongs to one clip
				const n = (captionTrsUsers.get(tr.id) ?? 0) + 1;
				captionTrsUsers.set(tr.id, n);
				if (n === 2)
					issues.push(inv('INV-014', `Caption transcript ${tr.id} is shared by several clips`, cw));
			}
		}
		if (c.kind === 'captions') {
			const fid = (r.style as { fontId?: string } | undefined)?.fontId;
			if (fid && !doc.fonts[fid])
				issues.push(inv('INV-006', `Caption ${c.id} references missing font ${fid}`, cw));
		}
		// wp-multicam: a multi-camera selection names an angle of a multi-camera source.
		if (r.multicam !== undefined) {
			const sel = r.multicam as { enabled?: unknown; angle?: unknown };
			const mc = typeof r.sequenceId === 'string' ? multicamSourceOf(doc.sequences[r.sequenceId]) : null;
			if (c.kind !== 'nest-video' && c.kind !== 'nest-audio')
				issues.push(inv('INV-012', `Clip ${c.id}: only nest clips can be multi-camera clips`, cw));
			else if (!mc)
				issues.push(
					inv(
						'INV-006',
						`Clip ${c.id} is a multi-camera clip of a sequence that is not a multi-camera source`,
						cw,
					),
				);
			else {
				const a = typeof sel.angle === 'string' ? angleById(mc, sel.angle) : null;
				if (!a) issues.push(inv('INV-006', `Clip ${c.id} shows a missing angle ${String(sel.angle)}`, cw));
				else if (c.kind === 'nest-video' && a.videoTrackId === null)
					issues.push(inv('INV-012', `Clip ${c.id} shows angle ${a.id}, which has no video`, cw));
			}
		}
		if (typeof r.sequenceId === 'string' && isKnownClipKind(c.kind)) {
			if (!doc.sequences[r.sequenceId])
				issues.push(inv('INV-006', `Clip ${c.id} references missing sequence`, cw));
			// INV-005 for nests (KND-011): the nested sequence's duration bounds the edits that set the nest clip's
			// range (trim and slip handles, contentWindow in commands/ripple.ts), not the document. Its length follows
			// its content, so shortening the content (lifting or trimming its last clip, deleting media used inside
			// it) leaves the nest clips that show it overhanging — as in Premiere, where the nested clip keeps its
			// length and shows nothing past the content. Refusing that made every such edit fail with E_INVARIANT
			// once the nest was placed (security review DATA-2). (A negative content start is INV-004 above.)
			const set = nestEdges.get(seq.id) ?? new Set<string>();
			set.add(r.sequenceId);
			nestEdges.set(seq.id, set);
		}
		const content = r.content as { style?: { fontId?: string } } | undefined;
		if (c.kind === 'text' && content?.style?.fontId && !doc.fonts[content.style.fontId]) {
			issues.push(inv('INV-006', `Clip ${c.id} references missing font ${content.style.fontId}`, cw));
		}
		// spec 13 SH-004: stroke lists and shadow spreads of the clip's text styles.
		for (const st of clipTextStyles(c, cw))
			for (const m of textStyleIssues(st.style))
				issues.push(inv('INV-012', `Clip ${c.id} text style ${m}`, st.path));
		// spec 19 TL-111, TL-093: the writing fields are read leniently.
		for (const ct of clipTextContents(c))
			for (const m of textWritingIssues(ct)) issues.push(inv('INV-012', `Clip ${c.id}: ${m}`, cw));
		// spec 13 SH-002: link fields to a project text style (a link to a missing style is soft).
		const styleLink = clipTextStyleIssue(c);
		if (styleLink) issues.push(inv('INV-TEXTSTYLE', `Clip ${c.id}: ${styleLink}`, [...cw, 'styleId']));
		// spec 19 TL-010: at most one look, on a clip kind that takes one.
		const lookBad = clipLookProblem(c as never);
		if (lookBad) issues.push(inv('INV-APPEARANCE', `Clip ${c.id}: ${lookBad}`, [...cw, 'effects']));
		// spec 13 AS-003: a subtitle's words and group reference (only on text clips).
		const captionBad = clipCaptionProblem(c);
		if (captionBad) issues.push(inv('INV-SUBTITLE', `Clip ${c.id}: ${captionBad}`, [...cw, 'caption']));
		// M2 (S11:TXA-008): animator windows are whole frames ≥ 1; known presets have valid params (unknown
		// presets are preserved and skipped by the renderers).
		const ta = r.textAnimation as Record<string, { durationFrames?: unknown } | null | undefined> | undefined;
		if (c.kind === 'text' && ta) {
			for (const side of ['in', 'out'] as const) {
				const d = ta[side]?.durationFrames;
				if (ta[side] && (typeof d !== 'number' || !Number.isInteger(d) || d < 1))
					issues.push(
						inv('INV-012', `Clip ${c.id} ${side} animation duration must be a whole frame count ≥ 1`, cw),
					);
				if (invalidAnimatorParams(ta[side]))
					issues.push(inv('INV-012', `Clip ${c.id} ${side} animation params are invalid`, cw));
			}
		}
		// wp shapes: vector shape items are well-formed (every field, value and keyframe) with ids unique in the clip.
		if (c.kind === 'shape' && (r.shape as { type?: string }).type === 'vector') {
			const contents = (r.shape as { contents?: unknown }).contents;
			if (!Array.isArray(contents)) issues.push(inv('INV-012', `Shape ${c.id} has no contents`, cw));
			else {
				contents.forEach((it, i) => {
					const e = checkShapeItem(it as ShapeItem);
					if (e)
						issues.push(
							inv('INV-012', `Shape ${c.id} item ${i}: ${e.message}`, [
								...cw,
								'shape',
								'contents',
								String(i),
								...e.path,
							]),
						);
				});
				const dup = duplicateItemIds(contents as ShapeItem[]);
				if (dup.length)
					issues.push(inv('INV-001', `Shape ${c.id} has duplicate item ids ${dup.join(', ')}`, cw));
			}
		}
		// sound-design (spec 12 §2.2): sound-design metadata must be readable, on audio clips only (INV-SFX).
		if (r.sfx !== undefined) {
			const bad = clipSfxProblem(c as Clip & { sfx?: unknown });
			if (bad) issues.push(inv('INV-SFX', `Clip ${c.id}: ${bad}`, [...cw, 'sfx']));
		}
		// sound-design (spec 12 §4 P6-E12): bed metadata must be readable, on audio clips only (INV-SFX).
		if (r.bed !== undefined) {
			const bad = clipBedProblem(c as Clip & { bed?: unknown });
			if (bad) issues.push(inv('INV-SFX', `Clip ${c.id}: ${bad}`, [...cw, 'bed']));
		}
		// spec 14 TC-024: edge micro-fades must be readable, on audio clips only (INV-CLEANUP).
		if (r.edgeFades !== undefined) {
			const bad =
				c.kind === 'audio' ? edgeFadesProblem(r.edgeFades) : `a ${c.kind} clip cannot carry edge fades`;
			if (bad) issues.push(inv('INV-CLEANUP', `Clip ${c.id}: ${bad}`, [...cw, 'edgeFades']));
		}
		// three-d: only visual clips with Motion are 3D layers; environment lights reference existing media.
		if (r.threeD !== undefined && !canBe3d(c.kind))
			issues.push(inv('INV-012', `Clip ${c.id}: a ${c.kind} clip cannot be a 3D layer`, [...cw, 'threeD']));
		if (r.threeD !== undefined) {
			const bad = threeDProblem(r.threeD);
			if (bad) issues.push(inv('INV-012', `Clip ${c.id}: 3D layer ${bad}`, [...cw, 'threeD']));
		}
		if (c.kind === 'light') {
			const env = (r.light as { environmentMediaId?: string | null } | undefined)?.environmentMediaId;
			if (env && !doc.media[env])
				issues.push(inv('INV-006', `Light ${c.id} references missing environment media ${env}`, cw));
		}
		// three-d: a model layer shows a model media and is always 3D.
		if (c.kind === 'model') {
			const m = doc.media[(r as { mediaId: string }).mediaId];
			if (m && m.kind !== 'model')
				issues.push(inv('INV-012', `Clip ${c.id}: a model layer needs a 3D model media, not ${m.kind}`, cw));
			if ((r.threeD as { enabled?: boolean } | undefined)?.enabled !== true)
				issues.push(inv('INV-012', `Clip ${c.id}: a 3D model layer must be a 3D layer`, [...cw, 'threeD']));
		}
		// three-d: the 3D Camera Tracker sits on video clips, analyses existing media, its solve is whole.
		if (r.cameraTracker !== undefined) {
			const t = r.cameraTracker as ClipCameraTracker;
			if (c.kind !== 'video')
				issues.push(inv('INV-012', `Clip ${c.id}: a ${c.kind} clip cannot carry a 3D Camera Tracker`, cw));
			else if (!doc.media[t.mediaId])
				issues.push(
					inv('INV-006', `Clip ${c.id}: 3D Camera Tracker references missing media ${t.mediaId}`, cw),
				);
			const bad = cameraTrackerProblem(t);
			if (bad)
				issues.push(inv('INV-012', `Clip ${c.id}: 3D Camera Tracker ${bad}`, [...cw, 'cameraTracker']));
		}
		// animators, selectors, Path / More Options, Source Text keys.
		if (c.kind === 'text')
			for (const i of textAnimatorIssues(r, cw, claim))
				issues.push(inv('INV-012', `Clip ${c.id}: ${i.message}`, i.path));
		// M2 (S11:SHP-001): shape geometry is non-negative.
		else if (c.kind === 'shape') {
			const sh = r.shape as {
				size?: AnimLike;
				cornerRadius?: AnimLike;
				fill?: AnimLike | null;
				stroke?: { width?: AnimLike; color?: AnimLike } | null;
			};
			const values = (a: AnimLike | undefined) => (a ? [a.value, ...a.keyframes.map((k) => k.value)] : []);
			const bad = (v: unknown) => typeof v !== 'number' || !Number.isFinite(v) || v < 0;
			if (values(sh.size).some((v) => !Array.isArray(v) || v.length !== 2 || v.some(bad)))
				issues.push(inv('INV-012', `Shape ${c.id} size must be two numbers ≥ 0`, cw));
			if (values(sh.cornerRadius).some(bad))
				issues.push(inv('INV-012', `Shape ${c.id} corner radius must be ≥ 0`, cw));
			if (sh.stroke && values(sh.stroke.width).some(bad))
				issues.push(inv('INV-012', `Shape ${c.id} stroke width must be ≥ 0`, cw));
			// wp-m2-shapes: paint colours are RGBA in 0..1 (value and keyframes).
			const badColor = (v: unknown) =>
				!Array.isArray(v) || v.length !== 4 || v.some((x) => bad(x) || (x as number) > 1);
			if (values(sh.fill ?? undefined).some(badColor) || values(sh.stroke?.color).some(badColor))
				issues.push(inv('INV-012', `Shape ${c.id} fill and stroke colours must be RGBA in 0..1`, cw));
		}
		if (c.kind === 'motion-graphic') {
			const stamp = templateStampIssue(c, opts.mgTemplates);
			if (stamp) issues.push(inv('INV-012', `Clip ${c.id} ${stamp}`, [...cw, 'template']));
			// Template media params (avatars): their media must exist (INV-006); uses are counted above (INV-014).
			for (const ref of templateMediaRefs(c.params)) {
				if (!doc.media[ref.mediaId])
					issues.push(
						inv('INV-006', `Clip ${c.id} params.${ref.path} references missing media ${ref.mediaId}`, [
							...cw,
							'params',
							...ref.path.split('.'),
						]),
					);
			}
			for (const [name, list] of Object.entries(c.paramKeyframes ?? {})) {
				const path = [...cw, 'paramKeyframes', name];
				const shape = valueShape((c.params as Record<string, unknown>)[name]);
				let last = Number.NEGATIVE_INFINITY;
				for (const k of list) {
					claim(k.id, 'kf', [...path, k.id]);
					if (!(k.time > last))
						issues.push(inv('INV-011', 'Keyframes must have strictly increasing times', path));
					last = k.time;
					if (valueShape(k.value) !== shape)
						issues.push(inv('INV-011', 'Keyframe value type does not match the parameter', path));
					const sides = keySidesIssue(k as { interpolation?: unknown; inInterpolation?: unknown });
					if (sides) issues.push(inv('INV-011', `Keyframe ${k.id}: ${sides}`, [...path, k.id]));
				}
			}
		}
		if (c.linkId && !seq.links[c.linkId]?.members.includes(c.id))
			issues.push(inv('INV-006', `Clip ${c.id} has a dangling linkId`, cw));
		if (c.groupId && !seq.groups[c.groupId]?.members.includes(c.id))
			issues.push(inv('INV-006', `Clip ${c.id} has a dangling groupId`, cw));
		for (const m of c.markers) claim(m.id, 'mrk', [...cw, 'markers', m.id]);
		// parity (roto): roto objects and the effect params that name them.
		const rotoIds = new Set<string>();
		for (const ro of (r.rotos as ClipRoto[] | undefined) ?? []) {
			const rw = [...cw, 'rotos', ro.id];
			claim(ro.id, 'rto', rw);
			rotoIds.add(ro.id);
			if (ro.mediaId !== r.mediaId)
				issues.push(inv('INV-006', `Roto ${ro.id} belongs to media ${ro.mediaId}, not to its clip's`, rw));
			if (ro.span[1] < ro.span[0]) issues.push(inv('INV-012', `Roto ${ro.id} has an empty span`, rw));
			if (ro.base !== null && (ro.base < ro.span[0] || ro.base > ro.span[1]))
				issues.push(inv('INV-012', `Roto ${ro.id} base frame lies outside its span`, rw));
			if (ro.result && ro.result.end < ro.result.start)
				issues.push(inv('INV-012', `Roto ${ro.id} result has end < start`, rw));
		}
		for (const fx of (r.effects as EffectInstance[] | undefined) ?? []) {
			for (const name of ROTO_OBJECT_PARAMS[fx.effectId] ?? []) {
				const v = fx.params[name]?.value;
				if (typeof v === 'string' && v !== '' && !rotoIds.has(v))
					issues.push(
						inv('INV-006', `${fx.effectId}.${name} names a missing roto ${v}`, [...cw, 'effects', fx.id]),
					);
			}
		}
		if (isKnownClipKind(c.kind)) {
			effects(r.effects as EffectInstance[] | undefined, [...cw, 'effects'], true);
			masks(r.masks as Mask[] | undefined, [...cw, 'masks']);
			anims({ ...r, content: undefined, params: undefined }, cw);
			const opacity = r.opacity as AnimLike | undefined;
			if (opacity) {
				for (const v of [opacity.value, ...opacity.keyframes.map((k) => k.value)]) {
					if (typeof v !== 'number' || v < 0 || v > 100)
						issues.push(inv('INV-012', `Clip ${c.id} opacity out of 0..100`, cw));
				}
			}
		}
	};

	/** wp masks: Track Matte Key tracks exist, are other video tracks, and mattes form no cycle. */
	const trackMattes = (s: SeqScope): void => {
		const { seq, where } = s;
		const videoIds = new Set(seq.videoTracks.map((t) => t.id));
		const edges = new Map<string, Set<string>>();
		for (const c of Object.values(seq.clips)) {
			const fx = (c as { effects?: EffectInstance[] }).effects;
			if (!fx) continue;
			for (const t of trackMatteTracksOf({ effects: fx as never })) {
				const cw = [...where, 'clips', c.id];
				if (!videoIds.has(t)) issues.push(inv('INV-006', `Clip ${c.id} uses missing matte track ${t}`, cw));
				else if (t === c.trackId)
					issues.push(inv('INV-012', `Clip ${c.id} cannot use its own track as a track matte`, cw));
				else {
					const set = edges.get(c.trackId) ?? new Set<string>();
					set.add(t);
					edges.set(c.trackId, set);
				}
			}
		}
		const state = new Map<string, 1 | 2>();
		const cyclic = (n: string): boolean => {
			if (state.get(n) === 1) return true;
			if (state.get(n) === 2) return false;
			state.set(n, 1);
			for (const m of edges.get(n) ?? []) if (cyclic(m)) return true;
			state.set(n, 2);
			return false;
		};
		for (const n of edges.keys())
			if (cyclic(n)) {
				issues.push(inv('INV-012', `Track mattes form a cycle through track ${n}`, where));
				break;
			}
	};

	/** INV-003: no overlaps among the clips collected per track. */
	const overlaps = (where: string[], byTrack: Map<string, Clip[]>): void => {
		for (const [trackId, list] of byTrack) {
			list.sort((a, b) => a.start - b.start);
			for (let i = 1; i < list.length; i++) {
				if (list[i]!.start < clipEnd(list[i - 1]!)) {
					issues.push(
						inv('INV-003', `Clips ${list[i - 1]!.id} and ${list[i]!.id} overlap on ${trackId}`, [
							...where,
							'clips',
							list[i]!.id,
						]),
					);
				}
			}
		}
	};

	/** INV-007 (and INV-006) for one link group; `claimId` claims its id. */
	const link = (s: SeqScope, key: string, l: Sequence['links'][string], claimId: Claim): void => {
		const { seq, where, tracks } = s;
		claimId(l.id, 'lnk', [...where, 'links', key]);
		if (l.members.length < 2)
			issues.push(inv('INV-007', `Link group ${l.id} has fewer than 2 members`, [...where, 'links', key]));
		let videos = 0;
		for (const m of l.members) {
			const c = seq.clips[m];
			if (!c)
				issues.push(
					inv('INV-006', `Link group ${l.id} references missing clip ${m}`, [...where, 'links', key]),
				);
			else {
				if (c.linkId !== l.id)
					issues.push(
						inv('INV-007', `Clip ${m} is listed in ${l.id} but not linked to it`, [...where, 'links', key]),
					);
				if (tracks.get(c.trackId)?.kind === 'video') videos++;
			}
		}
		if (videos > 1)
			issues.push(
				inv('INV-007', `Link group ${l.id} has more than one video member`, [...where, 'links', key]),
			);
	};

	/** INV-007 (and INV-006) for one clip group; `claimId` claims its id. */
	const group = (s: SeqScope, key: string, g: Sequence['groups'][string], claimId: Claim): void => {
		const { seq, where } = s;
		claimId(g.id, 'grp', [...where, 'groups', key]);
		if (g.members.length < 2)
			issues.push(inv('INV-007', `Clip group ${g.id} has fewer than 2 members`, [...where, 'groups', key]));
		for (const m of g.members) {
			if (!seq.clips[m])
				issues.push(
					inv('INV-006', `Clip group ${g.id} references missing clip ${m}`, [...where, 'groups', key]),
				);
			else if (seq.clips[m]!.groupId !== g.id)
				issues.push(
					inv('INV-007', `Clip ${m} is listed in ${g.id} but not grouped`, [...where, 'groups', key]),
				);
		}
	};

	/** INV-010 over all transitions of `s.seq`; `claimOf(key)` claims a transition's id. */
	const transitions = (s: SeqScope, claimOf: (key: string) => Claim): void => {
		const { seq, where } = s;
		const edgeUse = new Set<string>();
		for (const [key, t] of Object.entries(seq.transitions)) {
			const tw = [...where, 'transitions', key];
			claimOf(key)(t.id, 'trn', tw);
			if (!t.outgoingClipId && !t.incomingClipId)
				issues.push(inv('INV-010', `Transition ${t.id} has no clips`, tw));
			const out = t.outgoingClipId ? seq.clips[t.outgoingClipId] : undefined;
			const inc = t.incomingClipId ? seq.clips[t.incomingClipId] : undefined;
			if ((t.outgoingClipId && !out) || (t.incomingClipId && !inc)) {
				issues.push(inv('INV-006', `Transition ${t.id} references a missing clip`, tw));
				continue;
			}
			if (out && inc && (out.trackId !== inc.trackId || clipEnd(out) !== inc.start))
				issues.push(inv('INV-010', `Transition ${t.id} joins non-adjacent clips`, tw));
			for (const c of [out, inc]) {
				if (c && c.trackId !== t.trackId)
					issues.push(inv('INV-010', `Transition ${t.id} is not on its clips' track`, tw));
				if (c && t.duration > c.duration)
					issues.push(inv('INV-010', `Transition ${t.id} is longer than clip ${c.id}`, tw));
			}
			// Premiere port: an off-centre cut position needs both clips; Custom Fade params are readable.
			for (const why of transitionFieldIssues(t))
				issues.push(inv('INV-010', `Transition ${t.id} ${why}`, tw));
			// A fade at a clip's head uses only its `in` edge, a fade at the tail only its `out` edge.
			for (const k of [out ? `${out.id}:out` : null, inc ? `${inc.id}:in` : null]) {
				if (!k) continue;
				if (edgeUse.has(k)) issues.push(inv('INV-010', `Two transitions on the same clip edge (${k})`, tw));
				edgeUse.add(k);
			}
		}
	};

	return { masks, effects, anims, clip, trackMattes, overlaps, link, group, transitions };
}

export function checkInvariants(doc: ProjectDocument, opts: InvariantOptions = {}): Issue[] {
	return runInvariants(doc, opts).issues;
}

/** The full check; `seen` holds every id it claimed (the incremental check's id index). */
export function runInvariants(
	doc: ProjectDocument,
	opts: InvariantOptions = {},
): { issues: Issue[]; seen: Set<string> } {
	const issues: Issue[] = [];
	const seen = new Set<string>();
	/** Ids claimed by the sequence being walked (per-sequence memo, `SequenceMemo`). */
	let claimLog: string[] | null = null;
	const claim = (id: string, prefix: IdPrefix | IdPrefix[], where: string[]) => {
		const prefixes = Array.isArray(prefix) ? prefix : [prefix];
		claimLog?.push(id);
		if (!isValidId(id) || !prefixes.includes(idPrefixOf(id)!)) {
			const issue = inv('INV-001', `Malformed id ${id} (expected ${prefixes.join('/')}_…)`, where);
			ID_ISSUES.set(issue, { kind: 'malformed', id, prefix: prefixes[0]!, where });
			issues.push(issue);
		}
		if (seen.has(id)) {
			const issue = inv('INV-001', `Duplicate id ${id}`, where);
			ID_ISSUES.set(issue, { kind: 'duplicate', id });
			issues.push(issue);
		} else seen.add(id);
	};
	const keyIssue = (key: string, id: string, path: string[], message: string) => {
		const issue = inv('INV-001', message, path);
		ID_ISSUES.set(issue, { kind: 'key', key, id, path });
		issues.push(issue);
	};

	// INV-001: ids, record keys
	claim(doc.projectId, 'prj', ['projectId']);
	const table = (rec: Record<string, { id: string }>, name: string, prefix: IdPrefix | IdPrefix[]) => {
		for (const [key, v] of Object.entries(rec)) {
			if (v.id !== key) keyIssue(key, v.id, [name, key], `Key ${key} does not match id ${v.id}`);
			claim(v.id, prefix, [name, key]);
		}
	};
	table(doc.items, 'items', ['itm', 'bin']);
	// wp-multicam: source clip markers of media items.
	for (const it of Object.values(doc.items)) {
		for (const m of (it as { markers?: { id: string; flicks: number }[] }).markers ?? []) {
			claim(m.id, 'mrk', ['items', it.id, 'markers', m.id]);
			if (!Number.isInteger(m.flicks) || m.flicks < 0)
				issues.push(inv('INV-004', `Marker ${m.id} has an invalid time`, ['items', it.id, 'markers', m.id]));
		}
	}
	for (const it of Object.values(doc.items)) {
		if ((it.kind === 'bin') !== (idPrefixOf(it.id) === 'bin'))
			issues.push(inv('INV-001', `Item ${it.id} prefix does not match its kind`, ['items', it.id]));
	}
	table(doc.media, 'media', 'med');
	table(doc.synthetics, 'synthetics', 'syn');
	table(doc.transcripts, 'transcripts', 'trs');
	table(doc.fonts, 'fonts', 'fnt');
	table(doc.sequences, 'sequences', 'seq');
	// previews: Sequence Settings ▸ Video Previews must be one of the known formats / sizes / qualities.
	for (const seq of Object.values(doc.sequences)) {
		const p = (seq as { previews?: unknown }).previews;
		if (p !== undefined && !SequencePreviewSettingsSchema.safeParse(p).success)
			issues.push(
				inv('INV-PREVIEWS', `Sequence ${seq.id}: invalid preview settings`, [
					'sequences',
					seq.id,
					'previews',
				]),
			);
	}

	const { effects, anims, clip, trackMattes, overlaps, link, group, transitions } = invariantCheckers(
		doc,
		opts,
		issues,
		claim,
		keyIssue,
	);

	// INV-008: bin tree
	const parents = new Map<string, number>();
	const countParent = (id: string, where: string[]) => {
		parents.set(id, (parents.get(id) ?? 0) + 1);
		if (!doc.items[id]) issues.push(inv('INV-006', `Bin tree references missing item ${id}`, where));
	};
	for (const id of doc.rootItems) countParent(id, ['rootItems']);
	for (const it of Object.values(doc.items))
		if (it.kind === 'bin') for (const c of it.children) countParent(c, ['items', it.id, 'children']);
	for (const it of Object.values(doc.items)) {
		const n = parents.get(it.id) ?? 0;
		if (n !== 1)
			issues.push(inv('INV-008', `Item ${it.id} appears ${n} times in the bin tree`, ['items', it.id]));
	}
	const reachable = new Set<string>();
	const walk = (id: string, stack: Set<string>) => {
		if (stack.has(id)) {
			issues.push(inv('INV-008', `Bin cycle at ${id}`, ['items', id]));
			return;
		}
		if (reachable.has(id)) return;
		reachable.add(id);
		const it = doc.items[id];
		if (it?.kind === 'bin') {
			stack.add(id);
			for (const c of it.children) walk(c, stack);
			stack.delete(id);
		}
	};
	for (const id of doc.rootItems) walk(id, new Set());
	const seqItems = new Map<string, number>();
	for (const it of Object.values(doc.items)) {
		if (it.kind === 'media' && !doc.media[it.mediaId])
			issues.push(inv('INV-006', `Item ${it.id} references missing media ${it.mediaId}`, ['items', it.id]));
		if (it.kind === 'synthetic' && !doc.synthetics[it.syntheticId])
			issues.push(
				inv('INV-006', `Item ${it.id} references missing synthetic ${it.syntheticId}`, ['items', it.id]),
			);
		// edit-ux: subclips reference their media (and parent item when it still exists) and hold a valid range.
		if (it.kind === 'subclip') {
			const asset = doc.media[it.mediaId];
			if (!asset)
				issues.push(
					inv('INV-006', `Subclip ${it.id} references missing media ${it.mediaId}`, ['items', it.id]),
				);
			if (it.parentItemId !== null && doc.items[it.parentItemId]?.kind !== 'media')
				issues.push(inv('INV-006', `Subclip ${it.id} references a missing parent item`, ['items', it.id]));
			const dur = asset ? mediaDurationFlicks(asset) : null;
			if (
				!(it.range.out > it.range.in) ||
				it.range.in < 0 ||
				(dur !== null && it.range.out > dur + FLICKS_PER_SECOND / 10)
			)
				issues.push(inv('INV-005', `Subclip ${it.id} has an invalid range`, ['items', it.id]));
		}
		if (it.kind === 'sequence') {
			if (!doc.sequences[it.sequenceId])
				issues.push(
					inv('INV-006', `Item ${it.id} references missing sequence ${it.sequenceId}`, ['items', it.id]),
				);
			seqItems.set(it.sequenceId, (seqItems.get(it.sequenceId) ?? 0) + 1);
		}
	}
	for (const s of Object.keys(doc.sequences)) {
		if (seqItems.get(s) !== 1)
			issues.push(inv('INV-008', `Sequence ${s} must have exactly one project item`, ['sequences', s]));
	}
	// spec 13 SH-004: caption style presets keep valid stroke lists and shadow spreads.
	(doc.settings.captionStylePresets ?? []).forEach((p, i) => {
		for (const m of textStyleIssues(p.style))
			issues.push(
				inv('INV-012', `Caption style preset ${p.id} ${m}`, [
					'settings',
					'captionStylePresets',
					String(i),
					'style',
				]),
			);
	});
	for (const f of Object.values(doc.fonts)) {
		if (f.source.type === 'asset' && !doc.media[f.source.mediaId])
			issues.push(inv('INV-006', `Font ${f.id} references missing media`, ['fonts', f.id]));
	}
	// spec 13 SH-002: project text styles (readable, keyed by id, fonts present).
	for (const [message, path] of textStylesRecordIssues(doc)) issues.push(inv('INV-TEXTSTYLE', message, path));
	// spec 13 AS-020: subtitle templates copied into the project.
	for (const [message, path] of subtitleTemplatesIssues(doc)) issues.push(inv('INV-SUBTITLE', message, path));
	// spec 19 TL-015: looks of the project.
	for (const [message, path] of titleLooksRecordIssues(doc))
		issues.push(inv('INV-APPEARANCE', message, path));
	for (const look of titleLooksOf(doc))
		for (const ref of titleLookMediaRefs(look))
			if (!doc.media[ref.mediaId])
				issues.push(
					inv('INV-006', `Look ${look.id}: ${ref.param} references missing media ${ref.mediaId}`, [
						'titleLooks',
						look.id,
					]),
				);
	// spec 15 EA-010: style recipes copied into the project.
	for (const [message, path] of styleRecipesIssues(doc)) issues.push(inv('INV-STYLE-RECIPE', message, path));
	// spec 18 AF-BRF-002: agent notes must be readable (INV-AGENT-NOTES).
	const notesBad = agentNotesIssue((doc as { agentNotes?: unknown }).agentNotes);
	if (notesBad) issues.push(inv('INV-AGENT-NOTES', `Agent notes: ${notesBad}`, ['agentNotes']));
	// scene files: the layer → clip bindings `jasper apply` keeps must be readable (INV-SCENE).
	const sceneBad = sceneBindingsIssue(doc);
	if (sceneBad)
		issues.push(inv('INV-SCENE', `Scene bindings: ${sceneBad}`, ['extensions', SCENE_EXTENSION_KEY]));
	for (const m of Object.values(doc.media)) {
		if (m.derivation && !doc.media[m.derivation.fromMediaId])
			issues.push(inv('INV-006', `Derived media ${m.id} references missing source`, ['media', m.id]));
		// imports: Interpret Footage sections must fit the media (frame rate on a still, a loop without a duration…).
		if (m.interpretation)
			for (const msg of interpretationIssues(m, m.interpretation))
				issues.push(
					inv('INV-012', `Media ${m.id} interpretation: ${msg}`, ['media', m.id, 'interpretation']),
				);
		// HTML compositions (schema v15): the page header must be readable (it is stored leniently).
		if (m.mgBundle?.html !== undefined) {
			const bad = mgHtmlPageIssue(m.mgBundle.html);
			if (bad)
				issues.push(
					inv('INV-MG-HTML', `Media ${m.id} HTML page: ${bad}`, ['media', m.id, 'mgBundle', 'html']),
				);
		}
		// sound-design (spec 12 §2.1): library provenance must be readable (it is stored leniently).
		if ((m as { library?: unknown }).library !== undefined) {
			const bad = libraryProvenanceIssue((m as { library?: unknown }).library);
			if (bad)
				issues.push(
					inv('INV-LIBRARY', `Media ${m.id} library provenance: ${bad}`, ['media', m.id, 'library']),
				);
		}
	}
	for (const t of Object.values(doc.transcripts)) {
		if (t.mediaId && !doc.media[t.mediaId])
			issues.push(inv('INV-006', `Transcript ${t.id} references missing media`, ['transcripts', t.id]));
		// wp captions (S01:AST-030): words sorted by start, non-overlapping, integer flicks
		const bad = wordsWellFormed(t.words);
		if (bad) issues.push(inv('INV-012', `Transcript ${t.id}: ${bad}`, ['transcripts', t.id]));
		// wp speech: coverage ranges sorted, disjoint, non-empty
		const cov = coverageProblem(t.coverage);
		if (cov) issues.push(inv('INV-012', `Transcript ${t.id}: ${cov}`, ['transcripts', t.id, 'coverage']));
		// hidden takes: re-decoded ranges of this recognition
		const red = redecodedProblem(t);
		if (red) issues.push(inv('INV-012', `Transcript ${t.id}: ${red}`, ['transcripts', t.id, 'redecoded']));
		// spec 14 TC-003: decoder scores per segment, read leniently
		const segs = transcriptSegmentsProblem(t.segments);
		if (segs) issues.push(inv('INV-012', `Transcript ${t.id}: ${segs}`, ['transcripts', t.id, 'segments']));
	}
	const captionTrsUsers = new TouchedMap<string, number>();

	// Sequences
	const usedMedia = new LoggedSet();
	const usedSyn = new LoggedSet();
	const usedTrs = new LoggedSet();
	const nestEdges = new Map<string, Set<string>>();
	// Per-sequence memo (golden-fuzz scale benchmark): a sequence the transaction left untouched is the same object,
	// so its findings are replayed instead of walked again (every transaction checks the whole document).
	const memoOn = !(opts as { [NO_MEMO]?: boolean })[NO_MEMO];
	const deps: SequenceDeps = {
		media: doc.media,
		synthetics: doc.synthetics,
		transcripts: doc.transcripts,
		fonts: doc.fonts,
		items: doc.items,
		effects: opts.effects,
		mgTemplates: opts.mgTemplates,
	};
	for (const seq of Object.values(doc.sequences)) {
		// Only frozen (immutable) sequences are memoized: a mutable one may change in place between checks (repairs).
		const frozen = memoOn && Object.isFrozen(seq) && Object.isFrozen(seq.clips);
		const hit = frozen ? sequenceMemo.get(seq) : undefined;
		if (hit && sameDeps(hit.deps, deps)) {
			// A replayed id seen elsewhere in the document is a duplicate: check everything the slow way.
			if (hit.ids.some((id) => seen.has(id)))
				return runInvariants(doc, { ...opts, [NO_MEMO]: true } as InvariantOptions);
			for (const id of hit.ids) seen.add(id);
			issues.push(...hit.issues);
			for (const id of hit.media) usedMedia.add(id);
			for (const id of hit.synthetics) usedSyn.add(id);
			for (const id of hit.transcripts) usedTrs.add(id);
			continue;
		}
		const seqMark = issues.length;
		claimLog = [];
		usedMedia.log = [];
		usedSyn.log = [];
		usedTrs.log = [];
		captionTrsUsers.touched = false;
		const where = ['sequences', seq.id];
		const s = seq.settings;
		if (!isAllowedSequenceRate(s.frameRate))
			issues.push(
				inv('INV-013', `Frame rate ${s.frameRate.num}/${s.frameRate.den} not allowed`, [
					...where,
					'settings',
				]),
			);
		for (const d of [s.width, s.height]) {
			if (!Number.isInteger(d) || d % 2 !== 0 || d < 16 || d > 8192)
				issues.push(inv('INV-013', `Frame size ${s.width}x${s.height} invalid`, [...where, 'settings']));
		}
		if (s.dropFrame && !supportsDropFrame(s.frameRate))
			issues.push(inv('INV-013', 'Drop-frame only applies to 29.97/59.94', [...where, 'settings']));
		if (seq.videoTracks.length < 1 || seq.audioTracks.length < 1)
			issues.push(inv('INV-015', 'Needs at least one video and one audio track', where));

		const tracks = new Map<string, Track>();
		for (const [list, kind] of [
			[seq.videoTracks, 'video'],
			[seq.audioTracks, 'audio'],
			[seq.captionTracks, 'caption'],
		] as const) {
			for (const t of list) {
				claim(t.id, 'trk', [...where, 'tracks', t.id]);
				if (t.kind !== kind)
					issues.push(
						inv('INV-002', `Track ${t.id} in the ${kind} list has kind ${t.kind}`, [
							...where,
							'tracks',
							t.id,
						]),
					);
				tracks.set(t.id, t);
				if (t.styleDefaults && !doc.fonts[t.styleDefaults.fontId])
					issues.push(
						inv('INV-006', `Track ${t.id} style references missing font ${t.styleDefaults.fontId}`, [
							...where,
							'tracks',
							t.id,
						]),
					);
				for (const m of textStyleIssues(t.styleDefaults))
					issues.push(
						inv('INV-012', `Track ${t.id} caption style ${m}`, [...where, 'tracks', t.id, 'styleDefaults']),
					);
				effects(t.effects, [...where, 'tracks', t.id, 'effects']);
				anims(t, [...where, 'tracks', t.id]);
			}
		}
		const active = (seq as { activeCaptionTrackId?: string | null }).activeCaptionTrackId;
		if (active && !seq.captionTracks.some((t) => t.id === active))
			issues.push(inv('INV-006', `Active caption track ${active} does not exist`, where));
		effects(seq.master.effects, [...where, 'master', 'effects']);
		anims(seq.master, [...where, 'master']);
		// audio-mix: submix tracks (ids, effects, keyframes), sends, routing (INV-MIX).
		for (const t of seq.submixTracks ?? []) {
			claim(t.id, 'trk', [...where, 'submixTracks', t.id]);
			effects(t.effects, [...where, 'submixTracks', t.id, 'effects']);
			anims(t, [...where, 'submixTracks', t.id]);
		}
		for (const t of [...seq.audioTracks, ...(seq.submixTracks ?? [])])
			for (const x of t.mixer?.sends ?? []) claim(x.id, 'snd', [...where, 'tracks', t.id, 'sends', x.id]);
		for (const m of audioMixIssues(seq as Sequence, where)) issues.push(inv('INV-MIX', m.message, m.path));
		for (const m of seq.markers) {
			claim(m.id, 'mrk', [...where, 'markers', m.id]);
			const verdictBad = markerVerdictProblem(m as { soundCheck?: unknown });
			if (verdictBad)
				issues.push(
					inv('INV-SOUND', `Marker ${m.id}: ${verdictBad}`, [...where, 'markers', m.id, 'soundCheck']),
				);
		}
		// spec 13 AS-003: subtitle groups readable, keyed by id; every subtitle's group present (INV-SUBTITLE).
		for (const [message, path] of sequenceSubtitleIssues(seq as Sequence))
			issues.push(inv('INV-SUBTITLE', message, [...where, ...path]));
		// sound-design (spec 12 §2.2): cues and settings must be readable, cue ids well-formed (INV-SOUND).
		const soundBad = sequenceSoundDesignIssue(seq as { soundDesign?: unknown });
		if (soundBad)
			issues.push(
				inv('INV-SOUND', `Sequence ${seq.id} sound design: ${soundBad}`, [...where, 'soundDesign']),
			);
		// spec 14 TC-030: transcript cleanup state must be readable (INV-CLEANUP).
		const cleanupBad = sequenceCleanupIssue((seq as { cleanup?: unknown }).cleanup);
		if (cleanupBad)
			issues.push(inv('INV-CLEANUP', `Sequence ${seq.id} cleanup: ${cleanupBad}`, [...where, 'cleanup']));
		// spec 17 SC-055: Fix Transcript settings and rejected fixes must be readable (INV-SCRIPTFIX).
		const scriptFixBad = sequenceScriptFixIssue((seq as { scriptFix?: unknown }).scriptFix);
		if (scriptFixBad)
			issues.push(
				inv('INV-SCRIPTFIX', `Sequence ${seq.id} scriptFix: ${scriptFixBad}`, [...where, 'scriptFix']),
			);
		// spec 19 TL-017: the sequence's light must be readable.
		const lightBad = globalLightProblem(seq.settings.globalLight);
		if (lightBad)
			issues.push(inv('INV-APPEARANCE', `Sequence ${seq.id}: ${lightBad}`, [...where, 'settings']));
		// spec 18 AF-BRF-001: the brief must be readable (INV-BRIEF).
		const briefBad = sequenceBriefIssue((seq as { brief?: unknown }).brief);
		if (briefBad) issues.push(inv('INV-BRIEF', `Sequence ${seq.id} brief: ${briefBad}`, [...where, 'brief']));
		// wp-multicam: a multi-camera source's angles reference its own tracks.
		const mcSource = (seq as Sequence).multicam;
		if (mcSource)
			for (const problem of multicamSourceIssues(seq, mcSource))
				issues.push(inv('INV-006', `Multi-camera source ${problem}`, [...where, 'multicam']));

		const rate = s.frameRate as Rational;
		const byTrack = new Map<string, Clip[]>();
		const scope: SeqScope = { seq: seq as Sequence, where, tracks, rate, byTrack };
		const facts: ClipFacts = { usedMedia, usedSyn, usedTrs, captionTrsUsers, nestEdges };
		for (const [key, c] of Object.entries(seq.clips)) clip(scope, facts, key, c);
		trackMattes(scope);
		overlaps(where, byTrack);
		for (const [key, l] of Object.entries(seq.links)) link(scope, key, l, claim);
		for (const [key, g] of Object.entries(seq.groups)) group(scope, key, g, claim);
		transitions(scope, () => claim);
		// Memoizable: no references into other sequences (nests, multicam), no order-dependent caption-transcript
		// counting, no duplicate ids found (those depend on the rest of the document).
		const segment = issues.slice(seqMark);
		if (
			frozen &&
			!nestEdges.has(seq.id) &&
			!captionTrsUsers.touched &&
			!segment.some((i) => i.message.startsWith('INV-001: Duplicate id'))
		)
			sequenceMemo.set(seq, {
				deps,
				ids: claimLog,
				issues: segment,
				media: usedMedia.log,
				synthetics: usedSyn.log,
				transcripts: usedTrs.log,
			});
		claimLog = null;
		usedMedia.log = usedSyn.log = usedTrs.log = null;
	}
	// INV-009 nesting acyclic
	const visiting = new Set<string>();
	const done = new Set<string>();
	const dfs = (s: string): boolean => {
		if (visiting.has(s)) return true;
		if (done.has(s)) return false;
		visiting.add(s);
		for (const n of nestEdges.get(s) ?? []) if (dfs(n)) return true;
		visiting.delete(s);
		done.add(s);
		return false;
	};
	for (const s of Object.keys(doc.sequences)) {
		if (dfs(s)) {
			issues.push(inv('INV-009', `Nesting cycle through ${s}`, ['sequences', s]));
			break;
		}
	}
	// INV-014 no leaks
	for (const it of Object.values(doc.items)) {
		if (it.kind === 'media' || it.kind === 'subclip') usedMedia.add(it.mediaId);
		if (it.kind === 'synthetic') usedSyn.add(it.syntheticId);
	}
	for (const m of Object.values(doc.media)) if (m.derivation) usedMedia.add(m.derivation.fromMediaId);
	for (const f of Object.values(doc.fonts)) if (f.source.type === 'asset') usedMedia.add(f.source.mediaId);
	for (const id of projectLookMediaIds(doc)) usedMedia.add(id);
	for (const id of Object.keys(doc.media))
		if (!usedMedia.has(id)) issues.push(inv('INV-014', `Media ${id} is not referenced`, ['media', id]));
	for (const id of Object.keys(doc.synthetics))
		if (!usedSyn.has(id))
			issues.push(inv('INV-014', `Synthetic ${id} is not referenced`, ['synthetics', id]));
	for (const t of Object.values(doc.transcripts)) {
		if (!usedTrs.has(t.id) && !(t.mediaId && usedMedia.has(t.mediaId)))
			issues.push(inv('INV-014', `Transcript ${t.id} is not referenced`, ['transcripts', t.id]));
	}
	// Wave expressions (INV-EXPR): well-formed expressions on properties that take them.
	for (const m of expressionIssues(doc, isAudioEffectId)) issues.push(inv('INV-EXPR', m.message, m.path));
	// audio-fx (INV-ESSENTIAL): Essential Sound settings are readable, essential effects name a known slot and sit
	// on clips with a type; remix pieces of one remix share a group and a count.
	for (const m of essentialIssues(doc)) issues.push(inv('INV-ESSENTIAL', m.message, m.path));
	// color-mgmt (INV-COLOR): working spaces, colour settings and colour interpretations are valid.
	issues.push(...colorIssues(doc as never));
	// gaps (INV-PROJECT-SETTINGS, INV-PROXY, INV-CHANNELS, INV-WARP, INV-GRAPHIC…): docs/wp-notes/gaps.md.
	issues.push(...gapsIssues(doc));
	return { issues, seen };
}

/** audio-fx: problems of Essential Sound settings, essential effects and remix pieces (see repairDocument). */
export function essentialIssues(
	doc: Pick<ProjectDocument, 'sequences'>,
): { message: string; path: string[] }[] {
	const out: { message: string; path: string[] }[] = [];
	for (const seq of Object.values(doc.sequences) as Sequence[]) {
		const remixes = new Map<string, number[]>();
		for (const c of Object.values(seq.clips)) {
			if (c.kind !== 'audio') continue;
			const raw = (c as { essential?: unknown }).essential;
			if (raw !== undefined && !EssentialSoundSchema.safeParse(raw).success)
				out.push({
					message: `clip ${c.id}: unreadable Essential Sound settings`,
					path: [seq.id, c.id, 'essential'],
				});
			else if (legacyPanApplied(raw, (c as AudioClip).pan))
				out.push({
					message: `clip ${c.id}: Essential Sound Pan saved by a build that wrote it into the clip's pan`,
					path: [seq.id, c.id, 'essential', 'pan'],
				});
			for (const fx of c.effects)
				if (
					fx.essential !== undefined &&
					(!ESSENTIAL_SLOTS.includes(fx.essential as never) || raw === undefined)
				)
					out.push({
						message: `clip ${c.id}: effect ${fx.id} is marked essential (${fx.essential}) without matching settings`,
						path: [seq.id, c.id, fx.id],
					});
			if (c.remix) remixes.set(c.remix.id, [...(remixes.get(c.remix.id) ?? []), c.remix.count]);
			if (c.remix && !remixAnchorsValid(c.remix))
				out.push({
					message: `clip ${c.id}: unreadable remix anchors`,
					path: [seq.id, c.id, 'remix', 'anchors'],
				});
		}
		for (const [id, counts] of remixes)
			if (counts.some((n) => n !== counts.length))
				out.push({
					message: `remix ${id}: ${counts.length} pieces but they record ${counts[0]}`,
					path: [seq.id, id],
				});
	}
	return out;
}

/** M2 (wp-m2-text-anim, S11:TXA-008): a known preset whose stored params its schema rejects. */
function invalidAnimatorParams(a: unknown): boolean {
	const x = a as { preset?: unknown; version?: unknown; params?: unknown } | null | undefined;
	if (!x || typeof x.preset !== 'string' || typeof x.version !== 'number') return false;
	const spec = getTextAnimationSpec(x.preset, x.version);
	return !!spec && !spec.paramsSchema.safeParse(x.params).success;
}

/** wp masks: what is wrong with a mask (null = valid). */
export function maskProblem(m: Mask): string | null {
	const paths = [m.path.value, ...m.path.keyframes.map((k) => k.value)];
	for (const p of paths) {
		if (!isBezierPath(p)) return 'malformed path';
		if (p.closed && p.vertices.length < 3) return 'a closed path needs at least 3 vertices';
		if (p.vertices.length === 0) return 'empty path';
		const segs = segmentCount(p as BezierPath);
		for (const f of p.feather ?? [])
			if (!(f.segment >= 0 && f.segment < segs) || ![f.t, f.radius, f.tension].every(Number.isFinite))
				return 'feather point off the path';
	}
	const nums: [Animatable<number>, { min: number; max: number }, string][] = [
		[m.feather, MASK_FEATHER_RANGE, 'feather'],
		[m.opacity, MASK_OPACITY_RANGE, 'opacity'],
		[m.expansion, MASK_EXPANSION_RANGE, 'expansion'],
	];
	for (const [a, r, name] of nums)
		for (const v of [a.value, ...a.keyframes.map((k) => k.value)])
			if (typeof v !== 'number' || !Number.isFinite(v) || v < r.min || v > r.max)
				return `${name} out of range`;
	if (!MASK_MODES.includes(m.mode)) return `unknown mode ${m.mode}`;
	return null;
}

/** sim-warp: what is wrong with an effect's Puppet data (null = valid). */
export function puppetProblem(p: Puppet): string | null {
	if (!p || !Array.isArray(p.meshes) || !Array.isArray(p.pins)) return 'malformed puppet';
	const fin = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
	const pt = (v: unknown) => Array.isArray(v) && v.length === 2 && v.every(fin);
	const meshIds = new Set<string>();
	for (const m of p.meshes) {
		if (!m || typeof m.id !== 'string' || meshIds.has(m.id)) return 'duplicate or missing mesh id';
		meshIds.add(m.id);
		if (!pt(m.seed) || ![m.density, m.expansion, m.triangles].every(fin)) return `mesh ${m.id}: bad numbers`;
		if (m.outline && (m.outline.length < 3 || !m.outline.every(pt))) return `mesh ${m.id}: bad outline`;
	}
	const pinIds = new Set<string>();
	for (const q of p.pins) {
		if (!q || typeof q.id !== 'string' || pinIds.has(q.id)) return 'duplicate or missing pin id';
		pinIds.add(q.id);
		if (!PUPPET_PIN_KINDS.includes(q.kind)) return `pin ${q.id}: unknown kind`;
		if (!meshIds.has(q.meshId)) return `pin ${q.id}: no mesh ${q.meshId}`;
		if (!pt(q.rest)) return `pin ${q.id}: bad rest point`;
		for (const prop of PUPPET_PIN_PROPS) {
			const a = q[prop] as Animatable<unknown> | undefined;
			if (!a || !isAnimLike(a)) return `pin ${q.id}: missing ${prop}`;
			const ok = prop === 'position' ? pt : fin;
			if (![a.value, ...a.keyframes.map((k) => k.value)].every(ok)) return `pin ${q.id}: bad ${prop}`;
		}
	}
	return null;
}

/** wp masks: drops invalid masks of a list in place (repair); returns the dropped ids. */
function repairMaskList(list: Mask[] | undefined): string[] {
	if (!list) return [];
	const dropped: string[] = [];
	for (let i = list.length - 1; i >= 0; i--) {
		const m = list[i]!;
		if (!m || typeof m !== 'object' || !isAnimLike(m.path) || maskProblem(m)) {
			dropped.push(m?.id ?? '?');
			list.splice(i, 1);
		}
	}
	return dropped;
}

export type RepairEntry = { action: string; entity: string; detail: string };

/**
 * spec 19 TL-020: the looks of a sequence's clips. A look that cannot be read is removed and the clip shows its own
 * picture again; other effects keep their stack. A missing project look only unlinks the clip (TL-015).
 */
function repairLooksOfSequence(
	doc: ProjectDocument,
	seq: Sequence,
	ids: IdSource,
	note: (action: string, entity: string, detail: string) => void,
): void {
	for (const c of Object.values(seq.clips)) {
		const r = c as { effects?: EffectInstance[] };
		if (!r.effects?.length) continue;
		const bad = (fx: EffectInstance, why: string) => {
			note('drop-look', fx.id, why);
			return false;
		};
		let seen = false;
		r.effects = r.effects.filter((fx) => {
			if (fx.effectId !== TITLE_LOOK_EFFECT_ID) {
				if (fx.appearance === undefined) return true;
				delete fx.appearance;
				note('drop-look', fx.id, 'appearance data on another effect removed');
				return true;
			}
			if (seen) return bad(fx, 'a clip holds at most one look: a second one removed');
			const kindBad = clipLookProblem({ kind: c.kind, effects: [fx] });
			if (kindBad) return bad(fx, kindBad);
			const fixed = repairAppearance(fx.appearance, () => ids.next('apl'), fx.id, note);
			if (!fixed) return bad(fx, 'unreadable look removed');
			fx.appearance = fixed as never;
			seen = true;
			if (fixed.lookId !== undefined && !titleLookOf(doc, fixed.lookId)) {
				delete fixed.lookId;
				delete fixed.lookOverrides;
				note('unlink-look', fx.id, 'the look is gone: the clip keeps its values');
			}
			return true;
		});
	}
	for (const fx of [
		...[...seq.videoTracks, ...seq.audioTracks].flatMap((t) => t.effects ?? []),
		...seq.master.effects,
	])
		if (fx.appearance !== undefined) {
			delete fx.appearance;
			note('drop-look', fx.id, 'a look on a track or master effect removed');
		}
	for (const t of [...seq.videoTracks, ...seq.audioTracks])
		if (t.effects?.some((fx) => fx.effectId === TITLE_LOOK_EFFECT_ID)) {
			t.effects = t.effects.filter((fx) => fx.effectId !== TITLE_LOOK_EFFECT_ID);
			note('drop-look', t.id, 'a look on a track removed');
		}
	const light = seq.settings as { globalLight?: unknown };
	if (light.globalLight !== undefined && !globalLightOf(seq)) {
		delete light.globalLight;
		note('repair-global-light', seq.id, 'unreadable global light removed');
	}
}

/** spec 19 TL-015: a clip links to a look that is gone (soft: `loadProject` tidies it). */
export function titleLooksNeedRepair(doc: ProjectDocument): boolean {
	for (const seq of Object.values(doc.sequences))
		for (const c of Object.values(seq.clips)) {
			const look = clipLook((c as { effects?: EffectInstance[] }).effects)?.appearance as
				| { lookId?: string }
				| undefined;
			if (look?.lookId !== undefined && !titleLookOf(doc, look.lookId)) return true;
		}
	return false;
}

/**
 * Conservative repairs for loaded documents: drops dangling references, moves the later of two
 * overlapping clips to a new track, dissolves link/clip groups with fewer than two members, puts
 * unparented items back at the root, and re-adds missing tracks. Returns a new document and a report.
 */
export function repairDocument(
	input: ProjectDocument,
	ids: IdSource,
	opts: Pick<InvariantOptions, 'mgTemplates'> = {},
): { document: ProjectDocument; report: RepairEntry[] } {
	const doc = nullPrototypeRecords(JSON.parse(JSON.stringify(input)) as ProjectDocument);
	const report: RepairEntry[] = [];
	const note = (action: string, entity: string, detail: string) => report.push({ action, entity, detail });
	sanitizeAppearances(doc, () => ids.next('apl'), note);
	sanitizeThreeD(doc, note);
	repairIds(doc, ids, note);
	repairStructure(doc, ids, note);
	// spec 13 SH-002: project text styles and the clips' links to them.
	// spec 13 AS-003 / AS-020: subtitle groups, subtitle words on clips, project subtitle templates.
	repairSubtitleTemplates(doc, note);
	// spec 15 EA-010: project style recipes.
	repairStyleRecipes(doc, note);
	// spec 18 AF-BRF-002: keep the readable agent notes.
	const notes = doc as { agentNotes?: unknown };
	if (agentNotesIssue(notes.agentNotes)) {
		const fixed = repairAgentNotes(notes.agentNotes, () => ids.next('agn'));
		if (fixed) notes.agentNotes = fixed;
		else delete notes.agentNotes;
		note(
			'repair-agent-notes',
			doc.projectId,
			fixed ? 'unreadable agent notes dropped or shortened, the rest kept' : 'unreadable agent notes removed',
		);
	}
	// scene files: keep the readable layer → clip bindings.
	if (sceneBindingsIssue(doc)) {
		const fixed = repairSceneBindings(doc.extensions[SCENE_EXTENSION_KEY]);
		if (fixed) doc.extensions[SCENE_EXTENSION_KEY] = fixed;
		else delete doc.extensions[SCENE_EXTENSION_KEY];
		note(
			'repair-scene-bindings',
			doc.projectId,
			fixed ? 'unreadable scene bindings dropped, the rest kept' : 'unreadable scene bindings removed',
		);
	}
	for (const seq of Object.values(doc.sequences) as Sequence[])
		repairSubtitleSequence(seq, () => ids.next('cgp'), note);
	// spec 19 TL-020: project looks, then what clips hold and link to.
	repairTitleLooks(
		doc,
		() => ids.next('apl'),
		() => ids.next('tlk'),
		note,
	);
	for (const seq of Object.values(doc.sequences) as Sequence[]) repairLooksOfSequence(doc, seq, ids, note);
	repairTextStyles(
		doc,
		{
			defaultFontId: () => {
				let font = Object.values(doc.fonts).find((f) => f.family === DEFAULT_FONT_FAMILY);
				if (!font) {
					font = createFontRef(ids);
					doc.fonts[font.id] = font;
				}
				return font.id;
			},
			newStyleId: () => ids.next('tsy'),
		},
		note,
	);

	for (const seq of Object.values(doc.sequences) as Sequence[]) {
		const r = seq as { previews?: unknown };
		if (r.previews !== undefined && !SequencePreviewSettingsSchema.safeParse(r.previews).success) {
			delete r.previews;
			note('reset-preview-settings', seq.id, 'invalid preview settings replaced by the defaults');
		}
		// spec 14 TC-030 / TC-024: keep the readable parts of cleanup state; drop unreadable edge fades.
		const sc = seq as { cleanup?: unknown };
		if (sequenceCleanupIssue(sc.cleanup)) {
			const fixed = repairSequenceCleanup(sc.cleanup);
			if (fixed) sc.cleanup = fixed;
			else delete sc.cleanup;
			note(
				'repair-cleanup',
				seq.id,
				fixed ? 'unreadable cleanup settings dropped, the rest kept' : 'unreadable cleanup state removed',
			);
		}
		// spec 17 SC-055: keep the readable parts of the Fix Transcript state.
		const sf = seq as { scriptFix?: unknown };
		if (sequenceScriptFixIssue(sf.scriptFix)) {
			const fixed = repairSequenceScriptFix(sf.scriptFix);
			if (fixed) sf.scriptFix = fixed;
			else delete sf.scriptFix;
			note(
				'repair-script-fix',
				seq.id,
				fixed
					? 'unreadable Fix Transcript settings or rejected fixes dropped, the rest kept'
					: 'unreadable Fix Transcript state removed',
			);
		}
		// spec 18 AF-BRF-001: keep the readable parts of the brief.
		const sb = seq as { brief?: unknown };
		if (sequenceBriefIssue(sb.brief)) {
			const fixed = repairSequenceBrief(sb.brief);
			if (fixed) sb.brief = fixed;
			else delete sb.brief;
			note(
				'repair-brief',
				seq.id,
				fixed ? 'unreadable brief fields dropped, the rest kept' : 'unreadable brief removed',
			);
		}
		for (const c of Object.values(seq.clips)) {
			const cr = c as { edgeFades?: unknown };
			if (cr.edgeFades === undefined) continue;
			const bad = c.kind === 'audio' ? edgeFadesProblem(cr.edgeFades) : 'not an audio clip';
			if (!bad) continue;
			const kept = c.kind === 'audio' ? readEdgeFades(cr.edgeFades) : {};
			if (kept.inMs !== undefined || kept.outMs !== undefined) cr.edgeFades = kept;
			else delete cr.edgeFades;
			note('repair-edge-fades', c.id, `edge fades: ${bad}`);
		}
	}

	// Keep static params when discarding invalid animation, and use the registry's renderer for known templates.
	for (const seq of Object.values(doc.sequences) as Sequence[]) {
		for (const c of Object.values(seq.clips)) {
			if (c.kind !== 'motion-graphic') continue;
			// Template media params (avatars) whose media is gone become "none" (the template draws without it).
			const fixed = rewriteParamMedia(c.params as Record<string, unknown>, (m) =>
				doc.media[m] ? undefined : null,
			);
			if (fixed.changed.length) {
				const gone = new Map(templateMediaRefs(c.params).map((r) => [r.path, r.mediaId]));
				c.params = fixed.value as typeof c.params;
				for (const path of fixed.changed)
					note(
						'clear-template-media',
						c.id,
						`params.${path} referenced missing media ${gone.get(path)}: cleared`,
					);
			}
			const info = opts.mgTemplates?.get(c.template.id, c.template.version);
			if (info && templateStampIssue(c, opts.mgTemplates)) {
				if (info.renderer === 'anime') c.template.renderer = 'anime';
				else delete c.template.renderer;
				note('restamp-renderer', c.id, `renderer set from template ${c.template.id}@${c.template.version}`);
			}
			const pk = c.paramKeyframes;
			if (!pk) continue;
			for (const [name, list] of Object.entries(pk)) {
				const shape = valueShape((c.params as Record<string, unknown>)[name]);
				const ok = list.every(
					(k, i) => valueShape(k.value) === shape && (i === 0 || k.time > list[i - 1]!.time),
				);
				if (ok && list.length > 0) {
					// keyframe-sides: unreadable incoming types (the keys stay).
					for (const k of list)
						if (normalizeKeySides(k))
							note('repair-key-sides', k.id, `params.${name}: incoming interpolation made readable`);
					continue;
				}
				delete pk[name];
				if (list.length > 0) note('drop-keyframes', c.id, `malformed keyframes of params.${name} removed`);
			}
			if (Object.keys(pk).length === 0) delete c.paramKeyframes;
		}
	}

	// Missing environment media uses studio light; unsupported clip kinds cannot retain 3D blocks.
	for (const seq of Object.values(doc.sequences) as Sequence[]) {
		for (const c of Object.values(seq.clips)) {
			const r = c as Record<string, unknown>;
			if (r.threeD !== undefined && !canBe3d(c.kind)) {
				delete r.threeD;
				note('drop-3d', c.id, `a ${c.kind} clip cannot be a 3D layer`);
			}
			if (c.kind === 'light' && c.light.environmentMediaId && !doc.media[c.light.environmentMediaId]) {
				c.light.environmentMediaId = null;
				note('reset-environment', c.id, 'environment media is missing: neutral studio light');
			}
			// Effect `{mediaId}` params (LUTs, maps, reflection images) naming missing media become None.
			for (const path of clearEffectMedia(r.effects as EffectInstance[] | undefined, (m) => !doc.media[m]))
				note('clear-effect-media', c.id, `${path} referenced missing media: cleared`);
			if (c.kind === 'model' && (r.threeD as { enabled?: boolean } | undefined)?.enabled !== true) {
				r.threeD = {
					...newLayer3D(true, 'model'),
					...((r.threeD as object | undefined) ?? {}),
					enabled: true,
				};
				note('enable-3d-model', c.id, 'a 3D model layer is always a 3D layer');
			}
			if (r.cameraTracker !== undefined) {
				const t = r.cameraTracker as ClipCameraTracker;
				if (c.kind !== 'video' || !doc.media[t.mediaId]) {
					delete r.cameraTracker;
					note('drop-camera-tracker', c.id, 'the 3D Camera Tracker has no video to analyse');
				} else if (cameraTrackerProblem(t)) {
					t.solve = null;
					delete t.ground;
					note('reset-camera-solve', c.id, 'the camera solve was malformed: analyse again');
				}
			}
		}
	}
	// spec 19 TL-021: a project look's layer media that is gone becomes None, like an effect param's.
	for (const look of Object.values((doc as { titleLooks?: Record<string, unknown> }).titleLooks ?? {}))
		for (const path of clearTitleLookMedia(look, (m) => !doc.media[m]))
			note('clear-look-media', (look as { id: string }).id, `${path} referenced missing media: cleared`);
	// HTML compositions (schema v15): an unreadable page header cannot be served or rendered. Its compositions are
	// dropped with it, so the clips show "Composition … not in bundle" and exports refuse them (re-import the page).
	for (const m of Object.values(doc.media)) {
		const b = m.mgBundle as { html?: unknown; compositions: unknown[] } | undefined;
		if (!b || b.html === undefined || mgHtmlPageIssue(b.html) === null) continue;
		delete b.html;
		b.compositions = [];
		note('drop-html-page', m.id, 'unreadable HTML page header removed: import the page again');
	}
	// sound-design: unreadable library provenance is repaired field by field, or dropped without a sound id.
	for (const m of Object.values(doc.media)) {
		const r = m as { library?: unknown };
		if (r.library === undefined || libraryProvenanceIssue(r.library) === null) continue;
		const fixed = readLibraryProvenance(r.library);
		if (fixed) {
			r.library = fixed;
			note(
				'repair-library',
				m.id,
				'library provenance repaired (unreadable fields reset; check its licence)',
			);
		} else {
			delete r.library;
			note('drop-library', m.id, 'unreadable library provenance removed (no sound id)');
		}
	}
	// Invalid interpretation sections revert to the file's own values.
	for (const m of Object.values(doc.media)) {
		const it = m.interpretation as Record<string, unknown> | undefined;
		if (!it) continue;
		for (const key of ['frameRate', 'pixelAspect', 'fieldOrder', 'alpha', 'loop'] as const) {
			if (it[key] === undefined) continue;
			const bad = interpretationIssues(m, { [key]: it[key] } as never);
			if (bad.length) {
				delete it[key];
				note('drop-interpretation', m.id, `${key}: ${bad.join('; ')}`);
			}
		}
		if (Object.keys(it).length === 0) delete (m as { interpretation?: unknown }).interpretation;
	}

	for (const seq of Object.values(doc.sequences) as Sequence[]) {
		for (const c of Object.values(seq.clips)) {
			if (c.kind !== 'shape' || c.shape.type !== 'vector') continue;
			const shape = c.shape as { contents: ShapeItem[] };
			if (!Array.isArray(shape.contents)) {
				shape.contents = [];
				note('reset-shape', c.id, 'vector shape without contents');
				continue;
			}
			const clean = (items: ShapeItem[]): ShapeItem[] =>
				items.filter((it) => {
					const e = checkShapeItem(it, false);
					if (e) {
						note('drop-shape-item', c.id, e.message);
						return false;
					}
					if (it.type === 'group') it.contents = clean(it.contents);
					return true;
				});
			shape.contents = clean(shape.contents);
			const seen = new Set<string>();
			walkItems(shape.contents, (it) => {
				if (seen.has(it.id)) {
					const old = it.id;
					it.id = ids.next('shp');
					note('reid-shape-item', c.id, `duplicate item id ${old} renamed ${it.id}`);
				}
				seen.add(it.id);
			});
		}
	}
	// spec 13 SH-004: stroke lists beyond the limit are cut, shadow spreads clamped to 0…MAX_SHADOW_SPREAD_PX.
	for (const st of storedTextStyles(doc))
		for (const n of repairTextStyle(st.style))
			note('repair-text-style', st.entity, `${st.path.join('.')}: ${n}`);
	// spec 19 TL-111, TL-093: unreadable writing fields are removed (the text reads as horizontal).
	for (const seq of Object.values(doc.sequences) as Sequence[])
		for (const c of Object.values(seq.clips))
			for (const ct of clipTextContents(c))
				for (const n of repairTextWriting(ct)) note('repair-text-writing', c.id, n);
	// malformed animator data is dropped, out-of-range values clamped.
	for (const seq of Object.values(doc.sequences) as Sequence[])
		for (const c of Object.values(seq.clips))
			if (c.kind === 'text')
				for (const n of repairTextAnimators(c as unknown as Record<string, unknown>))
					note('repair-text-animators', c.id, n);
	// Wave expressions: drop malformed expressions and expressions on properties that take none.
	for (const r of repairExpressions(doc, isAudioEffectId)) note('drop-expression', r.entity, r.detail);

	// audio-fx: Essential Sound settings normalised (defaults for what is missing; unreadable → type cleared, its
	// effects become the user's); essential markers without settings dropped; remix pieces recount.
	for (const seq of Object.values(doc.sequences) as Sequence[]) {
		const remixes = new Map<string, AudioClip[]>();
		for (const c of Object.values(seq.clips)) {
			if (c.kind !== 'audio') continue;
			const a = c as AudioClip & { essential?: unknown };
			if (a.essential !== undefined && !EssentialSoundSchema.safeParse(a.essential).success) {
				const fixed = readEssentialSound(a.essential);
				if (fixed) a.essential = fixed;
				else delete a.essential;
				note(
					'normalize-essential',
					c.id,
					fixed
						? 'Essential Sound settings completed with defaults'
						: 'unreadable Essential Sound settings removed',
				);
			}
			// sound-design Phase 0 close-out: Pan saved before it became an offset (`migrateLegacyPan`).
			if (legacyPanApplied(a.essential, a.pan)) {
				const n = migrateLegacyPan(a);
				if (n) note('migrate-essential-pan', c.id, n);
			}
			for (const fx of a.effects)
				if (
					fx.essential !== undefined &&
					(!ESSENTIAL_SLOTS.includes(fx.essential as never) || a.essential === undefined)
				) {
					delete fx.essential;
					note('drop-essential-mark', fx.id, 'essential marker without settings removed (the effect stays)');
				}
			if (a.remix) remixes.set(a.remix.id, [...(remixes.get(a.remix.id) ?? []), a]);
			// P6-E11: unreadable remix anchors dropped (the readable ones kept)
			if (a.remix && !remixAnchorsValid(a.remix)) {
				const kept = readRemixAnchors(a.remix);
				const { anchors: _drop, ...rest } = a.remix as typeof a.remix & { anchors?: unknown };
				a.remix = (kept.length ? { ...rest, anchors: kept } : rest) as never;
				note('repair-remix-anchors', c.id, `remix anchors: ${kept.length} readable kept`);
			}
		}
		for (const [id, list] of remixes) {
			if (list.every((c) => c.remix!.count === list.length)) continue;
			list
				.sort((x, y) => x.start - y.start)
				.forEach((c, i) => {
					c.remix = { ...c.remix!, index: i, count: list.length };
				});
			note('recount-remix', id, `remix pieces recounted (${list.length})`);
		}
	}

	// keyframes-blend: roving flags where a key cannot rove are dropped; roving keys get their run's times.
	// keyframe-sides: unreadable incoming interpolations first (an unknown one is dropped, so the key reads the legacy
	// way; Auto / Continuous Bezier on a key whose sides differ becomes Bezier with its stored ease).
	for (const seq of Object.values(doc.sequences) as Sequence[])
		forEachAnimatable(seq, [seq.id], (a, path) => {
			const kfs = a.keyframes as unknown as Keyframe<unknown>[];
			for (const k of kfs)
				if (normalizeKeySides(k))
					note('repair-key-sides', k.id, `${path.join('.')}: incoming interpolation made readable`);
			if (!kfs.some((k) => k.roving)) return;
			const bad = kfs.filter((k, i) => k.roving && !isRovingKey(kfs, i)).map((k) => k.id);
			retimeRoving(kfs);
			for (const id of bad) note('drop-roving', id, `${path.join('.')}: the key cannot rove`);
		});
	for (const t of Object.values(doc.transcripts)) {
		if (wordsWellFormed(t.words)) {
			t.words = normalizeWords(t.words);
			note('normalize-words', t.id, 'transcript words sorted and overlaps cut');
		}
		// wp speech: coverage ranges sorted and merged (empty or malformed ranges dropped)
		if (t.coverage !== undefined && coverageProblem(t.coverage)) {
			const ok = (Array.isArray(t.coverage) ? t.coverage : []).filter(
				(r): r is [number, number] =>
					Array.isArray(r) && Number.isInteger(r[0]) && Number.isInteger(r[1]) && r[0] >= 0 && r[1] > r[0],
			);
			t.coverage = mergeRanges(ok);
			note('normalize-coverage', t.id, 'transcript coverage ranges sorted and merged');
		}
		// hidden takes: a mark of an earlier recognition dropped, malformed ranges dropped, the rest sorted and merged
		if (redecodedProblem(t)) {
			const ranges = transcriptRedecoded(t);
			if (ranges.length) t.redecoded = { createdAt: t.createdAt, ranges };
			else delete t.redecoded;
			note('normalize-redecoded', t.id, 'transcript re-decoded ranges repaired or dropped');
		}
		// spec 14 TC-003: malformed segments dropped, the rest sorted
		if (transcriptSegmentsProblem(t.segments)) {
			const segs = normalizeTranscriptSegments(t.segments);
			if (segs.length) t.segments = segs;
			else delete t.segments;
			note('normalize-segments', t.id, 'transcript segments: malformed entries dropped, sorted by start');
		}
	}
	for (const seq of Object.values(doc.sequences) as Sequence[]) {
		const s = seq as Sequence & { activeCaptionTrackId?: string | null };
		if (s.activeCaptionTrackId && !s.captionTracks.some((t) => t.id === s.activeCaptionTrackId)) {
			s.activeCaptionTrackId = s.captionTracks[0]?.id ?? null;
			note('reset-active-caption-track', seq.id, 'active caption track did not exist');
		}
		const fallbackFont = Object.keys(doc.fonts)[0];
		for (const t of s.captionTracks) {
			if (t.styleDefaults && !doc.fonts[t.styleDefaults.fontId]) {
				if (fallbackFont) t.styleDefaults.fontId = fallbackFont;
				else delete t.styleDefaults;
				note('reset-caption-font', t.id, 'caption track style referenced a missing font');
			}
		}
		for (const c of Object.values(seq.clips)) {
			const st = (c as { style?: { fontId?: string } }).style;
			if (c.kind === 'captions' && st?.fontId && !doc.fonts[st.fontId]) {
				delete st.fontId;
				note('reset-caption-font', c.id, 'caption style referenced a missing font');
			}
		}
	}
	{
		const before = new Set(Object.keys(doc.transcripts));
		normalizeCaptionOwnership(doc as Draft<ProjectDocument>, () => ids.next('trs'));
		for (const id of Object.keys(doc.transcripts))
			if (!before.has(id)) note('split-caption-transcript', id, 'shared caption transcript copied per clip');
	}

	// Bin tree: drop missing references and duplicates, reattach orphans at the root.
	const placed = new Set<string>();
	const cleanList = (list: string[], owner: string) =>
		list.filter((id) => {
			if (!doc.items[id] || placed.has(id)) {
				note('drop-reference', id, `removed from ${owner}`);
				return false;
			}
			placed.add(id);
			return true;
		});
	doc.rootItems = cleanList(doc.rootItems, 'rootItems');
	for (const it of Object.values(doc.items))
		if (it.kind === 'bin') it.children = cleanList(it.children, it.id);
	for (const it of Object.values(doc.items)) {
		const dangling =
			(it.kind === 'media' && !doc.media[it.mediaId]) ||
			(it.kind === 'synthetic' && !doc.synthetics[it.syntheticId]) ||
			(it.kind === 'subclip' && !doc.media[it.mediaId]) ||
			(it.kind === 'sequence' && !doc.sequences[it.sequenceId]);
		if (dangling) {
			delete doc.items[it.id];
			doc.rootItems = doc.rootItems.filter((x) => x !== it.id);
			for (const b of Object.values(doc.items))
				if (b.kind === 'bin') b.children = b.children.filter((x) => x !== it.id);
			note('drop-item', it.id, 'item referenced a missing entity');
			continue;
		}
		if (!placed.has(it.id)) {
			doc.rootItems.push(it.id);
			note('reparent', it.id, 'item was not in the bin tree; moved to the root');
		}
	}

	for (const seq of Object.values(doc.sequences) as Sequence[]) {
		if (seq.videoTracks.length === 0) {
			seq.videoTracks.push(createTrack(ids, 'video'));
			note('add-track', seq.id, 'added missing video track');
		}
		if (seq.audioTracks.length === 0) {
			seq.audioTracks.push(createTrack(ids, 'audio'));
			note('add-track', seq.id, 'added missing audio track');
		}
		repairAudioMix(seq, note);
		const trackIds = new Set([...seq.videoTracks, ...seq.audioTracks, ...seq.captionTracks].map((t) => t.id));
		for (const c of Object.values(seq.clips)) {
			const r = c as Record<string, unknown>;
			const missing =
				!trackIds.has(c.trackId) ||
				(typeof r.mediaId === 'string' && !doc.media[r.mediaId]) ||
				(typeof r.syntheticId === 'string' && !doc.synthetics[r.syntheticId]) ||
				(typeof r.transcriptId === 'string' && !doc.transcripts[r.transcriptId]) ||
				(isNestClip(c) && (typeof r.sequenceId !== 'string' || !doc.sequences[r.sequenceId]));
			if (missing) {
				delete seq.clips[c.id];
				note('drop-clip', c.id, 'clip referenced a missing track or source');
			}
		}
		// Overlaps: move the later clip to a new track directly above (video) / below (audio).
		for (const list of [seq.videoTracks, seq.audioTracks, seq.captionTracks]) {
			for (let ti = 0; ti < list.length; ti++) {
				const track = list[ti]!;
				const clips = Object.values(seq.clips)
					.filter((c) => c.trackId === track.id)
					.sort((a, b) => a.start - b.start);
				let lastEnd = Number.NEGATIVE_INFINITY;
				let spill: Track | null = null;
				for (const c of clips) {
					if (c.start < lastEnd) {
						if (!spill) {
							spill = createTrack(ids, track.kind);
							list.splice(ti + 1, 0, spill);
						}
						c.trackId = spill.id;
						note('move-overlap', c.id, `overlapping clip moved to new track ${spill.id}`);
					} else lastEnd = c.start + c.duration;
				}
			}
		}
		for (const kind of ['links', 'groups'] as const) {
			const field = kind === 'links' ? 'linkId' : 'groupId';
			for (const g of Object.values(seq[kind])) {
				g.members = g.members.filter((m) => seq.clips[m]);
				if (g.members.length < 2) {
					for (const m of g.members) (seq.clips[m] as Record<string, unknown>)[field] = null;
					delete seq[kind][g.id];
					note(`dissolve-${kind}`, g.id, 'group had fewer than two members');
				} else for (const m of g.members) (seq.clips[m] as Record<string, unknown>)[field] = g.id;
			}
			for (const c of Object.values(seq.clips)) {
				const v = (c as Record<string, unknown>)[field] as string | null;
				if (v && !seq[kind][v]) {
					(c as Record<string, unknown>)[field] = null;
					note('drop-reference', c.id, `dangling ${field}`);
				}
			}
		}
		for (const c of Object.values(seq.clips))
			for (const detail of repairRemap(c, seq.settings.frameRate as Rational, contentDurationFlicks(doc, c)))
				note('repair-time-remap', c.id, detail);
		// parity (roto): roto objects follow their clip's media (else their mattes are dropped), spans and bases
		// are made valid, and effect params naming a missing roto are reset to "none".
		for (const c of Object.values(seq.clips)) {
			const r = c as Record<string, unknown>;
			const rotos = r.rotos as ClipRoto[] | undefined;
			for (const ro of rotos ?? []) {
				if (ro.mediaId !== r.mediaId && typeof r.mediaId === 'string') {
					ro.mediaId = r.mediaId;
					ro.result = null;
					note('reset-roto', ro.id, 'roto belonged to another media: mattes dropped');
				}
				if (ro.span[1] < ro.span[0]) {
					ro.span = [ro.span[1], ro.span[0]];
					note('fix-roto', ro.id, 'span swapped');
				}
				if (ro.base !== null && (ro.base < ro.span[0] || ro.base > ro.span[1])) {
					ro.base = Math.min(ro.span[1], Math.max(ro.span[0], ro.base));
					note('fix-roto', ro.id, 'base frame clamped into the span');
				}
				if (ro.result && ro.result.end < ro.result.start) {
					ro.result = null;
					note('fix-roto', ro.id, 'invalid result dropped');
				}
			}
			const ids = new Set((rotos ?? []).map((x) => x.id));
			for (const fx of (r.effects as EffectInstance[] | undefined) ?? [])
				for (const name of ROTO_OBJECT_PARAMS[fx.effectId] ?? []) {
					const a = fx.params[name];
					if (a && typeof a.value === 'string' && a.value !== '' && !ids.has(a.value)) {
						a.value = '';
						a.keyframes = [];
						note('drop-reference', fx.id, `${name} named a missing roto`);
					}
				}
		}
		// wp masks: malformed masks (bad path / ranges) are removed; masks on track or master effects too.
		for (const c of Object.values(seq.clips)) {
			const r = c as { masks?: Mask[]; effects?: EffectInstance[] };
			for (const id of repairMaskList(r.masks)) note('drop-mask', c.id, `invalid mask ${id} removed`);
			if (r.masks && r.masks.length === 0) delete r.masks;
			for (const fx of r.effects ?? []) {
				for (const id of repairMaskList(fx.masks)) note('drop-mask', fx.id, `invalid mask ${id} removed`);
				if (fx.masks && fx.masks.length === 0) delete fx.masks;
				// sim-warp: invalid Puppet data is removed whole (the effect then passes the layer through).
				if (fx.puppet && puppetProblem(fx.puppet)) {
					note('drop-puppet', fx.id, `invalid puppet data removed: ${puppetProblem(fx.puppet)}`);
					delete fx.puppet;
				}
			}
		}
		for (const fx of [
			...[...seq.videoTracks, ...seq.audioTracks].flatMap((t) => t.effects ?? []),
			...seq.master.effects,
		])
			if (fx.puppet) {
				delete fx.puppet;
				note('drop-puppet', fx.id, 'puppet data on a track or master effect removed');
			}
		for (const fx of [
			...[...seq.videoTracks, ...seq.audioTracks].flatMap((t) => t.effects ?? []),
			...seq.master.effects,
		])
			if (fx.masks) {
				delete fx.masks;
				note('drop-mask', fx.id, 'masks on a track or master effect removed');
			}
		// wp masks: Track Matte Keys reading a missing / own track, or closing a cycle, lose their track.
		{
			const videoIds = new Set(seq.videoTracks.map((t) => t.id));
			const reach = (from: string, to: string, seen = new Set<string>()): boolean => {
				if (from === to) return true;
				if (seen.has(from)) return false;
				seen.add(from);
				for (const c of Object.values(seq.clips))
					if (c.trackId === from)
						for (const t of trackMatteTracksOf({
							effects: ((c as { effects?: EffectInstance[] }).effects ?? []) as never,
						}))
							if (reach(t, to, seen)) return true;
				return false;
			};
			for (const c of Object.values(seq.clips))
				for (const fx of (c as { effects?: EffectInstance[] }).effects ?? []) {
					if (fx.effectId !== TRACK_MATTE_EFFECT_ID) continue;
					for (const { param } of TRACK_MATTE_TRACK_PARAMS) {
						const a = fx.params[param];
						if (!a) continue;
						const bad = (v: unknown) =>
							typeof v === 'string' &&
							v !== '' &&
							(!videoIds.has(v) || v === c.trackId || reach(v, c.trackId));
						if ([a.value, ...a.keyframes.map((k) => k.value)].some(bad)) {
							a.value = '';
							a.keyframes = [];
							note(
								'clear-track-matte',
								fx.id,
								`track matte ${param === 'matteTrack' ? 'matte' : 'clean plate'} referenced a missing track or formed a cycle`,
							);
						}
					}
				}
		}
		// M2 (wp-m2-text-anim, S11:TXA-008): animator params a known preset rejects are reset to its defaults.
		for (const c of Object.values(seq.clips)) {
			if (c.kind !== 'text' || !c.textAnimation) continue;
			for (const side of ['in', 'out'] as const) {
				const a = c.textAnimation[side];
				if (!a || !invalidAnimatorParams(a)) continue;
				a.params = { ...getTextAnimationSpec(a.preset, a.version)!.defaults };
				note(
					'reset-params',
					c.id,
					`${side} animation ${a.preset}@${a.version}: invalid params reset to defaults`,
				);
			}
		}
		for (const t of Object.values(seq.transitions)) {
			if (
				(t.outgoingClipId && !seq.clips[t.outgoingClipId]) ||
				(t.incomingClipId && !seq.clips[t.incomingClipId]) ||
				!trackIds.has(t.trackId)
			) {
				delete seq.transitions[t.id];
				note('drop-transition', t.id, 'transition referenced a missing clip or track');
			}
		}
	}
	// wp-multicam: angles keep only existing tracks; selections fall back to an existing angle.
	for (const seq of Object.values(doc.sequences) as Sequence[]) {
		if (!seq.multicam) continue;
		const ids0 = new Set<string>();
		seq.multicam.angles = seq.multicam.angles.filter((a) => {
			if (ids0.has(a.id)) {
				note('drop-angle', seq.id, `duplicate angle id ${a.id} removed`);
				return false;
			}
			ids0.add(a.id);
			return true;
		});
		const seenVideo = new Set<string>();
		for (const a of seq.multicam.angles) {
			if (a.videoTrackId && seenVideo.has(a.videoTrackId)) a.videoTrackId = null;
			if (a.videoTrackId) seenVideo.add(a.videoTrackId);
		}
		for (const id of pruneMulticamAngles(seq)) note('drop-angle', seq.id, `angle ${id} had no tracks left`);
	}
	for (const id of fixMulticamSelections(doc))
		note('fix-multicam', id, 'multi-camera selection pointed at a missing angle or source');
	for (const seq of Object.values(doc.sequences) as Sequence[])
		for (const c of Object.values(seq.clips)) {
			const r = c as Record<string, unknown>;
			if (r.multicam !== undefined && c.kind !== 'nest-video' && c.kind !== 'nest-audio') {
				delete r.multicam;
				note('fix-multicam', c.id, 'multi-camera selection on a clip that is not a nest');
			}
		}

	// edit-structure (INV-009): nest clips that close a nesting cycle are removed (the first found, until acyclic).
	for (;;) {
		const cycle = findNestCycleClip(doc);
		if (!cycle) break;
		delete doc.sequences[cycle.seqId]!.clips[cycle.clipId];
		note('drop-clip', cycle.clipId, 'nest clip formed a nesting cycle');
		for (const t of Object.values(doc.sequences[cycle.seqId]!.transitions))
			if (t.outgoingClipId === cycle.clipId || t.incomingClipId === cycle.clipId)
				delete doc.sequences[cycle.seqId]!.transitions[t.id];
		const seq = doc.sequences[cycle.seqId]!;
		for (const kind of ['links', 'groups'] as const) {
			const field = kind === 'links' ? 'linkId' : 'groupId';
			for (const g of Object.values(seq[kind])) {
				g.members = g.members.filter((m) => m !== cycle.clipId && seq.clips[m]);
				if (g.members.length >= 2) continue;
				for (const m of g.members) (seq.clips[m] as Record<string, unknown>)[field] = null;
				delete seq[kind][g.id];
			}
		}
	}
	// edit-structure: frame holds on clips that cannot have one are removed.
	for (const seq of Object.values(doc.sequences))
		for (const c of Object.values(seq.clips)) {
			if (c.frameHold === undefined) continue;
			const caps = kindCapabilities(c.kind);
			const ok =
				!!caps &&
				caps.trackKind === 'video' &&
				c.kind !== 'adjustment' &&
				Number.isInteger(c.frameHold.flicks) &&
				c.frameHold.flicks >= 0;
			if (!ok) {
				delete c.frameHold;
				note('drop-frame-hold', c.id, 'invalid frame hold removed');
			}
		}
	// edit-ux: a subclip whose parent item is gone keeps its media; clips drop a dangling `subclipId`.
	for (const it of Object.values(doc.items)) {
		if (it.kind === 'subclip' && it.parentItemId !== null && doc.items[it.parentItemId]?.kind !== 'media') {
			it.parentItemId = null;
			note('clear-parent', it.id, 'subclip parent item is missing');
		}
	}
	for (const seq of Object.values(doc.sequences) as Sequence[]) {
		for (const c of Object.values(seq.clips)) {
			if (c.subclipId !== undefined && doc.items[c.subclipId]?.kind !== 'subclip') {
				delete c.subclipId;
				note('clear-subclip', c.id, 'clip referenced a missing subclip');
			}
		}
	}
	// Leaked media/synthetics get a project item so nothing silently disappears (INV-014).
	const usedMedia = new Set<string>();
	const usedSyn = new Set<string>();
	for (const it of Object.values(doc.items)) {
		if (it.kind === 'media' || it.kind === 'subclip') usedMedia.add(it.mediaId);
		if (it.kind === 'synthetic') usedSyn.add(it.syntheticId);
	}
	for (const seq of Object.values(doc.sequences)) {
		for (const c of Object.values(seq.clips)) {
			const r = c as Record<string, unknown>;
			if (typeof r.mediaId === 'string') usedMedia.add(r.mediaId);
			const comp = r.composition as { mediaId?: unknown } | undefined;
			if (typeof comp?.mediaId === 'string') usedMedia.add(comp.mediaId);
			for (const id of clipParamMediaIds(c)) usedMedia.add(id);
			if (typeof r.syntheticId === 'string') usedSyn.add(r.syntheticId);
		}
	}
	for (const m of Object.values(doc.media)) if (m.derivation) usedMedia.add(m.derivation.fromMediaId);
	for (const f of Object.values(doc.fonts)) if (f.source.type === 'asset') usedMedia.add(f.source.mediaId);
	for (const id of projectLookMediaIds(doc)) usedMedia.add(id);
	for (const m of Object.values(doc.media)) {
		if (usedMedia.has(m.id)) continue;
		const itemId = ids.next('itm');
		doc.items[itemId] = {
			id: itemId,
			kind: 'media',
			name: m.originalName,
			mediaId: m.id,
			label: 'iris',
			marks: { in: null, out: null },
		};
		doc.rootItems.push(itemId);
		note('add-item', m.id, 'unreferenced media got a project item');
	}
	for (const s of Object.values(doc.synthetics)) {
		if (usedSyn.has(s.id)) continue;
		delete doc.synthetics[s.id];
		note('drop-synthetic', s.id, 'unreferenced synthetic source removed');
	}
	// Sequences without a project item get one.
	for (const s of Object.keys(doc.sequences)) {
		if (!Object.values(doc.items).some((it) => it.kind === 'sequence' && it.sequenceId === s)) {
			const itemId = ids.next('itm');
			doc.items[itemId] = {
				id: itemId,
				kind: 'sequence',
				name: 'Recovered Sequence',
				sequenceId: s,
				label: 'forest',
			};
			doc.rootItems.push(itemId);
			note('add-item', s, 'sequence had no project item');
		}
	}
	// color-mgmt: unknown spaces and dangling LUT / OCIO references go back to automatic.
	repairColor(doc as never, note);
	// gaps: unreadable project settings, dangling proxies, channel maps, analyses, graphic layers.
	repairGaps(doc, note);
	for (const seq of Object.values(doc.sequences) as Sequence[]) repairTransitionsFinal(seq, note);
	// sound-design: unreadable cues / clip metadata, dangling anchors, placed clips and cue links, duplicate cue ids.
	// Last: its soft references must see every clip, transition and marker the passes above removed (idempotence).
	repairSoundDesign(doc, ids, note);
	return { document: doc, report };
}

/** edit-structure: which synthetic sources a clip kind can show (AST-010). */
export function syntheticFitsClip(clipKind: string, synKind: string): boolean {
	if (clipKind === 'adjustment') return synKind === 'adjustment';
	if (clipKind === 'solid') return synKind !== 'adjustment';
	if (clipKind === 'synthetic-audio') return synKind === 'bars-and-tone' || synKind === 'counting-leader';
	return true;
}

/** A nest clip on a nesting cycle (INV-009), or null. */
function findNestCycleClip(doc: ProjectDocument): { seqId: string; clipId: string } | null {
	const state = new Map<string, 1 | 2>();
	let hit: { seqId: string; clipId: string } | null = null;
	const visit = (s: string): boolean => {
		state.set(s, 1);
		const seq = doc.sequences[s];
		for (const c of Object.values(seq?.clips ?? {})) {
			if (!isNestClip(c)) continue;
			const n = (c as { sequenceId: string }).sequenceId;
			if (!doc.sequences[n]) continue;
			if (state.get(n) === 1) {
				hit = { seqId: s, clipId: c.id };
				return true;
			}
			if (!state.has(n) && visit(n)) return true;
		}
		state.set(s, 2);
		return false;
	};
	for (const s of Object.keys(doc.sequences)) if (!state.has(s) && visit(s)) return hit;
	return null;
}

/**
 * Hidden takes: why a transcript's `redecoded` (`{createdAt, ranges}`) is malformed or marks an earlier recognition
 * than the transcript's (`createdAt` differs: a build that predates the field transcribed the media again), or null.
 */
function redecodedProblem(t: { redecoded?: unknown; createdAt?: unknown }): string | null {
	const r = t.redecoded;
	if (r === undefined) return null;
	if (!r || typeof r !== 'object' || Array.isArray(r)) return 'redecoded is not {createdAt, ranges}';
	const { createdAt, ranges } = r as { createdAt?: unknown; ranges?: unknown };
	if (typeof createdAt !== 'string' || createdAt !== t.createdAt)
		return 'redecoded ranges belong to another recognition than the words';
	if (!Array.isArray(ranges) || !ranges.length) return 'redecoded has no ranges';
	if (ranges.length > MAX_TRANSCRIPT_REDECODED)
		return `more than ${MAX_TRANSCRIPT_REDECODED} redecoded ranges`;
	return coverageProblem(ranges, 'redecoded');
}

/**
 * wp speech: why a transcript's `coverage` (absent = the whole media) — or another of its range lists, named
 * `label` (`redecoded`) — is malformed, or null.
 */
export function coverageProblem(coverage: unknown, label = 'coverage'): string | null {
	if (coverage === undefined) return null;
	if (!Array.isArray(coverage)) return `${label} is not a list of ranges`;
	let prev = -1;
	for (const r of coverage) {
		if (!Array.isArray(r) || r.length !== 2 || !Number.isInteger(r[0]) || !Number.isInteger(r[1]))
			return `${label} ranges must be [start, end] integer flicks`;
		if (r[0] < 0 || r[1] <= r[0]) return `a ${label} range is empty or negative`;
		if (r[0] <= prev) return `${label} ranges are not sorted and disjoint`;
		prev = r[1];
	}
	return null;
}

/** Wave expressions: audio effects take no expressions (the mixer processes them per sample). */
export function isAudioEffectId(effectId: string): boolean {
	return defaultEffectRegistry.get(effectId)?.appliesTo === 'audio';
}
