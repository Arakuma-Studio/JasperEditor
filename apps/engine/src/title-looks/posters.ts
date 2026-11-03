// Spec 19 TL-087: look thumbnails through the real render path. A poster is a one-text-clip sequence with the look applied
// by `look.apply`, drawn by Remotion through `JasperSequence` like any export, so a thumbnail is what the look renders.
// Files are named by the content of the request and live as ordinary `mg-posters` cache entries:
//
//   <appdir>/mg/posters/<sha256>/poster.png
//
// Requests are cheap to make and cheap to drop: at most `MAX_RUNNING` renders run, one key renders once however many
// clients ask, and a request nobody waits for any more is dropped from the queue, or cancelled mid-render.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { LookPosterRequest } from '@jasper/api';
import {
	applyTransaction,
	buildRenderSnapshot,
	canonicalJson,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type ProjectDocument,
	TX_PROTOCOL,
} from '@jasper/project';
import { JobError } from '../jobs/types.ts';
import type { SharedRenderBrowser } from '../remotion/service.ts';
import { fsyncDir } from '../tools/fs.ts';
import { ENGINE_VERSION } from '../version.ts';

/** Bumped when the poster scene changes (a new file for every look). */
const POSTER_SCENE_VERSION = 1;
/** Renders at the same time: each is a page of the shared render browser, and software GL is slow. */
const MAX_RUNNING = 2;
/** Requests that may wait: a panel asks only for visible cards, so more than this is a runaway client. */
const MAX_WAITING = 256;
/** The shared render browser closes after this long with nothing to draw. */
const BROWSER_IDLE_MS = 20_000;
/** Neutral grey behind a poster: black keylines and white glows both stay visible. */
const BACKDROP: [number, number, number, number] = [0.2, 0.21, 0.23, 1];
const CLIP_FRAMES = 30;

type Remotion = {
	renderStill(input: {
		inputProps: Record<string, unknown>;
		output: string;
		frame: number;
		signal: AbortSignal;
		purpose?: 'still';
		browser?: SharedRenderBrowser;
	}): Promise<void>;
	openSharedBrowser(): Promise<SharedRenderBrowser>;
};

type Deps = {
	/** `<appdir>/mg/posters`. */
	dir: string;
	remotion: Remotion;
	/** A font file's URL for the render browser, or null (the render uses the default sans). */
	resolveFont(family: string, weight: number, italic: boolean): string | null;
	/** Test seam for the idle close of the browser. */
	browserIdleMs?: number;
};

/** A request's cache key: its content, the scene and the renderer. Never ids. */
export function lookPosterKey(req: LookPosterRequest): string {
	return createHash('sha256')
		.update(
			canonicalJson([
				POSTER_SCENE_VERSION,
				ENGINE_VERSION,
				req.recipe ?? null,
				req.palette ?? null,
				req.text,
				req.font ?? null,
				req.width,
			]),
		)
		.digest('hex');
}

/** Text size that keeps `text` on one line inside the poster: an average glyph is about 0.6 em wide. */
export function posterTextSize(text: string, width: number, height: number): number {
	const fit = (width * 0.8) / (Math.max(1, [...text].length) * 0.6);
	return Math.max(8, Math.round(Math.min(height * 0.32, fit)));
}

/** The poster's document, through the same commands a person uses. Refusals keep their `E_*` code. */
export function lookPosterDocument(req: LookPosterRequest): { doc: ProjectDocument; sequenceId: string } {
	const width = req.width;
	// Sequence sizes are even.
	const height = Math.round((width * 9) / 32) * 2;
	const ids = createCounterIdSource(1);
	const project = createEmptyProject({ ids, name: 'poster', preset: 'hd-720p-30' });
	const sequenceId = Object.keys(project.sequences)[0]!;
	const family = req.font?.family;
	const size = posterTextSize(req.text, width, height);
	const { document, result } = applyTransaction(
		project,
		{
			protocol: TX_PROTOCOL,
			label: 'Look poster',
			origin: 'user',
			sequenceId,
			commands: [
				{ type: 'sequence.updateSettings', sequenceId, settings: { width, height } },
				{ type: 'clip.addSolid', at: 0, duration: CLIP_FRAMES, track: 'V1', color: BACKDROP },
				...(family ? [{ type: 'font.add', family, ref: '$font' }] : []),
				{
					type: 'clip.addText',
					at: 0,
					duration: CLIP_FRAMES,
					track: 'V2',
					content: {
						text: req.text,
						style: {
							...(family ? { fontId: '$font' } : {}),
							sizePx: size,
							fill: [1, 1, 1, 1],
							align: 'center',
							weight: req.font?.weight ?? 700,
							italic: req.font?.italic ?? false,
						},
					},
					// As tall as its line: the clip is centred in the frame, so the text is too.
					box: { width: Math.round(width * 0.92), height: Math.round(size * 1.4), autoSize: 'none' },
					ref: '$title',
				},
				// The seed is fixed: the same look always gets the same poster.
				{ type: 'look.apply', clipIds: ['$title'], look: { name: 'Poster', recipe: req.recipe }, seed: 4242 },
				...(req.palette ? [{ type: 'look.setColorway', clipIds: ['$title'], palette: req.palette }] : []),
			] as never,
		},
		{
			ids,
			now: () => '2026-01-01T00:00:00.000Z',
			revision: 0,
			registries: defaultRegistries(),
		},
	);
	if (!result.ok) {
		const e = result.errors[0];
		throw new JobError(e?.code ?? 'BAD_REQUEST', e?.message ?? 'The look cannot be drawn', false);
	}
	return { doc: document, sequenceId };
}

