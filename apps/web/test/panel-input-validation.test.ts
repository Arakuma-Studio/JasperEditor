import type { GraphicTemplate } from '@jasper/project';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseGraphicLibrary } from '../src/panels/essentialGraphics/library.ts';
import { readMgTemplateDrag } from '../src/panels/motionTemplates/insert.ts';

const template: GraphicTemplate = {
	format: 'jasper-graphic-template',
	version: 1,
	name: 'Title',
	frame: { width: 1920, height: 1080 },
	payload: {},
};
const entry = { id: 'title', template, savedAt: '2026-10-11T10:00:00Z' };

describe('panel input validation', () => {
	it('preserves valid graphic templates beside malformed entries', () => {
		expect(parseGraphicLibrary([null, entry, {}, { ...entry, id: 3 }])).toEqual([entry]);
	});

	it('handles arbitrary persisted library values without discarding a valid neighbor', () => {
		fc.assert(
			fc.property(fc.jsonValue(), (raw) => {
				expect(() => parseGraphicLibrary(raw)).not.toThrow();
				expect(parseGraphicLibrary([raw, entry])).toContainEqual(entry);
			}),
		);
	});

	it.each([
		{ id: 'title' },
		{ id: 'title', version: '1' },
		{ id: 'title', version: 0 },
		{ id: 'title', version: 1.5 },
		{ id: '', version: 1 },
		{ id: 'title', version: 1, composition: {} },
		{ id: 'title', version: 1, composition: { mediaId: 'm', compositionId: 3 } },
	])('refuses an invalid template drag: %j', (template) => {
		expect(
			readMgTemplateDrag({ getData: () => JSON.stringify({ type: 'jasper/mg-template', template }) }),
		).toBeNull();
	});

	it('accepts a composition drag with a complete reference', () => {
		const template = { id: 'title', version: 1, composition: { mediaId: 'media', compositionId: 'title' } };
		expect(
			readMgTemplateDrag({ getData: () => JSON.stringify({ type: 'jasper/mg-template', template }) })
				?.template,
		).toEqual(template);
	});

	it('never throws on arbitrary drag JSON', () => {
		fc.assert(
			fc.property(fc.jsonValue(), (raw) => {
				expect(() => readMgTemplateDrag({ getData: () => JSON.stringify(raw) })).not.toThrow();
			}),
		);
	});
});
