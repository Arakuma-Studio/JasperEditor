// A test-only anime template for Program-monitor text editing (WP7b canvas-edit): a multi-line word-marks `text`
// (like social-comment's) and a single-line `name`. Not in the catalogue; the tests add it to the registry.
import type { MgAnimeTemplateDefinition } from '@jasper/mg-templates';
import { z } from 'zod';

export const canvasEditParams = z.strictObject({
	name: z.string().min(1).max(24).default('username'),
	text: z.string().max(200).default('Hello ==big== world'),
	likes: z.number().int().min(0).default(3),
});

export const CANVAS_EDIT_TEMPLATE: MgAnimeTemplateDefinition<z.output<typeof canvasEditParams>> = {
	id: 'canvas-edit-test',
	version: 1,
	name: 'Canvas edit test',
	category: 'Test',
	renderer: 'anime',
	renderVersion: 1,
	paramsSchema: canvasEditParams,
	defaults: canvasEditParams.parse({}),
	introFrames: 15,
	outroFrames: 6,
	defaultDurationSeconds: 3,
	canvases: [{ width: 1920, height: 1080 }],
	ui: { params: { text: { multiline: true } } },
};
