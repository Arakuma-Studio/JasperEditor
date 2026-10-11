import {
	COLOR_SPACES,
	type ColorInterpretation,
	type ColorInterpretationPatch,
	colorSpace,
	type MediaAsset,
	resolveInputSpace,
	type SequenceColorInfo,
	sequenceColorInfo,
	WORKING_SPACE_CHOICES,
} from '@jasper/project';

type WorkingChoice = (typeof WORKING_SPACE_CHOICES)[number];
export type Option<T extends string = string> = { value: T; label: string };

/** Working Color Space choices: the spaces, then their linear variants (Linearize Working Space on). */
export function workingSpaceOptions(): Option<WorkingChoice>[] {
	return WORKING_SPACE_CHOICES.map((value) => {
		const linear = value.endsWith('-linear');
		const space = linear ? value.slice(0, -'-linear'.length) : value;
		const label = colorSpace(space)!.label;
		return { value, label: linear ? `${label} (linear)` : label };
	});
}

/** The working choice id of a sequence's settings (`rec709` or `rec709-linear` …). */
export function workingChoiceOf(info: SequenceColorInfo): WorkingChoice {
	return info.linearize && !info.space.startsWith('rec2100') ? `${info.space}-linear` : info.space;
}

/** Source colour space choices for Interpret Footage ▸ Colour (grouped by a label prefix). */
export function sourceSpaceOptions(): Option[] {
	return COLOR_SPACES.map((s) => ({
		value: s.id,
		label: s.group === 'Display' ? s.label : `${s.group}: ${s.label}`,
	}));
}

/** HDR Graphics White choices (Premiere: 100, 203, 300 cd/m²). */
export const SDR_WHITE_OPTIONS: Option[] = [
	{ value: '100', label: '100 nits (51% PQ, 63% HLG)' },
	{ value: '203', label: '203 nits (BT.2408: 58% PQ, 75% HLG)' },
	{ value: '300', label: '300 nits (62% PQ, 81% HLG)' },
];

export const isHdrWorking = (info: SequenceColorInfo) =>
	info.space === 'rec2100-pq' || info.space === 'rec2100-hlg';

/** "Automatic (Rec. 2100 PQ)": what the file's tags say, for the Automatic entry of the source space menu. */
export function detectedSpaceLabel(asset: MediaAsset, working: string): string {
	const r = resolveInputSpace(
		asset,
		{} as ColorInterpretation,
		colorSpace(working) ? (working as never) : 'rec709',
	);
	return r.space?.label ?? 'Rec. 709';
}

/** A short summary of a media's colour interpretation for the Project panel / dialogs. */
export function interpretationSummary(
	asset: MediaAsset,
	seqSettings: Parameters<typeof sequenceColorInfo>[0],
): string {
	const info = sequenceColorInfo(seqSettings);
	const c = asset.interpretation?.color;
	if (c?.ocio) return `OCIO: ${c.ocio.space}`;
	if (c?.space) return colorSpace(c.space)?.label ?? c.space;
	return `Automatic (${detectedSpaceLabel(asset, info.space)})`;
}

export function colorPatchOf(from: ColorInterpretation, to: ColorInterpretation): ColorInterpretationPatch {
	const keys = ['space', 'ocio', 'range', 'toneMap', 'peakNits', 'inputLut'] as const;
	let patch: ColorInterpretationPatch = {};
	for (const key of keys)
		if (JSON.stringify(from[key] ?? null) !== JSON.stringify(to[key] ?? null))
			patch = { ...patch, [key]: to[key] ?? null };
	return patch;
}
