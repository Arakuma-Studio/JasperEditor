// UI-6: the model's names the UI shows (effects and their parameters / options, transitions, command labels shown in
// History and menus, property labels of the inspectors) → apps/web/src/i18n/model-strings.json (`pnpm i18n:model`).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as project from '@jasper/project';
import { COMMAND_CATALOG, defaultRegistries, PROPERTY_SPECS, TRANSITION_SPECS } from '@jasper/project';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const out = new Set<string>();
const add = (s: string | undefined) => {
	if (s?.trim()) out.add(s.trim());
};
const reg = defaultRegistries();
for (const e of reg.effects.list()) {
	add(e.label);
	if ('bin' in e && typeof e.bin === 'string') add(e.bin);
	add(e.category);
	for (const p of e.params) {
		add(p.label);
		for (const o of p.optionLabels ?? []) add(o);
		add(p.group);
	}
}
for (const t of TRANSITION_SPECS) {
	add(t.label);
	add(t.bin);
	add(t.subBin);
	for (const p of t.params) {
		add(p.label);
		for (const o of p.optionLabels ?? []) add(o);
	}
}
for (const c of Object.values(COMMAND_CATALOG)) add(c.label);
for (const p of PROPERTY_SPECS) {
	add(p.label);
	for (const o of p.optionLabels ?? []) add(o);
}
type Named = {
	name?: string;
	label?: string;
	category?: string;
	group?: string;
	folder?: string;
	description?: string;
};
const presetFamilies: readonly (readonly Named[])[] = [
	project.BUILTIN_EFFECT_PRESETS,
	project.BUILTIN_CAPTION_PRESETS,
	project.BUILTIN_PRESETS,
	project.PROXY_PRESETS,
	project.EQ_PRESETS,
	project.REVERB_PRESETS,
	project.SHAPE_PRESETS,
	project.TEXT_ANIMATOR_PRESETS,
];
for (const presets of presetFamilies) {
	for (const p of presets) {
		add(p.name);
		add(p.label);
		add(p.category);
		add(p.group);
		add(p.folder);
		add(p.description);
	}
}
for (const p of project.builtinEssentialPresets()) add(p.name);
const list = [...out].sort((a, b) => a.localeCompare(b, 'en'));
writeFileSync(join(root, 'apps/web/src/i18n/model-strings.json'), `${JSON.stringify(list, null, 2)}\n`);
console.log(`model strings: ${list.length}`);
