// C3: template presets and UI hints reach GET /api/motion-graphics/templates on both catalogue paths (the TS catalog
// when jasper-mg is unavailable; the binary's catalog, which has none, gets them from the TS twin).
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MgTemplatesResponseSchema } from '@jasper/api';
import { createMgRegistry, type MgTemplateDefinition } from '@jasper/mg-templates';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createMgService } from '../src/mg/index.ts';

const params = z.strictObject({ name: z.string().max(60).default('Name'), dark: z.boolean().default(false) });
const twin: MgTemplateDefinition<z.infer<typeof params>> = {
	id: 'card',
	version: 1,
	name: 'Card',
	category: 'Titles',
	paramsSchema: params,
	defaults: params.parse({}),
	introFrames: 10,
	outroFrames: 10,
	defaultDurationSeconds: 4,
	canvases: [{ width: 1920, height: 1080 }],
	renderSvg: () => '',
	presets: [
		{ id: 'light', name: 'Light', params: {} },
		{ id: 'dark', name: 'Dark', description: 'Dark theme', params: { dark: true } },
	],
	ui: {
		groups: [{ id: 'look', label: 'Look', params: ['dark'] }],
		params: { name: { label: 'Author' } },
	},
};
const registry = createMgRegistry([twin]);

function fakeBinary(): string {
	const dir = mkdtempSync(join(tmpdir(), 'jasper-mg-fake-'));
	const native = registry
		.catalogJson()
		.map(({ presets: _p, ui: _u, description: _d, renderer: _r, ...t }) => t);
	writeFileSync(
		join(dir, 'version.json'),
		JSON.stringify({ name: 'jasper-mg', version: '0.0.0', renderer: 'x' }),
	);
	writeFileSync(join(dir, 'schema.json'), JSON.stringify({ templates: native }));
	const bin = join(dir, 'jasper-mg');
	writeFileSync(
		bin,
		`#!/bin/sh\nif [ "$1" = "--version" ]; then cat "${dir}/version.json"; else cat "${dir}/schema.json"; fi\n`,
	);
	chmodSync(bin, 0o755);
	return bin;
}

describe('motion-graphics catalogue presets and ui hints', () => {
	it('lists them from the TS catalog (renderer unavailable)', async () => {
		const mgDir = mkdtempSync(join(tmpdir(), 'jasper-mg-dir-'));
		const svc = createMgService({ mgDir, env: { JASPER_MG: '/nonexistent' }, registry });
		await svc.refresh();
		const body = MgTemplatesResponseSchema.parse(svc.templates());
		expect(body.renderer.status).toBe('unavailable');
		expect(body.templates[0]).toMatchObject({
			id: 'card',
			native: false,
			presets: [
				{ id: 'light', name: 'Light', params: {} },
				{ id: 'dark', name: 'Dark', description: 'Dark theme', params: { dark: true } },
			],
			ui: {
				groups: [{ id: 'look', label: 'Look', params: ['dark'] }],
				params: { name: { label: 'Author' } },
			},
		});
		await svc.shutdown();
	});

	it('adds the twin presets to native entries', async () => {
		const mgDir = mkdtempSync(join(tmpdir(), 'jasper-mg-dir-'));
		const svc = createMgService({ mgDir, env: { JASPER_MG: fakeBinary() }, registry });
		const probe = await svc.refresh();
		expect(probe.status, JSON.stringify(probe)).toBe('ready');
		const body = MgTemplatesResponseSchema.parse(svc.templates());
		expect(body.templates[0]).toMatchObject({ id: 'card', native: true });
		expect(body.templates[0]!.presets?.map((p) => p.id)).toEqual(['light', 'dark']);
		expect(body.templates[0]!.ui?.params?.name?.label).toBe('Author');
		await svc.shutdown();
	});
});
