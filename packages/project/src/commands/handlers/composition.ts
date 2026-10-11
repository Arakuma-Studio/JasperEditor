// Motion-graphics composition clips (M2, S08:MGC-003…007): clip.addComposition places a composition of an
// `mg-bundle` asset; its props are edited with clip.update `{props}` (whole override object) and param.set on
// `["clip", id, "props", …path]` (property keys `props.<dotted.path>`), validated against the composition's
// `propsSchema` when there is one (E_INVALID_PARAM). Owner: wp-m2-mg (ARCHITECTURE §19.8).
import type { Draft } from 'immer';
import {
	compositionOfClip,
	compositionSequenceFrames,
	formatSchemaIssues,
	mergeProps,
	setPropOverride,
	validateCompositionProps,
} from '../../composition/props.ts';
import { anim, type Box, defaultTransform } from '../../factories.ts';
import type { MgCompositionInfo } from '../../schema/media.ts';
import type { Clip, CompositionClip } from '../../schema/sequence.ts';
import type { DClip, DDoc, HandlerContext } from '../context.ts';
import {
	assertKindFits,
	assertUnlocked,
	cleanupSequence,
	clearRange,
	relinkSplits,
	resolveOrCreateTrack,
} from '../placement.ts';
import type { ClipPatch } from '../schemas/clip.ts';
import type { CommandOf } from '../schemas/index.ts';
import type { HandlerMap } from './util.ts';

type DComp = Draft<CompositionClip>;

/** The composition of an mg-bundle asset, or a command error naming what is missing. */
function requireComposition(
	doc: DDoc,
	ref: { mediaId: string; id: string },
	h: HandlerContext,
): MgCompositionInfo {
	const asset = doc.media[ref.mediaId];
	if (!asset) return h.fail('E_NOT_FOUND', `Media not found: ${ref.mediaId}`);
	if (asset.kind !== 'mg-bundle' || !asset.mgBundle)
		return h.fail(
			'E_INVALID_PARAM',
			`${ref.mediaId} is a ${asset.kind} asset, not an imported Remotion bundle`,
		);
	const info = asset.mgBundle.compositions.find((c) => c.id === ref.id);
	if (!info) {
		const known = asset.mgBundle.compositions.map((c) => c.id);
		return h.fail(
			'E_NOT_FOUND',
			`Composition ${ref.id} is not in bundle ${asset.originalName} (compositions: ${known.slice(0, 20).join(', ') || 'none'})`,
		);
	}
	return info as MgCompositionInfo;
}

/** Validates effective props (defaults ⊕ overrides) against the composition's schema; fails with E_INVALID_PARAM. */
function checkProps(info: MgCompositionInfo, overrides: Record<string, unknown>, h: HandlerContext): void {
	const issues = validateCompositionProps(info, mergeProps(info.defaultProps, overrides));
	if (issues.length)
		h.fail('E_INVALID_PARAM', `Invalid props for composition ${info.id}: ${formatSchemaIssues(issues)}`, {
			path: ['props', ...(issues[0]!.path === '(root)' ? [] : issues[0]!.path.split('.'))],
		});
}

/**
 * Writes one prop (param.set `props.<path>`): the value lands in the clip's overrides (containers copied from
 * the effective props so siblings keep their values), then the effective props are validated.
 */
export function setCompositionProp(
	doc: DDoc,
	clip: DClip,
	path: readonly string[],
	value: unknown,
	h: HandlerContext,
): void {
	const c = clip as DComp;
	const found = compositionOfClip(doc as never, c as unknown as Clip);
	const overrides = (c.props ?? {}) as Record<string, unknown>;
	const effective = mergeProps(found?.info.defaultProps, overrides);
	const next = setPropOverride(overrides, effective, path, value);
	if (found) checkProps(found.info as MgCompositionInfo, next, h);
	c.props = next as never;
}

/**
 * clip.update on a composition clip (MGC-007): `props` replaces the whole override object (validated),
 * `canvas` sets the render size ('sequence' or a size). Returns true when it handled the patch.
 */
export function applyCompositionPatch(
	doc: DDoc,
	clip: DClip,
	p: Pick<ClipPatch, 'props' | 'canvas' | 'params'>,
	h: HandlerContext,
): boolean {
	if (clip.kind !== 'composition') return false;
	if (p.params !== undefined)
		h.fail(
			'E_INVALID_PARAM',
			'params do not apply to composition clips (edit props with clip.update {props})',
		);
	const c = clip as DComp;
	if (p.props !== undefined) {
		const found = compositionOfClip(doc as never, c as unknown as Clip);
		if (found) checkProps(found.info as MgCompositionInfo, p.props, h);
		c.props = JSON.parse(JSON.stringify(p.props)) as never;
	}
	if (p.canvas !== undefined) c.canvas = p.canvas as never;
	return true;
}

export const compositionHandlers = {
	'clip.addComposition': (doc, cmd: CommandOf<'clip.addComposition'>, h: HandlerContext) => {
		const info = requireComposition(doc, cmd.composition, h);
		const overrides = cmd.props ?? {};
		checkProps(info, overrides, h);
		const seq = h.sequence(doc, cmd.sequenceId);
		const rate = seq.settings.frameRate;
		const total = compositionSequenceFrames(info, rate);
		const at = h.frame(seq, cmd.at);
		let duration = cmd.duration === undefined ? total : h.durationFrames(seq, cmd.duration);
		if (at < 0) h.fail('E_INVALID_PARAM', 'Clip start must be >= 0');
		if (duration < 1) h.fail('E_INVALID_PARAM', 'Clip duration must be >= 1 frame');
		if (duration > total) {
			h.warn(
				'W_DURATION_CLAMPED',
				`Composition ${info.id} is ${total} frames long; the clip is limited to it`,
			);
			duration = total;
		}
		if (Math.abs(info.fps - rate.num / rate.den) > 1e-3)
			h.warn(
				'MG_FPS_MISMATCH',
				`Composition ${info.id} is ${info.fps} fps, the sequence ${+(rate.num / rate.den).toFixed(3)} fps: it renders at the sequence rate`,
			);
		const track = resolveOrCreateTrack(seq, cmd.track, h, true);
		assertUnlocked(track, h);
		assertKindFits('composition', track, h);
		const id = h.newId(doc, 'clp', cmd.id);
		relinkSplits(seq, clearRange(seq, track.id, at, at + duration, h), h);
		const frame: Box = { width: seq.settings.width, height: seq.settings.height };
		const canvas = cmd.canvas ?? { width: info.width, height: info.height };
		const box = canvas === 'sequence' ? frame : canvas;
		seq.clips[id] = {
			id,
			trackId: track.id,
			start: at,
			duration,
			sourceIn: 0,
			speed: { rate: 1, reverse: false, maintainPitch: false },
			name: cmd.name ?? info.id,
			label: 'magenta',
			enabled: true,
			linkId: null,
			groupId: null,
			markers: [],
			kind: 'composition',
			composition: { mediaId: cmd.composition.mediaId, id: info.id, version: cmd.composition.version ?? 1 },
			props: JSON.parse(JSON.stringify(overrides)),
			canvas,
			// Fitted to the frame by the default scaling rule (MGC-003): scale down when larger, else 100 %.
			transform: defaultTransform(box, frame, canvas === 'sequence' ? 'none' : 'fit-if-larger'),
			opacity: anim(100),
			blendMode: 'normal',
			effects: [],
		} as DClip;
		cleanupSequence(seq, h);
		h.defineRef(cmd.ref, id);
		return { clipId: id, durationFrames: duration, compositionFrames: total };
	},
} satisfies HandlerMap;
