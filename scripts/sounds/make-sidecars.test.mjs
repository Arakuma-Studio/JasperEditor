// The starter kit's sidecars and ATTRIBUTION.md rows are generated from its manifest (make-sidecars.mjs): the committed
// files must be exactly what the generator writes, and the generator's pieces behave.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSidecar } from '../check-assets.mjs';
import {
	attributionSection,
	BEGIN,
	END,
	STARTER_REL,
	sidecarText,
	syncSidecars,
	withSection,
} from './make-sidecars.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const manifest = JSON.parse(readFileSync(join(ROOT, STARTER_REL, 'manifest.json'), 'utf8'));

describe('starter-kit sidecars', () => {
	it('the committed sidecars and ATTRIBUTION.md section are up to date', () => {
		expect(syncSidecars({ write: false }).problems).toEqual([]);
	});

	it('a sidecar has every key check-assets requires, with the manifest values', () => {
		const sound = manifest.sounds[0];
		const pack = manifest.packs.find((p) => p.id === sound.packId);
		const text = sidecarText(
			sound,
			pack,
			{ src: ['a.ogg', 'b.ogg'], filter: '[in0][in1]concat[out]', derivation: 'a then b' },
			'2026-10-15 by test',
		);
		const s = parseSidecar(text);
		expect(s.asset).toBe(sound.file);
		expect(s.author).toBe(sound.author);
		expect(s.source).toBe(sound.sourceUrl);
		expect(s.license).toBe('CC0-1.0');
		expect(s['license-file']).toBe('none');
		expect(s.added).toBe('2026-10-15 by test');
		expect(s.notes).toContain(pack.sha256);
		expect(s.notes).toContain('Audio/a.ogg, Audio/b.ogg: a then b');
		expect(sidecarText(sound, pack, { src: ['x.ogg'] }, 'd').includes('Audio/x.ogg, unedited')).toBe(true);
	});

	it('the ATTRIBUTION.md section is replaced in place or appended once', () => {
		const section = attributionSection(manifest);
		expect(section.startsWith(BEGIN) && section.endsWith(END)).toBe(true);
		for (const s of manifest.sounds) expect(section).toContain(`| \`${STARTER_REL}/${s.file}\` |`);
		const appended = withSection('# Attribution\n', section);
		expect(appended).toBe(`# Attribution\n\n${section}\n`);
		expect(withSection(appended, section)).toBe(appended);
		const replaced = withSection(`a\n${BEGIN}\nold\n${END}\nb\n`, section);
		expect(replaced).toBe(`a\n${section}\nb\n`);
	});
});
