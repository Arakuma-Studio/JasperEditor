// Colour management commands (workstream color-mgmt, docs/wp-notes/color-mgmt.md): the sequence colour settings of
// `sequence.updateSettings` / `sequence.create`, Interpret Footage ▸ Colour on media and the clip colour override.
import type { Draft } from 'immer';
import { colorSpace } from '../../color/cms/spaces.ts';
import {
	type ColorInterpretation,
	type ColorInterpretationPatch,
	parseWorkingChoice,
	resolveInputSpace,
	type SequenceColor,
} from '../../color/model.ts';
import type { MediaAsset } from '../../schema/media.ts';
import type { DDoc, DSeq, HandlerContext } from '../context.ts';
import { assertUnlocked, findTrackIn } from '../placement.ts';
import type { CommandOf } from '../schemas/index.ts';
import { type HandlerMap, idList } from './util.ts';

type ColorSettingsPatch = Pick<
	CommandOf<'sequence.updateSettings'>['settings'],
	'workingColorSpace' | 'color'
>;

/** Applies the colour fields of a settings patch (working space, linear variants, colour settings; null resets). */
export function applyColorSettings(seq: DSeq, p: ColorSettingsPatch, h: HandlerContext): void {
	if (p.workingColorSpace !== undefined) {
		const w = parseWorkingChoice(p.workingColorSpace);
		if (!w) h.fail('E_INVALID_PARAM', `Unknown working colour space "${p.workingColorSpace}"`);
		seq.settings.workingColorSpace = w.space;
		if (w.linearize) (seq.settings.color ??= {}).linearize = true;
	}
	if (p.color) {
		const c = (seq.settings.color ??= {}) as Draft<SequenceColor>;
		for (const k of ['linearize', 'blendLinear', 'autoToneMap', 'sdrWhiteNits', 'hdrPeakNits'] as const) {
			const v = p.color[k];
			if (v === undefined) continue;
			if (v === null) delete c[k];
			else (c as Record<string, unknown>)[k] = v;
		}
	}
	if (seq.settings.color && Object.keys(seq.settings.color).length === 0) delete seq.settings.color;
}

/** The HDR working space matching a media file's PQ / HLG tags (null for SDR media). */
export function hdrWorkingSpaceOf(asset: MediaAsset): 'rec2100-pq' | 'rec2100-hlg' | null {
	if (asset.kind !== 'video') return null;
	const s = resolveInputSpace(asset, {}, 'rec709').space;
	return s?.kind === 'pq' ? 'rec2100-pq' : s?.kind === 'hlg' ? 'rec2100-hlg' : null;
}

const PICTURE_KINDS = new Set(['video', 'image', 'animated-image']);

/** Validates a patch against the document and applies it to an interpretation object (in place). */
function patchInterpretation(
	doc: DDoc,
	target: ColorInterpretation,
	patch: ColorInterpretationPatch,
	h: HandlerContext,
): void {
	if (patch.space) {
		if (!colorSpace(patch.space)) h.fail('E_INVALID_PARAM', `Unknown colour space "${patch.space}"`);
	}
	if (patch.inputLut) {
		if (doc.media[patch.inputLut]?.kind !== 'lut')
			h.fail('E_INVALID_PARAM', `Input LUT ${patch.inputLut} is not a LUT item of this project`);
	}
	if (patch.ocio) {
		const cfg = doc.media[patch.ocio.configId] as MediaAsset | undefined;
		if (cfg?.kind !== 'color-config')
			h.fail(
				'E_INVALID_PARAM',
				`OCIO config ${patch.ocio.configId} is not a colour config item of this project`,
			);
		const info = cfg.colorConfig;
		const name = patch.ocio.space.toLowerCase();
		const known =
			!info ||
			info.spaces.some((s) => s.name.toLowerCase() === name) ||
			info.roles.some(([r]) => r.toLowerCase() === name);
		if (!known) h.fail('E_INVALID_PARAM', `The OCIO config has no colour space "${patch.ocio.space}"`);
	}
	for (const k of ['space', 'range', 'toneMap', 'peakNits', 'inputLut', 'ocio'] as const) {
		const v = patch[k];
		if (v === undefined) continue;
		if (v === null) delete target[k];
		else (target as Record<string, unknown>)[k] = typeof v === 'object' ? { ...v } : v;
	}
	// An explicit space and an OCIO space exclude each other: the field set by this patch wins.
	if (patch.space && target.ocio) delete target.ocio;
	if (patch.ocio && target.space) delete target.space;
}

export const colorMgmtHandlers = {
	'media.interpretColor': (doc, cmd, h) => {
		for (const id of new Set(cmd.mediaIds)) {
			const asset = doc.media[id] as Draft<MediaAsset> | undefined;
			if (!asset) return h.fail('E_NOT_FOUND', `Media not found: ${id}`);
			if (!PICTURE_KINDS.has(asset.kind))
				h.fail(
					'E_INVALID_PARAM',
					`Colour interpretation applies to pictures, not ${asset.kind} media (${id})`,
				);
			if (cmd.color === null) {
				if (asset.interpretation?.color) delete asset.interpretation.color;
			} else {
				const interp = (asset.interpretation ??= {});
				const c = (interp.color ??= {}) as ColorInterpretation;
				patchInterpretation(doc, c, cmd.color, h);
				if (Object.keys(c).length === 0) delete interp.color;
			}
			if (asset.interpretation && Object.keys(asset.interpretation).length === 0) delete asset.interpretation;
		}
		return { mediaIds: [...new Set(cmd.mediaIds)] };
	},
	'clip.setColorInterpretation': (doc, cmd, h) => {
		const ids = idList(cmd.clipIds);
		if (ids.length === 0) h.fail('E_INVALID_PARAM', 'No clips given');
		for (const id of ids) {
			const { seq, clip } = h.clip(doc, id);
			assertUnlocked(findTrackIn(seq, clip.trackId)!.track, h);
			const mediaId = (clip as { mediaId?: unknown }).mediaId;
			const asset = typeof mediaId === 'string' ? (doc.media[mediaId] as MediaAsset | undefined) : undefined;
			if (!asset || !PICTURE_KINDS.has(asset.kind) || !('effects' in clip))
				return h.fail('E_INVALID_PARAM', `Clip ${id} does not show a picture from media`);
			const c = clip as Draft<{ colorInterpretation?: ColorInterpretation }>;
			if (cmd.color === null) delete c.colorInterpretation;
			else {
				const target = (c.colorInterpretation ??= {}) as ColorInterpretation;
				patchInterpretation(doc, target, cmd.color, h);
				if (Object.keys(target).length === 0) delete c.colorInterpretation;
			}
		}
		return { clipIds: ids };
	},
} satisfies HandlerMap;
