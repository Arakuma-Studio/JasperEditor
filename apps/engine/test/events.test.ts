import { EngineCapabilitiesSchema, FontCatalogSchema, LicensesResponseSchema, parseEvent } from '@jasper/api';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type RunningEngine, startEngine } from '../src/index.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, H, makeApp, tempAppdir } from './helpers.ts';

let engine: RunningEngine;
beforeAll(async () => {
	engine = await startEngine({
		appdir: tempAppdir(),
		port: 0,
		insecure: true,
		dev: true,
		env: { PATH: process.env.PATH },
	});
});
afterAll(async () => {
	await engine.stop();
	await closeApps();
});

async function readEvents(
	url: string,
	count: number,
	during?: () => void,
): Promise<Record<string, unknown>[]> {
	const ac = new AbortController();
	const res = await fetch(url, { signal: ac.signal });
	expect(res.status).toBe(200);
	expect(res.headers.get('content-type')).toContain('application/x-ndjson');
	const reader = res.body!.getReader();
	const out: Record<string, unknown>[] = [];
	let buf = '';
	const dec = new TextDecoder();
	let triggered = false;
	const timer = setTimeout(() => ac.abort(), 10_000);
	try {
		while (out.length < count) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += dec.decode(value, { stream: true });
			for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
				out.push(JSON.parse(buf.slice(0, nl)));
				buf = buf.slice(nl + 1);
			}
			if (!triggered && out.length > 0) {
				triggered = true;
				during?.();
			}
		}
	} finally {
		clearTimeout(timer);
		ac.abort();
	}
	return out;
}

describe('GET /events (NDJSON)', () => {
	it('streams live events after an initial heartbeat, filtered by projectId, and resumes with ?since=', async () => {
		const b = coreServices(engine.app).broadcaster;
		const first = await readEvents(`${engine.url}/events?projectId=prj_A`, 4, () => {
			b.publish('media.updated', { mediaKey: 'mk_a', status: 'online' }, 'prj_A');
			b.publish('media.updated', { mediaKey: 'mk_b', status: 'online' }, 'prj_B');
			b.publish('capabilities.changed', {});
			b.publish('media.updated', { mediaKey: 'mk_c', status: 'online' }, 'prj_A');
		});
		expect(first[0]).toMatchObject({ type: 'engine.heartbeat' });
		const live = first.slice(1);
		expect(live.map((e) => e.type)).toEqual(['media.updated', 'capabilities.changed', 'media.updated']);
		expect(live.map((e) => (e.payload as { mediaKey?: string }).mediaKey)).toEqual([
			'mk_a',
			undefined,
			'mk_c',
		]);
		for (const e of live) expect(parseEvent(e)).not.toBeNull();
		const ids = live.map((e) => e.id as number);
		expect(ids).toEqual([...ids].sort((a, c) => a - c));

		const resumed = (await readEvents(`${engine.url}/events?since=${ids[0]}`, 4)).filter(
			(e) => e.type !== 'engine.heartbeat',
		);
		expect(resumed.map((e) => e.id)).toEqual([ids[0]! + 1, ids[0]! + 2, ids[0]! + 3]);
		expect(resumed[0]).toMatchObject({ projectId: 'prj_B' });
	});

	it('rejects a malformed since', async () => {
		const r = await fetch(`${engine.url}/events?since=abc`);
		expect(r.status).toBe(400);
		expect((await r.json()).code).toBe('VALIDATION_FAILED');
	});
});

