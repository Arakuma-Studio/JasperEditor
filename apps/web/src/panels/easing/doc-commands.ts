// Easing panel ▸ the document commands its actions send (one transaction each, so one undo step). The
// keyframe-ease commands (`keyframe.applyEase`, `keyframe.pasteEase`, `keyframe.pasteValues`,
// `keyframe.createPathController`, `keyframes.cleanupPath`) live in packages/project; an action whose command the
// document model does not have is disabled with a reason (`missingDocCommand`), never sent. Duplicate / Mirror keys at
// the playhead reuse the keyframe paste (a mirrored paste reverses timing and eases, `reversedKeyTiming`).
import {
	buildKeyframesPayload,
	type Command,
	type CubicEase,
	type Ease,
	type EaseCurve,
	type EaseSection,
	isCommandType,
	type MultiEase,
	type ParamPath,
	type ProjectDocument,
} from '@jasper/project';
import { t } from '../../i18n/runtime.ts';
import { type InterpolationPreset, interpolationCommand } from '../effectControls/lib.ts';
import type { EaseSelection } from './selection.ts';

/** A copied ease: the two sides of one key, or the segments between keys (with the span as one curve). */
export type EaseClip =
	| { kind: 'key'; easeIn: Ease; easeOut: Ease }
	| { kind: 'segments'; segments: CubicEase[]; curve?: MultiEase };

export type EaseDocCommand =
	| 'keyframe.applyEase'
	| 'keyframe.pasteEase'
	| 'keyframe.pasteValues'
	| 'keyframe.createPathController'
	| 'keyframes.cleanupPath';

/** Which document commands exist (the model's command catalogue; tests can substitute it). */
export const docCommandSupport = { has: (type: string): boolean => isCommandType(type) };

/** Why an action cannot run in this build (its document command is missing), else undefined. */
export function missingDocCommand(type: EaseDocCommand): string | undefined {
	return docCommandSupport.has(type) ? undefined : t('This build has no {0} command yet', type);
}

const ids = (keyframeIds: readonly string[]) => [...new Set(keyframeIds)];

export function applyEaseCommand(
	keyframeIds: readonly string[],
	curve: EaseCurve,
	sections?: readonly EaseSection[],
): Command {
	return {
		type: 'keyframe.applyEase',
		keyframeIds: ids(keyframeIds),
		curve,
		...(sections?.length ? { sections: [...sections] } : {}),
	} as unknown as Command;
}

export function pasteEaseCommand(
	keyframeIds: readonly string[],
	clip: EaseClip,
	opts: { sections?: readonly EaseSection[]; mode?: 'segments' | 'curve' } = {},
): Command {
	return {
		type: 'keyframe.pasteEase',
		keyframeIds: ids(keyframeIds),
		clip,
		...(opts.sections?.length ? { sections: [...opts.sections] } : {}),
		...(opts.mode ? { mode: opts.mode } : {}),
	} as unknown as Command;
}

export function pasteValuesCommand(keyframeIds: readonly string[], values: readonly unknown[]): Command {
	return {
		type: 'keyframe.pasteValues',
		keyframeIds: ids(keyframeIds),
		values: [...values],
	} as unknown as Command;
}

export function createPathControllerCommand(keyframeIds: readonly string[]): Command {
	return { type: 'keyframe.createPathController', keyframeIds: ids(keyframeIds) } as unknown as Command;
}

export function cleanupPathCommand(keyframeIds: readonly string[], tolerance?: number): Command {
	return {
		type: 'keyframes.cleanupPath',
		keyframeIds: ids(keyframeIds),
		...(tolerance !== undefined && Number.isFinite(tolerance) ? { tolerance } : {}),
	} as unknown as Command;
}

/** Easy Ease (both sides), Easy Ease In (arriving), Easy Ease Out (leaving): {⅓ influence, 0 speed}. */
export function easyEaseCommand(keyframeIds: readonly string[], side: 'both' | 'in' | 'out'): Command {
	const preset: InterpolationPreset = side === 'both' ? 'easy-ease' : side === 'in' ? 'ease-in' : 'ease-out';
	return interpolationCommand(ids(keyframeIds), preset);
}

export function continuousCommand(keyframeIds: readonly string[]): Command {
	return interpolationCommand(ids(keyframeIds), 'continuous-bezier');
}

export function spatialLinearCommand(keyframeIds: readonly string[]): Command {
	return {
		type: 'keyframe.setSpatialInterpolation',
		keyframeIds: ids(keyframeIds),
		mode: 'linear',
	} as Command;
}

/**
 * The selected keys pasted again with the earliest at the playhead (`mirror`: in reverse order with the latest at
 * the playhead and every segment's ease mirrored — the keyframe paste's reversed path).
 */
export function keysAtPlayheadCommand(
	doc: ProjectDocument,
	clipId: string,
	keyframeIds: readonly string[],
	playhead: number,
	mirror: boolean,
	sequenceId?: string,
): Command {
	const payload = buildKeyframesPayload(doc, clipId, keyframeIds);
	const sec = payload.keyframes!;
	if (mirror) {
		sec.speed = { ...sec.speed, reverse: !sec.speed.reverse };
		// Pasted backwards, offsets run from the latest key: it lands on the playhead, the earlier keys follow it.
		sec.originFlicks = Math.max(...sec.tracks.flatMap((tr) => tr.keyframes.map((k) => k.time)));
	}
	return {
		type: 'keyframe.paste',
		payload,
		clipId,
		at: { sequenceFrame: Math.max(0, Math.round(playhead)) },
		...(sequenceId ? { sequenceId } : {}),
	} as Command;
}

/** `expression.set` of `text` on every selected property that suits it. */
export function expressionCommands(
	sel: EaseSelection,
	text: string,
	kinds: readonly string[],
	sequenceId: string,
): Command[] {
	return sel.properties
		.filter((p): p is typeof p & { path: ParamPath } => !!p.path && (!kinds.length || kinds.includes(p.kind)))
		.map((p) => ({ type: 'expression.set', target: p.path, text, sequenceId }) as Command);
}

/** What Copy takes from the selection: the ease (one key's sides, or the segments between keys) and the values. */
export function copyFromSelection(
	sel: EaseSelection,
): { ok: true; ease: EaseClip; values: unknown[]; label: string } | { ok: false; reason: string } {
	if (sel.blocked && sel.properties.length === 0) return { ok: false, reason: sel.blocked };
	const keys = sel.properties.flatMap((p) => p.keys);
	if (keys.length === 0) return { ok: false, reason: t('Select keyframes in Effect Controls') };
	if (keys.length === 1) {
		const p = sel.properties.find((x) => x.keys.length === 1)!;
		const k = p.keys[0]!;
		return {
			ok: true,
			ease: { kind: 'key', easeIn: { ...k.easeIn }, easeOut: { ...k.easeOut } },
			values: [k.value],
			label: p.label,
		};
	}
	const p = sel.properties.find((x) => x.keys.length >= 2);
	if (!p) return { ok: false, reason: t('Select two or more keys of one property, or a single key') };
	const inner = p.segments.filter((s) => s.inner);
	if (inner.length === 0)
		return { ok: false, reason: t('Select neighbouring keys to copy the segments between them') };
	if (inner.some((s) => !s.curve)) return { ok: false, reason: t('Hold segments have no ease to copy') };
	const segments = inner.map((s) => s.curve!);
	return {
		ok: true,
		ease: { kind: 'segments', segments, ...(p.curve?.kind === 'multi' ? { curve: p.curve } : {}) },
		values: p.keys.map((k) => k.value),
		label: p.label,
	};
}
