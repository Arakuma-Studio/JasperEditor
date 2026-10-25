// Engine core services (WP-2F) and their wiring. Route plugins (including WP-2G `mg` and WP-2H `agent`)
// reach them through `coreServices(app)`; the hooks for other packages are `registerCapabilityProvider`,
// `registerMgMasterProvider` and `queue.registerRunner`.
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { UrlSigner } from '../auth/signed-url.ts';
import { CacheService } from '../cache/service.ts';
import { type EngineConfig, isLoopbackHost } from '../context.ts';
import { DerivativeService } from '../derivatives/service.ts';
import { Broadcaster } from '../events/broadcaster.ts';
import type { NativeExtension } from '../export/native-ext.ts';
import type { PlanCapabilities } from '../export/planner.ts';
import { ExportService, type MgMasterProvider } from '../export/service.ts';
import { FontCatalogService } from '../fonts/catalog.ts';
import { FontLibrary } from '../fonts/library.ts';
import { JobQueue } from '../jobs/queue.ts';
import { MediaRegistry } from '../media/registry.ts';
import { MediaService } from '../media/service.ts';
import { prerenderKey } from '../mg-bundles/service.ts';
import { LeaseManager } from '../projects/leases.ts';
import { RecoveryJournal } from '../projects/recovery.ts';
import { ProjectStoreFs } from '../projects/store.ts';
import { RemotionService } from '../remotion/service.ts';
import { UploadService } from '../uploads/service.ts';
import { type CapabilityProvider, CapabilityService } from './capabilities.ts';
import { EncoderService } from './encoders.ts';
import { Ffmpeg, resolveBinaries, selfCheck } from './ffmpeg.ts';
import { findVendorDir, resolveRemotionBinaries } from './lgpl.ts';

export type CoreServices = {
	config: EngineConfig;
	broadcaster: Broadcaster;
	queue: JobQueue;
	ffmpeg: Ffmpeg;
	/** Encoder inventory + selection (ARCHITECTURE D-13). */
	encoders: EncoderService;
	signer: UrlSigner;
	registry: MediaRegistry;
	media: MediaService;
	derivatives: DerivativeService;
	uploads: UploadService;
	leases: LeaseManager;
	projects: ProjectStoreFs;
	/** Per-session crash-recovery journals (S01:PER-021, AC-18, D-39). */
	recovery: RecoveryJournal;
	fonts: FontCatalogService;
	/** wp fonts: the user font library (`<appdir>/fonts`), part of `fonts`' catalog. */
	fontLibrary: FontLibrary;
	remotion: RemotionService;
	exports: ExportService;
	capabilities: CapabilityService;
	/** M3 (wp-m3-cachegc): the cache registry and garbage collector (S04 §7.5). */
	cache: CacheService;
	/** Absolute engine origin (`http://127.0.0.1:<port>`) for signed URLs handed to headless renderers. */
	origin(): string;
	/** WP-2G: contribute to `GET /api/capabilities` (e.g. `render.fframes`). */
	registerCapabilityProvider(fn: CapabilityProvider): () => void;
	/** WP-2G: motion-graphic masters for native exports. */
	registerMgMasterProvider(fn: MgMasterProvider | null): void;
	/** M2 (ARCHITECTURE §19.6): native export extensions (colour LUTs, MG pre-renders, warp stage). */
	registerNativeExtension(ext: NativeExtension): () => void;
	/** Starts the queue (journal recovery) and timers; called from the server's onReady hook. */
	start(): void;
	/** Graceful stop (S04:ENG-004): running jobs become `interrupted`, the journal is flushed. */
	stop(): Promise<void>;
};

type CoreServiceOptions = {
	jsonBodyLimit: number;
	env?: Record<string, string | undefined>;
	/** Packaged resources folder (ffmpeg under `<dir>/bin` or `<dir>/ffmpeg-lgpl`, D-13). */
	resourcesDir?: string | null;
	totalSlots?: number;
	log?(msg: string): void;
};

