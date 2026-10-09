// UI-6: the model's names the UI shows (effects and their parameters / options, transitions, command labels shown in
// History and menus, property labels of the inspectors) → apps/web/src/i18n/model-strings.json (`pnpm i18n:model`).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as project from '@jasper/project';
import { COMMAND_CATALOG, defaultRegistries, PROPERTY_SPECS, TRANSITION_SPECS } from '@jasper/project';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const out = new Set<string>();
const add = (s: unknown) => {
	if (typeof s === 'string' && s.trim()) out.add(s.trim());
};
const reg = defaultRegistries();
for (const e of reg.effects.list()) {
	add(e.label);
	add((e as { bin?: string }).bin);
	add(e.category);
	for (const p of e.params) {
		add(p.label);
		for (const o of p.optionLabels ?? []) add(o);
		add(p.group);
	}
}
for (const t of TRANSITION_SPECS) {
	add(t.label);
	add((t as { bin?: string }).bin);
	add((t as { subBin?: string }).subBin);
	for (const p of t.params) {
		add(p.label);
		for (const o of p.optionLabels ?? []) add(o);
	}
}
for (const c of Object.values(COMMAND_CATALOG)) add(c.label);
for (const p of PROPERTY_SPECS as readonly { label?: string; optionLabels?: readonly string[] }[]) {
	add(p.label);
	for (const o of p.optionLabels ?? []) add(o);
}
// polish: the built-in presets (effect, caption, sequence, proxy, EQ, reverb, shape, text animator, Essential
// Sound): their names, bins / categories and descriptions.
type Named = { name?: string; label?: string; category?: string; group?: string; folder?: string; description?: string };
const presetFamilies = project as unknown as Record<string, unknown>;
for (const family of [
	'BUILTIN_EFFECT_PRESETS',
	'BUILTIN_CAPTION_PRESETS',
	'BUILTIN_PRESETS',
	'PROXY_PRESETS',
	'EQ_PRESETS',
	'REVERB_PRESETS',
	'SHAPE_PRESETS',
	'TEXT_ANIMATOR_PRESETS',
]) {
	const presets = presetFamilies[family];
	if (!Array.isArray(presets)) throw new Error(`@jasper/project no longer exports ${family}`);
	for (const p of presets as Named[]) {
		add(p.name);
		add(p.label);
		add(p.category);
		add(p.group);
		add(p.folder);
		add(p.description);
	}
}
for (const p of project.builtinEssentialPresets() as Named[]) {
	add(p.name);
	add(p.label);
	add(p.category);
}
const list = [...out].sort((a, b) => a.localeCompare(b, 'en'));
writeFileSync(join(root, 'apps/web/src/i18n/model-strings.json'), `${JSON.stringify(list, null, 2)}\n`);
console.log(`model strings: ${list.length}`);
