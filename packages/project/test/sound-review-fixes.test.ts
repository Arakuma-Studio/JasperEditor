// Phase 1 verification (docs/wp-notes/sound-design.md "Phase 1 verification"): regression tests for the review
// findings in the pure sound model — each failed before its fix.
import { describe, expect, it } from 'vitest';
import {
	isCommercialSafe,
	type LibraryProvenance,
	licenseClass,
	readLibraryProvenance,
	requiresAttribution,
	soundCredits,
} from '../src/index.ts';
import { Harness, videoAsset } from './helpers.ts';
import { LIB } from './sound-fixtures.ts';

describe('licence classes need the whole SPDX id', () => {
	it('a CC BY prefix with anything after it is not commercial-safe CC BY', () => {
		for (const l of [
			'CC-BY-4.0 AND LicenseRef-Proprietary',
			'CC-BY-4.0 (non-commercial)',
			'CC-BY-4.0x',
			'CC-BY-SA-4.0 OR GPL',
		]) {
			expect(licenseClass(l), l).toBe('unknown');
			expect(isCommercialSafe(l), l).toBe(false);
		}
		for (const l of [
			'CC-BY-4.0',
			'cc-by-3.0',
			'CC-BY-3.0-AT',
			'CC-BY-2.5-AU',
			'CC-BY-3.0-IGO',
			'CC-BY',
			' CC-BY-4.0 ',
		])
			expect(licenseClass(l), l).toBe('cc-by');
		for (const l of ['CC-BY-SA-4.0', 'CC-BY-SA-2.0-UK', 'CC-BY-SA'])
			expect(licenseClass(l), l).toBe('cc-by-sa');
		expect(licenseClass('CC-BY-NC-4.0')).toBe('nc');
		expect(licenseClass('CC-BY-4.0-NC')).toBe('nc');
		expect(licenseClass('CC-BY-ND-4.0')).toBe('nd');
		expect(requiresAttribution('CC-BY-4.0 AND LicenseRef-Proprietary')).toBe(false);
	});
});

describe('provenance repair keeps unknown fields of any name', () => {
	it('an unknown "constructor" or "toString" field survives a field-by-field repair, as on the valid path', () => {
		const raw = JSON.parse(
			JSON.stringify({ ...LIB, title: 42, constructor: { a: 1 }, toString: 'x', hasOwnProperty: 3 }),
		) as Record<string, unknown>;
		const r = readLibraryProvenance(raw) as Record<string, unknown> | null;
		expect(r).not.toBeNull();
		expect(Object.hasOwn(r!, 'constructor')).toBe(true);
		expect(r!.toString).toBe('x');
		expect(r!.hasOwnProperty).toBe(3);
		expect(r!.title).toBe(LIB.soundId);
	});
});

describe('Markdown credits', () => {
	it('links only web URLs and escapes brackets', () => {
		const h = new Harness();
		const m = h.registerVideo({ kind: 'audio', seconds: 1 });
		const library: LibraryProvenance = {
			...LIB,
			title: 'Hit [loud]',
			license: 'CC-BY-4.0',
			licenseUrl: 'javascript:alert(1)',
		};
		h.ok([{ type: 'media.setLibraryInfo', mediaId: m, library }]);
		h.ok([{ type: 'clip.place', source: { mediaId: m }, at: 0, tracks: { audio: 'A1' } }]);
		const md = soundCredits(h.doc).markdown;
		expect(md).not.toContain('](javascript');
		expect(md).toContain('Hit \\[loud\\]');
		h.ok([
			{
				type: 'media.setLibraryInfo',
				mediaId: m,
				library: { ...library, licenseUrl: 'https://example.org/l' },
			},
		]);
		expect(soundCredits(h.doc).markdown).toContain('[CC-BY-4.0](https://example.org/l)');
	});
});

describe('media.register validates provenance like media.setLibraryInfo', () => {
	it('refuses provenance on a still image and descriptors past the end of the sound', () => {
		const h = new Harness();
		const still = h.tx([
			{ type: 'media.register', asset: { ...videoAsset({ kind: 'image' }), library: LIB } },
		]);
		expect(still.ok).toBe(false);
		if (!still.ok) expect(still.errors[0]!.code).toBe('E_INVALID_PARAM');
		const late = h.tx([
			{
				type: 'media.register',
				asset: {
					...videoAsset({ kind: 'audio', seconds: 1 }),
					library: { ...LIB, descriptors: { ...LIB.descriptors!, peakSec: 5 } },
				},
			},
		]);
		expect(late.ok).toBe(false);
		if (!late.ok) expect(late.errors[0]!.code).toBe('E_INVALID_PARAM');
		// valid provenance on audio still registers
		const fine = h.tx([
			{ type: 'media.register', asset: { ...videoAsset({ kind: 'audio', seconds: 1 }), library: LIB } },
		]);
		expect(fine.ok, JSON.stringify(fine)).toBe(true);
	});
});
