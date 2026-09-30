// Helper for route plugins that are not implemented yet: registers every route of the @jasper/api
// table under its path and answers 501 `{code: 'NOT_IMPLEMENTED'}` (S04:ENG-022 shape).
import { errorBody, ROUTES, type RouteName } from '@jasper/api';
import type { FastifyInstance } from 'fastify';

export function registerStubRoutes(app: FastifyInstance, names: readonly RouteName[]): void {
	for (const name of names) {
		const route = ROUTES[name];
		app.route({
			method: route.method,
			url: route.path,
			handler: async (_req, reply) =>
				reply
					.code(501)
					.send(
						errorBody(
							'NOT_IMPLEMENTED',
							`${route.method} ${route.path} is not implemented yet (${route.owner})`,
							{ route: name, owner: route.owner },
						),
					),
		});
	}
}
