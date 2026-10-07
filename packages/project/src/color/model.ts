// Colour management in the project model (workstream color-mgmt, docs/wp-notes/color-mgmt.md):
// - the sequence working space (`settings.workingColorSpace`) and its colour settings (`settings.color`: linearize,
//   blend using 1.0 gamma, auto tone map, HDR graphics white, HDR mastering peak);
// - the colour interpretation of media (Interpret Footage ▸ Colour, `asset.interpretation.color`) and of single clips
//   (`clip.colorInterpretation`, which wins): a colour space override (else automatic from the stream tags), the file
//   range for log curves, a per-source tone-mapping switch, the PQ content peak, an input LUT, or a space of a custom
//   OCIO config;
// - invariants and conservative repairs for both.
// Everything is optional with read-time defaults (no schema version bump; the integrator bumps once).
import { z } from 'zod';
import type { Issue } from '../commands/types.ts';
import type { MediaAsset } from '../schema/media.ts';
import { DEFAULT_HDR_PEAK_NITS, hdrPeakNits, REFERENCE_WHITE_NITS } from './cms/hdr.ts';
import {
	type ColorSpaceDef,
	colorSpace,
	isWorkingSpaceId,
	spaceFromStreamTags,
	WORKING_SPACE_IDS,
	type WorkingSpaceId,
} from './cms/spaces.ts';
import type { WorkingColorSettings } from './cms/transform.ts';

// ---------------------------------------------------------------- schemas

/** Sequence Settings ▸ Colour beyond the working space. Absent fields take the defaults below. */
export const SequenceColorSchema = z.looseObject({
	/** Linearize Working Space: blending and GPU effects work in linear light (the composite stays encoded). */
	linearize: z.boolean().optional(),
	/** Blend Using 1.0 Gamma: layers, opacity and blend modes composite in linear light. */
	blendLinear: z.boolean().optional(),
	/** Auto Tone Map Media: HDR and log media are tone mapped into an SDR working space (default on). */
	autoToneMap: z.boolean().optional(),
	/** HDR Graphics White (cd/m²): SDR white of graphics and SDR media in an HDR working space (default 203). */
	sdrWhiteNits: z.number().min(80).max(400).optional(),
	/** PQ working space: the mastering peak (cd/m²) tone mapped from for SDR monitors and outputs (default 1000). */
	hdrPeakNits: z.number().min(REFERENCE_WHITE_NITS).max(10000).optional(),
});
export type SequenceColor = z.infer<typeof SequenceColorSchema>;

/** Interpret Footage ▸ Colour (media) and the clip override: every field optional, absent = automatic. */
export const ColorInterpretationSchema = z.looseObject({
	/** Colour space override (a `COLOR_SPACES` id); absent = from the stream tags. */
	space: z.string().optional(),
	/** A space of a custom OCIO config (a `color-config` media item), related through its interchange roles. */
	ocio: z.looseObject({ configId: z.string(), space: z.string() }).optional(),
	/** The file's range for log curves and LUTs: `tv` (limited) or `pc` (full); absent = the file's flag. */
	range: z.enum(['tv', 'pc']).optional(),
	/** Tone map this source into an SDR working space; absent = the sequence's Auto Tone Map Media. */
	toneMap: z.boolean().optional(),
	/** PQ content peak (cd/m²) for tone mapping; absent = MaxCLL / mastering peak from the file, else 1000. */
	peakNits: z.number().min(REFERENCE_WHITE_NITS).max(10000).optional(),
	/** An input LUT (a `lut` media item) applied to the signal first; its output is read as `space` (Rec. 709 if unset). */
	inputLut: z.string().optional(),
});
export type ColorInterpretation = z.infer<typeof ColorInterpretationSchema>;

/** Patch of a colour interpretation (commands): absent = unchanged, null = back to automatic. */
export const ColorInterpretationPatchSchema = z.strictObject({
	space: z.string().nullable().optional(),
	ocio: z
		.strictObject({ configId: z.string(), space: z.string().min(1) })
		.nullable()
		.optional(),
	range: z.enum(['tv', 'pc']).nullable().optional(),
	toneMap: z.boolean().nullable().optional(),
	peakNits: z.number().min(REFERENCE_WHITE_NITS).max(10000).nullable().optional(),
	inputLut: z.string().nullable().optional(),
});
export type ColorInterpretationPatch = z.infer<typeof ColorInterpretationPatchSchema>;

// ---------------------------------------------------------------- read helpers

export type SequenceColorInfo = WorkingColorSettings & { linearize: boolean; blendLinear: boolean };

type SettingsLike = { workingColorSpace?: unknown; color?: SequenceColor | null };