describe('capabilities and fonts', () => {
	it('reports ffmpeg, native render, Remotion state and provider patches (WP-2G hook)', async () => {
		// Pin the route plugin's fframes provider to unavailable so the baseline does not depend on
		// whether pnpm mg:build was run on this machine.
		vi.stubEnv('JASPER_MG', '/nonexistent/jasper-mg');
		const app = await makeApp().finally(() => vi.unstubAllEnvs());
		const caps = EngineCapabilitiesSchema.parse(
			(await app.inject({ method: 'GET', url: '/api/capabilities', headers: H })).json(),
		);
		expect(caps.engine).toMatchObject({
			apiVersion: 1,
			mode: 'dev',
			pathRegistration: true,
		});
		expect(caps.media.ffmpegVersion).toBeTruthy();
		expect(caps.media.encoders).toEqual(expect.arrayContaining(['aac']));
		// D-13: the vendored LGPL build has OpenH264, a system dev build libx264.
		expect(caps.media.encoders.some((e) => e === 'libx264' || e === 'libopenh264')).toBe(true);
		expect(['vendor', 'path', 'env']).toContain(caps.media.ffmpegSource);
		expect(caps.render.remotionBinaries).toMatchObject({
			source: expect.stringMatching(/^(vendor|bundled)$/),
		});
		expect(caps.media.filters).toEqual(expect.arrayContaining(['overlay', 'amix', 'scale']));
		const lic = LicensesResponseSchema.parse(
			(await app.inject({ method: 'GET', url: '/api/licenses', headers: H })).json(),
		);
		expect(lic.components.filter((c) => c.id === 'ffmpeg')).toHaveLength(1);
		const opencv = lic.components.find((c) => c.id === 'opencv-js');
		expect(opencv).toMatchObject({ id: 'opencv-js', license: 'Apache-2.0', bundled: true });
		expect(opencv!.texts[0]!.text).toMatch(/Apache License/);
		expect(lic.components.find((component) => component.id === 'ffmpeg')).toMatchObject({
			id: 'ffmpeg',
			bundled: caps.media.ffmpegSource === 'vendor',
		});
		expect(lic.components.find((component) => component.id === 'ffmpeg')!.texts.length > 0).toBe(
			caps.media.ffmpegSource === 'vendor',
		);
		expect(caps.render.native).toBe(true);
		expect(['ready', 'needs-browser-download']).toContain(caps.render.remotionLocal);
		expect(caps.render.fframes).toBe('unavailable');
		expect(caps.limits.cpuCount).toBeGreaterThan(0);
		expect(caps.limits.freeDiskBytes).toBeGreaterThan(0);
		const events: string[] = [];
		coreServices(app).broadcaster.subscribe((e) => events.push(e.type));
		const off = coreServices(app).registerCapabilityProvider(() => ({
			render: { fframes: 'ready', fframesReason: undefined },
		}));
		expect(events).toContain('capabilities.changed');
		const patched = (await app.inject({ method: 'GET', url: '/api/capabilities', headers: H })).json();
		expect(patched.render).toMatchObject({ fframes: 'ready', native: true });
		expect(patched.render.fframesReason).toBeUndefined();
		off();
		expect(
			(await app.inject({ method: 'GET', url: '/api/capabilities', headers: H })).json().render.fframes,
		).toBe('unavailable');
	});

	it('serves the curated font catalog and immutable font files', async () => {
		const app = await makeApp();
		const cat = FontCatalogSchema.parse(
			(await app.inject({ method: 'GET', url: '/api/fonts', headers: H })).json(),
		);
		const inter = cat.fonts.find((font) => font.family === 'Inter');
		expect(inter).toBeDefined();
		const file = inter!.files.find((f) => f.weight === 400 && f.style === 'normal' && f.subset === 'latin')!;
		const r = await app.inject({ method: 'GET', url: file.url, headers: H });
		expect(r.statusCode).toBe(200);
		expect(r.headers['content-type']).toBe('font/woff2');
		expect(r.headers['cache-control']).toContain('immutable');
		expect(r.rawPayload.subarray(0, 4).toString('latin1')).toBe('wOF2');
		for (const bad of [
			'/fonts/inter/../../package.json',
			'/fonts/nope/x.woff2',
			'/fonts/inter/metadata.json',
		]) {
			expect((await app.inject({ method: 'GET', url: bad, headers: H })).statusCode, bad).toBe(404);
		}
		const fonts = coreServices(app).fonts;
		expect(fonts.resolve('Inter', 400, false)?.fallback).toBe(false);
		expect(fonts.resolve('Comic Whatever', 400, false)).toMatchObject({
			family: 'Source Sans 3',
			fallback: true,
		});
	});
});
