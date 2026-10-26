// Proposal items of the overlay passes (spec 15 EA-023…EA-026, EA-002…EA-004, EA-032; producer checklist in
// docs/wp-notes/edit-automation.md): one item per reaction, slide, bed or stinger in the pass's Review group, setup
// items for the new tracks, the user's files from a folder and the library sounds, `meta` with the frame, range,
// why-line, seed (Reroll), anchors and the export cost; alternatives = other pictures / directions / songs with the
// same temp refs. Pure.
import type { ProposalItemInput } from '../proposals/schema.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Sequence } from '../schema/sequence.ts';
import { SOUND_PROPOSAL_SETUP_GROUP } from '../sound/proposal-draft.ts';
import { flicksPerFrame } from '../time.ts';
import { fpsValue, frameGeometry, timecodeOf } from './common.ts';
import type { BedPart, BedPlacement, MusicPlan } from './music.ts';
import { AUTOMATION_PASS_GROUP } from './params.ts';
import {
	type AutomationCost,
	type ItemSound,
	itemSound,
	type PassItems,
	type PassSfx,
	refKey,
	soundSetup,
} from './proposal.ts';
import {
	type ReactionChoice,
	type ReactionPlacement,
	type ReactionPlan,
	type ReactionTrigger,
	reactionPosition,
} from './reactions.ts';
import { placedSpan, sfxCommands } from './sfx.ts';
import { type SlideChoice, type SlidePlacement, type SlidePlan, SMOOTH_SLIDE_ID } from './slides.ts';
import { STINGER_MATTE, STINGER_NOISE, type StingerPlacement, type StingerPlan } from './stingers.ts';

export const REACTION_TRACK_ITEM = 'reaction-track';
export const MUSIC_TRACK_ITEM = 'music-track';
export const STINGER_TRACK_ITEM = 'stinger-track';
const REACTION_TRACK_REF = '$reactionTrack';
const MUSIC_TRACK_REF = '$musicTrack';
const STINGER_TRACK_REF = '$stingerTrack';

function trackSetup(
	id: string,
	seq: Sequence,
	t: { create: true; name: string; index?: number },
	kind: 'video' | 'audio',
	ref: string,
): ProposalItemInput {
	return {
		id,
		label: `Track "${t.name}"`,
		group: SOUND_PROPOSAL_SETUP_GROUP,
		commands: [
			{
				type: 'track.add',
				sequenceId: seq.id,
				kind,
				...(t.index !== undefined ? { index: t.index } : {}),
				name: t.name,
				ref,
			},
		],
		meta: { setup: true, kind: 'track' },
	};
}

const secs = (seq: Sequence, frames: number) =>
	`${Math.round((frames / fpsValue(frameGeometry(seq).fps)) * 10) / 10} s`;

// ---------------------------------------------------------------------------------------------------------------
// Reactions

export function triggerText(t: Pick<ReactionTrigger, 'kind' | 'text'>): string {
	if (t.kind === 'marker') return `marker “${t.text}”`;
	if (t.kind === 'cta') return `call to action “${t.text}”`;
	if (t.kind === 'exclamation') return `exclamation “${t.text}”`;
	return 'the speaker is not visible';
}

function reactionCommands(
	seq: Sequence,
	r: ReactionPlacement,
	c: ReactionChoice,
	trackRef: string,
	wobble: ReactionPlan['wobble'],
): Record<string, unknown>[] {
	const ref = `$react_${refKey(r.id)}`;
	const F = flicksPerFrame(frameGeometry(seq).fps);
	return [
		{
			type: 'clip.place',
			sequenceId: seq.id,
			source: { mediaId: c.asset.mediaRef },
			at: r.frame,
			tracks: { video: trackRef },
			video: true,
			audio: false,
			sourceRange: { in: { flicks: 0 }, out: { flicks: (r.end - r.frame) * F } },
			ref,
		},
		{ type: 'param.set', target: ['clip', ref, 'transform', 'scale'], value: c.scale },
		{ type: 'param.set', target: ['clip', ref, 'transform', 'position'], value: reactionPosition(c.rect) },
		...(r.flip ? [{ type: 'effect.add', target: { clipId: ref }, effectId: 'jasper.flip-horizontal' }] : []),
		...(wobble.enabled
			? [
					{
						type: 'effect.add',
						target: { clipId: ref },
						effectId: 'jasper.s.shake',
						params: { amplitude: wobble.amplitude, frequency: wobble.frequency },
					},
				]
			: []),
	];
}

