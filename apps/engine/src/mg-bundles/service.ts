// Motion-graphics bundles in the engine (M2, S08 §3/§5, ARCHITECTURE §19.3): import (project directory with its
// own `remotion bundle`, built bundle directory, zip upload), content-addressed storage
// `<appdir>/mg-bundles/<bundleHash>/`, composition metadata (getCompositions with the LGPL binaries directory),
// props schemas, watch + rebuild, pre-render jobs (`mg-prerender`: ProRes 4444 master + VP9-alpha preview +
// poster under `<appdir>/mg/<renderKey>/`) and posters of the Motion Templates panel.
// HTML compositions (schema v13, html.ts): a page implementing `__duration` / `__ready` / `__seek` is imported as a
// bundle of the files it loaded (`mgBundle.html`), watched by those files, and rendered by seeking it frame by frame
// in the same headless browser; everything downstream (masters, previews, posters, exports) is shared.
import { createHash } from 'node:crypto';
import { existsSync, type FSWatcher, watch as fsWatch } from 'node:fs';
import { copyFile, cp, mkdir, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import type {
	EngineJob,
	MgBundleRebuiltEvent,
	MgHtmlImportRequest,
	MgPrerenderRequest,
	MgPrerenderResult,
	MgTextMeasureRequest,
	MgTextMeasureResult,
	RegisteredMedia,
} from '@jasper/api';
import { renderPagesInOwnWindows } from '@jasper/compositions/render-host';
import {
	compositionRenderKeyMaterial,
	EMPTY_PROBE,
	MG_REMOTION_VERSION,
	type MgBundleInfo,
	type MgCompositionInfo,
} from '@jasper/project';
import type { JobContext } from '../jobs/types.ts';
import { JobError } from '../jobs/types.ts';
import type { MediaRecord } from '../media/registry.ts';
import { MAX_RENDERS_IN_FLIGHT, type PageGrant, pageShares, runPagePool } from '../remotion/page-pool.ts';
import { Ffmpeg } from '../tools/ffmpeg.ts';
import { atomicWriteJson, readJsonOrNull } from '../tools/fs.ts';
import { binaryNames } from '../tools/lgpl.ts';
import type { CoreServices } from '../tools/services.ts';
import { hashBundleDir, listBundleFiles } from './hash.ts';
import {
	HTML_MAX_BYTES,
	HTML_MAX_FILES,
	type HtmlBrowserOptions,
	probeHtmlPage,
	renderHtmlProRes,
	renderHtmlStill,
} from './html.ts';
import {
	bundleProject,
	checkBundleVersion,
	checkRemotionVersion,
	isBuiltBundle,
	MgBundleError,
	readProjectPackage,
} from './project.ts';
import { buildCompositionInfos, loadSchemaModule, type RawComposition, readManifest } from './schemas.ts';
import { measureBundleTexts } from './text-measure.ts';
import { extractZip, ZipError } from './zip.ts';

/** CPU slots of one pre-render (S08:MGC-030) and of a bundle build. */
const MG_PRERENDER_SLOTS = 4;
const MG_BUNDLE_SLOTS = 4;
const MG_DELAY_RENDER_TIMEOUT_MS = 60_000;
const KEY_RE = /^[0-9a-f]{40}$/;
const MEDIA_KEY_RE = /^mk_[0-9a-f]{24}$/;

/** sha256 (40 hex, like the M1 `/mg/:key/:file` keys) of the pre-render key material (MGC-031). */
export const prerenderKey = (
	req: Pick<
		MgPrerenderRequest,
		'compositionId' | 'props' | 'width' | 'height' | 'fps' | 'startFrame' | 'durationFrames'
	>,
	bundleHash: string,
) =>
	createHash('sha256')
		.update(
			compositionRenderKeyMaterial({
				bundleHash,
				compositionId: req.compositionId,
				props: req.props,
				width: req.width,
				height: req.height,
				fps: req.fps,
				startFrame: req.startFrame,
				durationFrames: req.durationFrames,
			}),
		)
		.digest('hex')
		.slice(0, 40);

type RendererModule = typeof import('@remotion/renderer');

type HtmlImportInput = {
	file: string;
	query: string;
	width: number;
	height: number;
	fps: number;
};

type BundleJobInput =
	| { op: 'import-dir'; dir: string; watch: boolean; projectId?: string }
	| { op: 'import-zip'; file: string; name: string; projectId?: string }
	| ({ op: 'import-html'; watch: boolean; projectId?: string } & HtmlImportInput)
	| { op: 'rebuild'; key: string; projectId?: string };

/** Props of an HTML composition: none (the page takes its parameters from the import's query string). */
const HTML_PROPS_SCHEMA = { type: 'object', properties: {}, additionalProperties: false };

/** Identity of an HTML import (the same page, query, size and rate is the same bundle). */
const canonicalImport = (i: HtmlImportInput) =>
	JSON.stringify([i.file, i.query, i.width, i.height, Math.round(i.fps * 1e6)]);

type PrerenderJobInput = {
	req: MgPrerenderRequest;
	renderKey: string;
	/** Browser tabs (child jobs of an export run inside the export's CPU budget). */
	concurrency?: number;
};

type Watch = {
	/** Key in the watch map: the folder, or `<page file>?<query>` (one page may be imported with several queries). */
	id: string;
	/** Project folder (Remotion) or page file (HTML composition). */
	dir: string;
	key: string;
	watchers: FSWatcher[];
	timer: NodeJS.Timeout | null;
	/** Projects that imported it with watch: relinked headlessly when no editor has them open. */
	projectIds: Set<string>;
};

type RenderMeta = {
	kind: 'composition';
	renderKey: string;
	request: MgPrerenderRequest;
	bundleHash: string;
	files: string[];
	createdAt: string;
	lastUsedAt: string;
};

type MgBundlesOptions = {
	core: CoreServices;
	/** Local mode (loopback or dev): imports from engine paths and watchers are allowed (S04:SC-002). */
	localMode: boolean;
	log?(msg: string): void;
	now?: () => Date;
	/**
	 * Relinks a rebuilt bundle in a project no editor has open (an open editor relinks on `mgBundle.rebuilt` itself).
	 * Resolves true when it relinked.
	 */
	relinkHeadless?(projectId: string, event: MgBundleRebuiltEvent): Promise<boolean>;
};

export class MgBundleService {
	readonly bundlesDir: string;
	readonly mgDir: string;
	private readonly logsDir: string;
	private readonly watchesFile: string;
	private readonly watches = new Map<string, Watch>();
	private readonly posterJobs = new Map<string, Promise<string>>();
	private rendererPromise: Promise<RendererModule> | null = null;
	/** Error detail and hint of failed bundle jobs (EngineJob.error carries code + message only). */
	private readonly jobErrors = new Map<string, { detail?: unknown; hint?: string }>();
	private readonly now: () => Date;

	constructor(private readonly o: MgBundlesOptions) {
		const appdir = o.core.config.appdir;
		this.bundlesDir = join(appdir, 'mg-bundles');
		this.mgDir = o.core.config.paths.mgDir;
		this.logsDir = join(o.core.config.paths.logsDir, 'mg-bundles');
		this.watchesFile = join(this.bundlesDir, 'watches.json');
		this.now = o.now ?? (() => new Date());
	}

	private get core(): CoreServices {
		return this.o.core;
	}

	/** `features.mgBundles` (ARCHITECTURE §19.7). */
	capability(): { status: 'ready' | 'unavailable'; reason?: string; projectImport: boolean } {
		const r = this.core.remotion;
		const state = r.state();
		const projectImport = this.o.localMode;
		if (!r.binaries.allowed)
			return {
				status: 'unavailable',
				reason: r.binaries.message ?? 'Remotion rendering is disabled (no LGPL FFmpeg binaries directory)',
				projectImport,
			};
		if (state === 'unavailable')
			return {
				status: 'unavailable',
				reason: 'The Remotion renderer is not available on this engine',
				projectImport,
			};
		return { status: 'ready', projectImport };
	}

	private requireReady(): void {
		const c = this.capability();
		if (c.status !== 'ready')
			throw new MgBundleError(
				'MG_UNAVAILABLE',
				`Composition clips need the Remotion renderer: ${c.reason ?? 'unavailable'}`,
				503,
			);
	}

	private renderer(): Promise<RendererModule> {
		this.rendererPromise ??= import('@remotion/renderer');
		return this.rendererPromise;
	}

	/** binariesDirectory (D-13 LGPL), browser and license options for every Remotion call. */
	private remotionOptions(): {
		binariesDirectory?: string;
		browserExecutable?: string;
		chromeMode: 'headless-shell' | 'chrome-for-testing';
	} {
		const r = this.core.remotion;
		if (!r.binaries.allowed)
			throw new MgBundleError('MG_UNAVAILABLE', r.binaries.message ?? 'Remotion rendering is disabled', 503);
		const exe = r.browserExecutable();
		return {
			...(r.binariesDirectory ? { binariesDirectory: r.binariesDirectory } : {}),
			...(exe
				? {
						browserExecutable: exe,
						chromeMode: /headless-shell/.test(exe) ? 'headless-shell' : 'chrome-for-testing',
					}
				: { chromeMode: 'headless-shell' as const }),
		};
	}

	/** ffmpeg of the LGPL binaries directory when there is one (D-13), else the engine's. */
	private ffmpeg(): Ffmpeg {
		const dir = this.core.remotion.binariesDirectory;
		if (dir) {
			const n = binaryNames();
			const ff = join(dir, n.ffmpeg);
			const fp = join(dir, n.ffprobe);
			if (existsSync(ff) && existsSync(fp)) return new Ffmpeg({ ffmpeg: ff, ffprobe: fp });
		}
		return this.core.ffmpeg;
	}

	registerRunners(): void {
		this.core.queue.registerRunner('mg-bundle', (ctx) => this.runBundleJob(ctx));
		this.core.queue.registerRunner('mg-prerender', (ctx) => this.runPrerender(ctx));
	}

	async start(): Promise<void> {
		await mkdir(this.bundlesDir, { recursive: true });
		for (const n of await readdir(this.bundlesDir).catch(() => [] as string[]))
			if (n.startsWith('.staging-')) await rm(join(this.bundlesDir, n), { recursive: true, force: true });
		if (this.o.localMode) await this.restoreWatches();
	}

	async stop(): Promise<void> {
		for (const w of this.watches.values()) this.closeWatch(w);
		this.watches.clear();
	}

	/** Registry record of a bundle key (kind mg-bundle), or null. */
	record(key: string): MediaRecord | null {
		if (!MEDIA_KEY_RE.test(key)) return null;
		const r = this.core.registry.get(key);
		return r && r.kind === 'mg-bundle' && r.mgBundle ? r : null;
	}

	/** The bundle directory of a key (served at `/mg/bundles/<key>/`). */
	bundleDir(key: string): string | null {
		const r = this.record(key);
		if (!r) return null;
		const dir = dirname(r.storage.path);
		return existsSync(join(dir, this.entryOf(r))) ? dir : null;
	}

	/** The page of a bundle: `index.html` (Remotion) or the HTML composition's entry file. */
	entryOf(r: MediaRecord): string {
		return r.mgBundle?.html?.entry ?? 'index.html';
	}

	/** `POST /api/mg-bundles/import` with a path (local mode): waits for the `mg-bundle` job. */
	async importPath(
		rawPath: string,
		opts: { projectId?: string; watch?: boolean; origin?: EngineJob['origin'] },
	): Promise<RegisteredMedia> {
		if (!this.o.localMode)
			throw new MgBundleError('LOCAL_MODE_ONLY', 'Importing a folder is only available in local mode', 403);
		if (!isAbsolute(rawPath)) throw new MgBundleError('BAD_REQUEST', 'Paths must be absolute');
		let dir: string;
		try {
			dir = await realpath(resolve(rawPath));
		} catch {
			throw new MgBundleError('ASSET_NOT_FOUND', `Folder not found: ${rawPath}`, 404);
		}
		const st = await stat(dir);
		if (!st.isDirectory()) throw new MgBundleError('MG_NOT_A_BUNDLE', `${rawPath} is not a folder`);
		this.requireReady();
		return this.runAndWait(
			{
				op: 'import-dir',
				dir,
				watch: !!opts.watch,
				...(opts.projectId ? { projectId: opts.projectId } : {}),
			},
			`Import Remotion project – ${basename(dir)}`,
			opts,
		);
	}

	/**
	 * `POST /api/mg-bundles/import-html` (local mode): an HTML composition page by path. Waits for the `mg-bundle`
	 * job; contract failures are `HTML_*` errors with a hint.
	 */
	async importHtml(
		req: Omit<MgHtmlImportRequest, 'projectId' | 'watch'>,
		opts: { projectId?: string; watch?: boolean; origin?: EngineJob['origin'] },
	): Promise<RegisteredMedia> {
		if (!this.o.localMode)
			throw new MgBundleError(
				'LOCAL_MODE_ONLY',
				'Importing a page file is only available in local mode',
				403,
			);
		if (!isAbsolute(req.path)) throw new MgBundleError('BAD_REQUEST', 'Paths must be absolute');
		const file = resolve(req.path);
		const st = await stat(file).catch(() => null);
		if (!st) throw new MgBundleError('ASSET_NOT_FOUND', `File not found: ${req.path}`, 404);
		if (!st.isFile() || !/^\.html?$/i.test(extname(file)))
			throw new MgBundleError(
				'HTML_NOT_A_PAGE',
				`${req.path} is not an .html file`,
				400,
				undefined,
				'Pass the absolute path of the page file (…/page.html), not its folder.',
			);
		this.requireReady();
		const query = (req.query ?? '').replace(/^\?/, '');
		return this.runAndWait(
			{
				op: 'import-html',
				file,
				query,
				width: req.width,
				height: req.height,
				fps: req.fps,
				watch: !!opts.watch,
				...(opts.projectId ? { projectId: opts.projectId } : {}),
			},
			`Import HTML composition – ${basename(file)}${query ? `?${query}` : ''}`,
			opts,
		);
	}

	/** `POST /api/mg-bundles/import` with an uploaded zip of a built bundle. */
	async importUpload(
		uploadId: string,
		opts: { projectId?: string; origin?: EngineJob['origin'] },
	): Promise<RegisteredMedia> {
		this.requireReady();
		const up = await this.core.uploads.take(uploadId, 'mg-bundle');
		try {
			return await this.runAndWait(
				{
					op: 'import-zip',
					file: up.file,
					name: up.fileName.replace(/\.zip$/i, ''),
					projectId: opts.projectId ?? up.projectId,
				},
				`Import Remotion bundle – ${up.fileName}`,
				{ ...opts, projectId: opts.projectId ?? up.projectId },
			);
		} finally {
			await up.release().catch(() => undefined);
		}
	}

	/** `POST /api/mg-bundles/:key/rebuild` (project directories). Returns the queued job. */
	rebuild(key: string, opts: { projectId?: string; origin?: EngineJob['origin'] } = {}): EngineJob {
		const r = this.record(key);
		if (!r) throw new MgBundleError('NOT_FOUND', `Unknown bundle ${key}`, 404);
		const src = r.mgBundle!.source;
		if ((src.type !== 'project-dir' && src.type !== 'html-page') || !src.path)
			throw new MgBundleError(
				'MG_NOT_A_BUNDLE',
				'Only bundles imported from a project folder can be rebuilt',
				409,
			);
		if (!this.o.localMode)
			throw new MgBundleError(
				'LOCAL_MODE_ONLY',
				'Rebuilding a project folder is only available in local mode',
				403,
			);
		return this.submitBundleJob(
			{ op: 'rebuild', key, ...(opts.projectId ? { projectId: opts.projectId } : {}) },
			`${src.type === 'html-page' ? 'Reload HTML composition' : 'Rebuild Remotion bundle'} – ${src.name}`,
			opts,
		);
	}

	private submitBundleJob(
		input: BundleJobInput,
		title: string,
		opts: { projectId?: string; origin?: EngineJob['origin'] },
	): EngineJob {
		const dedupe =
			input.op === 'import-dir'
				? `mg-bundle:${input.dir}`
				: input.op === 'import-html'
					? `mg-bundle:html:${canonicalImport(input)}`
					: input.op === 'rebuild'
						? `mg-bundle:rebuild:${input.key}`
						: undefined;
		return this.core.queue.submit({
			kind: 'mg-bundle',
			title,
			priority: 'user',
			cpuSlots: MG_BUNDLE_SLOTS,
			minSlots: 1,
			origin: opts.origin ?? { type: 'user' },
			...(opts.projectId ? { projectId: opts.projectId } : {}),
			...(dedupe ? { dedupeKey: dedupe } : {}),
			input,
			stage: 'Queued',
		});
	}

	private async runAndWait(
		input: BundleJobInput,
		title: string,
		opts: { projectId?: string; origin?: EngineJob['origin'] },
	): Promise<RegisteredMedia> {
		const job = this.submitBundleJob(input, title, opts);
		const done = await this.core.queue.wait(job.id);
		if (done.state !== 'succeeded') {
			const e = done.error;
			const extra = this.jobErrors.get(done.id);
			this.jobErrors.delete(done.id);
			throw new MgBundleError(
				e?.code ?? 'MG_BUNDLE_FAILED',
				e?.message ?? `Import ${done.state}`,
				e?.code === 'MG_REMOTION_VERSION' ||
					e?.code === 'MG_BUNDLE_FAILED' ||
					e?.code === 'MG_NOT_INSTALLED' ||
					e?.code === 'MG_RENDER_FAILED' ||
					(e?.code?.startsWith('HTML_') && e.code !== 'HTML_NOT_A_PAGE')
					? 422
					: e?.code === 'MG_UNAVAILABLE'
						? 503
						: e?.code === 'NOT_FOUND' || e?.code === 'ASSET_NOT_FOUND'
							? 404
							: 400,
				{ jobId: done.id, ...((extra?.detail as object | undefined) ?? {}) },
				extra?.hint,
			);
		}
		return (done.result as { media: RegisteredMedia }).media;
	}

	private async runBundleJob(ctx: JobContext): Promise<unknown> {
		const input = ctx.input as BundleJobInput;
		try {
			if (input.op === 'import-dir') return { media: await this.importDir(ctx, input.dir, input.watch) };
			if (input.op === 'import-zip') return { media: await this.importZip(ctx, input.file, input.name) };
			if (input.op === 'import-html') {
				const media = await this.importHtmlPage(ctx, input);
				if (input.watch) await this.startWatch(input.file, media.mediaKey, true, input.projectId);
				return { media };
			}
			return await this.rebuildJob(ctx, input.key);
		} catch (e) {
			if (e instanceof MgBundleError) {
				this.jobErrors.set(ctx.job.id, { detail: e.detail, ...(e.hint ? { hint: e.hint } : {}) });
				if (this.jobErrors.size > 200) this.jobErrors.delete(this.jobErrors.keys().next().value!);
				if (e.hint) ctx.log(`hint: ${e.hint}`);
				throw new JobError(e.code, e.message, e.code === 'MG_BUNDLE_FAILED', e.detail);
			}
			if (e instanceof ZipError) throw new JobError('MG_NOT_A_BUNDLE', e.message, false);
			throw e;
		}
	}

	private async staging(ctx: JobContext): Promise<string> {
		const dir = join(this.bundlesDir, `.staging-${ctx.job.id}`);
		await rm(dir, { recursive: true, force: true });
		await mkdir(dir, { recursive: true });
		ctx.addPartial(dir);
		return dir;
	}

	/** Imports a project folder (bundled with its own CLI) or a built bundle folder. */
	private async importDir(ctx: JobContext, dir: string, watch: boolean): Promise<RegisteredMedia> {
		const stage = await this.staging(ctx);
		const out = join(stage, 'bundle');
		if (await isBuiltBundle(dir)) {
			ctx.progress(0.1, { stage: 'Copying bundle' });
			await cp(dir, out, { recursive: true, dereference: true });
			await checkBundleVersion(out);
			const media = await this.finishImport(ctx, out, {
				source: { type: 'bundle-upload', path: null, name: basename(dir) },
				manifestDirs: [dir],
			});
			return media;
		}
		const pkg = await readProjectPackage(dir);
		await checkRemotionVersion(dir, pkg);
		ctx.progress(0.05, { stage: 'Bundling (remotion bundle)' });
		await mkdir(this.logsDir, { recursive: true });
		await bundleProject(dir, out, {
			signal: ctx.signal,
			logFile: join(this.logsDir, `${ctx.job.id}.log`),
			onSpawn: (c) => ctx.trackChild(c),
			onLog: (line) => {
				const m = /Bundling\s+(\d+)%/.exec(line);
				if (m) {
					ctx.progress(0.05 + (Number(m[1]) / 100) * 0.55, { stage: `Bundling ${m[1]}%` });
				}
				ctx.log(line);
			},
		});
		await checkBundleVersion(out);
		const media = await this.finishImport(ctx, out, {
			source: { type: 'project-dir', path: dir, name: pkg.name },
			manifestDirs: [dir],
			schemaModule: pkg.jasper?.schemas ? { projectDir: dir, entry: pkg.jasper.schemas } : undefined,
		});
		if (watch) await this.startWatch(dir, media.mediaKey, true);
		return media;
	}

	private async importZip(ctx: JobContext, file: string, name: string): Promise<RegisteredMedia> {
		const stage = await this.staging(ctx);
		const unz = join(stage, 'unzipped');
		ctx.progress(0.05, { stage: 'Unpacking' });
		await mkdir(unz, { recursive: true });
		await extractZip(file, unz);
		// The bundle root is the folder with index.html (the zip may wrap it in one folder).
		let root = unz;
		if (!existsSync(join(root, 'index.html'))) {
			const entries = (await readdir(unz, { withFileTypes: true })).filter((e) => !e.name.startsWith('.'));
			const only = entries.length === 1 && entries[0]!.isDirectory() ? join(unz, entries[0]!.name) : null;
			if (only && existsSync(join(only, 'index.html'))) root = only;
		}
		if (!(await isBuiltBundle(root)))
			throw new MgBundleError(
				'MG_NOT_A_BUNDLE',
				'The zip does not contain a built Remotion bundle (index.html + bundle.js from `remotion bundle`)',
			);
		await checkBundleVersion(root);
		return this.finishImport(ctx, root, {
			source: { type: 'bundle-upload', path: null, name },
			manifestDirs: [root],
		});
	}

	/** Hash → content-addressed directory → metadata → schemas → registry record. */
	private async finishImport(
		ctx: JobContext,
		built: string,
		o: {
			source: MgBundleInfo['source'];
			manifestDirs: string[];
			schemaModule?: { projectDir: string; entry: string };
		},
	): Promise<RegisteredMedia> {
		ctx.progress(0.62, { stage: 'Hashing bundle' });
		const { hash } = await hashBundleDir(built);
		const finalDir = join(this.bundlesDir, hash);
		if (existsSync(join(finalDir, 'index.html'))) await rm(built, { recursive: true, force: true });
		else {
			await rm(finalDir, { recursive: true, force: true });
			await rename(built, finalDir);
			// A new bundle directory belongs to this import until it is registered: a cancelled or failed
			// import removes it (a directory that already existed is shared and kept).
			ctx.addPartial(finalDir);
		}
		ctx.progress(0.68, { stage: 'Reading compositions' });
		const raw = await this.readCompositions(finalDir, ctx.signal);
		const warnings: string[] = [];
		let manifest = null;
		for (const d of [...o.manifestDirs, finalDir]) {
			manifest = await readManifest(d, warnings);
			if (manifest) break;
		}
		let moduleSchemas: Record<string, Record<string, unknown>> = {};
		if (o.schemaModule) {
			ctx.progress(0.9, { stage: 'Reading props schemas' });
			const res = await loadSchemaModule(o.schemaModule.projectDir, o.schemaModule.entry, {
				// The job's scratch directory: removed when the job ends, whatever the outcome.
				scratchDir: join(await ctx.scratchDir(), 'schemas'),
				signal: ctx.signal,
			});
			moduleSchemas = res.schemas;
			warnings.push(...res.warnings);
		}
		for (const w of warnings) ctx.log(`warning: ${w}`);
		const compositions = buildCompositionInfos(raw, { manifest, moduleSchemas });
		const info: MgBundleInfo = {
			remotionVersion: MG_REMOTION_VERSION,
			bundleHash: hash,
			builtAt: this.now().toISOString(),
			source: o.source,
			compositions,
		};
		const media = await this.registerBundle(finalDir, info);
		ctx.progress(1, { stage: warnings.length ? `Imported with ${warnings.length} warning(s)` : 'Imported' });
		return media;
	}

	/** Browser options of the headless pages (the Remotion browser, without the binaries directory). */
	private htmlBrowser(): HtmlBrowserOptions {
		const { binariesDirectory: _b, ...browser } = this.remotionOptions();
		return browser;
	}

	/**
	 * Imports an HTML composition page: loads it from its folder in the headless browser (contract check, duration,
	 * the files it loads), copies those files into a content-addressed bundle directory and registers one
	 * composition of `width`×`height` at `fps` for `round(__duration × fps)` frames.
	 */
	private async importHtmlPage(ctx: JobContext, input: HtmlImportInput): Promise<RegisteredMedia> {
		const root = dirname(input.file);
		const entry = basename(input.file);
		ctx.progress(0.05, { stage: 'Loading the page' });
		const probe = await probeHtmlPage(
			await this.renderer(),
			this.htmlBrowser(),
			{ dir: root, entry, query: input.query, width: input.width, height: input.height, fps: input.fps },
			{ signal: ctx.signal },
		);
		for (const m of probe.missing) ctx.log(`warning: the page asked for ${m}, which is not in its folder`);
		for (const u of probe.remote) ctx.log(`warning: the page loads ${u} from the network (renders need it)`);
		if (probe.files.length > HTML_MAX_FILES)
			throw new MgBundleError(
				'HTML_NOT_A_PAGE',
				`The page loads ${probe.files.length} files (at most ${HTML_MAX_FILES})`,
				422,
			);
		ctx.progress(0.5, { stage: `Copying ${probe.files.length} file(s)` });
		const out = join(await this.staging(ctx), 'bundle');
		const realRoot = await realpath(root);
		let bytes = 0;
		for (const rel of probe.files) {
			// The loopback server only served paths inside the folder; checked again before reading.
			const src = normalize(join(realRoot, rel));
			const dst = normalize(join(out, rel));
			if (!src.startsWith(realRoot + sep) || !dst.startsWith(out + sep)) continue;
			bytes += (await stat(src)).size;
			if (bytes > HTML_MAX_BYTES)
				throw new MgBundleError(
					'HTML_NOT_A_PAGE',
					`The files the page loads exceed ${HTML_MAX_BYTES / 1024 ** 3} GiB`,
					422,
				);
			await mkdir(dirname(dst), { recursive: true });
			await copyFile(src, dst);
		}
		ctx.progress(0.8, { stage: 'Hashing page files' });
		const content = await hashBundleDir(out);
		// The page, its query, size and rate are one bundle (the query may change what the page shows and lasts).
		const hash = createHash('sha256')
			.update(JSON.stringify({ html: content.hash, entry, ...input, file: undefined }))
			.digest('hex');
		const finalDir = join(this.bundlesDir, hash);
		if (existsSync(join(finalDir, entry))) await rm(out, { recursive: true, force: true });
		else {
			await rm(finalDir, { recursive: true, force: true });
			await rename(out, finalDir);
			ctx.addPartial(finalDir);
		}
		const id = entry.replace(/\.html?$/i, '').replace(/[^\w.-]/g, '_') || 'page';
		const frames = probe.meta.durationInFrames;
		const name = `${entry}${input.query ? `?${input.query}` : ''}`;
		const info: MgBundleInfo = {
			remotionVersion: MG_REMOTION_VERSION,
			bundleHash: hash,
			builtAt: this.now().toISOString(),
			source: { type: 'html-page', path: input.file, name },
			compositions: [
				{
					id,
					width: input.width,
					height: input.height,
					fps: input.fps,
					durationInFrames: frames,
					defaultProps: {},
					propsSchema: HTML_PROPS_SCHEMA,
					schemaSource: 'inferred',
					// Pages usually animate in: the middle frame shows the design.
					thumbnailFrame: Math.floor((frames - 1) / 2),
				},
			],
			html: { entry, query: input.query },
		};
		const media = await this.registerBundle(finalDir, info);
		const warn = probe.missing.length + probe.remote.length;
		ctx.progress(1, { stage: warn ? `Imported with ${warn} warning(s)` : 'Imported' });
		return media;
	}

	/** Registry record for a bundle directory (storage = its page, so availability checks work). */
	private async registerBundle(dir: string, info: MgBundleInfo): Promise<RegisteredMedia> {
		const index = join(dir, info.html?.entry ?? 'index.html');
		const st = await stat(index);
		const key = `mk_${info.bundleHash.slice(0, 24)}`;
		const record: MediaRecord = {
			mediaKey: key,
			fingerprint: `q1:${info.bundleHash}`,
			originalName: info.source.name,
			sizeBytes: st.size,
			mtimeMs: st.mtimeMs,
			container: info.html ? 'html-page' : 'remotion-bundle',
			kind: 'mg-bundle',
			probe: EMPTY_PROBE,
			browserPlayable: 'no',
			storage: { type: 'managed', path: index },
			durationSec: null,
			display: null,
			hasAudio: false,
			registeredAt: this.now().toISOString(),
			mgBundle: info,
		};
		await this.core.registry.put(record);
		return this.core.registry.toRegistered(record, { exposePath: false });
	}

	/** `getCompositions` on the bundle directory (defaultProps as the page resolves them). */
	private async readCompositions(dir: string, signal: AbortSignal): Promise<RawComposition[]> {
		const r = await this.renderer();
		try {
			const comps = await r.getCompositions(dir, {
				...this.remotionOptions(),
				inputProps: {},
				timeoutInMilliseconds: MG_DELAY_RENDER_TIMEOUT_MS,
				logLevel: 'error',
			});
			if (signal.aborted) throw new MgBundleError('JOB_CANCELLED', 'Cancelled', 499);
			return comps.map((c) => ({
				id: c.id,
				width: c.width,
				height: c.height,
				fps: c.fps,
				durationInFrames: c.durationInFrames,
				defaultProps: (c.defaultProps ?? {}) as Record<string, unknown>,
			}));
		} catch (e) {
			if (e instanceof MgBundleError) throw e;
			throw new MgBundleError(
				'MG_RENDER_FAILED',
				`Reading the compositions failed: ${String((e as Error)?.message ?? e)
					.split('\n')
					.slice(0, 3)
					.join(' ')}`,
				422,
				undefined,
				'Open the project in Remotion Studio (`npx remotion studio`) to see the error, fix it, then import again.',
			);
		}
	}

	private async rebuildJob(ctx: JobContext, key: string): Promise<unknown> {
		const r = this.record(key);
		if (!r) throw new MgBundleError('NOT_FOUND', `Unknown bundle ${key}`, 404);
		const dir = r.mgBundle!.source.path;
		if (!dir) throw new MgBundleError('MG_NOT_A_BUNDLE', 'The bundle has no project folder');
		const html = r.mgBundle!.html;
		const comp = r.mgBundle!.compositions[0];
		const watcher = this.watches.get(this.watchId(dir, key));
		const media =
			html && comp
				? await this.importHtmlPage(ctx, {
						file: dir,
						query: html.query,
						width: comp.width,
						height: comp.height,
						fps: comp.fps,
					})
				: await this.importDir(ctx, dir, false);
		if (media.mediaKey !== key) {
			if (watcher) {
				watcher.key = media.mediaKey;
				// The page may load other files now: watch the new bundle's.
				if (html) this.watchHtmlFiles(watcher);
				await this.saveWatches();
			}
			const event: MgBundleRebuiltEvent = {
				oldKey: key,
				newKey: media.mediaKey,
				mgBundle: media.mgBundle!,
				sizeBytes: media.sizeBytes,
			};
			this.core.broadcaster.publish('mgBundle.rebuilt', event);
			// Projects that imported it with watch and that no editor has open are relinked here.
			for (const projectId of watcher?.projectIds ?? []) {
				const relinked = await this.o.relinkHeadless?.(projectId, event).catch((e: unknown) => {
					ctx.log(`relinking ${projectId} failed: ${(e as Error).message}`);
					return false;
				});
				if (relinked) ctx.log(`relinked project ${projectId}`);
			}
		}
		return { media, rebuilt: { oldKey: key, newKey: media.mediaKey, changed: media.mediaKey !== key } };
	}

	/**
	 * Watches a project folder (MGC-013) or an HTML composition page (the files it loads): changes rebuild it after
	 * 1 s of quiet. `projectId`: a project relinked headlessly after a rebuild when no editor has it open.
	 */
	async startWatch(dir: string, key: string, persist: boolean, projectId?: string): Promise<void> {
		const id = this.watchId(dir, key);
		const existing = this.watches.get(id);
		if (existing) {
			existing.key = key;
			if (projectId) existing.projectIds.add(projectId);
			if (this.record(key)?.mgBundle?.html) this.watchHtmlFiles(existing);
			if (persist) await this.saveWatches();
			return;
		}
		const w: Watch = {
			id,
			dir,
			key,
			watchers: [],
			timer: null,
			projectIds: new Set(projectId ? [projectId] : []),
		};
		this.watches.set(id, w);
		if (this.record(key)?.mgBundle?.html) this.watchHtmlFiles(w);
		else {
			this.addWatcher(w, join(dir, 'src'), true);
			this.addWatcher(w, join(dir, 'public'), true);
			this.addWatcher(w, dir, false, (f) => /^remotion\.config\.|^jasper\.mg\.json$|^package\.json$/.test(f));
		}
		if (persist) await this.saveWatches();
	}

	/** The watch map key of a folder or page (see `Watch.id`). */
	private watchId(dir: string, key: string): string {
		const html = this.record(key)?.mgBundle?.html;
		return html ? `${dir}?${html.query}` : dir;
	}

	/** Debounced rebuild of a watch (1 s after the last change). */
	private trigger(w: Watch): void {
		if (w.timer) clearTimeout(w.timer);
		w.timer = setTimeout(() => {
			w.timer = null;
			try {
				this.rebuild(w.key, {});
			} catch (e) {
				this.o.log?.(`[mg-bundles] watch rebuild of ${w.dir} failed: ${(e as Error).message}`);
			}
		}, 1000);
		w.timer.unref?.();
	}

	private addWatcher(w: Watch, target: string, recursive: boolean, filter?: (f: string) => boolean): void {
		if (!existsSync(target)) return;
		try {
			const watcher = fsWatch(target, { recursive, persistent: false }, (_e, f) => {
				const name = String(f ?? '');
				if (filter && !filter(name)) return;
				this.trigger(w);
			});
			watcher.on('error', () => undefined);
			w.watchers.push(watcher);
		} catch (e) {
			this.o.log?.(`[mg-bundles] cannot watch ${target}: ${(e as Error).message}`);
		}
	}

	/**
	 * An HTML page is watched by the files of its bundle (what the page loaded), each through its folder: editors
	 * save by replacing the file, which a watcher on the file itself would miss.
	 */
	private watchHtmlFiles(w: Watch): void {
		for (const x of w.watchers) x.close();
		w.watchers = [];
		const bundle = this.bundleDir(w.key);
		const root = dirname(w.dir);
		if (!bundle) return;
		void listBundleFiles(bundle).then(
			(files) => {
				const rels = files.map((f) => f.rel);
				if (this.watches.get(w.id) !== w) return;
				const byDir = new Map<string, Set<string>>();
				for (const rel of rels) {
					const abs = join(root, rel);
					const names = byDir.get(dirname(abs)) ?? new Set<string>();
					names.add(basename(abs));
					byDir.set(dirname(abs), names);
				}
				for (const [d, names] of byDir) this.addWatcher(w, d, false, (f) => names.has(basename(f)));
			},
			(e: unknown) => this.o.log?.(`[mg-bundles] cannot list ${bundle}: ${(e as Error).message}`),
		);
	}

	private closeWatch(w: Watch): void {
		if (w.timer) clearTimeout(w.timer);
		for (const x of w.watchers) x.close();
		w.watchers = [];
	}

	stopWatch(dir: string): void {
		const w = this.watches.get(dir);
		if (!w) return;
		this.closeWatch(w);
		this.watches.delete(dir);
		void this.saveWatches();
	}

	watching(): { dir: string; key: string; projectIds?: string[] }[] {
		return [...this.watches.values()].map((w) => ({
			dir: w.dir,
			key: w.key,
			...(w.projectIds.size ? { projectIds: [...w.projectIds] } : {}),
		}));
	}

	private async saveWatches(): Promise<void> {
		await mkdir(this.bundlesDir, { recursive: true });
		await atomicWriteJson(this.watchesFile, { version: 1, watches: this.watching() });
	}

	private async restoreWatches(): Promise<void> {
		const saved = await readJsonOrNull<{ watches?: { dir: string; key: string; projectIds?: unknown }[] }>(
			this.watchesFile,
		);
		for (const w of Array.isArray(saved?.watches) ? saved.watches : []) {
			if (typeof w?.dir !== 'string' || typeof w.key !== 'string') continue;
			if (!existsSync(w.dir) || !this.record(w.key)) continue;
			const ids = Array.isArray(w.projectIds) ? w.projectIds.filter((x) => typeof x === 'string') : [];
			await this.startWatch(w.dir, w.key, false);
			for (const id of ids.slice(0, 100)) this.watches.get(this.watchId(w.dir, w.key))?.projectIds.add(id);
		}
	}

	/** The request's render key (null when the bundle is unknown). */
	renderKeyOf(req: MgPrerenderRequest): string | null {
		const r = this.record(req.mediaKey);
		return r ? prerenderKey(req, r.mgBundle!.bundleHash) : null;
	}

	/** `<appdir>/mg/<renderKey>` (M3: the cache entry exports pin). */
	renderDirOf(renderKey: string): string {
		return join(this.mgDir, renderKey);
	}

	private measureChain: Promise<unknown> = Promise.resolve();
	private readonly measureCache = new Map<string, MgTextMeasureResult>();

	/**
	 * Measures where the given texts land in the composition rendered with `props` (the engine's headless browser;
	 * one measurement at a time, results cached by request).
	 */
	measureTexts(req: MgTextMeasureRequest): Promise<MgTextMeasureResult> {
		this.requireReady();
		const dir = this.bundleDir(req.mediaKey);
		if (!dir) throw new MgBundleError('MG_NOT_A_BUNDLE', `Bundle ${req.mediaKey} is not available`, 404);
		const key = createHash('sha256').update(JSON.stringify(req)).digest('hex');
		const hit = this.measureCache.get(key);
		if (hit) return Promise.resolve(hit);
		const run = this.measureChain.then(async () => {
			const again = this.measureCache.get(key);
			if (again) return again;
			const { binariesDirectory: _b, ...browser } = this.remotionOptions();
			let result: MgTextMeasureResult;
			try {
				result = await measureBundleTexts(await this.renderer(), dir, req, browser);
			} catch (e) {
				throw new MgBundleError(
					'MG_RENDER_FAILED',
					`Measuring the texts of ${req.compositionId} failed: ${(e as Error).message.split('\n')[0]}`,
					422,
				);
			}
			this.measureCache.set(key, result);
			if (this.measureCache.size > 64) this.measureCache.delete(this.measureCache.keys().next().value!);
			return result;
		});
		this.measureChain = run.catch(() => undefined);
		return run;
	}

	/** Cached result of a render key (master and/or preview present), or null. */
	async cached(renderKey: string): Promise<MgPrerenderResult | null> {
		if (!KEY_RE.test(renderKey)) return null;
		const dir = this.renderDirOf(renderKey);
		const meta = await readJsonOrNull<RenderMeta>(join(dir, 'meta.json'));
		if (meta?.kind !== 'composition') return null;
		const has = (f: string) => existsSync(join(dir, f));
		if (!has('preview.webm') && !has('master.mov')) return null;
		return this.resultOf(renderKey, meta.request, {
			master: has('master.mov'),
			preview: has('preview.webm'),
			poster: has('poster.png'),
		});
	}

	private resultOf(
		renderKey: string,
		req: MgPrerenderRequest,
		files: { master: boolean; preview: boolean; poster: boolean },
	): MgPrerenderResult {
		return {
			renderKey,
			masterUrl: files.master ? `/mg/${renderKey}/master.mov` : null,
			previewUrl: files.preview ? `/mg/${renderKey}/preview.webm` : '',
			posterUrl: files.poster ? `/mg/${renderKey}/poster.png` : null,
			startFrame: req.startFrame,
			durationFrames: req.durationFrames,
			width: req.width,
			height: req.height,
		};
	}

	/** Absolute path of a cached master (null when not rendered). Marks the render as used (GC). */
	masterPath(renderKey: string): string | null {
		const p = join(this.renderDirOf(renderKey), 'master.mov');
		if (!KEY_RE.test(renderKey) || !existsSync(p)) return null;
		void this.markUsed(renderKey);
		return p;
	}

	private async markUsed(renderKey: string): Promise<void> {
		// Synchronously, before the metadata write: a cleaning pass working from an older scan sees the use too.
		this.core.cache.touch(this.renderDirOf(renderKey));
		const file = join(this.renderDirOf(renderKey), 'meta.json');
		const meta = await readJsonOrNull<RenderMeta>(file);
		if (!meta) return;
		meta.lastUsedAt = this.now().toISOString();
		await atomicWriteJson(file, meta).catch(() => undefined);
	}

	/**
	 * Queues (or joins) an `mg-prerender` job (lane user, 4 CPU slots, dedupe by render key and quality). A
	 * cached result completes the job immediately. Child jobs of an export (`parentId`) run inside the export's
	 * CPU budget (0 slots) so a full export can never starve its own pre-renders.
	 */
	prerender(
		req: MgPrerenderRequest,
		meta: { projectId?: string; parentId?: string; origin?: EngineJob['origin']; concurrency?: number } = {},
	): EngineJob {
		const r = this.record(req.mediaKey);
		if (!r) throw new MgBundleError('NOT_FOUND', `Unknown bundle ${req.mediaKey}`, 404);
		const comp = r.mgBundle!.compositions.find((c) => c.id === req.compositionId);
		if (!comp)
			throw new MgBundleError(
				'NOT_FOUND',
				`Composition ${req.compositionId} is not in bundle ${r.originalName}`,
				404,
			);
		this.requireReady();
		const renderKey = prerenderKey(req, r.mgBundle!.bundleHash);
		const child = !!meta.parentId;
		return this.core.queue.submit({
			kind: 'mg-prerender',
			title: `${req.quality === 'master' ? 'Render composition' : 'Preview composition'} – ${req.compositionId}`,
			priority: req.quality === 'preview' ? 'interactive' : 'user',
			cpuSlots: child ? 0 : MG_PRERENDER_SLOTS,
			minSlots: child ? 0 : 1,
			origin: meta.origin ?? { type: 'user' },
			...((meta.projectId ?? req.projectId) ? { projectId: meta.projectId ?? req.projectId } : {}),
			...(meta.parentId ? { parentId: meta.parentId } : {}),
			dedupeKey: `mg-prerender:${renderKey}:${req.quality}${child ? `:${meta.parentId}` : ''}`,
			input: {
				req,
				renderKey,
				...(meta.concurrency ? { concurrency: meta.concurrency } : {}),
			} satisfies PrerenderJobInput,
			stage: 'Queued',
		});
	}

	private async runPrerender(ctx: JobContext): Promise<MgPrerenderResult> {
		const { req, renderKey, concurrency } = ctx.input as PrerenderJobInput;
		const dir = this.renderDirOf(renderKey);
		const hit = await this.cached(renderKey);
		if (hit && (req.quality === 'preview' ? hit.previewUrl : hit.masterUrl)) {
			void this.markUsed(renderKey);
			return hit;
		}
		const bundleDir = this.bundleDir(req.mediaKey);
		const record = this.record(req.mediaKey);
		if (!bundleDir || !record)
			throw new JobError('ASSET_NOT_FOUND', `Bundle ${req.mediaKey} is not available`, false);
		if (record.mgBundle!.html) return this.runHtmlPrerender(ctx, record, bundleDir);
		const r = await this.renderer();
		const opts = this.remotionOptions();
		const scratch = await ctx.scratchDir();
		const tabs = Math.max(1, Math.min(8, concurrency ?? (ctx.slots || MG_PRERENDER_SLOTS)));
		const { cancelSignal, cancel } = r.makeCancelSignal();
		const onAbort = () => cancel();
		ctx.signal.addEventListener('abort', onAbort, { once: true });
		const fps = req.fps.num / req.fps.den;
		let instance: Awaited<ReturnType<typeof r.openBrowser>> | null = null;
		try {
			ctx.progress(0, { stage: 'Loading composition' });
			const selected = await r.selectComposition({
				serveUrl: bundleDir,
				id: req.compositionId,
				inputProps: req.props,
				timeoutInMilliseconds: MG_DELAY_RENDER_TIMEOUT_MS,
				logLevel: 'error',
				...opts,
			});
			// Renders run at the requested (sequence) rate and size (MGC-005): scale the duration with the rate.
			const total =
				Math.abs(selected.fps - fps) > 1e-3
					? Math.max(1, Math.round((selected.durationInFrames * fps) / selected.fps))
					: selected.durationInFrames;
			const first = Math.min(req.startFrame, total - 1);
			const last = Math.min(total - 1, req.startFrame + req.durationFrames - 1);
			if (last - first + 1 !== req.durationFrames)
				throw new JobError(
					'INVALID_SPEC',
					`Frames ${req.startFrame}…${req.startFrame + req.durationFrames - 1} are outside the composition (${total} frames at ${fps} fps)`,
					false,
				);
			const composition = { ...selected, width: req.width, height: req.height, fps, durationInFrames: total };
			// S11:ANM-014: with a full Chrome, parallel pages must each get their own window, or Remotion captures a
			// hidden tab's first frame before Chrome has painted it (see RemotionService.renderBrowser).
			if (tabs > 1 && opts.chromeMode === 'chrome-for-testing') {
				const opened = await r.openBrowser('chrome', { ...opts, logLevel: 'error' });
				if (renderPagesInOwnWindows(opened)) instance = opened;
				else await opened.close({ silent: true }).catch(() => undefined);
			}
			const common = {
				serveUrl: bundleDir,
				composition,
				inputProps: req.props,
				frameRange: [first, last] as [number, number],
				muted: true,
				imageFormat: 'png' as const,
				concurrency: tabs,
				cancelSignal,
				...(instance ? { puppeteerInstance: instance } : {}),
				timeoutInMilliseconds: MG_DELAY_RENDER_TIMEOUT_MS,
				licenseKey: this.core.remotion.licenseKey,
				logLevel: 'error' as const,
				overwrite: true,
				...opts,
			};
			await mkdir(dir, { recursive: true });
			const ff = this.ffmpeg();
			const files = { master: false, preview: false, poster: false };
			// S04:LC-004 / S11:LBK-026 (wp-m2-layer-bake): pre-renders are Remotion renders, logged like exports.
			await this.core.remotion.recordUsage('media', 'mg-prerender');
			if (req.quality === 'master') {
				const raw = join(scratch, 'master-raw.mov');
				await r.renderMedia({
					...common,
					codec: 'prores',
					proResProfile: '4444',
					pixelFormat: 'yuva444p10le',
					colorSpace: 'bt709',
					outputLocation: raw,
					onProgress: (p) =>
						ctx.progress(p.progress * 0.85, {
							stage: `Rendering master ${p.renderedFrames}/${req.durationFrames}`,
						}),
				});
				// Remotion leaves the colour description unset: stamp BT.709 losslessly (the pixels are 709).
				ctx.progress(0.86, { stage: 'Tagging BT.709' });
				const tmpMaster = join(scratch, 'master.mov');
				await ff.run(
					[
						'-i',
						raw,
						'-map',
						'0:v:0',
						'-c',
						'copy',
						'-color_primaries',
						'bt709',
						'-color_trc',
						'bt709',
						'-colorspace',
						'bt709',
						'-movflags',
						'+write_colr',
						'-f',
						'mov',
						tmpMaster,
					],
					{ signal: ctx.signal, onSpawn: ctx.trackChild },
				);
				const frames = await ff.countVideoFrames(tmpMaster, { signal: ctx.signal });
				if (frames !== req.durationFrames)
					throw new JobError(
						'FRAME_COUNT_MISMATCH',
						`The master has ${frames} frames, expected ${req.durationFrames}`,
						true,
					);
				await rename(tmpMaster, join(dir, 'master.mov'));
				files.master = true;
				ctx.progress(0.9, { stage: 'Encoding preview' });
				await this.encodePreview(ff, join(dir, 'master.mov'), join(dir, 'preview.webm'), ctx);
				files.preview = true;
			} else {
				const half = req.width % 4 === 0 && req.height % 4 === 0;
				const tmpPreview = join(scratch, 'preview.webm');
				await r.renderMedia({
					...common,
					codec: 'vp9',
					pixelFormat: 'yuva420p',
					crf: 32,
					...(half ? { scale: 0.5 } : {}),
					ffmpegOverride: ({ type, args }) => {
						if (type !== 'stitcher') return args;
						const outIdx = args.length - 1;
						return [...args.slice(0, outIdx), '-row-mt', '1', '-cpu-used', '4', ...args.slice(outIdx)];
					},
					outputLocation: tmpPreview,
					onProgress: (p) =>
						ctx.progress(p.progress * 0.95, {
							stage: `Rendering preview ${p.renderedFrames}/${req.durationFrames}`,
						}),
				});
				await rename(tmpPreview, join(dir, 'preview.webm'));
				files.preview = true;
				if (existsSync(join(dir, 'master.mov'))) files.master = true;
			}
			return await this.finishPrerender(ctx, ff, req, renderKey, record, files);
		} catch (e) {
			if (ctx.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
			if (e instanceof JobError) throw e;
			const msg = String((e as Error)?.message ?? e);
			throw new JobError(
				'MG_RENDER_FAILED',
				`Pre-rendering ${req.compositionId} failed: ${msg.slice(0, 1200)}`,
				true,
			);
		} finally {
			ctx.signal.removeEventListener('abort', onAbort);
			await instance?.close({ silent: true }).catch(() => undefined);
		}
	}

	/** Poster and `meta.json` of a finished pre-render (both renderers). */
	private async finishPrerender(
		ctx: JobContext,
		ff: Ffmpeg,
		req: MgPrerenderRequest,
		renderKey: string,
		record: MediaRecord,
		files: { master: boolean; preview: boolean; poster: boolean },
	): Promise<MgPrerenderResult> {
		const dir = this.renderDirOf(renderKey);
		await this.extractPoster(
			ff,
			join(dir, req.quality === 'master' ? 'master.mov' : 'preview.webm'),
			join(dir, 'poster.png'),
			req,
			ctx,
			req.quality === 'master' ? null : 'libvpx-vp9',
		);
		files.poster = existsSync(join(dir, 'poster.png'));
		const t = this.now().toISOString();
		const prev = await readJsonOrNull<RenderMeta>(join(dir, 'meta.json'));
		const meta: RenderMeta = {
			kind: 'composition',
			renderKey,
			request: req,
			bundleHash: record.mgBundle!.bundleHash,
			files: ['master.mov', 'preview.webm', 'poster.png'].filter((f) => existsSync(join(dir, f))),
			createdAt: prev?.createdAt ?? t,
			lastUsedAt: t,
		};
		await atomicWriteJson(join(dir, 'meta.json'), meta, true);
		ctx.progress(1, { stage: 'Done' });
		return this.resultOf(renderKey, req, files);
	}

	/**
	 * `mg-prerender` of an HTML composition: the page seeked frame by frame in parallel pages (html.ts) into ProRes
	 * 4444 — the master as is, or the source of the half-size VP9-alpha preview — then the shared poster and meta.
	 */
	private async runHtmlPrerender(
		ctx: JobContext,
		record: MediaRecord,
		bundleDir: string,
	): Promise<MgPrerenderResult> {
		const { req, renderKey, concurrency } = ctx.input as PrerenderJobInput;
		const html = record.mgBundle!.html!;
		const comp = record.mgBundle!.compositions.find((c) => c.id === req.compositionId);
		if (!comp)
			throw new JobError('ASSET_NOT_FOUND', `Composition ${req.compositionId} is not in the bundle`, false);
		const fps = req.fps.num / req.fps.den;
		// Renders run at the requested (sequence) rate: frame f shows the page at f / fps seconds (MGC-005).
		const total =
			Math.abs(comp.fps - fps) > 1e-3
				? Math.max(1, Math.round((comp.durationInFrames * fps) / comp.fps))
				: comp.durationInFrames;
		if (req.startFrame + req.durationFrames > total)
			throw new JobError(
				'INVALID_SPEC',
				`Frames ${req.startFrame}…${req.startFrame + req.durationFrames - 1} are outside the composition (${total} frames at ${fps} fps)`,
				false,
			);
		const dir = this.renderDirOf(renderKey);
		const scratch = await ctx.scratchDir();
		const ff = this.ffmpeg();
		const pages = Math.max(1, Math.min(8, concurrency ?? (ctx.slots || MG_PRERENDER_SLOTS)));
		const files = { master: false, preview: false, poster: false };
		const what = req.quality === 'master' ? 'master' : 'preview';
		try {
			ctx.progress(0, { stage: 'Loading the page' });
			await mkdir(dir, { recursive: true });
			await this.core.remotion.recordUsage('media', 'mg-prerender');
			const prores = join(scratch, 'html.mov');
			await renderHtmlProRes(
				await this.renderer(),
				this.htmlBrowser(),
				ff,
				{
					dir: bundleDir,
					entry: html.entry,
					query: html.query,
					width: req.width,
					height: req.height,
					fps,
					rate: req.fps,
					totalFrames: total,
					startFrame: req.startFrame,
					durationFrames: req.durationFrames,
					pages,
					out: prores,
					scratch,
				},
				{
					signal: ctx.signal,
					trackChild: ctx.trackChild,
					onFrames: (n) =>
						ctx.progress((n / req.durationFrames) * 0.85, {
							stage: `Rendering ${what} ${n}/${req.durationFrames}`,
						}),
				},
			);
			const frames = await ff.countVideoFrames(prores, { signal: ctx.signal });
			if (frames !== req.durationFrames)
				throw new JobError(
					'FRAME_COUNT_MISMATCH',
					`The ${what} has ${frames} frames, expected ${req.durationFrames}`,
					true,
				);
			ctx.progress(0.9, { stage: 'Encoding preview' });
			if (req.quality === 'master') {
				await rename(prores, join(dir, 'master.mov'));
				files.master = true;
				await this.encodePreview(ff, join(dir, 'master.mov'), join(dir, 'preview.webm'), ctx);
			} else {
				await this.encodePreview(ff, prores, join(dir, 'preview.webm'), ctx);
				files.master = existsSync(join(dir, 'master.mov'));
			}
			files.preview = true;
			return await this.finishPrerender(ctx, ff, req, renderKey, record, files);
		} catch (e) {
			if (ctx.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
			if (e instanceof JobError) throw e;
			throw new JobError(
				'MG_RENDER_FAILED',
				`Rendering ${record.mgBundle!.source.name} failed: ${String((e as Error)?.message ?? e).slice(0, 1200)}`,
				true,
			);
		}
	}

	/** VP9 + alpha (`yuva420p`) at half size, CRF 32, row-mt (MGC-030). */
	private async encodePreview(ff: Ffmpeg, master: string, out: string, ctx: JobContext): Promise<void> {
		const tmp = `${out}.part.webm`;
		// Next to the cache entry (same disk for the rename); deleted if the job is cancelled or fails.
		ctx.addPartial(tmp);
		await ff.run(
			[
				'-i',
				master,
				'-map',
				'0:v:0',
				'-vf',
				'scale=trunc(iw/4)*2:trunc(ih/4)*2:flags=bicubic,format=yuva420p',
				'-c:v',
				'libvpx-vp9',
				'-pix_fmt',
				'yuva420p',
				'-crf',
				'32',
				'-b:v',
				'0',
				'-row-mt',
				'1',
				'-deadline',
				'good',
				'-cpu-used',
				'4',
				'-auto-alt-ref',
				'0',
				'-an',
				'-f',
				'webm',
				tmp,
			],
			{ signal: ctx.signal, onSpawn: ctx.trackChild },
		);
		await rename(tmp, out);
	}

	/** A straight-alpha PNG of the middle frame. */
	private async extractPoster(
		ff: Ffmpeg,
		src: string,
		out: string,
		req: MgPrerenderRequest,
		ctx: JobContext,
		decoder: string | null,
	): Promise<void> {
		const mid = Math.floor(req.durationFrames / 2);
		const fps = req.fps.num / req.fps.den;
		// Written beside the entry and renamed into place: a cancel never leaves a truncated poster in the cache.
		const tmp = `${out}.part.png`;
		ctx.addPartial(tmp);
		await ff
			.run(
				[
					...(decoder ? ['-c:v', decoder] : []),
					'-i',
					src,
					'-vf',
					`select=eq(n\\,${mid}),format=rgba`,
					'-frames:v',
					'1',
					'-update',
					'1',
					'-f',
					'image2',
					tmp,
				],
				{ signal: ctx.signal, onSpawn: ctx.trackChild },
			)
			.then(() => rename(tmp, out))
			.catch((e) => {
				// A cancelled job stops here (the poster is optional, a failed one is only logged).
				if (ctx.signal.aborted) throw e;
				ctx.log(`poster failed: ${(e as Error).message} (${fps} fps)`);
			});
	}

	/**
	 * Renders (or reuses) the masters an export needs, as child jobs of `parentId`. Resolves renderKey → path.
	 * The renders run side by side within the export's Remotion page budget (`concurrency`, S11:LBK-022 page pool):
	 * one render per distinct render key, each with its share of the pages. Throws a JobError when one of them fails
	 * (the others are cancelled first).
	 */
	async ensureMasters(
		reqs: readonly MgPrerenderRequest[],
		meta: {
			parentId: string;
			projectId?: string;
			signal: AbortSignal;
			/** The export's Remotion page budget. */
			concurrency: number;
			/** Renders in flight at most (default: the page pool's). */
			maxInFlight?: number;
			stage(text: string): void;
		},
	): Promise<Map<string, string>> {
		const out = new Map<string, string>();
		const todo = new Map<string, MgPrerenderRequest>();
		for (const req of reqs) {
			const key = this.renderKeyOf(req);
			if (!key) throw new JobError('ASSET_NOT_FOUND', `Bundle ${req.mediaKey} is not available`, false);
			const cached = this.masterPath(key);
			if (cached) out.set(key, cached);
			else if (!todo.has(key)) todo.set(key, req);
		}
		if (todo.size === 0) return out;
		const budget = Math.max(1, Math.floor(meta.concurrency));
		meta.stage(`Rendering compositions 0/${todo.size}`);
		const shares = pageShares(
			[...todo.values()].map((r) => r.durationFrames),
			budget,
			Math.min(budget, MAX_RENDERS_IN_FLIGHT),
		);
		await runPagePool(
			[...todo].map(([key, req], i) => ({
				want: shares[i]!,
				weight: req.durationFrames + 30,
				run: async (g: PageGrant) => {
					const job = this.prerender(req, {
						parentId: meta.parentId,
						...(meta.projectId ? { projectId: meta.projectId } : {}),
						origin: { type: 'system' },
						concurrency: g.pages,
					});
					const onAbort = () => this.core.queue.cancel(job.id);
					g.signal.addEventListener('abort', onAbort, { once: true });
					const poll = setInterval(() => {
						const p = this.core.queue.get(job.id)?.progress;
						if (typeof p === 'number') g.progress(p);
					}, 250);
					poll.unref();
					try {
						const done = await this.core.queue.wait(job.id);
						if (g.signal.aborted || done.state === 'cancelled')
							throw new JobError('JOB_CANCELLED', 'Cancelled');
						if (done.state !== 'succeeded')
							throw new JobError(
								done.error?.code ?? 'MG_RENDER_FAILED',
								`Composition ${req.compositionId}: ${done.error?.message ?? done.state}`,
								done.error?.retryable ?? true,
							);
					} finally {
						clearInterval(poll);
						g.signal.removeEventListener('abort', onAbort);
					}
					const p = this.masterPath(key);
					if (!p)
						throw new JobError('MG_RENDER_FAILED', `The master of ${req.compositionId} is missing`, true);
					out.set(key, p);
				},
			})),
			{
				budget,
				...(meta.maxInFlight ? { maxInFlight: meta.maxInFlight } : {}),
				signal: meta.signal,
				onProgress: (p) =>
					meta.stage(
						`Rendering compositions ${p.done}/${p.total}${p.done < p.total ? ` · ${Math.floor(p.fraction * 100)} %` : ''}`,
					),
			},
		);
		return out;
	}

	/** PNG of one composition at its `thumbnailFrame` (default props), rendered once and cached. */
	poster(key: string, compositionId: string): Promise<string> {
		const r = this.record(key);
		const dir = this.bundleDir(key);
		if (!r || !dir) return Promise.reject(new MgBundleError('NOT_FOUND', `Unknown bundle ${key}`, 404));
		const comp = r.mgBundle!.compositions.find((c) => c.id === compositionId);
		if (!comp) return Promise.reject(new MgBundleError('NOT_FOUND', `No composition ${compositionId}`, 404));
		const frame = Math.min(comp.durationInFrames - 1, Math.max(0, comp.thumbnailFrame ?? 0));
		const safeId = compositionId.replace(/[^\w.-]/g, '_');
		const file = join(this.mgDir, 'posters', r.mgBundle!.bundleHash, `${safeId}@${frame}.png`);
		if (existsSync(file)) return Promise.resolve(file);
		const pending = this.posterJobs.get(file);
		if (pending) return pending;
		// One poster at a time (each opens a headless page).
		const prev = [...this.posterJobs.values()].at(-1) ?? Promise.resolve('');
		const job = prev
			.catch(() => '')
			.then(() => this.renderPoster(dir, comp as MgCompositionInfo, frame, file, r.mgBundle!.html))
			.finally(() => this.posterJobs.delete(file));
		this.posterJobs.set(file, job);
		return job;
	}

	private async renderPoster(
		dir: string,
		comp: MgCompositionInfo,
		frame: number,
		file: string,
		html?: { entry: string; query: string },
	): Promise<string> {
		this.requireReady();
		if (html) return this.renderHtmlPoster(dir, comp, frame, file, html);
		const r = await this.renderer();
		const opts = this.remotionOptions();
		await mkdir(dirname(file), { recursive: true });
		const tmp = `${file}.${process.pid}.tmp.png`;
		// S11:LBK-026 (wp-m2-layer-bake): posters are Remotion renders too.
		await this.core.remotion.recordUsage('still', 'mg-prerender');
		const selected = await r.selectComposition({
			serveUrl: dir,
			id: comp.id,
			inputProps: comp.defaultProps,
			timeoutInMilliseconds: MG_DELAY_RENDER_TIMEOUT_MS,
			logLevel: 'error',
			...opts,
		});
		await r.renderStill({
			serveUrl: dir,
			composition: selected,
			inputProps: comp.defaultProps,
			frame,
			output: tmp,
			imageFormat: 'png',
			scale: Math.min(1, 480 / Math.max(1, selected.width)),
			timeoutInMilliseconds: MG_DELAY_RENDER_TIMEOUT_MS,
			licenseKey: this.core.remotion.licenseKey,
			logLevel: 'error',
			overwrite: true,
			...opts,
		});
		await rename(tmp, file);
		return file;
	}

	/** Motion Templates poster of an HTML composition: the frame at full size, scaled to 480 px wide at most. */
	private async renderHtmlPoster(
		dir: string,
		comp: MgCompositionInfo,
		frame: number,
		file: string,
		html: { entry: string; query: string },
	): Promise<string> {
		await mkdir(dirname(file), { recursive: true });
		const png = await renderHtmlStill(await this.renderer(), this.htmlBrowser(), {
			dir,
			entry: html.entry,
			query: html.query,
			width: comp.width,
			height: comp.height,
			fps: comp.fps,
			totalFrames: comp.durationInFrames,
			frame,
		}).catch((e: unknown) => {
			throw e instanceof MgBundleError
				? e
				: new MgBundleError('MG_RENDER_FAILED', `Poster of ${comp.id} failed: ${(e as Error).message}`, 422);
		});
		const full = `${file}.${process.pid}.full.png`;
		const tmp = `${file}.${process.pid}.tmp.png`;
		await writeFile(full, png);
		try {
			const w = Math.min(480, comp.width);
			await this.ffmpeg().run(
				[
					'-i',
					full,
					'-vf',
					`scale=${w}:-2:flags=bicubic,format=rgba`,
					'-frames:v',
					'1',
					'-update',
					'1',
					'-f',
					'image2',
					tmp,
				],
				{},
			);
			await rename(tmp, file);
		} finally {
			await rm(full, { force: true });
		}
		return file;
	}
}
