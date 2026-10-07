// @jasper/project — the pure model (ARCHITECTURE §5): schema, time, ids, commands, invariants,
// keyframes, registries, render snapshot and scene resolver. No DOM, no Node built-ins, no React.
export * from './agent/addressing.ts';
export * from './agent/guard.ts';
export * from './agent/queries.ts';
export * from './agent/schema-export.ts';
export * from './agent/strict.ts';
export * from './animation/index.ts';
export * from './audio/index.ts';
export * from './audio-fade.ts';
export * from './blend-modes.ts';
export * from './captions/index.ts';
export * from './clipboard/index.ts';
export * from './color/curves.ts';
export * from './color/lumetri.ts';
export * from './color/lut.ts';
export * from './color/retime.ts';
export * from './color/runs.ts';
export * from './commands/index.ts';
export * from './composition/index.ts';
export * from './derive/index.ts';
export * from './edit/match-frame.ts';
export * from './edit/trim-mode.ts';
export * from './effect-presets/index.ts';
export * from './essential/index.ts';
export * from './expressions.ts';
export * from './factories.ts';
export * from './ids.ts';
export * from './invariants.ts';
export * from './keyframes.ts';
export * from './keyframes-spatial.ts';
export * from './masks/index.ts';
export * from './migrations.ts';
export * from './multicam/index.ts';
export * from './path/index.ts';
export * from './presets.ts';
export * from './process/index.ts';
export * from './registry/audio/index.ts';
export * from './registry/color-effects.ts';
export * from './registry/effects.ts';
export * from './registry/expression-controls.ts';
export * from './registry/fx/index.ts';
export * from './registry/kinds.ts';
export * from './registry/mg.ts';
export * from './registry/properties.ts';
export * from './registry/text-animator-properties.ts';
export * from './registry/transitions/index.ts';
export * from './render/index.ts';
export * from './roto/index.ts';
export * from './schema/index.ts';
export * from './speech/index.ts';
export * from './structure/index.ts';
export * from './text-animations.ts';
export * from './text-animators/index.ts';
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
export * from './vector/index.ts';
