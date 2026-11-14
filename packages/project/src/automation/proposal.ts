// Proposal items of the editing-automation passes (spec 15 EA-002…EA-004, EA-020…EA-022, EA-032; producer checklist
// in docs/wp-notes/edit-automation.md): one item per decoration in the pass's Review group, one batch command for its
// picture part (`clip.addAdjustmentBatch` / `keyframe.addBatch`) plus its sound (cue, placement, trims), setup items for
// the new FX / ZOOM track and the library sounds, `meta` with the frame, range, why-line, seed (Reroll), anchors
// (`anchorOn`: the decorated clips and the cut) and the export cost; alternatives = other families / sizes /
// directions with the same temp refs. The pass's parameters travel in the proposal's report for the refresher. Pure.
import type { BatchEffect } from '../commands/schemas/batch.ts';
import { EDIT_AUTOMATION_FEATURE } from '../proposals/features.ts';
import type { ProposalItemInput } from '../proposals/schema.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Sequence } from '../schema/sequence.ts';
import {
	SOUND_PROPOSAL_SETUP_GROUP,
	type SoundProposalMedia,
	soundSetupItems,
} from '../sound/proposal-draft.ts';
import { frameGeometry } from './common.ts';
import type { DecoratePlan, KitChoice, KitPlacement } from './decorate-cuts.ts';
import type { KenBurnsPlacement, KenBurnsPlan } from './ken-burns.ts';
import { AUTOMATION_PASS_GROUP, type AutomationPass } from './params.ts';
import type { MotionPlan, PunchPlacement, PunchPlan } from './punch-ins.ts';
import { editAnchor, placedSpan, type SfxMediaInfo, sfxCommands, sfxMediaInfo } from './sfx.ts';

/** Export cost class of a pass's output (EA-033). */
export type AutomationCost = {
	/**
	 * `native`: Motion keys, clips and audio the native ffmpeg export draws; `hybrid`: the export stays native with the
	 * decorated layers or transition spans pre-rendered by the layer bake (Remotion) — clips with GPU effects (S_Shake,
	 * Noise) and GPU transitions (Smooth Slide); without the layer bake the export takes the Remotion path; `remotion`:
	 * adjustment clips with GPU effects — the export planner sends the whole export through the Remotion renderer (no
	 * native or layer-bake route draws an adjustment layer's shader effects).
	 */
	class: 'native' | 'hybrid' | 'remotion';
	/** Frames the decorations cover. */
	frames: number;
	/** Effects that need the Remotion path. */
	effects: string[];
};

/** The setup item of a new video track for the pass's adjustment clips. */
export const FX_TRACK_ITEM = 'fx-track';
export const ZOOM_TRACK_ITEM = 'zoom-track';
const FX_TRACK_REF = '$fxTrack';
const ZOOM_TRACK_REF = '$zoomTrack';

/** Effects the native export draws on an adjustment layer (crop and flips, `BUILTIN_NATIVE_EFFECTS`). */
const NATIVE_EFFECTS: ReadonlySet<string> = new Set([
	'jasper.crop',
	'jasper.flip-horizontal',
	'jasper.flip-vertical',
]);

function effectsCost(effects: readonly BatchEffect[], frames: number): AutomationCost {
	const remote = [...new Set(effects.map((e) => e.effectId).filter((id) => !NATIVE_EFFECTS.has(id)))];
	return { class: remote.length ? 'remotion' : 'native', frames, effects: remote };
}

/** Library sounds a pass places: the registered media (from the engine) and the pick per item id. */
export type PassSfx = {
	media: readonly SoundProposalMedia[];
	assign: ReadonlyMap<string, { soundId: string; gainOffsetDb: number }>;
	type: string;
	gainDb?: number;
};

export type PassItems = {
	items: ProposalItemInput[];
	cost: AutomationCost;
	/** Items whose sound could not be planned (placed without one). */
	unsounded: string[];
};

const binName = 'Sound Effects';

export function soundSetup(doc: ProjectDocument, sfx: PassSfx | undefined, order: readonly string[]) {
	if (!sfx)
		return { items: [] as ProposalItemInput[], mediaOf: new Map<string, string>(), setupOf: new Map() };
	const ids: string[] = [];
	for (const id of order) {
		const a = sfx.assign.get(id);
		if (a) ids.push(a.soundId);
	}
	return soundSetupItems(doc, sfx.media, ids, { binName });
}

