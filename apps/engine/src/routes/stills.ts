import { StillRequestSchema, StillSheetRequestSchema } from '@jasper/api';
import type { FastifyInstance } from 'fastify';
import { guarded, parseOr400 } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';

export default async function stillsRoutes(app: FastifyInstance): Promise<void> {
	const { exports } = coreServices(app);
	app.post(
		'/api/stills',
		guarded(async (req, reply) => {
			const body = parseOr400(StillRequestSchema, req.body);
			return reply.code(202).send(await exports.still(body));
		}),
	);
	// spec 19 TL-103: several stills as one job.
	app.post(
		'/api/stills/sheet',
		guarded(async (req, reply) => {
			const body = parseOr400(StillSheetRequestSchema, req.body);
			return reply.code(202).send(await exports.stillSheet(body));
		}),
	);
}
