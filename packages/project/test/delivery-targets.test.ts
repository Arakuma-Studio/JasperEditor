// Delivery targets and their export format (spec 18 AF-VER-003 / AF-VER-004).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	DELIVERY_DEFAULT_LUFS,
	DELIVERY_TARGET_IDS,
	DELIVERY_TARGETS,
	type DeliveryLimits,
	deliveryExportFormat,
	deliveryPresetId,
	deliveryTarget,
} from '../src/index.ts';

const NOTE = join(import.meta.dirname, '../../../docs/wp-notes/agent-footage-verify.md');

describe('DELIVERY_TARGETS', () => {
	it('keeps the persisted ids in order and gives every target limits', () => {
		expect(DELIVERY_TARGETS.map((t) => t.id)).toEqual([...DELIVERY_TARGET_IDS]);
		for (const t of DELIVERY_TARGETS) {
			const l = t.limits;
			expect(l.maxDurationSec).toBeGreaterThan(0);
			expect(l.maxFileSizeBytes).toBeGreaterThan(0);
			expect(l.maxFrameRate).toBeGreaterThanOrEqual(Math.max(...l.frameRates));
			if (l.minFrameRate !== null) expect(Math.min(...l.frameRates)).toBeGreaterThanOrEqual(l.minFrameRate);
			if (l.aspectRange) {
				const shape = l.recommendedSize.width / l.recommendedSize.height;
				expect(shape).toBeGreaterThanOrEqual(l.aspectRange.min);
				expect(shape).toBeLessThanOrEqual(l.aspectRange.max);
			}
			for (const a of t.assumptions) expect(Object.keys(l)).toContain(a);
		}
	});

	it('matches the cited table of the wp-note (values, official / assumption labels)', () => {
		const text = readFileSync(NOTE, 'utf8');
		const section = text.slice(text.indexOf('## Delivery targets'));
		const rows = section
			.split('\n')
			.filter((l) => l.startsWith('| `'))
			.map((l) => l.split('|').map((c) => c.trim()));
		const fmt = (k: keyof DeliveryLimits, v: DeliveryLimits[keyof DeliveryLimits]): string => {
			if (v === null) return 'none';
			if (k === 'recommendedSize') {
				const s = v as DeliveryLimits['recommendedSize'];
				return `${s.width}x${s.height}`;
			}
			if (k === 'aspectRange') {
				const r = v as NonNullable<DeliveryLimits['aspectRange']>;
				return `${+r.min.toFixed(4)}-${+r.max.toFixed(4)}`;
			}
			if (Array.isArray(v)) return v.join(',');
			return String(v);
		};
		let checked = 0;
		for (const t of DELIVERY_TARGETS) {
			for (const k of Object.keys(t.limits) as (keyof DeliveryLimits)[]) {
				const row = rows.find((r) => r[1] === `\`${t.id}\`` && r[2] === `\`${k}\``);
				expect(row, `${t.id}.${k} has a row`).toBeDefined();
				expect(row![3], `${t.id}.${k}`).toBe(fmt(k, t.limits[k]));
				const assumed = t.assumptions.includes(k);
				expect(row![5]!.startsWith(assumed ? 'assumption' : 'official'), `${t.id}.${k} label`).toBe(true);
				if (!assumed) expect(row![4]).toMatch(/^https:\/\//);
				checked++;
			}
		}
		expect(rows.length).toBe(checked);
	});
});

describe('deliveryExportFormat', () => {
	const fps30 = { num: 30, den: 1 };

	it('fits a matching sequence into the recommended size, keeps its rate and normalises loudness', () => {
		const r = deliveryExportFormat(deliveryTarget('youtube-shorts'), {
			width: 720,
			height: 1280,
			frameRate: fps30,
		});
		expect(r).toEqual({
			ok: true,
			format: {
				presetId: 'delivery-youtube-shorts',
				container: 'mp4',
				videoCodec: 'h264',
				width: 1080,
				height: 1920,
				frameRate: fps30,
				crf: 18,
				audio: { codec: 'aac', sampleRate: 48000, bitrateKbps: 256 },
				normalize: { targetLufs: -14, truePeakDb: -1 },
			},
		});
		expect(deliveryPresetId(deliveryTarget('x'))).toBe('delivery-x');
	});

	it('refuses a vertical target for a horizontal sequence with the Auto Reframe hint (never crops)', () => {
		for (const id of ['youtube-shorts', 'instagram-reels', 'tiktok'] as const) {
			const r = deliveryExportFormat(deliveryTarget(id), { width: 1920, height: 1080, frameRate: fps30 });
			expect(r.ok).toBe(false);
			if (r.ok) continue;
			expect(r.refusal.code).toBe('E_INVALID_PARAM');
			expect(r.refusal.hint).toBe('auto_reframe_sequence');
			expect(r.refusal.aspect).toBe('9:16');
			expect(r.refusal.message).toContain('auto_reframe_sequence');
		}
	});

	it('refuses shapes outside the accepted range and fits other shapes without padding', () => {
		const wide = deliveryExportFormat(deliveryTarget('x'), { width: 4000, height: 1000, frameRate: fps30 });
		expect(wide.ok).toBe(false);
		const square = deliveryExportFormat(deliveryTarget('tiktok'), {
			width: 1000,
			height: 1000,
			frameRate: fps30,
		});
		expect(square.ok && square.format).toMatchObject({ width: 1080, height: 1080 });
		const yt = deliveryExportFormat(deliveryTarget('linkedin'), {
			width: 1920,
			height: 1080,
			frameRate: fps30,
		});
		expect(yt.ok && yt.format).toMatchObject({ width: 1080, height: 608 });
	});

	it('moves a rate the platform does not take to the nearest recommended rate', () => {
		const hi = deliveryExportFormat(deliveryTarget('tiktok'), {
			width: 1080,
			height: 1920,
			frameRate: { num: 120, den: 1 },
		});
		expect(hi.ok && hi.format.frameRate).toEqual({ num: 60, den: 1 });
		const lo = deliveryExportFormat(deliveryTarget('instagram-reels'), {
			width: 1080,
			height: 1920,
			frameRate: { num: 15, den: 1 },
		});
		expect(lo.ok && lo.format.frameRate).toEqual({ num: 24, den: 1 });
		const ntsc = deliveryExportFormat(deliveryTarget('youtube'), {
			width: 1920,
			height: 1080,
			frameRate: { num: 30000, den: 1001 },
		});
		expect(ntsc.ok && ntsc.format.frameRate).toEqual({ num: 30000, den: 1001 });
		const li = deliveryExportFormat(deliveryTarget('linkedin'), {
			width: 1080,
			height: 1080,
			frameRate: fps30,
		});
		expect(li.ok && li.format.normalize.targetLufs).toBe(DELIVERY_DEFAULT_LUFS);
	});
});