/** The media info (provenance, length) of a sound for its placement span. */
function mediaInfoOf(doc: ProjectDocument, sfx: PassSfx, soundId: string, mediaRef: string) {
	const m = sfx.media.find((x) => x.soundId === soundId);
	if (mediaRef.startsWith('$')) return sfxMediaInfo(m ? { ...m.register.asset, library: m.library } : null);
	return sfxMediaInfo(doc.media[mediaRef] ?? (m ? { ...m.register.asset, library: m.library } : null));
}

// ---------------------------------------------------------------------------------------------------------------
// Decorate Cuts

/** A temp-ref safe key of an item id (`kit:120` → `kit_120`): refs stay the item's own across Refresh / Reroll. */
export const refKey = (itemId: string) => itemId.replace(/[^\w.-]/g, '_');

/** The commands of a kit (its adjustment clips on the FX track, then its whoosh). */
function kitCommands(
	seq: Sequence,
	choice: KitChoice,
	trackRef: string,
	sound: Record<string, unknown>[] | null,
): Record<string, unknown>[] {
	return [
		{
			type: 'clip.addAdjustmentBatch',
			sequenceId: seq.id,
			trackId: trackRef,
			items: choice.clips.map((c) => ({
				start: c.start,
				length: c.length,
				name: c.name,
				effects: c.effects,
			})),
		},
		...(sound ?? []),
	];
}

const kitWhy = (k: KitChoice, timecode: string, sound: string | null) =>
	`${k.variantLabel} kit on the cut at ${timecode} (${k.before} + ${k.after} frames)${sound ? ` + whoosh “${sound}”` : ''}`;

/** The sound of one item: its media (a project id or the `$ref` of its setup item) and what placement reads of it. */
export type ItemSound = {
	mediaId: string;
	info: SfxMediaInfo;
	soundId: string;
	title: string | null;
	type: string;
	gainDb?: number;
	gainOffsetDb: number;
};

/** The proposal item of one kit (`trackRef`: the FX track id or `$fxTrack`; `requires`: its setup items). */
export function kitItem(
	seq: Sequence,
	k: KitPlacement,
	o: { trackRef: string; requires: readonly string[]; sound: ItemSound | null },
): ProposalItemInput {
	const fps = frameGeometry(seq).fps;
	const s = o.sound;
	const key = refKey(k.id);
	const soundFor = s
		? (() => {
				const expected = placedSpan(s.info, k.frame, fps, 'peak');
				const anchor = editAnchor(seq, { ...k.cut, frame: k.frame });
				return (c: KitChoice) =>
					sfxCommands({
						sequenceId: seq.id,
						cueFrame: k.frame,
						cueRef: `$kitCue_${key}`,
						clipRef: `$kitSfx_${key}`,
						mediaId: s.mediaId,
						kind: 'cut',
						type: s.type,
						align: 'peak',
						window: { start: c.start, end: k.frame },
						reason: `${c.variantLabel} kit (${c.before} + ${c.after} frames)`,
						label: `${c.variantLabel} whoosh`,
						anchor,
						...(s.gainDb !== undefined ? { gainDb: s.gainDb } : { gainOffsetDb: s.gainOffsetDb }),
						expected,
						trim: { start: c.start, end: c.end },
					});
			})()
		: null;
	const clips = [k.cut.outgoingClipId, k.cut.incomingClipId].filter(
		(x): x is string => !!x && !!seq.clips[x],
	);
	const title = s?.title ?? null;
	return {
		id: k.id,
		label: `${k.variantLabel} at ${k.timecode}`.slice(0, 200),
		group: AUTOMATION_PASS_GROUP['decorate-cuts'],
		commands: kitCommands(seq, k, o.trackRef, soundFor ? soundFor(k) : null),
		...(o.requires.length ? { requires: [...o.requires] } : {}),
		meta: {
			group: AUTOMATION_PASS_GROUP['decorate-cuts'],
			pass: 'decorate-cuts',
			kind: 'kit',
			frame: k.frame,
			timecode: k.timecode,
			range: { start: k.start, end: k.end },
			why: kitWhy(k, k.timecode, title),
			seed: k.seed,
			rerollable: true,
			family: k.family,
			variant: k.variant,
			kitFrames: { before: k.before, after: k.after },
			anchorOn: {
				cuts: [{ trackId: k.cut.trackId, frame: k.frame }],
				...(clips.length ? { clips } : {}),
			},
			cut: k.cut,
			cost: effectsCost(
				k.clips.flatMap((c) => c.effects),
				k.end - k.start,
			).class,
			...(s ? { sound: { soundId: s.soundId, title, mediaId: s.mediaId } } : {}),
		},
		...(k.alternatives.length
			? {
					alternatives: k.alternatives.map((a) => ({
						label: a.variantLabel,
						commands: kitCommands(seq, a, o.trackRef, soundFor ? soundFor(a) : null),
						meta: {
							family: a.family,
							variant: a.variant,
							range: { start: a.start, end: a.end },
							why: kitWhy(a, k.timecode, title),
							kitFrames: { before: a.before, after: a.after },
						},
					})),
				}
			: {}),
	};
}

