// UI-6: the model's names the UI shows (effects and their parameters / options, transitions, command labels shown in
// History and menus, property labels of the inspectors) → apps/web/src/i18n/model-strings.json (`pnpm i18n:model`).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
const list = [...out].sort((a, b) => a.localeCompare(b, 'en'));
writeFileSync(join(root, 'apps/web/src/i18n/model-strings.json'), `${JSON.stringify(list, null, '\t')}\n`);
console.log(`model strings: ${list.length}`);
