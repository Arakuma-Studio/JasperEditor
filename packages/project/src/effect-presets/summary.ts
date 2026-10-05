// What a preset holds, for the Effects panel (labels, badges, search) and agents (list_effect_presets):
// effects resolved against the registry (unknown ids flagged, never dropped), intrinsic sections, the media it
// applies to, and the Real-time / Native badges (a preset passes a badge filter when every effect it uses does;
// intrinsic properties never restrict it).
import { type EffectRegistry, effectBadges } from '../registry/effects.ts';
import { EFFECT_PRESET_TYPE_LABELS, type EffectPreset } from './schema.ts';

export type PresetSummary = {
	id: string;
	name: string;
	type: EffectPreset['type'];
	typeLabel: string;
	description: string;
	builtIn: boolean;
	category: string | null;
	folderId: string | null;
	/** Intrinsic sections in Effect Controls order: Motion, Opacity, Crop, Volume, Panner. */
	intrinsic: string[];
	effects: { effectId: string; label: string; known: boolean }[];
	/** Effect ids the registry does not know (kept in the preset; skipped when applied). */
	unknownEffects: string[];
	/** Media the preset has something for. */
	media: ('video' | 'audio')[];
	realtime: boolean;
	native: boolean;
	keyframed: boolean;
};

const hasKeys = (v: unknown): boolean => {
	if (!v || typeof v !== 'object') return false;
	if (
		Array.isArray((v as { keyframes?: unknown }).keyframes) &&
		(v as { keyframes: unknown[] }).keyframes.length
	)
		return true;
	return Object.values(v as Record<string, unknown>).some(hasKeys);
};

export function presetSummary(preset: EffectPreset, registry: EffectRegistry): PresetSummary {
	const i = preset.intrinsic ?? {};
	const intrinsic = [
		i.motion ? 'Motion' : null,
		i.opacity || i.blendMode ? 'Opacity' : null,
		i.crop ? 'Crop' : null,
		i.volume ? 'Volume' : null,
		i.pan ? 'Panner' : null,
	].filter((x): x is string => x !== null);
	const media = new Set<'video' | 'audio'>();
	if (i.motion || i.opacity || i.blendMode || i.crop) media.add('video');
	if (i.volume || i.pan) media.add('audio');
	let realtime = true;
	let native = true;
	const unknownEffects: string[] = [];
	const effects = (preset.effects ?? []).map((fx) => {
		const spec = registry.get(fx.effectId, fx.effectVersion) ?? registry.get(fx.effectId);
		if (!spec) {
			if (!unknownEffects.includes(fx.effectId)) unknownEffects.push(fx.effectId);
			realtime = false;
			native = false;
			return { effectId: fx.effectId, label: fx.effectId, known: false };
		}
		const b = effectBadges(spec);
		realtime &&= b.realtime;
		native &&= b.native;
		media.add(spec.appliesTo);
		return { effectId: spec.id, label: spec.label, known: true };
	});
	return {
		id: preset.id,
		name: preset.name,
		type: preset.type,
		typeLabel: EFFECT_PRESET_TYPE_LABELS[preset.type],
		description: preset.description ?? '',
		builtIn: preset.builtIn === true,
		category: preset.category ?? null,
		folderId: preset.folderId ?? null,
		intrinsic,
		effects,
		unknownEffects,
		media: [...media].sort(),
		realtime,
		native,
		keyframed: hasKeys(preset.intrinsic) || hasKeys(preset.effects),
	};
}

/** Effects panel / agent search: name, description, type, category and the effects it uses. */
export function presetMatches(s: PresetSummary, query: string): boolean {
	const q = query.trim().toLowerCase();
	if (!q) return true;
	const hay = [
		s.name,
		s.description,
		s.typeLabel,
		s.category ?? '',
		'preset',
		...s.intrinsic,
		...s.effects.map((e) => `${e.label} ${e.effectId}`),
	]
		.join(' ')
		.toLowerCase();
	return q.split(/\s+/).every((w) => hay.includes(w));
}
