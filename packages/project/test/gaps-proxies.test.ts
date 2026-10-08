// Workstream gaps (PRJ-8): attached proxies in the model.
import { describe, expect, it } from 'vitest';
import {
	checkInvariants,
	PROXY_PRESETS,
	proxyKeyOf,
	proxyMismatch,
	proxySize,
	repairDocument,
} from '../src/index.ts';
import { Harness, videoAsset } from './helpers.ts';

function proxyOf(opts: Parameters<typeof videoAsset>[0] = {}) {
	const a = videoAsset({ width: 1280, height: 720, ...opts });
	return {
		fingerprint: a.fingerprint,
		originalName: 'clip_Proxy.mp4',
		sizeBytes: 10,
		container: 'mov,mp4',
		probe: a.probe,
		locators: a.locators,
		origin: 'created' as const,
		preset: 'proxy-720',
	};
}

describe('proxies', () => {
	it('sizes keep the aspect and never upscale', () => {
		const p720 = PROXY_PRESETS.find((p) => p.id === 'proxy-720')!;
		expect(proxySize(3840, 2160, p720)).toEqual({ width: 1280, height: 720 });
		expect(proxySize(1080, 1920, p720)).toEqual({ width: 406, height: 720 });
		expect(proxySize(640, 360, p720)).toEqual({ width: 640, height: 360 });
	});

	it('checks duration, rate and orientation', () => {
		const orig = { ...videoAsset({ seconds: 10 }), id: 'm' } as never;
		expect(proxyMismatch(orig, proxyOf({ seconds: 10 }).probe)).toBeNull();
		expect(proxyMismatch(orig, proxyOf({ seconds: 10.02 }).probe)).toBeNull();
		expect(proxyMismatch(orig, proxyOf({ seconds: 11 }).probe)).toMatch(/long/);
		expect(proxyMismatch(orig, proxyOf({ fps: { num: 25, den: 1 } }).probe)).toMatch(/fps/);
		expect(proxyMismatch(orig, proxyOf({ width: 720, height: 1280 }).probe)).toMatch(/turned/);
		expect(proxyMismatch({ ...(orig as object), kind: 'audio' } as never, proxyOf().probe)).toMatch(/not a video/);
	});

	it('attach / detach are undoable commands with refusals', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 10 });
		const bad = h.tx([{ type: 'media.attachProxy', mediaId: m, proxy: proxyOf({ seconds: 4 }) }]);
		expect(bad.ok).toBe(false);
		h.ok([{ type: 'media.attachProxy', mediaId: m, proxy: proxyOf({ seconds: 4 }), force: true }]);
		expect(h.doc.media[m]!.proxy?.origin).toBe('created');
		expect(proxyKeyOf(h.doc.media[m])).toMatch(/^mk_/);
		h.ok([{ type: 'media.attachProxy', mediaId: m, proxy: proxyOf({ seconds: 10 }) }]);
		expect(h.doc.media[m]!.proxy?.attachedAt).toBe('2026-09-30T10:00:00.000Z');
		const r = h.ok([{ type: 'media.detachProxy', mediaIds: [m] }]);
		expect((r.results[0] as { detached: string[] }).detached).toEqual([m]);
		expect(h.doc.media[m]!.proxy).toBeUndefined();
		// The original itself cannot be its own proxy.
		const self = { ...proxyOf({ seconds: 10 }), fingerprint: h.doc.media[m]!.fingerprint };
		expect(h.tx([{ type: 'media.attachProxy', mediaId: m, proxy: self }]).ok).toBe(false);
	});

	it('repairs unreadable proxies by detaching them', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 10 });
		const broken = structuredClone(h.doc);
		(broken.media[m] as Record<string, unknown>).proxy = { locators: [] };
		expect(checkInvariants(broken).some((i) => i.invariant === 'INV-PROXY')).toBe(true);
		const { document, report } = repairDocument(broken, h.ids);
		expect(document.media[m]!.proxy).toBeUndefined();
		expect(report.some((r) => r.action === 'detach-proxy')).toBe(true);
	});
});
