// color-grade: grading analysis routes (grading/service.ts):
//   POST /api/grading/scopes     Lumetri Scopes of a rendered frame as numbers (`scopes_read`)
//   POST /api/grading/match      Colour Match of a clip to a reference frame → Lumetri params
//   POST /api/grading/auto-tone  Basic Correction ▸ Auto of a clip → Lumetri params
import { AutoToneRequestSchema, ColorMatchRequestSchema, GradingScopesRequestSchema } from '@jasper/api';
import type { FastifyInstance } from 'fastify';
import { GradingService } from '../grading/service.ts';
import type { RotoService } from '../roto/service.ts';
import { guarded, parseOr400 } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';

export default async function gradingRoutes(app: FastifyInstance): Promise<void> {
	const core = coreServices(app);
	const svc = new GradingService(core, () => app.jasper.services.roto as RotoService | undefined);
	app.jasper.services.grading = svc;
	app.post(
		'/api/grading/scopes',
		guarded(async (req) => svc.scopes(parseOr400(GradingScopesRequestSchema, req.body))),
	);
	app.post(
		'/api/grading/match',
		guarded(async (req) => svc.match(parseOr400(ColorMatchRequestSchema, req.body))),
	);
	app.post(
		'/api/grading/auto-tone',
		guarded(async (req) => svc.autoTone(parseOr400(AutoToneRequestSchema, req.body))),
	);
}
