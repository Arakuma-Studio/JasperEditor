// scripts/check-assets.mjs (AGENTS.md §3, ARCHITECTURE D-38): sidecars, the ATTRIBUTION.md index and the fix text.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkRepo, findProblems, isAsset, parseSidecar, template } from './check-assets.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

const SIDECAR = `asset:        logo.png
title:        A logo
author:       JasperEditor contributors
source:       original work
license:      LicenseRef-JasperEditor
license-file: none
added:        2026-10-07 by tests
notes:        drawn by code
`;
const INDEX = '| `img/logo.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |\n';

/** Problems of an in-memory repo `{path: text}`. */
const problems = (files) =>
	findProblems(Object.keys(files), (p) => (Object.hasOwn(files, p) ? files[p] : null)).map((p) => p.problem);

describe('check-assets', () => {
	it('recognises assets by extension, not code or data', () => {
		for (const f of ['a.png', 'b.JPG', 'c.ttf', 'd.cube', 'e.mp4', 'f.onnx', 'g.wasm', 'h.jasper', 'i.svg'])
			expect(isAsset(f), f).toBe(true);
		for (const f of ['a.ts', 'b.json', 'c.md', 'd.png.attribution', 'e.txt'])
			expect(isAsset(f), f).toBe(false);
	});

	it('accepts an asset with a complete sidecar and an index row', () => {
		expect(
			problems({ 'img/logo.png': 'x', 'img/logo.png.attribution': SIDECAR, 'ATTRIBUTION.md': INDEX }),
		).toEqual([]);
	});

	it('fails without a sidecar, and the fix is the exact template to write', () => {
		const all = findProblems(['img/logo.png', 'ATTRIBUTION.md'], (p) => (p === 'ATTRIBUTION.md' ? '' : 'x'));
		expect(all.map((p) => p.problem)).toEqual(['asset without an attribution sidecar']);
		expect(all[0].fix).toContain('Create img/logo.png.attribution');
		expect(all[0].fix).toContain('asset:        logo.png');
		expect(all[0].fix).toContain('| `img/logo.png` |');
		expect(template('x/y.ttf')).toMatch(/license-file: .*none/);
	});

	it('fails on a missing index row, missing keys, a wrong asset name, a bad licence or date', () => {
		expect(
			problems({ 'img/logo.png': 'x', 'img/logo.png.attribution': SIDECAR, 'ATTRIBUTION.md': '' }),
		).toEqual(['no row in ATTRIBUTION.md']);
		const broken = SIDECAR.replace('asset:        logo.png', 'asset:        other.png')
			.replace('LicenseRef-JasperEditor', 'CC-BY-NC-4.0')
			.replace('2026-10-07 by tests', 'yesterday')
			.replace(/^notes:.*$/m, '');
		expect(
			problems({ 'img/logo.png': 'x', 'img/logo.png.attribution': broken, 'ATTRIBUTION.md': INDEX }),
		).toEqual([
			'missing or empty key(s): notes',
			'asset: is "other.png", expected "logo.png"',
			'licence not allowed or not an SPDX id: CC-BY-NC-4.0',
			'added: "yesterday" is not "<YYYY-MM-DD> by <contributor>"',
		]);
	});

	it('checks that a named licence file exists, and accepts SPDX expressions', () => {
		const withFile = SIDECAR.replace('license-file: none', 'license-file: img/OFL.txt').replace(
			'LicenseRef-JasperEditor',
			'OFL-1.1 OR MIT',
		);
		expect(
			problems({ 'img/logo.png': 'x', 'img/logo.png.attribution': withFile, 'ATTRIBUTION.md': INDEX }),
		).toEqual(['license-file img/OFL.txt does not exist']);
		expect(
			problems({
				'img/logo.png': 'x',
				'img/logo.png.attribution': withFile,
				'img/OFL.txt': 'licence',
				'ATTRIBUTION.md': INDEX,
			}),
		).toEqual([]);
	});

	it('fails on orphan sidecars and on committed generated media', () => {
		expect(problems({ 'img/gone.png.attribution': SIDECAR, 'ATTRIBUTION.md': '' })).toEqual([
			'sidecar without its asset (img/gone.png is not in the repository)',
		]);
		expect(problems({ 'fixtures/media/clip-a.mp4': 'x', 'ATTRIBUTION.md': '' })).toEqual([
			'generated test media is committed',
		]);
	});

	it('parses continuation lines', () => {
		expect(parseSidecar('notes: one\n  two\nlicense: MIT\n')).toEqual({ notes: 'one two', license: 'MIT' });
	});

	it('the repository passes', () => {
		expect(checkRepo(repo)).toEqual([]);
	}, 60_000);
});
