// Media cache (M3, S04 §7.5 CA-013/CA-014/CA-019). Owner: wp-m3-cachegc.
//   GET  /api/cache            → usage per kind (in use / referenced / unused), budgets, last cleaning
//   POST /api/cache/clean      → {mode: auto | unused | all, kinds?} → the pass report (answers when done)
//   GET/PUT /api/cache/settings → budgets, age limit, automatic cleaning (`<appdir>/engine/cache.json`)
// The registry itself is a core service (`core.cache`, created with the queue and the project store).
import {
	CacheCleanRequestSchema,
	CacheLocationRequestSchema,
	CacheMoveRequestSchema,
	CacheSettingsSchema,
} from '@jasper/api';
import type { FastifyInstance } from 'fastify';
import type { AgentService } from '../agent/service.ts';
import { CacheLocationError } from '../cache/service.ts';
import { isLoopbackHost } from '../context.ts';
import type { MgService } from '../mg/index.ts';
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
	// …and their editors answer with the live document (refs of media imported but not saved yet).
	const offLive = agent
		? core.cache.addLiveDocumentSource(async (pid) => {
				const conn = agent.sessions.holder(pid) ?? agent.sessions.connectionsFor(pid).at(-1);
				if (!conn) return null;
				const out = await agent.sessions.request(conn, 'query', { query: 'doc.get', args: {} }, 3000);
				if (out.error) return null;
				return ((out.result ?? {}) as { result?: unknown }).result ?? null;
			})
		: null;
	app.addHook('onClose', async () => {
		offProbe?.();
		offLive?.();
	});
	// fframes motion-graphic renders (`mg/<key>`) that saved projects use are referenced like composition renders.
	const mg = app.jasper.services.mg as MgService | undefined;
	if (mg) core.cache.setFframesRenderKey((clip, fps) => mg.clipRenderKey(clip, fps));

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

	// CA-021: moving the cache writes to arbitrary folders — a local/desktop feature, like path registration.
	const localMode = core.config.dev || isLoopbackHost(core.config.host);
	const local = () => {
		if (!localMode)
			throw new HttpError(403, 'LOCAL_MODE_ONLY', 'The cache location can only be changed in local mode');
	};

	app.post(
		'/api/cache/location/check',
		guarded(async (req) => {
			local();
			const body = parseOr400(CacheLocationRequestSchema, req.body ?? {});
			return cache().checkLocation(body.path);
		}),
	);

	app.post(
		'/api/cache/location',
		guarded(async (req, reply) => {
			local();
			const body = parseOr400(CacheMoveRequestSchema, req.body ?? {});
			try {
				return reply.code(202).send(await cache().startMove(body));
			} catch (e) {
				if (e instanceof CacheLocationError)
					throw new HttpError(422, 'CACHE_LOCATION_INVALID', e.message, { check: e.check });
				throw e;
			}
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
