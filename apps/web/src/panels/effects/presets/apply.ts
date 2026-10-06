// Applying effect presets from the editor (S03:FX-010/030): drag onto a timeline clip, a Program Monitor layer or
// Effect Controls, or double-click / Enter with clips selected. One `effect.applyPreset` transaction for N clips
// ("Apply Preset <name>"), the preset JSON inline. Drags reuse the effect drag contract (drag.ts): a preset is the
// effect ref `preset:<presetId>`, so every effect drop target accepts presets without knowing about them.
import {
	type Command,
	type EffectPreset,
	isKnownClipKind,
	kindCapabilities,
	presetSummary,
	type TransactionResult,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { findPreset } from './store.ts';

export const PRESET_REF_PREFIX = 'preset:';

export const presetRef = (presetId: string) => `${PRESET_REF_PREFIX}${presetId}`;
export const isPresetRef = (effectRef: string) => effectRef.startsWith(PRESET_REF_PREFIX);
/** The preset an effect ref names (null for a registry effect or an unknown preset). */
export function presetOfRef(effectRef: string): EffectPreset | null {
	return isPresetRef(effectRef) ? (findPreset(effectRef.slice(PRESET_REF_PREFIX.length)) ?? null) : null;
}

/** Clips (of the committed document) the preset has something for: unlocked, of a medium it holds. */
export function clipsAcceptingPreset(
	session: EditorSession,
	preset: EffectPreset,
	clipIds: readonly string[],
): string[] {
	const media = presetSummary(preset, session.ctx.registries.effects).media;
	const doc = session.getCommitted();
	const out: string[] = [];
	for (const id of clipIds) {
		for (const seq of Object.values(doc.sequences)) {
			const c = seq.clips[id];
			if (!c || !isKnownClipKind(c.kind)) continue;
			const caps = kindCapabilities(c.kind);
			const track = [...seq.videoTracks, ...seq.audioTracks].find((t) => t.id === c.trackId);
			if (!caps || track?.locked) continue;
			if ((media.includes('video') && caps.visual) || (media.includes('audio') && caps.audio)) out.push(id);
		}
	}
	return out;
}

/** Applies a preset to clips as one undo step; null when none of them takes it. */
export function applyPresetToClips(
	session: EditorSession,
	preset: EffectPreset,
	clipIds: readonly string[],
	index?: number,
): TransactionResult | null {
	const targets = clipsAcceptingPreset(session, preset, clipIds);
	if (!targets.length) return null;
	return session.apply({
		label:
			targets.length > 1
				? `Apply Preset ${preset.name} (${targets.length} clips)`
				: `Apply Preset ${preset.name}`,
		origin: 'user',
		commands: [
			{
				type: 'effect.applyPreset',
				preset: preset as unknown as Record<string, unknown>,
				clipIds: targets,
				...(index !== undefined ? { index } : {}),
			} as Command,
		],
	});
}