type Waiter = { resolve(file: string): void; reject(e: unknown): void };

type Entry = {
	key: string;
	req: LookPosterRequest;
	file: string;
	waiters: Set<Waiter>;
	ac: AbortController;
	running: boolean;
};

export class LookPosterService {
	private readonly entries = new Map<string, Entry>();
	private running = 0;
	private browser: Promise<SharedRenderBrowser> | null = null;
	private idle: ReturnType<typeof setTimeout> | null = null;
	private closed = false;
	private tmpSeq = 0;

	constructor(private readonly deps: Deps) {}

	fileOf(key: string): string {
		return join(this.deps.dir, key, 'poster.png');
	}

	/** The poster's file, rendering it if needed. `signal`: this caller stopped waiting. */
	async poster(req: LookPosterRequest, signal: AbortSignal): Promise<{ file: string; cached: boolean }> {
		const key = lookPosterKey(req);
		const file = this.fileOf(key);
		if (existsSync(file)) return { file, cached: true };
		if (signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled', false);
		return { file: await this.wait(key, req, file, signal), cached: false };
	}

	private wait(key: string, req: LookPosterRequest, file: string, signal: AbortSignal): Promise<string> {
		let entry = this.entries.get(key);
		if (!entry) {
			if (this.entries.size >= MAX_WAITING + MAX_RUNNING)
				return Promise.reject(new JobError('POSTER_QUEUE_FULL', 'Too many posters requested', true));
			entry = { key, req, file, waiters: new Set(), ac: new AbortController(), running: false };
			this.entries.set(key, entry);
		}
		const target = entry;
		return new Promise<string>((resolve, reject) => {
			const waiter: Waiter = {
				resolve: (f) => {
					signal.removeEventListener('abort', drop);
					resolve(f);
				},
				reject: (e) => {
					signal.removeEventListener('abort', drop);
					reject(e);
				},
			};
			const drop = () => {
				target.waiters.delete(waiter);
				reject(new JobError('JOB_CANCELLED', 'Cancelled', false));
				if (target.waiters.size > 0) return;
				if (target.running) target.ac.abort();
				else this.entries.delete(target.key);
			};
			target.waiters.add(waiter);
			signal.addEventListener('abort', drop, { once: true });
			this.pump();
		});
	}

	private pump(): void {
		while (this.running < MAX_RUNNING) {
			const next = [...this.entries.values()].find((e) => !e.running);
			if (!next) return;
			next.running = true;
			this.running++;
			void this.run(next);
		}
	}

	private async run(e: Entry): Promise<void> {
		try {
			await this.render(e);
			this.entries.delete(e.key);
			for (const w of e.waiters) w.resolve(e.file);
		} catch (err) {
			this.entries.delete(e.key);
			for (const w of e.waiters) w.reject(err);
		} finally {
			this.running--;
			this.touchBrowser();
			if (!this.closed) this.pump();
		}
	}

	private async render(e: Entry): Promise<void> {
		const { doc, sequenceId } = lookPosterDocument(e.req);
		const snapshot = buildRenderSnapshot(doc, sequenceId, {
			resolveMedia: () => null,
			resolveFont: (font, weight, italic) => this.deps.resolveFont(font.family, weight, italic),
		});
		await mkdir(dirname(e.file), { recursive: true });
		// A `.tmp.` name: a crash leaves a partial the cache scan sweeps, never a file under the final name.
		const tmp = `${e.file}.${process.pid}-${++this.tmpSeq}.tmp.png`;
		try {
			await this.deps.remotion.renderStill({
				inputProps: {
					doc: snapshot,
					options: { isPreview: false, useProxies: false, transparentBackground: false },
				},
				output: tmp,
				frame: 0,
				signal: e.ac.signal,
				purpose: 'still',
				browser: await this.sharedBrowser(),
			});
			if ((await stat(tmp)).size === 0) throw new JobError('RENDER_FAILED', 'The render wrote nothing', true);
			const fh = await open(tmp, 'r+');
			try {
				await fh.sync();
			} finally {
				await fh.close();
			}
			await rename(tmp, e.file);
			await fsyncDir(dirname(e.file));
		} catch (err) {
			await rm(tmp, { force: true });
			throw err;
		}
	}

	private sharedBrowser(): Promise<SharedRenderBrowser> {
		if (this.idle) clearTimeout(this.idle);
		this.idle = null;
		if (!this.browser) {
			const opening = this.deps.remotion.openSharedBrowser();
			this.browser = opening;
			// A browser that failed to open is not kept: the next poster tries again.
			opening.catch(() => {
				if (this.browser === opening) this.browser = null;
			});
		}
		return this.browser;
	}

	private touchBrowser(): void {
		if (this.running > 0 || this.entries.size > 0 || !this.browser) return;
		if (this.idle) clearTimeout(this.idle);
		this.idle = setTimeout(() => void this.closeBrowser(), this.deps.browserIdleMs ?? BROWSER_IDLE_MS);
		this.idle.unref?.();
	}

	private async closeBrowser(): Promise<void> {
		const b = this.browser;
		this.browser = null;
		if (this.idle) clearTimeout(this.idle);
		this.idle = null;
		await (await b?.catch(() => null))?.close();
	}

	/** Engine shutdown: stops what runs and what waits. */
	async close(): Promise<void> {
		this.closed = true;
		for (const e of this.entries.values()) {
			if (e.running) e.ac.abort();
			else {
				this.entries.delete(e.key);
				for (const w of e.waiters) w.reject(new JobError('JOB_CANCELLED', 'The engine is stopping', true));
			}
		}
		await this.closeBrowser();
	}
}
