// Document invariants INV-001…INV-015 (S01 §16.3, with the ARCHITECTURE §2.3 locked-track change:
// locked tracks never shift, so there is no invariant about them) and conservative load-time repairs
// (S01:PER-004).

import type { Draft } from 'immer';
import { audioMixIssues, repairAudioMix } from './audio/invariants.ts';
import { normalizeCaptionOwnership } from './captions/model.ts';
import { mergeRanges } from './captions/sequence-transcript.ts';
import { normalizeWords, wordsWellFormed } from './captions/words.ts';
import type { Issue } from './commands/types.ts';
import { clipEnd } from './derive/index.ts';
import { ESSENTIAL_SLOTS, EssentialSoundSchema, readEssentialSound } from './essential/model.ts';
import { expressionIssues, repairExpressions } from './expressions.ts';
import { createTrack } from './factories.ts';
import { type IdPrefix, type IdSource, idPrefixOf, isValidId } from './ids.ts';
import { isRovingKey, retimeRoving } from './keyframes.ts';
import { MASK_EXPANSION_RANGE, MASK_FEATHER_RANGE, MASK_OPACITY_RANGE } from './masks/model.ts';
import { TRACK_MATTE_EFFECT_ID, trackMatteTracksOf } from './masks/track-matte.ts';
import {
	angleById,
	fixMulticamSelections,
	multicamSourceIssues,
	multicamSourceOf,
	pruneMulticamAngles,
} from './multicam/model.ts';
import { type BezierPath, isBezierPath, segmentCount } from './path/model.ts';
import type { EffectRegistry } from './registry/effects.ts';
import { defaultEffectRegistry } from './registry/effects.ts';
import { contentDurationFlicks, isBoundedContent, kindCapabilities, trackKindFor } from './registry/kinds.ts';
import type { MgTemplateRegistry } from './registry/mg.ts';
import { ROTO_OBJECT_PARAMS } from './roto/index.ts';
import { type Animatable, type Keyframe, SPATIAL_INTERPOLATIONS } from './schema/common.ts';
import type { ProjectDocument } from './schema/document.ts';
import { MASK_MODES, type Mask } from './schema/mask.ts';
import type { AudioClip, Clip, ClipRoto, EffectInstance, Sequence, Track } from './schema/sequence.ts';
import { isKnownClipKind } from './schema/sequence.ts';
import { isNestClip } from './structure/nest.ts';
import { getTextAnimationSpec } from './text-animations.ts';
import {
	contentSpanFlicks,
	flicksPerFrame,
	isAllowedSequenceRate,
	type Rational,
	supportsDropFrame,
} from './time.ts';

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
	if (isAnimLike(root)) {
		cb(root, path);
		return;
	}
	if (Array.isArray(root)) {
		root.forEach((v, i) => {
			forEachAnimatable(v, [...path, String(i)], cb);
		});
	} else if (root && typeof root === 'object') {
		for (const [k, v] of Object.entries(root)) forEachAnimatable(v, [...path, k], cb);
	}
}

function valueShape(v: unknown): string {
	if (typeof v === 'number') return 'number';
	if (Array.isArray(v)) return `array${v.length}`;
	return typeof v;
}

export type InvariantOptions = {
	effects?: EffectRegistry;
	/** wp-m2-anime-templates (S11:ATP-002): checks renderer stamps against known templates when given. */
	mgTemplates?: MgTemplateRegistry;
};

// ---- wp-m2-anime-templates (S11:ATP-002): the renderer stamp of a motion-graphic clip must agree with a known
// registry entry (absent = fframes); unknown templates keep whatever they carry (preserved, KND-030 spirit).
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
// ---- end wp-m2-anime-templates

