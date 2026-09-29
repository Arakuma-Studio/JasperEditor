// GET /health and GET /api/capabilities (ARCHITECTURE §9.2, S04:RT-002 subset).
import { z } from 'zod';

export const HealthSchema = z.object({
	ok: z.literal(true),
	version: z.string(),
	apiVersion: z.number().int(),
});
export type Health = z.infer<typeof HealthSchema>;

export const EngineCapabilitiesSchema = z.object({
	engine: z.object({
		version: z.string(),
		apiVersion: z.number().int(),
		mode: z.enum(['local', 'remote', 'dev']),
		/** Registering engine-side file paths is allowed (desktop/dev only, S04:SC-002). */
		pathRegistration: z.boolean(),
	}),
	media: z.object({
		ffmpegVersion: z.string().nullable(),
		ffprobeVersion: z.string().nullable(),
		encoders: z.array(z.string()),
		filters: z.array(z.string()),
	}),
	render: z.object({
		native: z.boolean(),
		remotionLocal: z.enum(['ready', 'needs-browser-download', 'unavailable']),
		fframes: z.enum(['ready', 'unavailable']),
		fframesReason: z.string().optional(),
	}),
	fonts: z.object({ bundledCatalog: z.boolean(), systemFonts: z.boolean(), customUpload: z.boolean() }),
	limits: z.object({
		maxUploadBytes: z.number().nullable(),
		freeDiskBytes: z.number().nullable(),
		cpuCount: z.number().int(),
		maxJsonBodyBytes: z.number().int(),
	}),
});
export type EngineCapabilities = z.infer<typeof EngineCapabilitiesSchema>;