const reactionWhy = (seq: Sequence, r: ReactionPlacement, c: ReactionChoice) =>
	`“${c.asset.name}” at ${r.slot.name ?? `slot ${r.slot.index + 1}`} from ${r.timecode} for ${secs(seq, r.end - r.frame)}, ${c.scale} %${r.flip ? ', flipped' : ''} — ${triggerText(r.trigger)}${r.cut ? ' (on the cut)' : ''}`;

export function reactionCost(wobble: ReactionPlan['wobble'], frames: number): AutomationCost {
	return wobble.enabled
		? { class: 'hybrid', frames, effects: ['jasper.s.shake'] }
		: { class: 'native', frames, effects: [] };
}

/** The proposal item of one reaction. */
export function reactionItem(
	seq: Sequence,
	r: ReactionPlacement,
	o: { trackRef: string; requires: readonly string[]; wobble: ReactionPlan['wobble'] },
): ProposalItemInput {
	// alternatives carry no `requires` of their own: the item needs every file its pictures come from
	const requires = [
		...new Set([
			...o.requires,
			...[r.choice, ...r.alternatives].map((c) => c.asset.setup).filter((x): x is string => !!x),
		]),
	];
	return {
		id: r.id,
		label: `${r.choice.asset.name} at ${r.timecode}`.slice(0, 200),
		group: AUTOMATION_PASS_GROUP.reactions,
		commands: reactionCommands(seq, r, r.choice, o.trackRef, o.wobble),
		...(requires.length ? { requires } : {}),
		meta: {
			group: AUTOMATION_PASS_GROUP.reactions,
			pass: 'reactions',
			kind: 'reaction',
			frame: r.frame,
			timecode: r.timecode,
			range: { start: r.frame, end: r.end },
			why: reactionWhy(seq, r, r.choice).slice(0, 600),
			seed: r.seed,
			rerollable: true,
			trigger: { kind: r.trigger.kind, key: r.trigger.key, text: r.trigger.text, frame: r.trigger.frame },
			slot: {
				index: r.slot.index,
				x: r.slot.x,
				y: r.slot.y,
				flip: r.flip,
				...(r.slot.name ? { name: r.slot.name } : {}),
			},
			asset: { key: r.choice.asset.key, name: r.choice.asset.name },
			scale: r.choice.scale,
			anchorOn: {
				...(r.cut ? { cuts: [r.cut] } : {}),
				...(r.clipId && seq.clips[r.clipId] ? { clips: [r.clipId] } : {}),
			},
			cost: reactionCost(o.wobble, r.end - r.frame).class,
		},
		...(r.alternatives.length
			? {
					alternatives: r.alternatives.map((a) => ({
						label: a.asset.name.slice(0, 120),
						commands: reactionCommands(seq, r, a, o.trackRef, o.wobble),
						meta: {
							asset: { key: a.asset.key, name: a.asset.name },
							scale: a.scale,
							why: reactionWhy(seq, r, a).slice(0, 600),
						},
					})),
				}
			: {}),
	};
}

