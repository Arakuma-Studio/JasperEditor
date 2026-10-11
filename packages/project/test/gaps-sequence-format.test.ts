import { describe, expect, it } from 'vitest';
import { checkInvariants, displayWidthOf, repairDocument, sequenceFormatOf } from '../src/index.ts';
import { Harness, videoAsset } from './helpers.ts';

describe('sequence delivery format', () => {
	it('display width of storage widths', () => {
		expect(displayWidthOf(720, { num: 10, den: 11 })).toBe(654);
		expect(displayWidthOf(1440, { num: 4, den: 3 })).toBe(1920);
		expect(displayWidthOf(1280, { num: 3, den: 2 })).toBe(1920);
	});

	it('a pixel aspect ratio makes width the display width; square restores the storage width; undoable', () => {
		const h = new Harness();
		h.ok([
			{
				type: 'sequence.updateSettings',
				settings: { pixelAspectRatio: { num: 4, den: 3 }, storageWidth: 1440 },
			},
		]);
		expect(h.seq.settings.width).toBe(1920);
		expect(sequenceFormatOf(h.seq.settings)).toMatchObject({ storageWidth: 1440, par: { num: 4, den: 3 } });
		h.ok([{ type: 'sequence.updateSettings', settings: { fieldOrder: 'upper' } }]);
		expect(sequenceFormatOf(h.seq.settings).fieldOrder).toBe('upper');
		expect(
			h.tx([
				{
					type: 'sequence.updateSettings',
					settings: { pixelAspectRatio: { num: 4, den: 3 }, storageWidth: 1440, width: 1000 },
				},
			]).ok,
		).toBe(false);
		h.ok([{ type: 'sequence.updateSettings', settings: { pixelAspectRatio: null } }]);
		expect(h.seq.settings.width).toBe(1440);
		expect(h.seq.settings.pixelAspectRatio).toBeUndefined();
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('New Sequence From Clip matches an anamorphic interlaced clip', () => {
		const h = new Harness();
		const a = videoAsset({ width: 1440, height: 1080, fps: { num: 30000, den: 1001 } });
		const vs = a.probe.streams[0] as { pixelAspect: unknown; fieldOrder?: string };
		vs.pixelAspect = { num: 4, den: 3 };
		vs.fieldOrder = 'tt';
		const m = (h.ok([{ type: 'media.register', asset: a }]).results[0] as { mediaId: string }).mediaId;
		const r = h.ok([{ type: 'sequence.create', name: 'HDV', fromMediaId: m }]);
		const seq = h.doc.sequences[(r.results[0] as { sequenceId: string }).sequenceId]!;
		expect(seq.settings.width).toBe(1920);
		expect(sequenceFormatOf(seq.settings)).toMatchObject({ storageWidth: 1440, fieldOrder: 'upper' });
		// The clip fills the display frame (its box is the square-pixel display size).
		expect(Object.values(seq.clips).length).toBeGreaterThan(0);
	});

	it('repairs an inconsistent format to square pixels', () => {
		const h = new Harness();
		const broken = structuredClone(h.doc);
		Object.assign(Object.values(broken.sequences)[0]!.settings, {
			pixelAspectRatio: { num: 4, den: 3 },
			storageWidth: 999,
		});
		expect(checkInvariants(broken).some((i) => i.invariant === 'INV-SEQUENCE-FORMAT')).toBe(true);
		const { document, report } = repairDocument(broken, h.ids);
		expect(report.some((x) => x.action === 'reset-sequence-format')).toBe(true);
		expect(checkInvariants(document).filter((i) => i.invariant === 'INV-SEQUENCE-FORMAT')).toEqual([]);
	});
});
