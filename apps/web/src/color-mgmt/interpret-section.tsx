import {
	type ColorInterpretation,
	type CommandInput,
	isPictureMedia,
	type MediaAsset,
	sequenceColorInfo,
} from '@jasper/project';
import {
	type InterpretDraft,
	type InterpretSectionProps,
	registerInterpretSection,
} from '../imports/interpret-dialog.tsx';
import { ColorInterpretationFields } from './dialogs.tsx';
import { colorPatchOf, detectedSpaceLabel, isHdrWorking } from './model.ts';

export const COLOR_SECTION_ID = 'color';

/** The selected items' common colour interpretation (empty when they differ or none is set). */
function commonInterpretation(assets: readonly MediaAsset[]): ColorInterpretation {
	const vals = assets.map((a) => JSON.stringify(a.interpretation?.color ?? {}));
	return vals.every((v) => v === vals[0]) ? { ...(assets[0]?.interpretation?.color ?? {}) } : {};
}

function sectionValue(assets: readonly MediaAsset[], draft: InterpretDraft): ColorInterpretation {
	return (
		(draft.sections[COLOR_SECTION_ID] as ColorInterpretation | undefined) ?? commonInterpretation(assets)
	);
}

function ColorSection({ assets, session, draft, setDraft }: InterpretSectionProps) {
	if (!session) return null;
	// A dialog: the project's items and the active sequence as they are when it opens.
	const st = session.getState();
	const media = st.document.media;
	const working = sequenceColorInfo(
		st.activeSequenceId ? st.document.sequences[st.activeSequenceId]?.settings : undefined,
	);
	const luts = Object.values(media)
		.filter((m) => m.kind === 'lut')
		.map((m) => ({ value: m.id, label: m.originalName }));
	const configs = Object.values(media)
		.filter((m) => m.kind === 'color-config' && (m as MediaAsset).colorConfig)
		.map((m) => ({
			id: m.id,
			name: (m as MediaAsset).colorConfig!.name || m.originalName,
			spaces: (m as MediaAsset).colorConfig!.spaces.map((s) => s.name),
		}));
	return (
		<ColorInterpretationFields
			value={sectionValue(assets, draft)}
			onChange={(v) => setDraft((d) => ({ ...d, sections: { ...d.sections, [COLOR_SECTION_ID]: v } }))}
			detected={assets[0] ? detectedSpaceLabel(assets[0], working.space) : 'Rec. 709'}
			luts={luts}
			configs={configs}
			hdrWorking={isHdrWorking(working)}
		/>
	);
}

registerInterpretSection({
	id: COLOR_SECTION_ID,
	title: 'Colour',
	order: 60,
	applies: (a) => a.length > 0 && a.every((x) => isPictureMedia(x)),
	component: ColorSection,
	commands(assets, draft): CommandInput[] {
		const edited = draft.sections[COLOR_SECTION_ID] as ColorInterpretation | undefined;
		if (!edited) return [];
		const patch = colorPatchOf(commonInterpretation(assets), edited);
		if (Object.keys(patch).length === 0) return [];
		return [
			{
				type: 'media.interpretColor',
				mediaIds: assets.map((a) => a.id),
				color: Object.keys(edited).length === 0 ? null : patch,
			} satisfies CommandInput,
		];
	},
});