/** The working space and colour settings of a sequence, defaults applied and invalid values ignored. */
export function sequenceColorInfo(settings: SettingsLike | null | undefined): SequenceColorInfo {
	const c = settings?.color ?? {};
	const space: WorkingSpaceId = isWorkingSpaceId(settings?.workingColorSpace)
		? settings.workingColorSpace
		: 'rec709';
	const fin = (v: unknown, lo: number, hi: number, d: number) =>
		typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
	return {
		space,
		linearize: c.linearize === true,
		blendLinear: c.blendLinear === true || c.linearize === true,
		autoToneMap: c.autoToneMap !== false,
		sdrWhiteNits: fin(c.sdrWhiteNits, 80, 400, REFERENCE_WHITE_NITS),
		hdrPeakNits: fin(c.hdrPeakNits, REFERENCE_WHITE_NITS, 10000, DEFAULT_HDR_PEAK_NITS),
	};
}

/** True for the settings of every sequence made before colour management (nothing to do anywhere). */
export function isPlainRec709(info: SequenceColorInfo): boolean {
	return info.space === 'rec709' && !info.blendLinear && !info.linearize;
}

type AssetLike = Pick<MediaAsset, 'kind' | 'probe'> & {
	interpretation?: { color?: ColorInterpretation | null } | null;
};

/** The media's own colour interpretation (Interpret Footage ▸ Colour), or null. */
export function mediaColorInterpretation(asset: AssetLike | null | undefined): ColorInterpretation | null {
	const c = asset?.interpretation?.color;
	return c && typeof c === 'object' ? c : null;
}

/** The interpretation that applies to a clip: the clip's override fields over the media's. */
export function effectiveColorInterpretation(
	asset: AssetLike | null | undefined,
	clip: { colorInterpretation?: ColorInterpretation | null } | null | undefined,
): ColorInterpretation {
	return { ...(mediaColorInterpretation(asset) ?? {}), ...(clip?.colorInterpretation ?? {}) };
}

export type ResolvedInputSpace = {
	/** A COLOR_SPACES id, or null when an OCIO config space is used. */
	space: ColorSpaceDef | null;
	ocio: { configId: string; space: string } | null;
	range: 'tv' | 'pc';
	toneMap: boolean | undefined;
	peakNits: number | null;
	inputLut: string | null;
	/** How the space was chosen: from the stream tags or an override. */
	auto: boolean;
};

/**
 * The source colour space of a media asset under an interpretation in a working space: the override, else detected from
 * the first video stream's tags (stills follow the working space's SDR encoding when untagged/sRGB).
 */
export function resolveInputSpace(
	asset: AssetLike,
	interp: ColorInterpretation,
	working: WorkingSpaceId,
): ResolvedInputSpace {
	const vs = asset.probe.streams.find((s) => s.type === 'video');
	const tags = vs?.type === 'video' ? vs.color : null;
	const fileRange: 'tv' | 'pc' = tags?.range === 'pc' ? 'pc' : asset.kind === 'video' ? 'tv' : 'pc';
	const override = interp.space ? colorSpace(interp.space) : undefined;
	const auto = !override && !interp.ocio;
	const wDef = colorSpace(working)!;
	const space =
		interp.ocio && !interp.inputLut
			? null
			: (override ??
				(interp.inputLut
					? colorSpace('rec709')!
					: spaceFromStreamTags(
							{ primaries: tags?.primaries, transfer: tags?.transfer, matrix: tags?.matrix },
							{ still: asset.kind !== 'video', workingCurve: wDef.curve },
						)));
	const hdr = (vs?.type === 'video' ? (vs as { hdr?: unknown }).hdr : undefined) as
		| Parameters<typeof hdrPeakNits>[0]
		| undefined;
	return {
		space,
		ocio:
			interp.ocio && !interp.inputLut ? { configId: interp.ocio.configId, space: interp.ocio.space } : null,
		range: interp.range ?? fileRange,
		toneMap: interp.toneMap,
		peakNits: interp.peakNits ?? hdrPeakNits(hdr ?? null),
		inputLut: interp.inputLut ?? null,
		auto,
	};
}

// ---------------------------------------------------------------- invariants and repairs

/** The render-only colour input effect (`jasper.color-input`): snapshots add it, documents never hold it. */
const INTERNAL_COLOR_INPUT = 'jasper.color-input';

type DocLike = {
	media: Record<string, { kind: string; interpretation?: { color?: ColorInterpretation | null } | null }>;
	sequences: Record<
		string,
		{
			id: string;
			settings: SettingsLike;
			clips: Record<
				string,
				{ id: string; colorInterpretation?: ColorInterpretation | null; effects?: { effectId: string }[] }
			>;
		}
	>;
};

function interpretationProblem(c: ColorInterpretation, media: DocLike['media']): string | null {
	if (c.space !== undefined && !colorSpace(c.space)) return `unknown colour space "${c.space}"`;
	if (c.inputLut !== undefined && media[c.inputLut]?.kind !== 'lut')
		return `input LUT ${c.inputLut} is not a LUT item`;
	if (c.ocio && media[c.ocio.configId]?.kind !== 'color-config')
		return `OCIO config ${c.ocio.configId} is not a colour config item`;
	if (c.space !== undefined && c.ocio) return 'both a colour space and an OCIO space are set';
	return null;
}