export function checkInvariants(doc: ProjectDocument, opts: InvariantOptions = {}): Issue[] {
	const issues: Issue[] = [];
	const seen = new Set<string>();
	const claim = (id: string, prefix: IdPrefix | IdPrefix[], where: string[]) => {
		const prefixes = Array.isArray(prefix) ? prefix : [prefix];
		if (!isValidId(id) || !prefixes.includes(idPrefixOf(id)!)) {
			issues.push(inv('INV-001', `Malformed id ${id} (expected ${prefixes.join('/')}_…)`, where));
		}
		if (seen.has(id)) issues.push(inv('INV-001', `Duplicate id ${id}`, where));
		else seen.add(id);
	};

	// INV-001: ids, record keys
	claim(doc.projectId, 'prj', ['projectId']);
	const table = (rec: Record<string, { id: string }>, name: string, prefix: IdPrefix | IdPrefix[]) => {
		for (const [key, v] of Object.entries(rec)) {
			if (v.id !== key) issues.push(inv('INV-001', `Key ${key} does not match id ${v.id}`, [name, key]));
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
	for (const f of Object.values(doc.fonts)) {
		if (f.source.type === 'asset' && !doc.media[f.source.mediaId])
			issues.push(inv('INV-006', `Font ${f.id} references missing media`, ['fonts', f.id]));
	}
	for (const m of Object.values(doc.media)) {
		if (m.derivation && !doc.media[m.derivation.fromMediaId])
			issues.push(inv('INV-006', `Derived media ${m.id} references missing source`, ['media', m.id]));
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
	}
	const captionTrsUsers = new Map<string, number>();

	// Sequences
	const usedMedia = new Set<string>();
	const usedSyn = new Set<string>();
	const usedTrs = new Set<string>();
	const nestEdges = new Map<string, Set<string>>();
	for (const seq of Object.values(doc.sequences)) {
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
		for (const m of seq.markers) claim(m.id, 'mrk', [...where, 'markers', m.id]);
		// wp-multicam: a multi-camera source's angles reference its own tracks.
		const mcSource = (seq as Sequence).multicam;
		if (mcSource)
			for (const problem of multicamSourceIssues(seq, mcSource))
				issues.push(inv('INV-006', `Multi-camera source ${problem}`, [...where, 'multicam']));

		const rate = s.frameRate as Rational;
		const byTrack = new Map<string, Clip[]>();
		for (const [key, c] of Object.entries(seq.clips)) {
			const cw = [...where, 'clips', key];
			if (c.id !== key) issues.push(inv('INV-001', `Key ${key} does not match clip id ${c.id}`, cw));
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
			const r = c as Record<string, unknown>;
			// INV-006 references
			if (typeof r.mediaId === 'string') {
				usedMedia.add(r.mediaId);
				const asset = doc.media[r.mediaId];
				if (!asset) issues.push(inv('INV-006', `Clip ${c.id} references missing media ${r.mediaId}`, cw));
				else if (c.frameHold && isBoundedContent(c) && asset.probe.durationFlicks !== null) {
					// edit-structure: a held clip shows one frame; only that frame must exist.
					if (c.frameHold.flicks >= asset.probe.durationFlicks + flicksPerFrame(rate) + 1)
						issues.push(inv('INV-005', `Clip ${c.id} holds a frame outside its media`, cw));
				} else if (isBoundedContent(c) && asset.probe.durationFlicks !== null) {
					// INV-005 media bounds with one frame of tolerance
					const span = contentSpanFlicks(c.duration, rate, c.speed.rate);
					const tol = flicksPerFrame(rate) * c.speed.rate + 1;
					if (c.sourceIn + span > asset.probe.durationFlicks + tol) {
						issues.push(
							inv(
								'INV-005',
								`Clip ${c.id} exceeds its media (${c.sourceIn + span} > ${asset.probe.durationFlicks})`,
								cw,
							),
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
					issues.push(
						inv('INV-006', `Clip ${c.id} references ${comp.mediaId}, which is not an mg-bundle`, cw),
					);
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
				else {
					// INV-005 for nests: inside the nested sequence's duration (KND-011).
					const dur = contentDurationFlicks(doc, c);
					const span = contentSpanFlicks(c.duration, rate, c.speed.rate);
					const tol = flicksPerFrame(rate) * c.speed.rate + 1;
					if (dur !== null && !c.frameHold && c.sourceIn + span > dur + tol)
						issues.push(
							inv('INV-005', `Clip ${c.id} exceeds its nested sequence (${c.sourceIn + span} > ${dur})`, cw),
						);
				}
				const set = nestEdges.get(seq.id) ?? new Set<string>();
				set.add(r.sequenceId);
				nestEdges.set(seq.id, set);
			}
			const content = r.content as { style?: { fontId?: string } } | undefined;
			if (c.kind === 'text' && content?.style?.fontId && !doc.fonts[content.style.fontId]) {
				issues.push(inv('INV-006', `Clip ${c.id} references missing font ${content.style.fontId}`, cw));
			}
			// M2 (S11:TXA-008): animator windows are whole frames ≥ 1; known presets have valid params (unknown
			// presets are preserved and skipped by the renderers).
			const ta = r.textAnimation as
				| Record<string, { durationFrames?: unknown } | null | undefined>
				| undefined;
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
			// M2 (S11:SHP-001): shape geometry is non-negative.
			if (c.kind === 'shape') {
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
			// ---- wp-m2-anime-templates (S11:ATP-002/006): renderer stamp and template param keyframes
			if (c.kind === 'motion-graphic') {
				const stamp = templateStampIssue(c, opts.mgTemplates);
				if (stamp) issues.push(inv('INV-012', `Clip ${c.id} ${stamp}`, [...cw, 'template']));
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
					}
				}
			}
			// ---- end wp-m2-anime-templates
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
		}
		// wp masks: Track Matte Key tracks exist, are other video tracks, and mattes form no cycle.
		{
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
		}
		// INV-003 overlaps
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
		// INV-007 link and clip groups
		for (const [key, l] of Object.entries(seq.links)) {
			claim(l.id, 'lnk', [...where, 'links', key]);
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
		}
		for (const [key, g] of Object.entries(seq.groups)) {
			claim(g.id, 'grp', [...where, 'groups', key]);
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
		}
		// INV-010 transitions
		const edgeUse = new Set<string>();
		for (const [key, t] of Object.entries(seq.transitions)) {
			const tw = [...where, 'transitions', key];
			claim(t.id, 'trn', tw);
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
			// A fade at a clip's head uses only its `in` edge, a fade at the tail only its `out` edge.
			for (const k of [out ? `${out.id}:out` : null, inc ? `${inc.id}:in` : null]) {
				if (!k) continue;
				if (edgeUse.has(k)) issues.push(inv('INV-010', `Two transitions on the same clip edge (${k})`, tw));
				edgeUse.add(k);
			}
		}
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
		if (it.kind === 'media') usedMedia.add(it.mediaId);
		if (it.kind === 'synthetic') usedSyn.add(it.syntheticId);
	}
	for (const m of Object.values(doc.media)) if (m.derivation) usedMedia.add(m.derivation.fromMediaId);
	for (const f of Object.values(doc.fonts)) if (f.source.type === 'asset') usedMedia.add(f.source.mediaId);
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
	return issues;
}

/** audio-fx: problems of Essential Sound settings, essential effects and remix pieces (see repairDocument). */
function essentialIssues(doc: ProjectDocument): { message: string; path: string[] }[] {
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

// ---------------------------------------------------------------- repair (S01:PER-004)

export type RepairEntry = { action: string; entity: string; detail: string };

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
	const doc = JSON.parse(JSON.stringify(input)) as ProjectDocument;
	const report: RepairEntry[] = [];
	const note = (action: string, entity: string, detail: string) => report.push({ action, entity, detail });

	// ---- wp-m2-anime-templates (S11:ATP-002/006): re-stamp renderers from the registry; drop malformed param
	// keyframe lists (unsorted / duplicate times / wrong value type) — the static params stay.
	for (const seq of Object.values(doc.sequences) as Sequence[]) {
		for (const c of Object.values(seq.clips)) {
			if (c.kind !== 'motion-graphic') continue;
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
				if (ok && list.length > 0) continue;
				delete pk[name];
				if (list.length > 0) note('drop-keyframes', c.id, `malformed keyframes of params.${name} removed`);
			}
			if (Object.keys(pk).length === 0) delete c.paramKeyframes;
		}
	}
	// ---- end wp-m2-anime-templates

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
			for (const fx of a.effects)
				if (
					fx.essential !== undefined &&
					(!ESSENTIAL_SLOTS.includes(fx.essential as never) || a.essential === undefined)
				) {
					delete fx.essential;
					note('drop-essential-mark', fx.id, 'essential marker without settings removed (the effect stays)');
				}
			if (a.remix) remixes.set(a.remix.id, [...(remixes.get(a.remix.id) ?? []), a]);
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
	for (const seq of Object.values(doc.sequences) as Sequence[])
		forEachAnimatable(seq, [seq.id], (a, path) => {
			const kfs = a.keyframes as unknown as Keyframe<unknown>[];
			if (!kfs.some((k) => k.roving)) return;
			const bad = kfs.filter((k, i) => k.roving && !isRovingKey(kfs, i)).map((k) => k.id);
			retimeRoving(kfs);
			for (const id of bad) note('drop-roving', id, `${path.join('.')}: the key cannot rove`);
		});
	// ---- wp captions: well-formed transcript words, an existing active caption track, caption fonts, and one clip
	// per caption transcript.
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
	// ---- end wp captions

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
			}
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
					if (fx.effectId !== TRACK_MATTE_EFFECT_ID || !fx.params.matteTrack) continue;
					const a = fx.params.matteTrack;
					const bad = (v: unknown) =>
						typeof v === 'string' && v !== '' && (!videoIds.has(v) || v === c.trackId || reach(v, c.trackId));
					if ([a.value, ...a.keyframes.map((k) => k.value)].some(bad)) {
						a.value = '';
						a.keyframes = [];
						note('clear-track-matte', fx.id, 'track matte referenced a missing track or formed a cycle');
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
	// Leaked media/synthetics get a project item so nothing silently disappears (INV-014).
	const usedMedia = new Set<string>();
	const usedSyn = new Set<string>();
	for (const it of Object.values(doc.items)) {
		if (it.kind === 'media') usedMedia.add(it.mediaId);
		if (it.kind === 'synthetic') usedSyn.add(it.syntheticId);
	}
	for (const seq of Object.values(doc.sequences)) {
		for (const c of Object.values(seq.clips)) {
			const r = c as Record<string, unknown>;
			if (typeof r.mediaId === 'string') usedMedia.add(r.mediaId);
			const comp = r.composition as { mediaId?: unknown } | undefined;
			if (typeof comp?.mediaId === 'string') usedMedia.add(comp.mediaId);
			if (typeof r.syntheticId === 'string') usedSyn.add(r.syntheticId);
		}
	}
	for (const m of Object.values(doc.media)) if (m.derivation) usedMedia.add(m.derivation.fromMediaId);
	for (const f of Object.values(doc.fonts)) if (f.source.type === 'asset') usedMedia.add(f.source.mediaId);
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

/** wp speech: why a transcript's `coverage` is malformed, or null (absent = the whole media). */
export function coverageProblem(coverage: unknown): string | null {
	if (coverage === undefined) return null;
	if (!Array.isArray(coverage)) return 'coverage is not a list of ranges';
	let prev = -1;
	for (const r of coverage) {
		if (!Array.isArray(r) || r.length !== 2 || !Number.isInteger(r[0]) || !Number.isInteger(r[1]))
			return 'coverage ranges must be [start, end] integer flicks';
		if (r[0] < 0 || r[1] <= r[0]) return 'a coverage range is empty or negative';
		if (r[0] <= prev) return 'coverage ranges are not sorted and disjoint';
		prev = r[1];
	}
	return null;
}

/** Wave expressions: audio effects take no expressions (the mixer processes them per sample). */
function isAudioEffectId(effectId: string): boolean {
	return defaultEffectRegistry.get(effectId)?.appliesTo === 'audio';
}
