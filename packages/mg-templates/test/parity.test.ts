// Shipped schemas and the native CLI share a parameter protocol; SVG twins also preserve geometry and timing.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { MgCatalogEntryJson } from '../src/index.ts';
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
		const files: Record<string, { templates: MgCatalogEntryJson[] } | MgCatalogEntryJson['paramsSchema']> =
			Object.fromEntries(catalog.map((entry) => [`${entry.id}@${entry.version}.json`, entry.paramsSchema]));
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

type Token = { n: number } | { s: string };
function tokens(svg: string): Token[] {
	const out: Token[] = [];
	for (const part of svg.split(/(-?\d+(?:\.\d+)?)/)) {
		if (part === '') continue;
		out.push(/^-?\d+(?:\.\d+)?$/.test(part) ? { n: Number(part) } : { s: part });
	}
	return out;
}

function expectSameMarkup(native: string, twin: string, label: string) {
	const a = tokens(native);
	const b = tokens(twin);
	expect(a.length, `${label}: token count`).toBe(b.length);
	for (let i = 0; i < a.length; i++) {
		const x = a[i]!;
		const y = b[i]!;
		if ('n' in x && 'n' in y)
			expect(Math.abs(x.n - y.n), `${label}: number #${i}`).toBeLessThanOrEqual(0.002);
		else expect(x, `${label}: token #${i}`).toEqual(y);
	}
}

describe.skipIf(!parityEnabled)('native parity (MG_PARITY=1)', () => {
	it('`jasper-mg schema` equals the TS catalog', () => {
		const native = JSON.parse(execFileSync(binary, ['schema'], { encoding: 'utf8' })) as {
			templates: MgCatalogEntryJson[];
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

	it('`jasper-mg svg` equals the TS twins', () => {
		const cases = [
			{ width: 1920, height: 1080, fps: { num: 30, den: 1 }, durationFrames: 150 },
			{ width: 1280, height: 720, fps: { num: 30000, den: 1001 }, durationFrames: 97, sourceInFrames: 12 },
			{ width: 1080, height: 1920, fps: { num: 25, den: 1 }, durationFrames: 60 },
		];
		const paramSets: Record<string, Record<string, unknown>[]> = {
			'lower-third': [
				{},
				{ name: 'Zoë <Ng> & "Co"', title: '', holdUntilFrames: 40, position: [-10.5, 33.25] },
			],
			'title-card': [{}, { alignment: 'right', subtitle: '', fadeInFrames: 0, background: [1, 1, 1, 0.5] }],
		};
		for (const def of FFRAMES_CATALOG) {
			for (const params of paramSets[def.id]!) {
				for (const c of cases) {
					const spec = { template: { id: def.id, version: def.version }, params, ...c };
					for (const frame of [0, 7, Math.floor(c.durationFrames / 2), c.durationFrames - 1]) {
						const native = execFileSync(binary, ['svg', '--spec', '-', '--frame', String(frame)], {
							input: JSON.stringify(spec),
							encoding: 'utf8',
						}).trim();
						const twin = def.renderSvg(
							def.paramsSchema.parse(params),
							frame,
							c.fps.num / c.fps.den,
							{ width: c.width, height: c.height },
							{ durationFrames: c.durationFrames, sourceInFrames: c.sourceInFrames ?? 0 },
						);
						expectSameMarkup(native, twin, `${def.id} ${c.width}x${c.height} f${frame}`);
					}
				}
			}
		}
	});
});
