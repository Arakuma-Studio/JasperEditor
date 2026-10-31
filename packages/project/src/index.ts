// @jasper/project — the pure model (ARCHITECTURE §5): schema, time, ids, commands, invariants,
// keyframes, registries, render snapshot and scene resolver. No DOM, no Node built-ins, no React.
export * from './agent/addressing.ts';
export * from './agent/guard.ts';
export * from './agent/keyframe-eases.ts';
export { clipKeyframesQuery, PropertyQueryError } from './agent/properties-query.ts';
export * from './agent/queries.ts';
export * from './agent/schema-export.ts';
export * from './agent/strict.ts';
export * from './animation/index.ts';
export * from './audio/index.ts';
export * from './audio-fade.ts';
export * from './automation/index.ts';
export * from './blend-modes.ts';
export * from './captions/index.ts';
export * from './cleanup/index.ts';
export * from './cleanup/voice-analysis.ts';
export * from './clipboard/index.ts';
export * from './color/analysis.ts';
export * from './color/auto-tone.ts';
export * from './color/cms/index.ts';
export * from './color/curves.ts';
export * from './color/grade-math.ts';
export * from './color/hue-curves.ts';
export * from './color/looks.ts';
export * from './color/lumetri.ts';
export * from './color/lumetri-spatial.ts';
export * from './color/lut.ts';
export * from './color/lut-formats.ts';
export * from './color/match.ts';
export * from './color/model.ts';
export * from './color/ocio/index.ts';
export * from './color/retime.ts';
export * from './color/runs.ts';
export * from './color/scopes.ts';
export * from './color/secondary-key.ts';
export * from './color/snapshot.ts';
export * from './commands/index.ts';
export * from './composition/index.ts';
export * from './derive/index.ts';
export * from './edit/match-frame.ts';
export * from './edit/trim-mode.ts';
export * from './effect-presets/index.ts';
export * from './essential/index.ts';
export * from './expressions.ts';
export * from './factories.ts';
export * from './find/index.ts';
export * from './font-usage.ts';
export * from './gaps/index.ts';
export * from './glossary/index.ts';
export * from './ids.ts';
export * from './interpret/index.ts';
export * from './invariants.ts';
export {
	checkTransactionInvariants,
	type InvariantMode,
	type InvariantStats,
	invariantMode,
	invariantStats,
	setInvariantMode,
	verifyDocument,
} from './invariants-incremental.ts';
export * from './json-cache.ts';
export * from './keyframes.ts';
export * from './keyframes-spatial.ts';
export * from './lottie/index.ts';
export * from './masks/index.ts';
export * from './migrations.ts';
export * from './multicam/index.ts';
export * from './param-media.ts';
export * from './path/index.ts';
export * from './presets.ts';
export * from './process/index.ts';
export * from './proposals/index.ts';
export * from './puppet/index.ts';
export * from './registry/audio/index.ts';
export * from './registry/color-effects.ts';
export * from './registry/effects.ts';
export * from './registry/expression-controls.ts';
export * from './registry/fx/index.ts';
export * from './registry/kinds.ts';
export * from './registry/lumetri-spatial.ts';
export * from './registry/mg.ts';
export * from './registry/mg-params.ts';
export { mediaParamId } from './registry/param-values.ts';
export * from './registry/properties.ts';
export * from './registry/text-animator-properties.ts';
export * from './registry/transitions/index.ts';
export * from './relink/index.ts';
export * from './render/index.ts';
export * from './roto/index.ts';
export * from './schema/index.ts';
// spec 17 (scapply): the persisted Fix Transcript state and the proposal item of a transcript fix.
export * from './script-fix/proposal-item.ts';
export * from './script-fix/sequence-state.ts';
export * from './sound/anchor.ts';
export * from './sound/cue-input.ts';
export * from './sound/cues/index.ts';
export * from './sound/index.ts';
export * from './sound/proposal-draft.ts';
export * from './sound/repair.ts';
export * from './sound/variant.ts';
export * from './speech/index.ts';
// cleanup/index.ts has its own `transcriptSegments` (segments as the cleanup reads them); the package name is speech's.
export { transcriptSegments } from './speech/index.ts';
export * from './structure/index.ts';
export * from './text-animations.ts';
export * from './text-animators/index.ts';
export * from './text-style.ts';
export * from './text-styles/index.ts';
export * from './three-d/index.ts';
export * from './time.ts';
export * from './time-remap/index.ts';
export * from './timecode.ts';
export * from './tracking/index.ts';
export * from './transitions.ts';

import type { Registries } from './commands/types.ts';
import { defaultPresetRegistry } from './presets.ts';
import { defaultEffectRegistry } from './registry/effects.ts';
import { emptyMgRegistry, type MgTemplateRegistry } from './registry/mg.ts';

/** Built-in effects and presets, with optional motion-graphic templates. */
export function defaultRegistries(mgTemplates: MgTemplateRegistry = emptyMgRegistry): Registries {
	return { effects: defaultEffectRegistry, mgTemplates, presets: defaultPresetRegistry };
}
export * from './bulk/age.ts';
export * from './bulk/messages.ts';
export * from './bulk/mg-import.ts';
export * from './bulk/table.ts';
export { DEFAULT_CLEANUP_TOLERANCE } from './commands/handlers/ease.ts';
export {
	copyEase,
	copyValues,
	describeKeyframeEases,
	type EaseClip,
	type EaseKeyInfo,
	type EasePropertyInfo,
	type EaseSegmentInfo,
	type EaseSideInfo,
} from './commands/handlers/ease-read.ts';
export * from './delivery/targets.ts';
export * from './ease/curve.ts';
export * from './ease/fit.ts';
export { applyMultiEase, MultiEaseError, type MultiEaseInput, type MultiEaseResult } from './ease/multi.ts';
export { type PathFitPlan, planPathCleanup } from './ease/path-fit.ts';
export * from './ease/presets.ts';
export * from './vector/index.ts';
