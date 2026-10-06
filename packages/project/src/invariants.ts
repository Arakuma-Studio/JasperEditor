// Document invariants INV-001…INV-015 (S01 §16.3, with the ARCHITECTURE §2.3 locked-track change:
// locked tracks never shift, so there is no invariant about them) and conservative load-time repairs
// (S01:PER-004).
import type { Issue } from './commands/types.ts';
import { clipEnd } from './derive/index.ts';
import { createTrack } from './factories.ts';
import { type IdPrefix, type IdSource, idPrefixOf, isValidId } from './ids.ts';
import type { EffectRegistry } from './registry/effects.ts';
import { contentDurationFlicks, isBoundedContent, trackKindFor } from './registry/kinds.ts';
import type { MgTemplateRegistry } from './registry/mg.ts';
import { SPATIAL_INTERPOLATIONS } from './schema/common.ts';
import type { ProjectDocument } from './schema/document.ts';
import type { Clip, EffectInstance, Sequence, Track } from './schema/sequence.ts';
import { isKnownClipKind } from './schema/sequence.ts';
import { ROTO_OBJECT_PARAMS } from './roto/index.ts';
import type { ClipRoto } from './schema/sequence.ts';
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
	for (const it of Object.values(doc.items)) {
		if ((it.kind === 'bin') !== (idPrefixOf(it.id) === 'bin'))
			issues.push(inv('INV-001', `Item ${it.id} prefix does not match its kind`, ['items', it.id]));
	}
	table(doc.media, 'media', 'med');
	table(doc.synthetics, 'synthetics', 'syn');
	table(doc.transcripts, 'transcripts', 'trs');
	table(doc.fonts, 'fonts', 'fnt');
	table(doc.sequences, 'sequences', 'seq');

	const effects = (list: readonly EffectInstance[] | undefined, where: string[]) => {
		for (const fx of list ?? []) {
			claim(fx.id, 'fx', [...where, fx.id]);
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
	}

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
				effects(t.effects, [...where, 'tracks', t.id, 'effects']);
				anims(t, [...where, 'tracks', t.id]);
			}
		}
		effects(seq.master.effects, [...where, 'master', 'effects']);
		anims(seq.master, [...where, 'master']);
		for (const m of seq.markers) claim(m.id, 'mrk', [...where, 'markers', m.id]);

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
				else if (isBoundedContent(c) && asset.probe.durationFlicks !== null) {
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
				if (!doc.synthetics[r.syntheticId])
					issues.push(inv('INV-006', `Clip ${c.id} references missing synthetic`, cw));
			}
			if (typeof r.transcriptId === 'string') {
				usedTrs.add(r.transcriptId);
				if (!doc.transcripts[r.transcriptId])
					issues.push(inv('INV-006', `Clip ${c.id} references missing transcript`, cw));
			}
			if (typeof r.sequenceId === 'string' && isKnownClipKind(c.kind)) {
				if (!doc.sequences[r.sequenceId])
					issues.push(inv('INV-006', `Clip ${c.id} references missing sequence`, cw));
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
						issues.push(inv('INV-006', `${fx.effectId}.${name} names a missing roto ${v}`, [...cw, 'effects', fx.id]));
				}
			}
			if (isKnownClipKind(c.kind)) {
				effects(r.effects as EffectInstance[] | undefined, [...cw, 'effects']);
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
	return issues;
}

/** M2 (wp-m2-text-anim, S11:TXA-008): a known preset whose stored params its schema rejects. */
function invalidAnimatorParams(a: unknown): boolean {
	const x = a as { preset?: unknown; version?: unknown; params?: unknown } | null | undefined;
	if (!x || typeof x.preset !== 'string' || typeof x.version !== 'number') return false;
	const spec = getTextAnimationSpec(x.preset, x.version);
	return !!spec && !spec.paramsSchema.safeParse(x.params).success;
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
		const trackIds = new Set([...seq.videoTracks, ...seq.audioTracks, ...seq.captionTracks].map((t) => t.id));
		for (const c of Object.values(seq.clips)) {
			const r = c as Record<string, unknown>;
			const missing =
				!trackIds.has(c.trackId) ||
				(typeof r.mediaId === 'string' && !doc.media[r.mediaId]) ||
				(typeof r.syntheticId === 'string' && !doc.synthetics[r.syntheticId]) ||
				(typeof r.transcriptId === 'string' && !doc.transcripts[r.transcriptId]);
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
