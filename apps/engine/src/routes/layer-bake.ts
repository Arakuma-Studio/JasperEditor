// Layer bake (M2, S11 §6, ARCHITECTURE §20.5). Owner: wp-m2-layer-bake.
//   POST /api/layer-bake/preview   graded VP9-alpha preview of one DOM layer (S11:LBK-010) → 202 EngineJob
// The package also registers here the `layer-bake` native extension (text, shapes and anime templates exported
// through cached alpha masters), the `layer-bake` job runner and the `features.layerBake` capability block.
// Registered after `mg-bundles` and before `tracking` (extension order, ARCHITECTURE §19.6).
// Contracts: the route answers 501 NOT_IMPLEMENTED naming its owner.
import { errorBody, ROUTES } from '@jasper/api';
import type { FastifyInstance } from 'fastify';

export default async function layerBakeRoutes(app: FastifyInstance): Promise<void> {
	const route = ROUTES.layerBakePreview;
	app.post(route.path, async (_req, reply) =>
		reply.code(501).send(
			errorBody('NOT_IMPLEMENTED', `${route.method} ${route.path} is not implemented yet (${route.owner})`, {
				route: 'layerBakePreview',
				owner: route.owner,
			}),
		),
	);
}
