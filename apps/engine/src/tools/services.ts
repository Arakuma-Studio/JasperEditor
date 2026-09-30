// Engine core services (WP-2F) and their wiring. Route plugins (including WP-2G `mg` and WP-2H `agent`)
// reach them through `coreServices(app)`; the hooks for other packages are `registerCapabilityProvider`,
// `registerMgMasterProvider` and `queue.registerRunner`.
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { UrlSigner } from '../auth/signed-url.ts';
import type { EngineConfig } from '../context.ts';
import { DerivativeService } from '../derivatives/service.ts';
import { Broadcaster } from '../events/broadcaster.ts';
import type { PlanCapabilities } from '../export/planner.ts';
import { ExportService, type MgMasterProvider } from '../export/service.ts';
import { FontCatalogService } from '../fonts/catalog.ts';
import { JobQueue } from '../jobs/queue.ts';
import { MediaRegistry } from '../media/registry.ts';
import { MediaService } from '../media/service.ts';
import { LeaseManager } from '../projects/leases.ts';
import { ProjectStoreFs } from '../projects/store.ts';
import { RemotionService } from '../remotion/service.ts';
import { UploadService } from '../uploads/service.ts';
import { type CapabilityProvider, CapabilityService } from './capabilities.ts';
import { EncoderService } from './encoders.ts';
import { Ffmpeg, resolveBinaries, selfCheck } from './ffmpeg.ts';

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
	fonts: FontCatalogService;
	remotion: RemotionService;
	exports: ExportService;
	capabilities: CapabilityService;
	/** Absolute engine origin (`http://127.0.0.1:<port>`) for signed URLs handed to headless renderers. */
	origin(): string;
	/** WP-2G: contribute to `GET /api/capabilities` (e.g. `render.fframes`). */
	registerCapabilityProvider(fn: CapabilityProvider): () => void;
	/** WP-2G: motion-graphic masters for native exports. */
	registerMgMasterProvider(fn: MgMasterProvider | null): void;
	/** Starts the queue (journal recovery) and timers; called from the server's onReady hook. */
	start(): void;
	/** Graceful stop (S04:ENG-004): running jobs become `interrupted`, the journal is flushed. */
	stop(): Promise<void>;
};

export type CoreServiceOptions = {
	jsonBodyLimit: number;
	env?: Record<string, string | undefined>;
	/** Packaged resources folder (ffmpeg under `<dir>/bin`). */
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
	const bins = resolveBinaries({ env, resourcesDir: opts.resourcesDir ?? env.JASPER_RESOURCES_DIR ?? null });
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
	const uploads = new UploadService({ dir: join(paths.mediaDir, '.uploads'), media });
	const leases = new LeaseManager();
	const projects = new ProjectStoreFs({ paths, leases, appVersion: config.version });
	const fonts = new FontCatalogService(env);
	const remotion = new RemotionService({
		bundleCacheDir: paths.remotionBundleDir,
		usageLog: join(paths.logsDir, 'remotion-usage.jsonl'),
		env,
		log: opts.log,
	});
	const capabilities = new CapabilityService({
		config,
		selfCheck: check,
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
		localMode: config.dev || ['127.0.0.1', 'localhost', '::1'].includes(config.host.toLowerCase()),
		capabilities: async (): Promise<PlanCapabilities> => {
			const caps = await capabilities.get();
			return {
				native: caps.render.native,
				remotionLocal: caps.render.remotionLocal,
				fframes: caps.render.fframes,
				mgMasters: exportsSvc.hasMgMasterProvider,
			};
		},
	});
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
		fonts,
		remotion,
		exports: exportsSvc,
		capabilities,
		origin,
		registerCapabilityProvider: (fn) => capabilities.register(fn),
		registerMgMasterProvider: (fn) => {
			exportsSvc.registerMgMasterProvider(fn);
			capabilities.changed();
		},
		start() {
			if (started) return;
			started = true;
			queue.start();
			uploads.start();
		},
		async stop() {
			uploads.stop();
			await queue.shutdown();
		},
	};
}

/** Typed access to the core services from any route plugin. */
export function coreServices(app: FastifyInstance): CoreServices {
	const s = app.jasper.services.core as CoreServices | undefined;
	if (!s) throw new Error('Engine core services are not initialized');
	return s;
}
