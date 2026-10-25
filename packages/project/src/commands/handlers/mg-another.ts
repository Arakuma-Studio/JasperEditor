// "Add another" (social-comments design §7.9, docs/wp-notes/social-comments.md "Add another & bulk import"): a copy
// of a motion-graphic clip right after it, never overwriting, with fresh values for the params its template
// re-randomizes (`ui.addAnother.reroll`, through the template's fill hook) — one command, so one undo step from the
// timeline, Properties, the gallery, the palette and MCP alike.

import { fillTemplateParams, mgRerollParams, validateTemplateParams } from '../../registry/mg-params.ts';
import type { Clip } from '../../schema/sequence.ts';
import type { DClip, DDoc, HandlerContext } from '../context.ts';
import {
	assertKindFits,
	cleanupSequence,
	end,
	firstFreeTrack,
	reidentifyClipChildren,
	trackSlotOf,
} from '../placement.ts';
import type { CommandOf } from '../schemas/index.ts';
import { clone, type HandlerMap } from './util.ts';

type MgClip = Extract<Clip, { kind: 'motion-graphic' }>;

function duplicateMotionGraphic(doc: DDoc, cmd: CommandOf<'clip.duplicateMotionGraphic'>, h: HandlerContext) {
	const { seq, clip } = h.clip(doc, cmd.clipId);
	if (clip.kind !== 'motion-graphic')
		h.fail(
			'E_INVALID_PARAM',
			`Add another takes a motion-graphic clip, not a ${clip.kind} clip (${clip.id})`,
		);
	const source = clone(clip) as MgClip;
	const ref = `${source.template.id}@${source.template.version}`;
	const info = h.registries.mgTemplates.get(source.template.id, source.template.version);
	if (!info) h.fail('E_INVALID_PARAM', `Template ${ref} is not installed, so its params cannot be checked`);

	// Kept: every param except the re-randomized ones; the caller's params win over both.
	const given = cmd.params ?? {};
	const reroll = mgRerollParams(info).filter((n) => !Object.hasOwn(given, n));
	const kept: Record<string, unknown> = { ...source.params };
	for (const n of reroll) delete kept[n];
	const base = { ...kept, ...given };
	let params: Record<string, unknown> = base;
	let filled: string[] = [];
	if (reroll.length > 0) {
		const f = fillTemplateParams(info, base, cmd.seed);
		if (!f.ok) h.fail(f.code, f.message);
		params = f.params;
		filled = f.filled;
	}
	const valid = validateTemplateParams(info, { ...info.defaults, ...params }, doc.media);
	if (!valid.ok) h.fail(valid.code, valid.message, valid.path ? { path: valid.path } : undefined);

	const at = cmd.at === undefined ? end(source) : h.frame(seq, cmd.at);
	if (at < 0) h.fail('E_INVALID_PARAM', 'Clip start must be >= 0');
	const slot = trackSlotOf(seq, cmd.track ?? source.trackId, h);
	assertKindFits('motion-graphic', { kind: slot.kind, id: cmd.track ?? source.trackId }, h);
	const free = firstFreeTrack(seq, slot.kind, slot.index, at, source.duration, h);

	const id = h.ids.next('clp');
	reidentifyClipChildren(source, h);
	const copy = {
		...source,
		id,
		trackId: free.track.id,
		start: at,
		linkId: null,
		groupId: null,
		params: valid.params,
	} as MgClip;
	// A keyframed param shows its keys, not the static value: re-randomized and given params drop theirs.
	if (copy.paramKeyframes) {
		const kf = { ...copy.paramKeyframes };
		for (const n of [...reroll, ...Object.keys(given)]) delete kf[n];
		if (Object.keys(kf).length > 0) copy.paramKeyframes = kf;
		else delete copy.paramKeyframes;
	}
	seq.clips[id] = copy as DClip;
	cleanupSequence(seq, h);
	h.defineRef(cmd.ref, id);
	return {
		clipId: id,
		sourceClipId: source.id,
		sequenceId: seq.id,
		trackId: free.track.id,
		track: `V${free.index + 1}`,
		...(free.created ? { createdTrack: true } : {}),
		start: at,
		duration: source.duration,
		params: clone(valid.params),
		rerolled: filled,
		seed: cmd.seed,
	};
}

export const mgAnotherHandlers: HandlerMap = {
	'clip.duplicateMotionGraphic': duplicateMotionGraphic,
};
