// A test-only anime template for the Program-monitor edit hold (WP7b canvas-edit): 15 intro and 6 outro frames, its
// implementation (packages/compositions/test/fixtures/hold-test-impl.tsx) prints the seek time. Not in the catalogue.
import { z } from 'zod';
import type { MgAnimeTemplateDefinition } from '../../src/types.ts';

export const holdTestParams = z.strictObject({ text: z.string().default('hi') });

export const HOLD_TEST_TEMPLATE: MgAnimeTemplateDefinition<z.output<typeof holdTestParams>> = {
	id: 'hold-test',
	version: 1,
	name: 'Hold test',
	category: 'Test',
	renderer: 'anime',
	renderVersion: 1,
	paramsSchema: holdTestParams,
	defaults: holdTestParams.parse({}),
	introFrames: 15,
	outroFrames: 6,
	defaultDurationSeconds: 3,
	canvases: [{ width: 1920, height: 1080 }],
};
