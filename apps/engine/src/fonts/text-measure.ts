// Headless text measurer (spec 13 SH-004, docs/wp-notes/text-render.md): text clips created or edited without an
// editor window (MCP, the CLI, engine features) get boxes measured from glyph metrics, like the editor's. The text
// is laid out by the compositions' own measuring code (`measureTextBox`, the same block CSS / typeset layout as the
// text layer) in the engine's render browser: a page of the Remotion bundle (`__jasperTextMeasure` hook), served by
// a private loopback server with the font files the export snapshot resolves (same files, same Chromium shaping).
//
// `apply(run)` runs a transaction with a measurer that answers from a cache; the measurements it was missing are
// made in the browser and the transaction runs again (at most MAX_ROUNDS times). Whatever cannot be measured in time
// (no browser, a dev bundle still building, a failure) stays an estimate marked `layoutPending`, which the editor
// measures when it opens the project. The page stays open IDLE_CLOSE_MS after its last use.
import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import type { MeasuredBox, MeasureFace, TextMeasureJob } from '@jasper/compositions';
import {
	type FontRef,
	isVerticalText,
	type TextBox,
	type TextContent,
	type TextMeasurer,
} from '@jasper/project';
import { z } from 'zod';
import { serveBundleForMeasuring } from '../mg-bundles/text-measure.ts';
import type { RemotionService, SharedRenderBrowser } from '../remotion/service.ts';
import type { FontCatalogService } from './catalog.ts';

const IDLE_CLOSE_MS = 60_000;
/** Longest wait for the Remotion bundle (a dev engine bundles on first use; it keeps building after this). */
const BUNDLE_WAIT_MS = 3_000;
/** Longest wait for one round of measurements (page start-up included). */
const ROUND_TIMEOUT_MS = 20_000;
const MAX_ROUNDS = 3;
const CACHE_SIZE = 4096;
/** Measurements per page call (a larger transaction measures in several calls). */
const BATCH = 500;

const ResultSchema = z.array(
	z
		.object({ width: z.number().finite().min(0).max(65_536), height: z.number().finite().min(0).max(65_536) })
		.nullable(),
);

type Request = { key: string; job: TextMeasureJob };
type Live = {
	browser: SharedRenderBrowser;
	page: MeasurePage;
	close(): Promise<void>;
	fonts: Map<string, string>;
};
type MeasurePage = {
	evaluate<T>(fn: (arg: string) => T | Promise<T>, arg: string): Promise<T>;
};

export type HeadlessTextMeasurerDeps = {
	remotion: Pick<RemotionService, 'serveUrl' | 'openSharedBrowser'>;
	fonts: Pick<FontCatalogService, 'resolve' | 'filePath'>;
	/** False = never measure (every headless text box stays an estimate, `layoutPending`). */
	enabled?: boolean;
	log?(m: string): void;
};

/** `JASPER_TEXT_MEASURE`: `off` disables the headless measurer; under Vitest it is off unless `on`. */
export function headlessTextMeasureEnabled(env: Record<string, string | undefined>): boolean {
	const v = env.JASPER_TEXT_MEASURE;
	if (v === 'off' || v === '0') return false;
	if (v === 'on' || v === '1') return true;
	return !env.VITEST;
}

/** Styles a content draws with: the base style and every run's merged style. */
function contentStyles(c: TextContent): TextContent['style'][] {
	return [c.style, ...(c.runs ?? []).map((r) => ({ ...c.style, ...r.style }) as TextContent['style'])];
}

export class HeadlessTextMeasurer {
	private readonly cache = new Map<string, MeasuredBox | null>();
	private live: Promise<Live> | null = null;
	private idle: ReturnType<typeof setTimeout> | null = null;
	private chain: Promise<unknown> = Promise.resolve();

	constructor(private readonly deps: HeadlessTextMeasurerDeps) {}

