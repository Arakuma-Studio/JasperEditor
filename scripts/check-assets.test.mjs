import { describe, expect, it } from 'vitest';
import { findProblems, parseSidecar } from './check-assets.mjs';

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

const problems = (files) =>
	findProblems(Object.keys(files), (p) => (Object.hasOwn(files, p) ? files[p] : null)).map((p) => p.problem);

describe('check-assets', () => {
	it('requires attribution for assets while ignoring source and data files', () => {
		for (const f of ['a.png', 'b.JPG', 'c.ttf', 'd.cube', 'e.mp4', 'f.onnx', 'g.wasm', 'h.jasper', 'i.svg'])
			expect(
				findProblems([f], () => null).map((p) => p.file),
				f,
			).toEqual([f]);
		for (const f of ['a.ts', 'b.json', 'c.md', 'e.txt'])
			expect(
				findProblems([f], () => null),
				f,
			).toEqual([]);
	});

	it('accepts an asset with a complete sidecar and an index row', () => {
		expect(
			problems({ 'img/logo.png': 'x', 'img/logo.png.attribution': SIDECAR, 'ATTRIBUTION.md': INDEX }),
		).toEqual([]);
	});

	it('fails on a missing index row, missing keys, a wrong asset name, a bad licence or date', () => {
		expect(
			problems({ 'img/logo.png': 'x', 'img/logo.png.attribution': SIDECAR, 'ATTRIBUTION.md': '' }),
		).toEqual([expect.stringContaining('ATTRIBUTION.md')]);
		for (const [before, after, field] of [
			['asset:        logo.png', 'asset:        other.png', 'asset:'],
			['LicenseRef-JasperEditor', 'CC-BY-NC-4.0', 'CC-BY-NC-4.0'],
			['2026-10-07 by tests', 'yesterday', 'added:'],
			['notes:        drawn by code', '', 'notes'],
		]) {
			const found = problems({
				'img/logo.png': 'x',
				'img/logo.png.attribution': SIDECAR.replace(before, after),
				'ATTRIBUTION.md': INDEX,
			});
			expect(found).toEqual([expect.stringContaining(field)]);
		}
	});

	it('checks that a named licence file exists, and accepts SPDX expressions', () => {
		const withFile = SIDECAR.replace('license-file: none', 'license-file: img/OFL.txt').replace(
			'LicenseRef-JasperEditor',
			'OFL-1.1 OR MIT',
		);
		expect(
			problems({ 'img/logo.png': 'x', 'img/logo.png.attribution': withFile, 'ATTRIBUTION.md': INDEX }),
		).toEqual([expect.stringContaining('img/OFL.txt')]);
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
		expect(findProblems(['img/gone.png.attribution'], () => SIDECAR)).toEqual([
			expect.objectContaining({ file: 'img/gone.png.attribution' }),
		]);
		expect(findProblems(['fixtures/media/clip-a.mp4'], () => '')).toEqual([
			expect.objectContaining({ file: 'fixtures/media/clip-a.mp4' }),
		]);
	});

	it('parses continuation lines', () => {
		expect(parseSidecar('notes: one\n  two\nlicense: MIT\n')).toEqual({ notes: 'one two', license: 'MIT' });
	});
});
