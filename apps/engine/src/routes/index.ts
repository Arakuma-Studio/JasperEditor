// Registers one plugin per area (ARCHITECTURE §9.1).
import type { FastifyInstance } from 'fastify';
import agentRoutes from './agent.ts';
import animeRoutes from './anime.ts';
import audioRoutes from './audio.ts';
import cacheRoutes from './cache.ts';
import capabilitiesRoutes from './capabilities.ts';
import captionRoutes from './captions.ts';
import colorRoutes from './color.ts';
import effectPresetRoutes from './effect-presets.ts';
import eventsRoutes from './events.ts';
import exportsRoutes from './exports.ts';
import fontsRoutes from './fonts.ts';
import jobsRoutes from './jobs.ts';
import layerBakeRoutes from './layer-bake.ts';
import maskRoutes from './masks.ts';
import mcpRoutes from './mcp.ts';
import mediaRoutes from './media.ts';
import mgRoutes from './mg.ts';
import mgBundleRoutes from './mg-bundles.ts';
import processingRoutes from './processing.ts';
import projectsRoutes from './projects.ts';
import speechRoutes from './speech.ts';
import stillsRoutes from './stills.ts';
import syncRoutes from './sync.ts';
import trackingRoutes from './tracking.ts';
import uploadsRoutes from './uploads.ts';

const ROUTE_PLUGINS = [
	capabilitiesRoutes,
	eventsRoutes,
	projectsRoutes,
	mediaRoutes,
	uploadsRoutes,
	jobsRoutes,
	exportsRoutes,
	stillsRoutes,
	fontsRoutes,
	mgRoutes,
	agentRoutes,
	mcpRoutes,
	// M3 (wp-m3-cachegc): Media Cache routes over the core cache registry (after agent: its relay marks open projects).
	cacheRoutes,
	// M3 (wp-m3-presets, S03:FX-030): the user effect preset library.
	effectPresetRoutes,
	// M2 (ARCHITECTURE §19.8): one plugin per work package.
	colorRoutes,
	processingRoutes,
	mgBundleRoutes,
	// M2 animation (ARCHITECTURE §20.5): layer-bake's extension sits between mg-bundles and tracking (warp).
	layerBakeRoutes,
	trackingRoutes,
	animeRoutes,
	// wp-multicam: audio sync for Synchronize / Merge Clips / multi-camera.
	syncRoutes,
	// wp masks: auto-trace (mask tracking runs as `track` jobs of kind `mask`).
	maskRoutes,
	// audio-mix: audio analysis (loudness, peaks, ducking activity) and loudness-normalised media versions.
	audioRoutes,
	// wp captions: caption / transcript files by path.
	captionRoutes,
	// wp speech: Whisper transcription (after processing: the model catalogue and its installer).
	speechRoutes,
] as const;

export async function registerRoutes(app: FastifyInstance): Promise<void> {
	// Plugins are registered without encapsulation-breaking wrappers so they share app.jasper.
	for (const plugin of ROUTE_PLUGINS) await plugin(app);
}
