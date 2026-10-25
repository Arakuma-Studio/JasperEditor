// UI-6: the model's names the UI shows (effects and their parameters / options, transitions, command labels shown in
// History and menus, property labels of the inspectors, sound-design label and refusal templates)
// → apps/web/src/i18n/model-strings.json (`pnpm i18n:model`).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mgRegistry, SOCIAL_IMPORT_HINTS } from '@jasper/mg-templates';
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
// Ease presets: `group` holds a group id, so only preset and group names are display strings.
for (const p of project.builtinEasePresets()) add(p.name);
for (const g of project.BUILTIN_EASE_GROUPS) add(g.name);
// Delivery presets (sound design, Phase 4): the names and where their numbers come from (Delivery Target…).
for (const p of Object.values(project.DELIVERY_PRESETS)) {
	add(p.label);
	add(p.source);
}
// Sound design: the History labels agents' tools compose and the refusals the editor shows in notices, as templates
// (`{0}`… are ids, titles and numbers); the runtime translates a text that matches one (`translateName`).
for (const t of project.SOUND_MODEL_STRINGS) add(t);
// Proposals: why a previewed item fails (WP6.5b: an invariant broken only together with the items before it).
for (const t of project.PROPOSAL_MODEL_STRINGS) add(t);
// The prefix of agents' History entries ("Agent: Sound Cues (add 2)", @jasper/session `agentLabel`).
add('Agent');
// Motion-graphic templates (C3): every template of the catalogue — its name, category and description, its presets'
// names and descriptions, its param groups and every param label and tooltip as Properties / Effect Controls show
// them (`paramsPropertySpecs`: `ui` hints, schema titles and `.describe()` texts, humanized names). A template added
// to @jasper/mg-templates is covered by running `pnpm i18n` and translating the new keys in es.json.
for (const def of mgRegistry.definitions()) {
	add(def.name);
	add(def.category);
	add(def.description);
	for (const p of def.presets ?? []) {
		add(p.name);
		add(p.description);
	}
	for (const g of def.ui?.groups ?? []) add(g.label);
	const info = mgRegistry.get(def.id, def.version);
	for (const s of info ? project.paramsPropertySpecs(info) : []) {
		add(s.label);
		add(s.description);
		for (const o of s.optionLabels ?? []) add(o);
	}
	// bulk import: the reasons a template gives for the columns it ignores
	for (const reason of Object.values(def.ui?.import?.ignored ?? {})) add(reason);
}
// bulk import (docs/wp-notes/social-comments.md "Add another & bulk import"): parser / planner messages and the
// social-comment hints (also listed when no installed template uses them yet)
for (const s of Object.values(project.MG_IMPORT_TEXT)) add(s);
for (const reason of Object.values(SOCIAL_IMPORT_HINTS.ignored ?? {})) add(reason);
const list = [...out].sort((a, b) => a.localeCompare(b, 'en'));
writeFileSync(join(root, 'apps/web/src/i18n/model-strings.json'), `${JSON.stringify(list, null, 2)}\n`);
console.log(`model strings: ${list.length}`);
