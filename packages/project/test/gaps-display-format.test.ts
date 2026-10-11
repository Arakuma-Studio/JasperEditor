import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	checkInvariants,
	formatAudioTime,
	formatTimeDisplay,
	parseTimeDisplayEntry,
	projectSettingsOf,
	repairDocument,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const r30 = { num: 30, den: 1 };

describe('video display formats', () => {
	it('formats frames, feet + frames and timecode', () => {
		expect(formatTimeDisplay(95, r30)).toBe('00:00:03:05');
		expect(formatTimeDisplay(95, r30, { display: 'frames' })).toBe('95');
		expect(formatTimeDisplay(95, r30, { display: 'feet35' })).toBe('0005+15');
		expect(formatTimeDisplay(95, r30, { display: 'feet16' })).toBe('0002+15');
		expect(formatTimeDisplay(10, r30, { display: 'frames', startFrames: 100 })).toBe('110');
	});
	it('parses entries in the display format', () => {
		const ctx = { current: 50 };
		expect(parseTimeDisplayEntry('120', r30, { ...ctx, display: 'frames' })).toBe(120);
		expect(parseTimeDisplayEntry('+10', r30, { ...ctx, display: 'frames' })).toBe(60);
		expect(parseTimeDisplayEntry('5+15', r30, { ...ctx, display: 'feet35' })).toBe(95);
		expect(parseTimeDisplayEntry('2+15', r30, { ...ctx, display: 'feet16' })).toBe(95);
		expect(parseTimeDisplayEntry('00:00:03:05', r30, { ...ctx, display: 'frames' })).toBe(95);
		expect(parseTimeDisplayEntry('x', r30, { ...ctx, display: 'feet16' })).toBeNull();
	});
	it('round-trips every format (property)', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 5_000_000 }),
				fc.constantFrom('timecode', 'frames', 'feet35', 'feet16'),
				(f, display) => {
					const s = formatTimeDisplay(f, r30, { display: display as never });
					return parseTimeDisplayEntry(s, r30, { current: 0, display: display as never }) === f;
				},
			),
		);
	});
	it('audio time units', () => {
		expect(formatAudioTime(15, r30, 48000, 'samples')).toBe('00:00:00:24000');
		expect(formatAudioTime(45, r30, 48000, 'milliseconds')).toBe('00:00:01:500');
	});
});

describe('project settings model', () => {
	it('reads defaults and repairs unreadable settings', () => {
		const h = new Harness();
		expect(projectSettingsOf(h.doc)).toEqual({
			display: { video: 'timecode', audio: 'samples' },
			scratch: { media: null },
			ingest: { enabled: false, action: 'proxies', preset: null, destination: null },
		});
		h.ok([
			{
				type: 'project.updateSettings',
				settings: {
					display: { video: 'feet35', audio: 'milliseconds' },
					scratch: { media: '/data/media' },
					ingest: {
						enabled: true,
						action: 'copyAndProxies',
						preset: 'prores-proxy-quarter',
						destination: null,
					},
				},
			},
		]);
		const s = projectSettingsOf(h.doc);
		expect(s.display.video).toBe('feet35');
		expect(s.scratch.media).toBe('/data/media');
		expect(s.ingest).toMatchObject({ enabled: true, action: 'copyAndProxies' });
		const broken = structuredClone(h.doc);
		(broken.settings as Record<string, unknown>).display = { video: 'reels' };
		expect(checkInvariants(broken).some((i) => i.invariant === 'INV-PROJECT-SETTINGS')).toBe(true);
		const { document, report } = repairDocument(broken, h.ids);
		expect(report.some((r) => r.action === 'reset-project-settings')).toBe(true);
		expect(projectSettingsOf(document).display.video).toBe('timecode');
		expect(checkInvariants(document).filter((i) => i.invariant === 'INV-PROJECT-SETTINGS')).toEqual([]);
	});
	it('refuses invalid settings through the command', () => {
		const h = new Harness();
		const r = h.tx([{ type: 'project.updateSettings', settings: { display: { video: 'reels' } } }]);
		expect(r.ok).toBe(false);
	});
});
