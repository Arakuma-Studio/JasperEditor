// M2 animation contracts for template metadata (ARCHITECTURE §20.3, S11:ATP-001/009): the definition union,
// `isAnimeTemplate`, `upgrades`, and the registry passing `renderer` through. fframes templates are unchanged.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
	createMgRegistry,
	FFRAMES_CATALOG,
	isAnimeTemplate,
	isSvgTemplate,
	lowerThird,
	MG_CATALOG,
	type MgAnimeTemplateDefinition,
	mgRegistry,
} from '../src/index.ts';

const params = z.strictObject({ title: z.string().max(120).default('Hello') });
const reveal: MgAnimeTemplateDefinition<z.infer<typeof params>> = {
	id: 'test-reveal',
	version: 2,
	name: 'Test Reveal',
	category: 'Titles',
	description: 'A test anime template',
	renderer: 'anime',
	renderVersion: 1,
	posterAt: 1.5,
	paramsSchema: params,
	defaults: { title: 'Hello' },
	introFrames: 20,
	outroFrames: 15,
	defaultDurationSeconds: 4,
	canvases: [{ width: 1920, height: 1080 }],
	upgrades: [{ fromVersion: 1, migrate: (p) => ({ title: String(p.text ?? 'Hello') }) }],
};

describe('template definitions (ARCHITECTURE §20.3)', () => {
	it('tells anime templates from fframes templates', () => {
		expect(isAnimeTemplate(reveal)).toBe(true);
		expect(isSvgTemplate(reveal)).toBe(false);
		expect(isAnimeTemplate(lowerThird)).toBe(false);
		expect(isSvgTemplate(lowerThird)).toBe(true);
		expect(FFRAMES_CATALOG).toEqual(MG_CATALOG.filter((d) => !isAnimeTemplate(d)));
	});
	it('the registry passes renderer, description and default duration through; fframes entries are unchanged', () => {
		const reg = createMgRegistry([lowerThird, reveal]);
		expect(reg.get('test-reveal', 2)).toMatchObject({
			renderer: 'anime',
			description: 'A test anime template',
			defaultDurationSeconds: 4,
			canvasDefault: 'sequence',
		});
		expect(reg.get('lower-third', 1)?.renderer).toBeUndefined();
		const json = reg.catalogJson();
		expect(json.find((t) => t.id === 'test-reveal')?.renderer).toBe('anime');
		expect('renderer' in json.find((t) => t.id === 'lower-third')!).toBe(false);
		// the upgrade path is plain data on the definition (the registry API belongs to wp-m2-anime-templates)
		expect(reveal.upgrades?.[0]?.migrate({ text: 'Hi' })).toEqual({ title: 'Hi' });
	});
	it('validates anime defaults like fframes ones', () => {
		expect(() => createMgRegistry([{ ...reveal, defaults: { title: 3 } as never }])).toThrow(/Defaults/);
	});
	it('the shipped registry only lists fframes templates in the jasper-mg schema files', () => {
		const json = mgRegistry.catalogJson();
		expect(json.every((t) => t.renderer === undefined)).toBe(true);
	});
	it('never imports animejs (ARCHITECTURE §3.1, S11:ANM-022)', () => {
		const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
		const files: string[] = [];
		const walk = (d: string) => {
			for (const e of readdirSync(d, { withFileTypes: true })) {
				if (e.isDirectory()) walk(join(d, e.name));
				else if (/\.tsx?$/.test(e.name)) files.push(join(d, e.name));
			}
		};
		walk(root);
		expect(files.length).toBeGreaterThan(0);
		for (const f of files)
			expect(readFileSync(f, 'utf8'), f).not.toMatch(/from ['"](animejs|@jasper\/motion)/);
	});
});
