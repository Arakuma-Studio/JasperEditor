import type { FastifyInstance } from 'fastify';
import agentRoutes from './agent.ts';
import animeRoutes from './anime.ts';
import audioRoutes from './audio.ts';
import audioFxRoutes from './audio-fx.ts';
import browseRoutes from './browse.ts';
import cacheRoutes from './cache.ts';
import camtrackRoutes from './camtrack.ts';
import capabilitiesRoutes from './capabilities.ts';
import captionRoutes from './captions.ts';
import colorRoutes from './color.ts';
import effectPresetRoutes from './effect-presets.ts';
import eventsRoutes from './events.ts';
import exportsRoutes from './exports.ts';
import fontsRoutes from './fonts.ts';
import gapsRoutes from './gaps.ts';
import gradingRoutes from './grading.ts';
import importsRoutes from './imports.ts';
import interchangeRoutes from './interchange.ts';
import jobsRoutes from './jobs.ts';
import layerBakeRoutes from './layer-bake.ts';
import maskRoutes from './masks.ts';
import mcpRoutes from './mcp.ts';
import mediaRoutes from './media.ts';
import mgRoutes from './mg.ts';
import mgBundleRoutes from './mg-bundles.ts';
import previewsRoutes from './previews.ts';
import processingRoutes from './processing.ts';
import projectsRoutes from './projects.ts';
import proposalRoutes from './proposals.ts';
import rotoRoutes from './roto.ts';
import soundDesignRoutes from './sound-design.ts';
import soundRoutes from './sounds.ts';
import speechRoutes from './speech.ts';
import stillsRoutes from './stills.ts';
import syncRoutes from './sync.ts';
import timeRoutes from './time.ts';
import trackingRoutes from './tracking.ts';
import uploadsRoutes from './uploads.ts';
import voiceRoutes from './voice.ts';
import cleanupRoutes from './cleanup.ts';

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
	// The agent relay supplies references to open projects for cache protection.
	cacheRoutes,
	effectPresetRoutes,
	colorRoutes,
	processingRoutes,
	mgBundleRoutes,
	// Imports prepare pictures before layer baking consumes them.
	importsRoutes,
	// Retime sources feed layer baking and tracking in extension order.
	timeRoutes,
	layerBakeRoutes,
	trackingRoutes,
	animeRoutes,
	syncRoutes,
	maskRoutes,
	audioRoutes,
	audioFxRoutes,
	captionRoutes,
	// Speech and roto require the processing model catalogue.
	speechRoutes,
	// Spec 14 TC-001: voice analysis (levels, voicing, frame classes) of media audio streams.
	voiceRoutes,
	// Spec 14: transcript cleanup analysis (needs voice analysis and the agent service) and the cleanup presets.
	cleanupRoutes,
	rotoRoutes,
	camtrackRoutes,
	interchangeRoutes,
	// Grading uses the roto face model.
	gradingRoutes,
	previewsRoutes,
	gapsRoutes,
	browseRoutes,
	// The sound library registers sounds through the media service.
	soundRoutes,
	// Cue suggestions read the live document through the agent service.
	soundDesignRoutes,
	// Proposals validate against and apply to the live document through the agent service.
	proposalRoutes,
] as const;

export async function registerRoutes(app: FastifyInstance): Promise<void> {
	// Plugins are registered without encapsulation-breaking wrappers so they share app.jasper.
	for (const plugin of ROUTE_PLUGINS) await plugin(app);
}