export function reactionItems(seq: Sequence, plan: ReactionPlan): PassItems {
	const setup: ProposalItemInput[] = [];
	let trackRef: string;
	if (plan.reactionTrack.create && plan.reactions.length) {
		setup.push(trackSetup(REACTION_TRACK_ITEM, seq, plan.reactionTrack, 'video', REACTION_TRACK_REF));
		trackRef = REACTION_TRACK_REF;
	} else trackRef = plan.reactionTrack.create ? REACTION_TRACK_REF : plan.reactionTrack.trackId;
	const used = new Set<string>();
	for (const r of plan.reactions) {
		if (r.choice.asset.setup) used.add(r.choice.asset.setup);
		for (const a of r.alternatives) if (a.asset.setup) used.add(a.asset.setup);
	}
	const assetSetup = plan.setup.filter((s) => used.has(s.id) || (s.id.endsWith('-bin') && used.size > 0));
	const requires = plan.reactionTrack.create ? [REACTION_TRACK_ITEM] : [];
	let frames = 0;
	const items = plan.reactions.map((r) => {
		frames += r.end - r.frame;
		return reactionItem(seq, r, { trackRef, requires, wobble: plan.wobble });
	});
	return {
		items: [...setup, ...assetSetup, ...items],
		cost: reactionCost(plan.wobble, frames),
		unsounded: [],
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Slides

function slideCommand(seq: Sequence, s: SlidePlacement, c: SlideChoice, plan: Pick<SlidePlan, 'params'>) {
	return {
		type: 'transition.add',
		sequenceId: seq.id,
		clipId: s.clipId,
		edge: s.edge,
		effectId: SMOOTH_SLIDE_ID,
		duration: s.frames,
		params: {
			direction: c.direction,
			animation: c.easing,
			motionBlur: plan.params.motionBlur,
			shutterAngle: plan.params.shutterAngle,
		},
	};
}

const EASE_NAMES: Record<string, string> = {
	easeInOutQuad: 'ease in-out quad',
	easeInOutCubic: 'ease in-out cubic',
};
const slideWhy = (s: SlidePlacement, c: SlideChoice) =>
	`Smooth Slide ${s.edge === 'in' ? 'in' : 'out'} ${c.direction} (${s.frames} frames, ${EASE_NAMES[c.easing] ?? c.easing}) at the ${s.edge === 'in' ? 'head' : 'tail'} of “${s.clipName}” at ${s.timecode}`;

export function slideItem(
	seq: Sequence,
	s: SlidePlacement,
	plan: Pick<SlidePlan, 'params'>,
): ProposalItemInput {
	return {
		id: s.id,
		label: `Slide ${s.edge} ${s.choice.direction} at ${s.timecode}`.slice(0, 200),
		group: AUTOMATION_PASS_GROUP.slides,
		commands: [slideCommand(seq, s, s.choice, plan)],
		meta: {
			group: AUTOMATION_PASS_GROUP.slides,
			pass: 'slides',
			kind: 'slide',
			frame: s.frame,
			timecode: s.timecode,
			range: { start: s.frame, end: s.end },
			why: slideWhy(s, s.choice).slice(0, 600),
			seed: s.seed,
			rerollable: true,
			clipId: s.clipId,
			edge: s.edge,
			direction: s.choice.direction,
			easing: s.choice.easing,
			anchorOn: { clips: [s.clipId] },
			cost: 'hybrid',
		},
		...(s.alternatives.length
			? {
					alternatives: s.alternatives.map((a) => ({
						label: `Slide ${s.edge} ${a.direction}`,
						commands: [slideCommand(seq, s, a, plan)],
						meta: { direction: a.direction, easing: a.easing, why: slideWhy(s, a).slice(0, 600) },
					})),
				}
			: {}),
	};
}

export function slideItems(seq: Sequence, plan: SlidePlan): PassItems {
	let frames = 0;
	const items = plan.slides.map((s) => {
		frames += s.frames;
		return slideItem(seq, s, plan);
	});
	return { items, cost: { class: 'hybrid', frames, effects: [SMOOTH_SLIDE_ID] }, unsounded: [] };
}

// ---------------------------------------------------------------------------------------------------------------
// Music beds

function bedCommands(
	seq: Sequence,
	b: BedPlacement,
	songRef: string,
	parts: readonly BedPart[],
	trackRef: string,
	duck: MusicPlan['duck'],
): Record<string, unknown>[] {
	const F = flicksPerFrame(frameGeometry(seq).fps);
	const key = refKey(b.id);
	const refs = parts.map((_, j) => `$bed_${key}_${j}`);
	const cmds: Record<string, unknown>[] = parts.map((pt, j) => ({
		type: 'clip.place',
		sequenceId: seq.id,
		source: { mediaId: songRef },
		at: pt.start,
		tracks: { audio: trackRef },
		video: false,
		audio: true,
		sourceRange: {
			in: { flicks: pt.sourceInFlicks },
			out: { flicks: pt.sourceInFlicks + (pt.end - pt.start) * F },
		},
		ref: refs[j],
	}));
	const byGain = new Map<number, string[]>();
	parts.forEach((pt, j) => {
		byGain.set(pt.gainDb, [...(byGain.get(pt.gainDb) ?? []), refs[j]!]);
	});
	for (const [g, ids] of byGain) cmds.push({ type: 'clip.update', clipIds: ids, patch: { gainDb: g } });
	const end = parts.length ? parts[parts.length - 1]!.end * F : 0;
	const regions = b.duckRegions.filter(([a, z]) => z > a && a < end).map(([a, z]) => [a, Math.min(z, end)]);
	if (duck.enabled && regions.length)
		cmds.push({
			type: 'audio.autoDuck',
			targetClipIds: refs,
			regions,
			amountDb: duck.amountDb,
			fadeMs: duck.fadeMs,
		});
	return cmds;
}

const SWITCH_TEXT: Record<BedPlacement['switchAt'], string> = {
	cut: 'switches on the cut',
	'song-end': 'ends with the song',
	'bed-seconds': 'switches where no cut came',
	end: 'runs to the end',
};

function bedWhy(
	seq: Sequence,
	b: BedPlacement,
	name: string,
	parts: readonly BedPart[],
	duck: MusicPlan['duck'],
) {
	const end = parts.length ? parts[parts.length - 1]!.end : b.end;
	const intro = parts.find((p) => p.intro);
	const main = parts.find((p) => !p.intro) ?? parts[0];
	return `“${name}” from ${b.timecode} to ${timecodeOf(seq, end)} at ${main?.gainDb ?? 0} dB${intro ? ` (${intro.gainDb} dB until the first cut)` : ''}, ${SWITCH_TEXT[b.switchAt]}${duck.enabled && b.duckRegions.length ? `, ducked ${duck.amountDb} dB under dialogue` : ''}`;
}

export function bedItem(
	seq: Sequence,
	b: BedPlacement,
	o: { trackRef: string; requires: readonly string[]; duck: MusicPlan['duck'] },
): ProposalItemInput {
	const requires = [
		...new Set([
			...o.requires,
			...[b.song, ...b.alternatives.map((a) => a.song)].map((x) => x.setup).filter((x): x is string => !!x),
		]),
	];
	return {
		id: b.id,
		label: `${b.song.name} at ${b.timecode}`.slice(0, 200),
		group: AUTOMATION_PASS_GROUP.music,
		commands: bedCommands(seq, b, b.song.mediaRef, b.parts, o.trackRef, o.duck),
		...(requires.length ? { requires } : {}),
		meta: {
			group: AUTOMATION_PASS_GROUP.music,
			pass: 'music',
			kind: 'bed',
			frame: b.frame,
			timecode: b.timecode,
			range: { start: b.frame, end: b.parts[b.parts.length - 1]?.end ?? b.end },
			why: bedWhy(seq, b, b.song.name, b.parts, o.duck).slice(0, 600),
			seed: b.seed,
			rerollable: true,
			index: b.index,
			song: { key: b.song.key, name: b.song.name },
			switchAt: b.switchAt,
			intro: b.parts.some((p) => p.intro),
			anchorOn: b.cut ? { cuts: [b.cut] } : {},
			cost: 'native',
		},
		...(b.alternatives.length
			? {
					alternatives: b.alternatives.map((a) => ({
						label: a.song.name.slice(0, 120),
						commands: bedCommands(seq, b, a.song.mediaRef, a.parts, o.trackRef, o.duck),
						meta: {
							song: { key: a.song.key, name: a.song.name },
							range: { start: b.frame, end: a.parts[a.parts.length - 1]?.end ?? b.end },
							why: bedWhy(seq, b, a.song.name, a.parts, o.duck).slice(0, 600),
						},
					})),
				}
			: {}),
	};
}

export function musicItems(seq: Sequence, plan: MusicPlan): PassItems {
	const setup: ProposalItemInput[] = [];
	let trackRef: string;
	if (plan.musicTrack.create) {
		if (plan.beds.length)
			setup.push(trackSetup(MUSIC_TRACK_ITEM, seq, plan.musicTrack, 'audio', MUSIC_TRACK_REF));
		trackRef = MUSIC_TRACK_REF;
	} else trackRef = plan.musicTrack.trackId;
	const used = new Set<string>();
	for (const b of plan.beds) {
		if (b.song.setup) used.add(b.song.setup);
		for (const a of b.alternatives) if (a.song.setup) used.add(a.song.setup);
	}
	const assetSetup = plan.setup.filter((s) => used.has(s.id) || (s.id.endsWith('-bin') && used.size > 0));
	const requires = plan.musicTrack.create ? [MUSIC_TRACK_ITEM] : [];
	let frames = 0;
	const items = plan.beds.map((b) => {
		frames += b.end - b.frame;
		return bedItem(seq, b, { trackRef, requires, duck: plan.duck });
	});
	return {
		items: [...setup, ...assetSetup, ...items],
		cost: { class: 'native', frames, effects: [] },
		unsounded: [],
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Stingers

const stingerTrigger = (s: StingerPlacement) =>
	s.trigger.source === 'both'
		? `a shout ${s.trigger.excessLu} LU over the local level on “${s.trigger.text}”`
		: s.trigger.source === 'loudness'
			? `a shout ${s.trigger.excessLu} LU over the local level`
			: `the exclamation “${s.trigger.text}”`;

export function stingerItem(
	seq: Sequence,
	s: StingerPlacement,
	o: { trackRef: string; requires: readonly string[]; sound: ItemSound | null; frames: number },
): ProposalItemInput {
	const ref = `$sting_${refKey(s.id)}`;
	const fps = frameGeometry(seq).fps;
	const snd = o.sound;
	const soundCmds = snd
		? sfxCommands({
				sequenceId: seq.id,
				cueFrame: s.frame,
				cueRef: `$stingCue_${refKey(s.id)}`,
				clipRef: `$stingSfx_${refKey(s.id)}`,
				mediaId: snd.mediaId,
				kind: 'emphasis',
				type: snd.type,
				align: 'start',
				window: { start: s.frame, end: s.end },
				reason: 'Stinger after a shouted punchline',
				label: 'Stinger noise',
				anchor: null,
				...(snd.gainDb !== undefined ? { gainDb: snd.gainDb } : { gainOffsetDb: snd.gainOffsetDb }),
				expected: placedSpan(snd.info, s.frame, fps, 'start'),
				trim: { start: s.frame, end: s.end },
			})
		: [];
	return {
		id: s.id,
		label: `Stinger at ${s.timecode}`.slice(0, 200),
		group: AUTOMATION_PASS_GROUP.stingers,
		commands: [
			{
				type: 'clip.addSolid',
				sequenceId: seq.id,
				at: s.frame,
				duration: s.end - s.frame,
				track: o.trackRef,
				color: [...STINGER_MATTE],
				name: 'TV static',
				ref,
			},
			{
				type: 'effect.add',
				target: { clipId: ref },
				effectId: STINGER_NOISE.effectId,
				params: { ...STINGER_NOISE.params },
			},
			...soundCmds,
		],
		...(o.requires.length ? { requires: [...o.requires] } : {}),
		meta: {
			group: AUTOMATION_PASS_GROUP.stingers,
			pass: 'stingers',
			kind: 'stinger',
			frame: s.frame,
			timecode: s.timecode,
			range: { start: s.frame, end: s.end },
			why: `TV static for ${s.end - s.frame} frames at ${s.timecode}${snd ? ` with “${snd.title ?? 'noise'}”` : ''} — after ${stingerTrigger(s)}${s.cut ? ' (on the cut)' : ''}`.slice(
				0,
				600,
			),
			seed: s.seed,
			rerollable: false,
			trigger: s.trigger,
			anchorOn: s.cut ? { cuts: [s.cut] } : {},
			cost: 'hybrid',
			...(snd ? { sound: { soundId: snd.soundId, title: snd.title, mediaId: snd.mediaId } } : {}),
		},
	};
}

export function stingerItems(
	doc: ProjectDocument,
	seq: Sequence,
	plan: StingerPlan,
	sfx?: PassSfx,
): PassItems {
	const setup: ProposalItemInput[] = [];
	let trackRef: string;
	if (plan.stingerTrack.create) {
		if (plan.stingers.length)
			setup.push(trackSetup(STINGER_TRACK_ITEM, seq, plan.stingerTrack, 'video', STINGER_TRACK_REF));
		trackRef = STINGER_TRACK_REF;
	} else trackRef = plan.stingerTrack.trackId;
	const sounds = soundSetup(
		doc,
		sfx,
		plan.stingers.map((s) => s.id),
	);
	const unsounded: string[] = [];
	let frames = 0;
	const items = plan.stingers.map((s) => {
		const { sound, setup: si } = itemSound(doc, sfx, sounds, s.id);
		if (sfx && !sound) unsounded.push(s.id);
		frames += s.end - s.frame;
		const requires = [...(plan.stingerTrack.create ? [STINGER_TRACK_ITEM] : []), ...(si ? [si] : [])];
		return stingerItem(seq, s, { trackRef, requires, sound, frames: plan.frames });
	});
	return {
		items: [...setup, ...sounds.items, ...items],
		cost: { class: 'hybrid', frames, effects: [STINGER_NOISE.effectId] },
		unsounded,
	};
}
