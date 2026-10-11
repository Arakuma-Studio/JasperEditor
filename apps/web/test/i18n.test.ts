import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { COMMAND_CATALOG, defaultRegistries, TRANSITION_SPECS } from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { isUiText, scan, transformI18n } from '../i18n/transform.mjs';
import { __t } from '../src/i18n/runtime.ts';

const root = join(__dirname, '../../..');
const es = JSON.parse(readFileSync(join(root, 'apps/web/src/i18n/es.json'), 'utf8')) as Record<
	string,
	string
>;
const model = JSON.parse(
	readFileSync(join(root, 'apps/web/src/i18n/model-strings.json'), 'utf8'),
) as string[];

function uiKeys(): Set<string> {
	const keys = new Set<string>();
	const walk = (d: string) => {
		for (const f of readdirSync(d)) {
			const p = join(d, f);
			if (statSync(p).isDirectory()) walk(p);
			else if (
				/\.(tsx|ts)$/.test(f) &&
				!/\.test\.|\.d\.ts$|\.tokens\.ts$/.test(f) &&
				!/[\\/]i18n[\\/]/.test(p)
			)
				scan(readFileSync(p, 'utf8'), p, { found: (k) => keys.add(k) });
		}
	};
	walk(join(root, 'apps/web/src'));
	walk(join(root, 'packages/ui/src'));
	return keys;
}

const placeholders = (s: string) =>
	[...s.matchAll(/\{(\d+)\}/g)]
		.map((m) => m[1])
		.sort()
		.join();

describe('i18n', () => {
	it('Spanish covers every UI string and model name (run `pnpm i18n` after adding strings)', () => {
		const keys = [...uiKeys(), ...model.filter((k) => isUiText(k))];
		const missing = keys.filter((k) => typeof es[k] !== 'string' || !es[k]!.trim());
		expect(missing.slice(0, 20), `${missing.length} strings without a Spanish translation`).toEqual([]);
		const bad = keys.filter((k) => es[k] !== undefined && placeholders(k) !== placeholders(es[k]!));
		expect(bad).toEqual([]);
	}, 120_000);

	it('model-strings.json lists the names the model shows (effects, parameters, transitions, commands)', () => {
		const set = new Set(model);
		const reg = defaultRegistries();
		const missing: string[] = [];
		for (const e of reg.effects.list()) {
			if (!set.has(e.label)) missing.push(e.label);
			for (const p of e.params) if (p.label && !set.has(p.label.trim())) missing.push(p.label);
		}
		for (const t of TRANSITION_SPECS) if (!set.has(t.label)) missing.push(t.label);
		for (const c of Object.values(COMMAND_CATALOG)) if (c.label && !set.has(c.label)) missing.push(c.label);
		expect(missing.slice(0, 20), 'run `pnpm i18n` to refresh model-strings.json').toEqual([]);
	});

	it('the transform wraps UI text and leaves ids, classes and data alone', () => {
		const code = `const a = { label: 'Open Project', id: 'file.open', title: \`Close \${n} Panels\` };
const COLOR_LABELS = { forest: 'Forest' };
export const X = () => <div className="flex gap-2" title="Hello there" data-testid="x">Some text &apos;here&apos; <b>{name}</b></div>;
const k = { label: 'violet' };`;
		const out = transformI18n(code, 'x.tsx', '/rt.ts')!;
		expect(out).toContain('__t("Open Project")');
		expect(out).toContain("id: 'file.open'");
		expect(out).toContain('__t("Close {0} Panels", n)');
		expect(out).toContain('title={__t("Hello there")}');
		expect(out).toContain('className="flex gap-2"');
		expect(out).toContain(`__t("Some text 'here'")`);
		expect(out).toContain("label: 'violet'");
		expect(out).toContain('__t("Forest")');
		expect(isUiText('panel.focus.timeline')).toBe(false);
		expect(isUiText('E_NOT_FOUND')).toBe(false);
	});

	it('the runtime fills placeholders (English source text)', () => {
		expect(__t('Delete {0}?', 'Clip 1')).toBe('Delete Clip 1?');
		expect(__t('Plain')).toBe('Plain');
	});
});
