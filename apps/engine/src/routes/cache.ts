// Media cache (M3, S04 §7.5 CA-013/CA-014/CA-019). Owner: wp-m3-cachegc.
//   GET  /api/cache            → usage per kind (in use / referenced / unused), budgets, last cleaning
//   POST /api/cache/clean      → {mode: auto | unused | all, kinds?} → the pass report (answers when done)
//   GET/PUT /api/cache/settings → budgets, age limit, automatic cleaning (`<appdir>/engine/cache.json`)
// The registry itself is a core service (`core.cache`, created with the queue and the project store).
import { CacheCleanRequestSchema, CacheSettingsSchema } from '@jasper/api';
import type { FastifyInstance } from 'fastify';
import type { AgentService } from '../agent/service.ts';
import { guarded, HttpError, parseOr400 } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';

export default async function cacheRoutes(app: FastifyInstance): Promise<void> {
	const core = coreServices(app);
	const cache = () => {
		if (!core.cache) throw new HttpError(503, 'CACHE_UNAVAILABLE', 'The cache registry is not running');
		return core.cache;
	};

	// Every editor window (read-only ones too) keeps an agent relay connection for its project: such projects are
	// open even when another session holds the lease (CA-014: never clean what an open project needs).
	const agent = app.jasper.services.agent as AgentService | undefined;
	const offProbe = agent
		? core.cache.addOpenProbe((pid) => agent.sessions.connectionsFor(pid).length > 0)
		: null;
	app.addHook('onClose', async () => offProbe?.());

	app.get(
		'/api/cache',
		guarded(async () => cache().usage()),
	);

	app.post(
		'/api/cache/clean',
		guarded(async (req) => {
			const body = parseOr400(CacheCleanRequestSchema, req.body ?? {});
			return cache().clean(body.mode, body.kinds);
		}),
	);

	app.get(
		'/api/cache/settings',
		guarded(async () => cache().settings()),
	);

	app.put(
		'/api/cache/settings',
		guarded(async (req) => cache().putSettings(parseOr400(CacheSettingsSchema, req.body ?? {}))),
	);
}
