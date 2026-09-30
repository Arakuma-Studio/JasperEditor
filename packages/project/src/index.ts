// @jasper/project — the pure model (ARCHITECTURE §5): schema, time, ids, commands, invariants,
// keyframes, registries, render snapshot and scene resolver. No DOM, no Node built-ins, no React.
export * from './agent/addressing.ts';
export * from './agent/guard.ts';
export * from './agent/queries.ts';
export * from './agent/schema-export.ts';
export * from './color/lut.ts';
export * from './color/runs.ts';
export * from './commands/index.ts';
export * from './derive/index.ts';
export * from './factories.ts';
export * from './ids.ts';
export * from './invariants.ts';
export * from './keyframes.ts';
export * from './migrations.ts';
export * from './presets.ts';
export * from './process/index.ts';
export * from './registry/effects.ts';
export * from './registry/kinds.ts';
export * from './registry/mg.ts';
export * from './registry/properties.ts';
export * from './render/index.ts';
export * from './schema/index.ts';
export * from './time.ts';
export * from './timecode.ts';
export * from './transitions.ts';

import type { Registries } from './commands/types.ts';
import { defaultPresetRegistry } from './presets.ts';
import { defaultEffectRegistry } from './registry/effects.ts';
import { emptyMgRegistry, type MgTemplateRegistry } from './registry/mg.ts';

/** Default registries (crop-only effects, no templates, built-in presets). */
export function defaultRegistries(mgTemplates: MgTemplateRegistry = emptyMgRegistry): Registries {
	return { effects: defaultEffectRegistry, mgTemplates, presets: defaultPresetRegistry };
}
