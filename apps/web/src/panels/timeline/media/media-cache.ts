// Engine derivative caches for the timeline: sprite indexes + sheet images (S04:TH-002/003) and waveform
// peaks (S04:WF-001). Fetches are de-duplicated, failures are remembered briefly, and a version store
// tells clips to redraw when data arrives. Level reduction runs in a Web Worker (TL-157).
import { type PeaksHeader, PeaksHeaderSchema, type SpriteIndex, SpriteIndexSchema } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import type { MediaAsset } from '@jasper/project';
import type { MediaRuntime } from '@jasper/session';
import { createStore } from 'zustand/vanilla';
import { type ColumnRequest, reduceColumns } from '../model/waveform.ts';

/** Bumped whenever any sprite/peaks resource finishes loading. */
export const mediaCacheVersion = createStore<{ v: number }>(() => ({ v: 0 }));
const bump = () => mediaCacheVersion.setState({ v: mediaCacheVersion.getState().v + 1 });

const RETRY_MS = 15_000;

type Entry<T> = { value: T | null; promise: Promise<T | null> | null; failedAt: number };

function cached<T>(map: Map<string, Entry<T>>, key: string, load: () => Promise<T>): T | null {
	const e = map.get(key);
	if (e?.value) return e.value;
	if (e?.promise) return null;
	if (e && Date.now() - e.failedAt < RETRY_MS) return null;
	const entry: Entry<T> = { value: null, promise: null, failedAt: 0 };
	entry.promise = load()
		.then((v) => {
			entry.value = v;
			entry.promise = null;
			bump();
			return v;
		})
		.catch(() => {
			entry.promise = null;
			entry.failedAt = Date.now();
			return null;
		});
	map.set(key, entry);
	return null;
}

/** Engine mediaKey of an asset (engine-store locator, ARCHITECTURE D-09). */
export function mediaKeyOf(asset: MediaAsset | undefined): string | null {
	const loc = asset?.locators.find((l) => l.type === 'engine-store') as { key?: string } | undefined;
	return loc?.key ?? null;
}

async function fetchJson(url: string): Promise<unknown> {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`${res.status}`);
	return res.json();
}

// ---------------------------------------------------------------- sprites

const spriteIndexes = new Map<string, Entry<SpriteIndex>>();
const images = new Map<string, Entry<HTMLImageElement>>();

type SpriteSource = { index: SpriteIndex; sheetUrl(n: number): string };

/** Sprite index for an asset (runtime URL first, else the engine URL); null until loaded. */
export function spriteFor(
	engine: EngineClient | null,
	asset: MediaAsset | undefined,
	runtime: MediaRuntime | undefined,
): SpriteSource | null {
	const key = mediaKeyOf(asset);
	const url = runtime?.spriteUrl ?? (engine && key ? engine.mediaUrl(key, 'sprite.json') : null);
	if (!url || typeof fetch === 'undefined') return null;
	const index = cached(spriteIndexes, url, async () => SpriteIndexSchema.parse(await fetchJson(url)));
	if (!index) return null;
	const base = url.replace(/sprite\.json(\?.*)?$/, '');
	return {
		index,
		sheetUrl: (n) => (engine && key ? engine.mediaUrl(key, { sprite: n }) : `${base}sprite/${n}.jpg`),
	};
}

/** A decoded sheet image, or null while it loads. */
export function sheetImage(url: string): HTMLImageElement | null {
	if (typeof Image === 'undefined') return null;
	return cached(
		images,
		url,
		() =>
			new Promise<HTMLImageElement>((resolve, reject) => {
				const img = new Image();
				img.decoding = 'async';
				img.onload = () => resolve(img);
				img.onerror = () => reject(new Error('image'));
				img.src = url;
			}),
	);
}

// ---------------------------------------------------------------- peaks

type PeaksData = { header: PeaksHeader; channels: Float32Array[]; key: string };
const peaks = new Map<string, Entry<PeaksData>>();

/** Peaks of one audio stream (planar float32 per channel, WF-001), or null until loaded. */
export function peaksFor(
	engine: EngineClient | null,
	asset: MediaAsset | undefined,
	runtime: MediaRuntime | undefined,
	streamIndex: number,
): PeaksData | null {
	const key = mediaKeyOf(asset);
	const headerUrl = runtime?.peaksUrl ?? (engine && key ? engine.mediaUrl(key, 'peaks.json') : null);
	if (!headerUrl || typeof fetch === 'undefined') return null;
	// Clips address audio by container stream index (S01:CLP-014; a movie's audio is usually stream 1) and
	// the engine keys peak streams and `peaks/<n>.bin` by the same container index (peaks generator v2).
	const cacheKey = `${headerUrl}#${streamIndex}`;
	return cached(peaks, cacheKey, async () => {
		const header = PeaksHeaderSchema.parse(await fetchJson(headerUrl));
		const s = header.streams?.find((x) => x.index === streamIndex);
		const binUrl =
			s?.url ??
			(engine && key
				? engine.mediaUrl(key, { peaks: streamIndex })
				: headerUrl.replace(/peaks\.json.*$/, `peaks/${streamIndex}.bin`));
		const res = await fetch(binUrl);
		if (!res.ok) throw new Error(`${res.status}`);
		const all = new Float32Array(await res.arrayBuffer());
		const nch = s?.channels ?? header.channels;
		const per = Math.floor(all.length / Math.max(1, nch));
		const channels = Array.from({ length: nch }, (_, c) => all.subarray(c * per, (c + 1) * per));
		return { header, channels, key: cacheKey };
	});
}

// ---------------------------------------------------------------- worker reduction

type Pending = { resolve(v: Float32Array): void; peaks: Float32Array; req: ColumnRequest };
let worker: Worker | null | undefined;
const loaded = new Set<string>();
const pending = new Map<number, Pending>();
let nextId = 1;

function getWorker(): Worker | null {
	if (worker !== undefined) return worker;
	try {
		if (typeof Worker === 'undefined' || typeof window === 'undefined' || !('document' in window)) {
			worker = null;
			return worker;
		}
		worker = new Worker(new URL('./peaks.worker.ts', import.meta.url), { type: 'module' });
		worker.onmessage = (e: MessageEvent<{ id: number; columns: Float32Array }>) => {
			const p = pending.get(e.data.id);
			pending.delete(e.data.id);
			p?.resolve(e.data.columns);
		};
		worker.onerror = () => {
			// Fall back to synchronous reduction for good; settle whatever was in flight.
			worker = null;
			loaded.clear();
			for (const p of pending.values()) p.resolve(reduceColumns(p.peaks, p.req));
			pending.clear();
		};
	} catch {
		worker = null;
	}
	return worker;
}

/** Reduces peaks to per-column maxima, in the worker when available (else synchronously). */
export function reducePeaks(data: PeaksData, channel: number, req: ColumnRequest): Promise<Float32Array> {
	const ch = data.channels[Math.min(channel, data.channels.length - 1)];
	if (!ch) return Promise.resolve(new Float32Array(req.columns));
	const w = getWorker();
	if (!w) return Promise.resolve(reduceColumns(ch, req));
	const key = `${data.key}:${channel}`;
	if (!loaded.has(key)) {
		w.postMessage({ type: 'load', key, peaks: ch.slice() });
		loaded.add(key);
	}
	const id = nextId++;
	return new Promise((resolve) => {
		pending.set(id, { resolve, peaks: ch, req });
		w.postMessage({ type: 'reduce', id, key, req });
	});
}
