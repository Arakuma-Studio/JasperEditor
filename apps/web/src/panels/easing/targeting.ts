// Easing panel ▸ which segments an ease goes to. The In | Middle | Out control picks sections explicitly (none =
// the command's automatic choice); click modifiers on Apply and on library presets override it for that click:
// Shift = in, Alt = out, Ctrl (Cmd on macOS) = middle, combined they add up. The info line says what is affected.
import { EASE_SECTIONS, type EaseCurve, type EaseSection } from '@jasper/project';
import type { Platform } from '../../commands/keymap-defaults.ts';
import { t } from '../../i18n/runtime.ts';
import type { EaseSelection } from './selection.ts';

export type SectionMods = { shift: boolean; alt: boolean; primary: boolean };

type ModEvent = { shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean };

/** The modifiers of a click; `primary` is Cmd on macOS, Ctrl elsewhere. */
export function sectionMods(e: ModEvent, platform: Platform): SectionMods {
	return { shift: e.shiftKey, alt: e.altKey, primary: platform === 'mac' ? e.metaKey : e.ctrlKey };
}

const ordered = (s: Iterable<EaseSection>): EaseSection[] => {
	const set = new Set(s);
	return EASE_SECTIONS.filter((x) => set.has(x));
};

/** Sections for one apply: modifiers first, else the explicit choice, else undefined (automatic). */
export function resolveSections(
	explicit: readonly EaseSection[],
	mods: SectionMods | null,
): EaseSection[] | undefined {
	const fromMods: EaseSection[] = [];
	if (mods?.shift) fromMods.push('in');
	if (mods?.primary) fromMods.push('middle');
	if (mods?.alt) fromMods.push('out');
	if (fromMods.length) return ordered(fromMods);
	if (explicit.length) return ordered(explicit);
	return undefined;
}

/** Toggles one section of the explicit choice. */
export function toggleSection(explicit: readonly EaseSection[], s: EaseSection): EaseSection[] {
	return explicit.includes(s) ? explicit.filter((x) => x !== s) : ordered([...explicit, s]);
}

/** The command's automatic choice for a property with `keyCount` selected keys. */
export function autoSections(keyCount: number, curve: EaseCurve): EaseSection[] {
	if (curve.kind === 'multi') return ['middle'];
	return keyCount >= 2 ? ['middle'] : ['in', 'out'];
}

/** How many segments an apply reaches: per property the in / middle / out segments that exist. */
export function countTargets(
	sel: EaseSelection,
	sections: readonly EaseSection[] | undefined,
	curve: EaseCurve,
): { segments: number; properties: number } {
	let segments = 0;
	let properties = 0;
	for (const p of sel.properties) {
		if (p.keys.length === 0) continue;
		const wanted = sections ?? autoSections(p.keys.length, curve);
		// Multi-point curves only span keys (middle); they never go to the outer segments.
		const use = curve.kind === 'multi' ? wanted.filter((s) => s === 'middle') : wanted;
		const n = p.segments.filter((s) => !s.hold && use.includes(s.section)).length;
		if (n > 0) properties++;
		segments += n;
	}
	return { segments, properties };
}

const SECTION_LABELS: Record<EaseSection, string> = { in: 'In', middle: 'Middle', out: 'Out' };

export function sectionsLabel(sections: readonly EaseSection[] | undefined): string {
	if (!sections) return t('Auto');
	return sections.map((s) => SECTION_LABELS[s]).join(' + ');
}

/** The info line under the targeting control. */
export function describeTargets(
	sel: EaseSelection,
	sections: readonly EaseSection[] | undefined,
	curve: EaseCurve,
): string {
	if (sel.blocked) return sel.blocked;
	const { segments, properties } = countTargets(sel, sections, curve);
	const which = sectionsLabel(sections);
	if (segments === 0)
		return curve.kind === 'multi' && sections && !sections.includes('middle')
			? t('Multi-point curves apply between selected keys only (Middle)')
			: t('{0}: no segment to ease for this selection', which);
	const segs = segments === 1 ? t('1 segment') : t('{0} segments', segments);
	const props = properties === 1 ? t('1 property') : t('{0} properties', properties);
	return t('{0}: {1} in {2}', which, segs, props);
}