/** The sound of an item from the pass's picks and the setup items that import them. */
export function itemSound(
	doc: ProjectDocument,
	sfx: PassSfx | undefined,
	sounds: ReturnType<typeof soundSetup>,
	itemId: string,
): { sound: ItemSound | null; setup: string | null } {
	const pick = sfx?.assign.get(itemId);
	const mediaId = pick ? sounds.mediaOf.get(pick.soundId) : undefined;
	if (!sfx || !pick || !mediaId) return { sound: null, setup: null };
	const m = sfx.media.find((x) => x.soundId === pick.soundId);
	return {
		sound: {
			mediaId,
			info: mediaInfoOf(doc, sfx, pick.soundId, mediaId),
			soundId: pick.soundId,
			title: m?.title ?? null,
			type: sfx.type,
			...(sfx.gainDb !== undefined ? { gainDb: sfx.gainDb } : {}),
			gainOffsetDb: pick.gainOffsetDb,
		},
		setup: sounds.setupOf.get(pick.soundId) ?? null,
	};
}

export function decorateCutsItems(
	doc: ProjectDocument,
	seq: Sequence,
	plan: DecoratePlan,
	sfx?: PassSfx,
): PassItems {
	const setup: ProposalItemInput[] = [];
	let trackRef: string;
	if (plan.fxTrack.create) {
		setup.push({
			id: FX_TRACK_ITEM,
			label: `Track "${plan.fxTrack.name}"`,
			group: SOUND_PROPOSAL_SETUP_GROUP,
			commands: [
				{ type: 'track.add', sequenceId: seq.id, kind: 'video', name: plan.fxTrack.name, ref: FX_TRACK_REF },
			],
			meta: { setup: true, kind: 'track' },
		});
		trackRef = FX_TRACK_REF;
	} else trackRef = plan.fxTrack.trackId;
	const sounds = soundSetup(
		doc,
		sfx,
		plan.kits.map((k) => k.id),
	);
	const items: ProposalItemInput[] = [];
	const unsounded: string[] = [];
	const allEffects: BatchEffect[] = [];
	let frames = 0;
	for (const k of plan.kits) {
		const { sound, setup: si } = itemSound(doc, sfx, sounds, k.id);
		if (sfx && !sound) unsounded.push(k.id);
		const requires = [...(plan.fxTrack.create ? [FX_TRACK_ITEM] : []), ...(si ? [si] : [])];
		for (const c of k.clips) allEffects.push(...c.effects);
		frames += k.end - k.start;
		items.push(kitItem(seq, k, { trackRef, requires, sound }));
	}
	return { items: [...setup, ...sounds.items, ...items], cost: effectsCost(allEffects, frames), unsounded };
}

// ---------------------------------------------------------------------------------------------------------------
// Motion keys (punch-ins, Ken Burns)

/** `keyframe.addBatch` targets of a Motion plan on `clipId` (scale, scale width, position; linear). */
export function motionTargets(clipId: string, m: MotionPlan): Record<string, unknown>[] {
	const keys = <T>(from: T, to: T) => [
		{ at: { frames: m.keys[0] }, value: from, interpolation: 'linear' },
		{ at: { frames: m.keys[1] }, value: to, interpolation: 'linear', inInterpolation: 'linear' },
	];
	return [
		{ clipId, path: ['transform', 'scale'], keys: keys(m.scale.from, m.scale.to) },
		...(m.scaleWidth
			? [{ clipId, path: ['transform', 'scaleWidth'], keys: keys(m.scaleWidth.from, m.scaleWidth.to) }]
			: []),
		...(m.position
			? [{ clipId, path: ['transform', 'position'], keys: keys(m.position.from, m.position.to) }]
			: []),
	];
}