/** INV-COLOR: working spaces, colour settings and interpretations reference valid spaces and items. */
export function colorIssues(doc: DocLike): Issue[] {
	const issues: Issue[] = [];
	const inv = (message: string, path: string[]): Issue => ({
		commandIndex: -1,
		code: 'E_INVARIANT',
		invariant: 'INV-COLOR',
		message: `INV-COLOR: ${message}`,
		path,
	});
	for (const [id, m] of Object.entries(doc.media)) {
		const c = m.interpretation?.color;
		if (!c) continue;
		const p = interpretationProblem(c, doc.media);
		if (p) issues.push(inv(`Media ${id}: ${p}`, ['media', id, 'interpretation', 'color']));
	}
	for (const seq of Object.values(doc.sequences)) {
		if (!isWorkingSpaceId(seq.settings.workingColorSpace))
			issues.push(
				inv(`Sequence ${seq.id}: unknown working colour space "${String(seq.settings.workingColorSpace)}"`, [
					'sequences',
					seq.id,
					'settings',
				]),
			);
		const sc = seq.settings.color;
		if (sc) {
			const r = SequenceColorSchema.safeParse(sc);
			if (!r.success)
				issues.push(
					inv(`Sequence ${seq.id}: invalid colour settings`, ['sequences', seq.id, 'settings', 'color']),
				);
		}
		for (const c of Object.values(seq.clips)) {
			if (c.effects?.some((fx) => fx.effectId === INTERNAL_COLOR_INPUT))
				issues.push(
					inv(`Clip ${c.id} holds the render-only colour input effect`, ['sequences', seq.id, 'clips', c.id]),
				);
			if (!c.colorInterpretation) continue;
			const p = interpretationProblem(c.colorInterpretation, doc.media);
			if (p) issues.push(inv(`Clip ${c.id}: ${p}`, ['sequences', seq.id, 'clips', c.id]));
		}
	}
	return issues;
}

/** Drops what `colorIssues` reports (conservatively: only the bad field), noting each repair. */
export function repairColor(
	doc: DocLike,
	note: (action: string, entity: string, detail: string) => void,
): void {
	const fix = (c: ColorInterpretation, entity: string): void => {
		if (c.space !== undefined && !colorSpace(c.space)) {
			note('drop-color-space', entity, `unknown colour space "${c.space}" removed (automatic again)`);
			delete c.space;
		}
		if (c.inputLut !== undefined && doc.media[c.inputLut]?.kind !== 'lut') {
			note('drop-input-lut', entity, `input LUT ${c.inputLut} is missing; removed`);
			delete c.inputLut;
		}
		if (c.ocio && doc.media[c.ocio.configId]?.kind !== 'color-config') {
			note('drop-ocio-space', entity, `OCIO config ${c.ocio.configId} is missing; removed`);
			delete c.ocio;
		}
		if (c.space !== undefined && c.ocio) {
			note(
				'drop-ocio-space',
				entity,
				'both a colour space and an OCIO space were set; the OCIO space was removed',
			);
			delete c.ocio;
		}
	};
	for (const [id, m] of Object.entries(doc.media))
		if (m.interpretation?.color) fix(m.interpretation.color, id);
	for (const seq of Object.values(doc.sequences)) {
		if (!isWorkingSpaceId(seq.settings.workingColorSpace)) {
			note(
				'reset-working-space',
				seq.id,
				`unknown working colour space "${String(seq.settings.workingColorSpace)}" set to Rec. 709`,
			);
			seq.settings.workingColorSpace = 'rec709';
		}
		const sc = seq.settings.color;
		if (sc && !SequenceColorSchema.safeParse(sc).success) {
			note('reset-color-settings', seq.id, 'invalid colour settings reset to the defaults');
			delete seq.settings.color;
		}
		for (const c of Object.values(seq.clips)) {
			if (c.effects?.some((fx) => fx.effectId === INTERNAL_COLOR_INPUT)) {
				c.effects = c.effects.filter((fx) => fx.effectId !== INTERNAL_COLOR_INPUT);
				note('drop-effect', c.id, 'the render-only colour input effect was removed from the clip');
			}
			if (c.colorInterpretation) fix(c.colorInterpretation, c.id);
		}
	}
}

/** Working space ids, plus the linear variants (`rec709-linear` = Rec. 709 with Linearize Working Space). */
export const WORKING_SPACE_CHOICES = [
	...WORKING_SPACE_IDS,
	...WORKING_SPACE_IDS.filter((s) => !s.startsWith('rec2100')).map((s) => `${s}-linear` as const),
] as const;

/** `rec709-linear` → {space: rec709, linearize: true}; plain ids → linearize unchanged (undefined). */
export function parseWorkingChoice(choice: string): { space: WorkingSpaceId; linearize?: boolean } | null {
	if (isWorkingSpaceId(choice)) return { space: choice };
	const m = /^(.*)-linear$/.exec(choice);
	if (m && isWorkingSpaceId(m[1]) && !m[1].startsWith('rec2100')) return { space: m[1], linearize: true };
	return null;
}
