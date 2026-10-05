// "Save Preset…" from Effect Controls headers (S03:EC-004, FX-030): which selected sections a preset can hold —
// the intrinsic Motion, Opacity, Crop, Volume and Panner sections and applied effects (missing effects too: they are
// kept and flagged) — all of one clip. Text Animation, Shape and Template sections have no preset form.
import type { PresetSections } from '@jasper/project';
import type { FxSection } from './items.ts';

const INTRINSIC = ['motion', 'opacity', 'crop', 'volume', 'panner'] as const;
type IntrinsicKey = (typeof INTRINSIC)[number];

function intrinsicKey(s: FxSection): IntrinsicKey | null {
	const suffix = s.id.slice(s.clip.id.length + 1);
	return (INTRINSIC as readonly string[]).includes(suffix) ? (suffix as IntrinsicKey) : null;
}

export function presetableSection(s: FxSection): boolean {
	return s.intrinsic ? intrinsicKey(s) !== null : !!s.fx;
}

export type PresetSelection =
	| { ok: true; clipId: string; sections: PresetSections; subject: string; defaultName: string }
	| { ok: false; reason: string };

/** The preset sections of the selected headers (Effect Controls order). */
export function presetSelection(selected: readonly FxSection[]): PresetSelection {
	const usable = selected.filter(presetableSection);
	if (!usable.length)
		return { ok: false, reason: 'Select Motion, Opacity, Crop, Volume, Panner or an applied effect' };
	const clipId = usable[0]!.clip.id;
	if (usable.some((s) => s.clip.id !== clipId)) return { ok: false, reason: 'Choose effects of one clip' };
	const sections: PresetSections = {};
	const effectIds: string[] = [];
	for (const s of usable) {
		const k = intrinsicKey(s);
		if (k) sections[k] = true;
		else if (s.fx) effectIds.push(s.fx.id);
	}
	if (effectIds.length) sections.effectIds = effectIds;
	const titles = usable.map((s) => s.title);
	return {
		ok: true,
		clipId,
		sections,
		subject: `${titles.join(', ')} of ${usable[0]!.clip.name || usable[0]!.clip.kind}`,
		defaultName: usable.length === 1 ? titles[0]! : 'Custom Preset',
	};
}