	/**
	 * The faces of a content as the export snapshot resolves them (`FontCatalogService.resolve`: the family's file,
	 * else the fallback family's), each with the file the page loads; null when a face has no file here.
	 */
	facesOf(
		content: TextContent,
		fonts: Readonly<Record<string, FontRef>>,
	): (MeasureFace & { path: string })[] {
		const out = new Map<string, MeasureFace & { path: string }>();
		for (const s of contentStyles(content)) {
			const font = fonts[s.fontId];
			if (!font) continue;
			const key = `${font.id}:${s.weight}:${s.italic}`;
			if (out.has(key)) continue;
			const r = this.deps.fonts.resolve(font.family, s.weight, s.italic);
			const path = r ? this.deps.fonts.filePath(r.url.replace(/^\/fonts\//, '')) : null;
			if (!path) continue;
			const name = `font-${createHash('sha256').update(path).digest('hex').slice(0, 24)}${extname(path).toLowerCase()}`;
			out.set(key, {
				fontId: font.id,
				family: font.family,
				weight: s.weight,
				style: s.italic ? 'italic' : 'normal',
				url: name,
				path,
			});
		}
		return [...out.values()];
	}

	private request(content: TextContent, box: TextBox, fonts: Readonly<Record<string, FontRef>>): Request {
		const faces = this.facesOf(content, fonts);
		const vertical = isVerticalText(content);
		const b = {
			width: box.autoSize === 'width' ? 0 : box.width,
			// Columns wrap at the box height (spec 19 TL-111).
			...(vertical ? { height: box.height } : {}),
			autoSize: box.autoSize,
		};
		// Font ids are not part of the key: a transaction that creates its font gets a new id every round.
		const family = (id: unknown) => (typeof id === 'string' ? (fonts[id]?.family ?? id) : id);
		const unId = (st: Record<string, unknown>) =>
			'fontId' in st ? { ...st, fontId: family(st.fontId) } : st;
		const key = JSON.stringify([
			content.text,
			unId(content.style as unknown as Record<string, unknown>),
			(content.runs ?? []).map((r) => ({ ...r, style: unId(r.style as Record<string, unknown>) })),
			content.paragraphs ?? [],
			vertical ? { writingMode: 'vertical', tateChuYoko: content.tateChuYoko } : null,
			b,
			faces.map((f) => [f.family, f.weight, f.style, f.path]),
		]);
		return {
			key,
			job: {
				content: {
					text: content.text,
					style: content.style,
					runs: content.runs,
					paragraphs: content.paragraphs,
					...(vertical ? { writingMode: 'vertical' as const, tateChuYoko: content.tateChuYoko } : {}),
				},
				box: { width: box.width, height: box.height, autoSize: box.autoSize },
				faces: faces.map(({ path: _p, ...f }) => f),
			},
		};
	}

	/**
	 * Runs `run` with a measurer: the measurements it misses are made in the browser and `run` runs again, until
	 * nothing is missing (or MAX_ROUNDS). Returns the last run's result.
	 */
	async apply<R>(run: (m: TextMeasurer) => R): Promise<R> {
		if (this.deps.enabled === false) return run({ measure: () => null });
		let result!: R;
		for (let round = 0; round < MAX_ROUNDS; round++) {
			const missing = new Map<string, Request & { paths: Map<string, string> }>();
			const measurer: TextMeasurer = {
				measure: (content, box, fonts) => {
					const req = this.request(content, box, fonts);
					if (this.cache.has(req.key)) return this.cache.get(req.key) ?? null;
					const paths = new Map(this.facesOf(content, fonts).map((f) => [f.url, f.path]));
					missing.set(req.key, { ...req, paths });
					return null;
				},
			};
			result = run(measurer);
			if (missing.size === 0 || round === MAX_ROUNDS - 1) return result;
			const ok = await this.measureMany([...missing.values()]);
			if (!ok) return result;
		}
		return result;
	}

	/** Measures the requests (serialized), caching every answer; false when nothing could be measured. */
	private measureMany(reqs: (Request & { paths: Map<string, string> })[]): Promise<boolean> {
		const run = this.chain.then(async () => {
			let timer: ReturnType<typeof setTimeout> | null = null;
			const timeout = new Promise<'timeout'>((resolve) => {
				timer = setTimeout(() => resolve('timeout'), ROUND_TIMEOUT_MS);
			});
			try {
				// The work goes on after a timeout (its answers fill the cache for later transactions).
				const work = this.measureNow(reqs);
				work.catch((e: unknown) => {
					this.deps.log?.(`[text-measure] failed: ${(e as Error).message.split('\n')[0]}`);
					void this.closePage();
				});
				const done = await Promise.race([work, timeout]);
				if (done === 'timeout') {
					this.deps.log?.('[text-measure] timed out: text boxes stay estimated (layoutPending)');
					return false;
				}
				return done;
			} catch {
				return false;
			} finally {
				if (timer) clearTimeout(timer);
				this.scheduleClose();
			}
		});
		this.chain = run.catch(() => undefined);
		return run;
	}

	private async measureNow(reqs: (Request & { paths: Map<string, string> })[]): Promise<boolean> {
		const fonts = new Map<string, string>();
		for (const r of reqs) for (const [u, p] of r.paths) fonts.set(u, p);
		let live = await this.page(fonts);
		// A face the open page's server does not know yet: reopen with every face so far.
		if ([...fonts.keys()].some((u) => !live.fonts.has(u))) {
			const all = new Map([...live.fonts, ...fonts]);
			await this.closePage();
			live = await this.page(all);
		}
		for (let i = 0; i < reqs.length; i += BATCH) {
			const batch = reqs.slice(i, i + BATCH);
			const raw = await live.page.evaluate(
				(json: string) => {
					const w = window as unknown as {
						__jasperTextMeasure?: { measure(jobs: unknown[]): Promise<unknown> };
					};
					if (!w.__jasperTextMeasure) throw new Error('The text measuring hook is not installed');
					return w.__jasperTextMeasure.measure(JSON.parse(json) as unknown[]);
				},
				JSON.stringify(batch.map((r) => r.job)),
			);
			const parsed = ResultSchema.safeParse(raw);
			if (!parsed.success || parsed.data.length !== batch.length)
				throw new Error('The text measuring page returned an invalid result');
			for (const [k, r] of batch.entries()) this.remember(r.key, parsed.data[k] ?? null);
		}
		return true;
	}

	private remember(key: string, v: MeasuredBox | null): void {
		this.cache.set(key, v);
		if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
	}

	private page(fonts: Map<string, string> = new Map()): Promise<Live> {
		if (this.idle) clearTimeout(this.idle);
		this.idle = null;
		this.live ??= this.openPage(fonts).catch((e) => {
			this.live = null;
			throw e;
		});
		return this.live;
	}

	private async openPage(fonts: Map<string, string>): Promise<Live> {
		const bundle = this.deps.remotion.serveUrl();
		bundle.catch(() => undefined);
		let wait: ReturnType<typeof setTimeout> | null = null;
		const dir = await Promise.race([
			bundle,
			new Promise<never>((_, reject) => {
				wait = setTimeout(() => reject(new Error('the Remotion bundle is not ready yet')), BUNDLE_WAIT_MS);
			}),
		]).finally(() => {
			if (wait) clearTimeout(wait);
		});
		const served = await serveBundleForMeasuring(dir, { bootstrap: false, files: fonts });
		let browser: SharedRenderBrowser | null = null;
		try {
			browser = await this.deps.remotion.openSharedBrowser();
			const page = await browser.instance.newPage({
				context: () => null,
				logLevel: 'error',
				indent: false,
				pageIndex: 0,
				onBrowserLog: null,
				onLog: () => undefined,
			});
			await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
			await page.goto({ url: served.url, timeout: ROUND_TIMEOUT_MS });
			// Faces resolve against the page URL (relative names served from `files`).
			const b = browser;
			return {
				browser: b,
				page: page as unknown as MeasurePage,
				fonts,
				close: async () => {
					await b.close();
					await served.close();
				},
			};
		} catch (e) {
			await browser?.close();
			await served.close();
			throw e;
		}
	}

	private scheduleClose(): void {
		if (this.idle) clearTimeout(this.idle);
		this.idle = setTimeout(() => void this.closePage(), IDLE_CLOSE_MS);
		this.idle.unref?.();
	}

	private async closePage(): Promise<void> {
		const live = this.live;
		this.live = null;
		if (!live) return;
		await live.then((l) => l.close()).catch(() => undefined);
	}

	/** Closes the page (engine shutdown). */
	async close(): Promise<void> {
		if (this.idle) clearTimeout(this.idle);
		this.idle = null;
		await this.closePage();
	}
}
