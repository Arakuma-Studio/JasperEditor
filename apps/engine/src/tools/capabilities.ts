// `GET /api/capabilities` (S04:RT-002, ARCHITECTURE §9.2).
import { availableParallelism } from 'node:os';
import type { EngineCapabilities } from '@jasper/api';
import { API_VERSION } from '@jasper/api';
import type { EngineConfig } from '../context.ts';
import type { Broadcaster } from '../events/broadcaster.ts';
import type { FontCatalogService } from '../fonts/catalog.ts';
import type { RemotionService } from '../remotion/service.ts';
import type { EncoderService } from './encoders.ts';
import type { FfmpegSource, SelfCheck } from './ffmpeg.ts';
import { freeDiskBytes } from './fs.ts';

type DeepPartial<T> = {
	[K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K];
};
type CapabilityPatch = DeepPartial<EngineCapabilities>;
/** Returns a patch merged over the base capabilities (or mutates nothing and returns void). */
export type CapabilityProvider = (
	base: EngineCapabilities,
) => CapabilityPatch | undefined | Promise<CapabilityPatch | undefined>;

function merge<T>(base: T, patch: unknown): T {
	if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return (patch as T) ?? base;
	const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
		if (v === undefined) continue;
		const b = out[k];
		out[k] =
			b && typeof b === 'object' && !Array.isArray(b) && v && typeof v === 'object' && !Array.isArray(v)
				? merge(b, v)
				: v;
	}
	return out as T;
}

function remotionBinaries(r: RemotionService): EngineCapabilities['render']['remotionBinaries'] {
	const b = r.binaries;
	return {
		source: b.source,
		lgpl: b.lgpl,
		license: b.license,
		ffmpegVersion: b.ffmpegVersion,
		...(b.message ? { message: b.message } : {}),
	};
}

function remotionGraphics(r: RemotionService): EngineCapabilities['render']['remotionGraphics'] {
	const s = r.webglStatus;
	return {
		webgl: s.state,
		gl: s.gl,
		...(s.renderer ? { renderer: s.renderer } : {}),
		...(s.hardware !== undefined ? { hardware: s.hardware } : {}),
		...(s.message ? { message: s.message } : {}),
	};
}

export class CapabilityService {
	private readonly providers = new Set<CapabilityProvider>();

	constructor(
		private readonly deps: {
			config: EngineConfig;
			selfCheck: SelfCheck;
			/** D-13 resolution result of the engine's ffmpeg. */
			ffmpegSource: FfmpegSource;
			encoders: EncoderService;
			remotion: RemotionService;
			fonts: FontCatalogService;
			broadcaster: Broadcaster;
			jsonBodyLimit: number;
		},
	) {}

	/** Registers a provider; returns an unregister function. Emits `capabilities.changed`. */
	register(fn: CapabilityProvider): () => void {
		this.providers.add(fn);
		this.changed();
		return () => {
			this.providers.delete(fn);
			this.changed();
		};
	}

	/** Tell clients to re-fetch (S04:RT-004). */
	changed(): void {
		this.deps.broadcaster.publish('capabilities.changed', {});
	}

	private base(): EngineCapabilities {
		const sc = this.deps.selfCheck;
		const { config } = this.deps;
		const encoding = this.deps.encoders.capabilities();
		return {
			engine: {
				version: config.version,
				apiVersion: API_VERSION,
				mode: config.dev ? 'dev' : 'local',
				// M1 binds loopback only: path registration is a local-mode feature (S04:SC-002).
				pathRegistration: true,
			},
			media: {
				ffmpegVersion: sc.ffmpegVersion,
				ffprobeVersion: sc.ffprobeVersion,
				encoders: sc.encoders,
				filters: sc.filters,
				encoding,
				ffmpegSource: this.deps.ffmpegSource,
			},
			render: {
				// The self-check found the filters + AAC; the selector must also find a usable video encoder.
				native: sc.nativeRender && encoding.export !== null,
				remotionLocal: this.deps.remotion.state(),
				remotionBinaries: remotionBinaries(this.deps.remotion),
				remotionGraphics: remotionGraphics(this.deps.remotion),
				fframes: 'unavailable',
				fframesReason: 'The jasper-mg renderer is not registered',
			},
			fonts: {
				bundledCatalog: this.deps.fonts.available,
				systemFonts: false,
				customUpload: this.deps.fonts.libraryAvailable,
			},
			limits: {
				maxUploadBytes: null,
				freeDiskBytes: null,
				cpuCount: availableParallelism(),
				maxJsonBodyBytes: this.deps.jsonBodyLimit,
			},
		};
	}

	async get(): Promise<EngineCapabilities> {
		let caps = this.base();
		caps.limits.freeDiskBytes = await freeDiskBytes(this.deps.config.appdir);
		for (const p of this.providers) {
			try {
				const patch = await p(caps);
				if (patch) caps = merge(caps, patch);
			} catch {
				// a failing provider never breaks the route
			}
		}
		// A provider that reports fframes ready cannot unset the base "not registered" reason through
		// a merge patch (undefined values are skipped), so drop the stale reason here.
		if (caps.render.fframes === 'ready') delete caps.render.fframesReason;
		return caps;
	}
}