export async function createCoreServices(
	config: EngineConfig,
	opts: CoreServiceOptions,
): Promise<CoreServices> {
	const env = opts.env ?? process.env;
	const paths = config.paths;
	const broadcaster = new Broadcaster();
	// Packaged desktop builds: the Electron main passes JASPER_RESOURCES_DIR; a utilityProcess also has
	// `process.resourcesPath`.
	const resourcesDir =
		opts.resourcesDir ??
		env.JASPER_RESOURCES_DIR ??
		(opts.env
			? null
			: 'resourcesPath' in process && typeof process.resourcesPath === 'string'
				? process.resourcesPath
				: null);
	// D-13: one LGPL directory (vendor in dev, <resources>/ffmpeg-lgpl packaged) serves both paths.
	const vendorDir = findVendorDir({ env });
	const bins = resolveBinaries({ env, resourcesDir, vendorDir });
	opts.log?.(`[ffmpeg] ${bins.ffmpeg ?? 'not found'} (${bins.source})`);
	const ffmpeg = new Ffmpeg(bins);
	const check = await selfCheck(bins);
	const encoders = await EncoderService.create({
		ffmpeg: bins.ffmpeg,
		encoders: check.encoders,
		hwaccels: check.hwaccels,
		license: check.license,
		env,
	});
	const signer = new UrlSigner(config.token ?? undefined);
	const queue = new JobQueue({
		journalPath: paths.jobsJournal,
		tmpDir: paths.tmpDir,
		logDir: join(paths.logsDir, 'jobs'),
		broadcaster,
		...(opts.totalSlots ? { totalSlots: opts.totalSlots } : {}),
		onError: (e) => opts.log?.(`[jobs] ${(e as Error).message}`),
	});
	const registry = await MediaRegistry.open(paths.mediaIndex);
	const derivatives = new DerivativeService({
		cacheDir: paths.cacheDir,
		ff: ffmpeg,
		encoders,
		queue,
		registry,
		broadcaster,
	});
	const media = new MediaService({
		mediaDir: paths.mediaDir,
		ff: ffmpeg,
		queue,
		registry,
		derivatives,
		broadcaster,
		exposePaths: true,
	});
	const uploadDependencies = {
		dir: join(paths.mediaDir, '.uploads'),
		media,
		onError: (error: unknown) =>
			opts.log?.(`[uploads] sweep failed: ${error instanceof Error ? error.message : String(error)}`),
	};
	const uploads = new UploadService(uploadDependencies);
	const leases = new LeaseManager();
	const projects = new ProjectStoreFs({ paths, leases, appVersion: config.version });
	const recovery = new RecoveryJournal({
		paths,
		leases,
		saved: async (projectId) => {
			const g = await projects.get(projectId).catch(() => null);
			return g ? { revision: g.revision, document: g.envelope.document } : null;
		},
	});
	const fontLibrary = await FontLibrary.open(paths.fontsDir, {
		onChange: (revision) => broadcaster.publish('fonts.changed', { revision }),
		log: opts.log,
	});
	const fonts = new FontCatalogService(env, fontLibrary);
	const remotion = new RemotionService({
		bundleCacheDir: paths.remotionBundleDir,
		usageLog: join(paths.logsDir, 'remotion-usage.jsonl'),
		env,
		binaries: resolveRemotionBinaries({ env, resourcesDir, vendorDir, strict: !config.dev }),
		log: opts.log,
	});
	await remotion.init(!config.dev);
	const capabilities = new CapabilityService({
		config,
		selfCheck: check,
		ffmpegSource: bins.source,
		encoders,
		remotion,
		fonts,
		broadcaster,
		jsonBodyLimit: opts.jsonBodyLimit,
	});
	const origin = () => `http://127.0.0.1:${config.port}`;
	const exportsSvc: ExportService = new ExportService({
		rendersDir: paths.rendersDir,
		ff: ffmpeg,
		encoders,
		queue,
		registry,
		fonts,
		remotion,
		broadcaster,
		signer,
		origin,
		localMode: config.dev || isLoopbackHost(config.host),
		capabilities: async (): Promise<PlanCapabilities> => {
			const caps = await capabilities.get();
			return {
				native: caps.render.native,
				remotionLocal: caps.render.remotionLocal,
				fframes: caps.render.fframes,
				mgMasters: exportsSvc.hasMgMasterProvider,
				...(check.decoders.length ? { decoders: check.decoders } : {}),
			};
		},
	});
	const cache = new CacheService({
		appdir: config.appdir,
		paths,
		queue,
		projects,
		leases,
		broadcaster,
		renderKey: prerenderKey,
		exposePaths: config.dev || isLoopbackHost(config.host),
		...(env.JASPER_CACHE_AUTO_GC !== undefined ? { autoTimers: env.JASPER_CACHE_AUTO_GC !== '0' } : {}),
		log: opts.log,
	});
	exportsSvc.cache = cache;
	cache.registerRunners();
	media.registerRunners();
	derivatives.registerRunners();
	exportsSvc.registerRunners();

	let started = false;
	return {
		config,
		broadcaster,
		queue,
		ffmpeg,
		encoders,
		signer,
		registry,
		media,
		derivatives,
		uploads,
		leases,
		projects,
		recovery,
		fonts,
		fontLibrary,
		remotion,
		exports: exportsSvc,
		capabilities,
		cache,
		origin,
		registerCapabilityProvider: (fn) => capabilities.register(fn),
		registerNativeExtension: (ext) => exportsSvc.registerNativeExtension(ext),
		registerMgMasterProvider: (fn) => {
			exportsSvc.registerMgMasterProvider(fn);
			capabilities.changed();
		},
		start() {
			if (started) return;
			started = true;
			queue.start();
			uploads.start();
			void exportsSvc.sweepRequests().catch(() => {});
			void cache.start().catch((e) => opts.log?.(`[cache] start failed: ${(e as Error).message}`));
		},
		async stop() {
			uploads.stop();
			await queue.shutdown();
			await cache.stop();
		},
	};
}

/** Typed access to the core services from any route plugin. */
export function coreServices(app: FastifyInstance): CoreServices {
	const s = app.jasper.services.core as CoreServices | undefined;
	if (!s) throw new Error('Engine core services are not initialized');
	return s;
}