// ---------------------------------------------------------------------------------------------------------------
// Punch-ins

/** The proposal item of one punch-in (`trackRef`: the ZOOM track for method `adjustment`). */
export function punchItem(
	seq: Sequence,
	p: PunchPlacement,
	o: {
		method: 'motion' | 'adjustment';
		trackRef: string | null;
		requires: readonly string[];
		sound: ItemSound | null;
	},
): ProposalItemInput {
	const fps = frameGeometry(seq).fps;
	const s = o.sound;
	const key = refKey(p.id);
	const soundCmds = s
		? sfxCommands({
				sequenceId: seq.id,
				cueFrame: p.frame,
				cueRef: `$punchCue_${key}`,
				clipRef: `$punchSfx_${key}`,
				mediaId: s.mediaId,
				kind: 'move',
				type: s.type,
				align: 'start',
				window: { start: p.frame, end: p.frame + p.rampFrames },
				reason: `Punch-in to ${p.scale} %`,
				label: 'Punch-in whoosh',
				anchor: null,
				...(s.gainDb !== undefined ? { gainDb: s.gainDb } : { gainOffsetDb: s.gainOffsetDb }),
				expected: placedSpan(s.info, p.frame, fps, 'start'),
			})
		: [];
	const adjustment = o.method === 'adjustment' && o.trackRef !== null;
	const picture = (m: MotionPlan, adj: PunchPlacement['adjustment']): Record<string, unknown> =>
		adjustment
			? {
					type: 'clip.addAdjustmentBatch',
					sequenceId: seq.id,
					trackId: o.trackRef,
					items: [{ start: adj.start, length: adj.length, name: adj.name, effects: adj.effects }],
				}
			: { type: 'keyframe.addBatch', sequenceId: seq.id, targets: motionTargets(p.clipId, m) };
	const target =
		p.target.source === 'center' || p.target.source === 'center-fallback'
			? 'the centre'
			: p.target.source === 'point'
				? 'the chosen point'
				: 'the subject';
	const where =
		p.start === 'caption'
			? `caption start${p.startRule === 'contrast' ? ' on “pero / aunque / sino”' : p.startRule === 'clause' ? ' opening a clause' : ''}`
			: p.start === 'word'
				? 'word start'
				: 'clip midpoint';
	const why = `Punch-in to ${p.scale} % toward ${target} at ${p.timecode} (${where}${p.emphasis ? ', "!" / "?" phrase' : ''}), held to the cut${s?.title ? ` + whoosh “${s.title}”` : ''}`;
	return {
		id: p.id,
		label: `Punch-in ${p.scale} % at ${p.timecode}`.slice(0, 200),
		group: AUTOMATION_PASS_GROUP['punch-ins'],
		commands: [picture(p.motion, p.adjustment), ...soundCmds],
		...(o.requires.length ? { requires: [...o.requires] } : {}),
		meta: {
			group: AUTOMATION_PASS_GROUP['punch-ins'],
			pass: 'punch-ins',
			kind: 'punch-in',
			frame: p.frame,
			timecode: p.timecode,
			range: { start: p.frame, end: p.end },
			why: why.slice(0, 600),
			seed: p.seed,
			rerollable: false,
			clipId: p.clipId,
			scale: p.scale,
			rampFrames: p.rampFrames,
			target: p.target,
			emphasis: p.emphasis,
			method: adjustment ? 'adjustment' : 'motion',
			anchorOn: { clips: [p.clipId] },
			cost: adjustment ? 'remotion' : 'native',
			...(s ? { sound: { soundId: s.soundId, title: s.title, mediaId: s.mediaId } } : {}),
		},
		alternatives: [
			{
				label: `${p.alternative.scale} %`,
				commands: [picture(p.alternative.motion, p.alternative.adjustment), ...soundCmds],
				meta: { scale: p.alternative.scale },
			},
		],
	};
}

