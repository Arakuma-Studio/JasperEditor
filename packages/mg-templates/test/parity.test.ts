// Shipped JSON schemas and the independent native CLI expose the same parameter protocol.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FFRAMES_CATALOG, mgRegistry } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const binary =
	process.env.JASPER_MG ??
	join(
		repo,
		'native',
		'mg',
		'target',
		'release',
		process.platform === 'win32' ? 'jasper-mg.exe' : 'jasper-mg',
	);
const parityEnabled = process.env.MG_PARITY === '1' && existsSync(binary);
if (!parityEnabled)
	console.info(
		`[mg parity] native comparison skipped (${process.env.MG_PARITY === '1' ? `no binary at ${binary}` : 'set MG_PARITY=1 after pnpm mg:build'})`,
	);

describe('checked-in schemas', () => {
	it('schemas/ matches the TS catalog (run `pnpm --filter @jasper/mg-templates schemas`)', () => {
		const catalog = mgRegistry.catalogJson().filter((entry) => entry.renderer !== 'anime');
		const files = Object.fromEntries(
			catalog.map((entry) => [`${entry.id}@${entry.version}.json`, entry.paramsSchema]),
		);
		files['catalog.json'] = { templates: catalog };
		const onDisk = readdirSync(join(here, '..', 'schemas')).filter((f) => f.endsWith('.json'));
		expect(onDisk.sort()).toEqual(Object.keys(files).sort());
		for (const [name, json] of Object.entries(files)) {
			const disk = JSON.parse(readFileSync(join(here, '..', 'schemas', name), 'utf8'));
			expect(disk, name).toEqual(json);
		}
	});

	it('fframes schemas reject unknown fields and invalid colour or frame values', () => {
		for (const def of FFRAMES_CATALOG) {
			expect(def.paramsSchema.safeParse({}).success, def.id).toBe(true);
			expect(def.paramsSchema.safeParse({ bogus: 1 }).success, def.id).toBe(false);
		}
		const lt = mgRegistry.getDefinition('lower-third', 1)!;
		expect(lt.paramsSchema.safeParse({ accentColor: [0.5, 0, 0, 1] }).success).toBe(true);
		expect(lt.paramsSchema.safeParse({ accentColor: [2, 0, 0, 1] }).success).toBe(false);
		expect(lt.paramsSchema.safeParse({ holdUntilFrames: 1 }).success).toBe(true);
		expect(lt.paramsSchema.safeParse({ holdUntilFrames: -1 }).success).toBe(false);
		expect(lt.paramsSchema.safeParse({ holdUntilFrames: 1.5 }).success).toBe(false);
	});
});

describe.skipIf(!parityEnabled)('native parity (MG_PARITY=1)', () => {
	it('`jasper-mg schema` equals the TS catalog', () => {
		const native = JSON.parse(execFileSync(binary, ['schema'], { encoding: 'utf8' })) as {
			templates: Record<string, unknown>[];
		};
		const ts = mgRegistry.catalogJson().filter((t) => t.renderer !== 'anime');
		expect(native.templates.map((t) => `${t.id}@${t.version}`).sort()).toEqual(
			ts.map((t) => `${t.id}@${t.version}`).sort(),
		);
		for (const t of ts) {
			const n = native.templates.find((entry) => entry.id === t.id && entry.version === t.version)!;
			for (const key of [
				'name',
				'category',
				'paramsSchema',
				'defaults',
				'introFrames',
				'outroFrames',
				'defaultDurationSeconds',
				'canvases',
			] as const) {
				expect(n[key], `${t.id} ${key}`).toEqual(t[key]);
			}
		}
	});
});
