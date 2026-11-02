// Spec 19 TL-087: posters on the client. Cards ask only while they are on screen and stop asking when they leave; a short
// wait before the request lets a fast scroll pass without asking at all. Bytes travel off the main thread and are decoded
// by the `<img>`; the store keeps a bounded number of object URLs.
import {
	type LookPosterRequest,
	LOOK_POSTER_WIDTHS,
} from '@jasper/api';
import type { Colorway, LookRecipe } from '@jasper/project';
import type { EngineClient } from '@jasper/engine-client';
import { useEffect, useState } from 'react';

/** Posters asked at the same time; the engine renders two and the rest wait there. */
const MAX_ASKING = 4;
/** Object URLs kept: a few screens of cards. */
const MAX_POSTERS = 240;
/** Wait after a card appears before it asks. */
const SETTLE_MS = 120;
/** Sample text when the selection has none of its own. */
export const DEFAULT_SAMPLE_TEXT = 'Title';

export type PosterSample = { text: string; font?: { family: string; weight?: number; italic?: boolean } };

export type PosterState =
	| { state: 'loading' }
	| { state: 'ready'; url: string }
	| { state: 'error'; message: string };

/** The poster width for a tile, device pixels included. */
export function posterWidth(tilePx: number, dpr = globalThis.devicePixelRatio || 1): number {
	const want = tilePx * Math.min(2, dpr);
	return LOOK_POSTER_WIDTHS.find((w) => w >= want) ?? LOOK_POSTER_WIDTHS[LOOK_POSTER_WIDTHS.length - 1]!;
}

export function posterRequest(
	recipe: LookRecipe,
	colorway: Pick<Colorway, 'palette'> | null,
	sample: PosterSample,
	width: number,
): LookPosterRequest {
	return {
		recipe,
		...(colorway ? { palette: colorway.palette as LookPosterRequest['palette'] } : {}),
		text: sample.text.trim() || DEFAULT_SAMPLE_TEXT,
		...(sample.font ? { font: sample.font } : {}),
		width,
	};
}

type Job = {
	key: string;
	req: LookPosterRequest;
	listeners: Set<(s: PosterState) => void>;
	ac: AbortController;
	started: boolean;
};

/** One engine's posters: a bounded LRU of finished ones and a small queue, newest asks first. */
export class PosterStore {
	private readonly done = new Map<string, string>();
	private readonly jobs = new Map<string, Job>();
	private asking = 0;

	constructor(
		private readonly fetchPoster: (req: LookPosterRequest, signal: AbortSignal) => Promise<Uint8Array>,
		private readonly opts: {
			maxPosters?: number;
			createUrl?(bytes: Uint8Array): string;
			revokeUrl?(url: string): void;
		} = {},
	) {}

	/** A finished poster, or null. */
	cached(req: LookPosterRequest): string | null {
		const key = JSON.stringify(req);
		const url = this.done.get(key);
		if (url) {
			// Least recently used goes first.
			this.done.delete(key);
			this.done.set(key, url);
		}
		return url ?? null;
	}

	/** Asks for a poster; the returned function stops listening, and stops the request when nobody else listens. */
	ask(req: LookPosterRequest, listener: (s: PosterState) => void): () => void {
		const url = this.cached(req);
		if (url) {
			listener({ state: 'ready', url });
			return () => {};
		}
		const key = JSON.stringify(req);
		let job = this.jobs.get(key);
		if (!job) {
			job = { key, req, listeners: new Set(), ac: new AbortController(), started: false };
			this.jobs.set(key, job);
		}
		job.listeners.add(listener);
		listener({ state: 'loading' });
		this.pump();
		const target = job;
		return () => {
			target.listeners.delete(listener);
			if (target.listeners.size > 0 || this.jobs.get(key) !== target) return;
			this.jobs.delete(key);
			target.ac.abort();
		};
	}

	private pump(): void {
		const queued = [...this.jobs.values()].filter((j) => !j.started).reverse();
		for (const job of queued) {
			if (this.asking >= MAX_ASKING) return;
			job.started = true;
			this.asking++;
			void this.run(job);
		}
	}

	private async run(job: Job): Promise<void> {
		try {
			const bytes = await this.fetchPoster(job.req, job.ac.signal);
			if (job.ac.signal.aborted) return;
			const url = (this.opts.createUrl ?? defaultCreateUrl)(bytes);
			this.keep(job.key, url);
			this.finish(job, { state: 'ready', url });
		} catch (e) {
			if (job.ac.signal.aborted) return;
			this.finish(job, { state: 'error', message: e instanceof Error ? e.message : String(e) });
		} finally {
			this.asking--;
			this.pump();
		}
	}

	private finish(job: Job, s: PosterState): void {
		if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
		for (const l of [...job.listeners]) l(s);
	}

	private keep(key: string, url: string): void {
		this.done.set(key, url);
		const max = this.opts.maxPosters ?? MAX_POSTERS;
		for (const [k, u] of this.done) {
			if (this.done.size <= max) break;
			this.done.delete(k);
			(this.opts.revokeUrl ?? defaultRevokeUrl)(u);
		}
	}

	/** Drops everything: requests in flight and object URLs. */
	dispose(): void {
		for (const j of this.jobs.values()) j.ac.abort();
		this.jobs.clear();
		for (const u of this.done.values()) (this.opts.revokeUrl ?? defaultRevokeUrl)(u);
		this.done.clear();
	}
}

const defaultCreateUrl = (bytes: Uint8Array) =>
	URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/png' }));
const defaultRevokeUrl = (url: string) => URL.revokeObjectURL(url);

const stores = new WeakMap<EngineClient, PosterStore>();

export function posterStoreFor(client: EngineClient): PosterStore {
	let s = stores.get(client);
	if (!s) {
		s = new PosterStore((req, signal) => client.titleLookPoster(req, signal));
		stores.set(client, s);
	}
	return s;
}

/** A card's poster while it is mounted: nothing is asked for a card that is scrolled past quickly. */
export function usePoster(store: PosterStore | null, req: LookPosterRequest): PosterState {
	const key = JSON.stringify(req);
	const [state, setState] = useState<PosterState>(() => {
		const url = store?.cached(req);
		return url ? { state: 'ready', url } : { state: 'loading' };
	});
	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the content of `req`
	useEffect(() => {
		if (!store) {
			setState({ state: 'error', message: 'The engine is not connected' });
			return;
		}
		const url = store.cached(req);
		if (url) {
			setState({ state: 'ready', url });
			return;
		}
		setState({ state: 'loading' });
		let stop = () => {};
		const timer = setTimeout(() => {
			stop = store.ask(req, setState);
		}, SETTLE_MS);
		return () => {
			clearTimeout(timer);
			stop();
		};
	}, [store, key]);
	return state;
}