export function punchInItems(doc: ProjectDocument, seq: Sequence, plan: PunchPlan, sfx?: PassSfx): PassItems {
	const setup: ProposalItemInput[] = [];
	let trackRef: string | null = null;
	if (plan.method === 'adjustment' && plan.zoomTrack) {
		if (plan.zoomTrack.create) {
			setup.push({
				id: ZOOM_TRACK_ITEM,
				label: `Track "${plan.zoomTrack.name}"`,
				group: SOUND_PROPOSAL_SETUP_GROUP,
				commands: [
					{
						type: 'track.add',
						sequenceId: seq.id,
						kind: 'video',
						index: plan.zoomTrack.index,
						name: plan.zoomTrack.name,
						ref: ZOOM_TRACK_REF,
					},
				],
				meta: { setup: true, kind: 'track' },
			});
			trackRef = ZOOM_TRACK_REF;
		} else trackRef = plan.zoomTrack.trackId;
	}
	const sounds = soundSetup(
		doc,
		sfx,
		plan.punches.map((p) => p.id),
	);
	const items: ProposalItemInput[] = [];
	const unsounded: string[] = [];
	const effects: BatchEffect[] = [];
	let frames = 0;
	for (const p of plan.punches) {
		const { sound, setup: si } = itemSound(doc, sfx, sounds, p.id);
		if (sfx && !sound) unsounded.push(p.id);
		if (plan.method === 'adjustment') effects.push(...p.adjustment.effects);
		frames += p.end - p.frame;
		const requires = [
			...(plan.method === 'adjustment' && plan.zoomTrack?.create ? [ZOOM_TRACK_ITEM] : []),
			...(si ? [si] : []),
		];
		items.push(punchItem(seq, p, { method: plan.method, trackRef, requires, sound }));
	}
	return {
		items: [...setup, ...sounds.items, ...items],
		cost:
			plan.method === 'adjustment' ? effectsCost(effects, frames) : { class: 'native', frames, effects: [] },
		unsounded,
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Ken Burns

/** The proposal item of one Ken Burns move. */
export function kenBurnsItem(seq: Sequence, m: KenBurnsPlacement): ProposalItemInput {
	const label = (d: 'in' | 'out') =>
		d === 'in' ? `Ken Burns in ${m.scale} %` : `Ken Burns out ${m.scale} %`;
	return {
		id: m.id,
		label: `${label(m.direction)} at ${m.timecode}`.slice(0, 200),
		group: AUTOMATION_PASS_GROUP['ken-burns'],
		commands: [{ type: 'keyframe.addBatch', sequenceId: seq.id, targets: motionTargets(m.clipId, m.motion) }],
		meta: {
			group: AUTOMATION_PASS_GROUP['ken-burns'],
			pass: 'ken-burns',
			kind: 'ken-burns',
			frame: m.frame,
			timecode: m.timecode,
			range: { start: m.frame, end: m.end },
			why: `Slow zoom ${m.direction} 100 ↔ ${m.scale} % over “${m.clipName}” (keys on its first and last frame, linear)`.slice(
				0,
				600,
			),
			seed: m.seed,
			rerollable: true,
			clipId: m.clipId,
			direction: m.direction,
			scale: m.scale,
			anchorOn: { clips: [m.clipId] },
			cost: 'native',
		},
		alternatives: [
			{
				label: label(m.alternative.direction),
				commands: [
					{
						type: 'keyframe.addBatch',
						sequenceId: seq.id,
						targets: motionTargets(m.clipId, m.alternative.motion),
					},
				],
				meta: { direction: m.alternative.direction },
			},
		],
	};
}

export function kenBurnsItems(seq: Sequence, plan: KenBurnsPlan): PassItems {
	let frames = 0;
	for (const m of plan.moves) frames += m.end - m.frame;
	return {
		items: plan.moves.map((m) => kenBurnsItem(seq, m)),
		cost: { class: 'native', frames, effects: [] },
		unsounded: [],
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Draft

export const AUTOMATION_PASS_TITLES: Record<AutomationPass, string> = {
	'decorate-cuts': 'Decorate Cuts',
	'punch-ins': 'Punch-ins',
	'ken-burns': 'Ken Burns',
	reactions: 'Reactions',
	slides: 'Slide Overlays',
	music: 'Music Bed',
	stingers: 'Stingers',
};

/** The proposal draft of a pass (feature `edit-automation`); `report` carries the parameters for the refresher. */
export function automationDraft(
	pass: AutomationPass,
	sequenceId: string,
	items: ProposalItemInput[],
	summary: string,
	report: Record<string, unknown>,
) {
	return {
		sequenceId,
		feature: EDIT_AUTOMATION_FEATURE,
		title: AUTOMATION_PASS_TITLES[pass],
		summary: summary.slice(0, 4000),
		items,
		report: { pass, version: 1, ...report },
	};
}
