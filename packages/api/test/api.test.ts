import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	makeEnvelope,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import {
	AgentTxRequestSchema,
	API_VERSION,
	buildPath,
	ENGINE_EVENT_TYPES,
	EngineCapabilitiesSchema,
	EngineJobSchema,
	ExportPlanRequestSchema,
	errorBody,
	isEnginePath,
	ProjectGetResponseSchema,
	parseEvent,
	ROUTES,
	TransactionResultSchema,
} from '../src/index.ts';

describe('@jasper/api route table', () => {
	it('covers every M1 route of ARCHITECTURE §9.2', () => {
		const have = new Set(Object.values(ROUTES).map((r) => `${r.method} ${r.path}`));
		const expected = [
			'GET /health',
			'GET /api/capabilities',
			'GET /events',
			'GET /api/projects',
			'POST /api/projects',
			'GET /api/projects/:projectId',
			'PUT /api/projects/:projectId',
			'PUT /api/projects/:projectId/view',
			'GET /api/projects/:projectId/versions',
			'DELETE /api/projects/:projectId',
			'POST /api/projects/:projectId/lease',
			'POST /api/projects/:projectId/lease/:leaseId/heartbeat',
			'DELETE /api/projects/:projectId/lease/:leaseId',
			'POST /api/media/register',
			'POST /api/uploads',
			'PUT /api/uploads/:uploadId',
			'POST /api/uploads/:uploadId/complete',
			'DELETE /api/uploads/:uploadId',
			'GET /api/media/:mediaKey',
			'POST /api/media/:mediaKey/derivatives',
			'GET /media/:mediaKey',
			'GET /media/:mediaKey/proxy/:tier',
			'GET /media/:mediaKey/poster.jpg',
			'GET /media/:mediaKey/sprite.json',
			'GET /media/:mediaKey/sprite/:sheet',
			'GET /media/:mediaKey/peaks.json',
			'GET /media/:mediaKey/peaks/:stream',
			'GET /api/jobs',
			'GET /api/jobs/:jobId',
			'POST /api/jobs/:jobId/cancel',
			'POST /api/jobs/:jobId/retry',
			'POST /api/exports/plan',
			'POST /api/exports',
			'GET /renders/:jobId/output',
			'POST /api/stills',
			'GET /api/fonts',
			'GET /fonts/*',
			'GET /api/motion-graphics/templates',
			'POST /api/motion-graphics/render',
			'GET /mg/:key/:file',
			'GET /api/agent/schema',
			'POST /api/agent/query',
			'POST /api/agent/tx',
			'GET /agent',
		];
		for (const e of expected) expect(have, e).toContain(e);
		expect(API_VERSION).toBe(1);
	});
	it('builds paths and classifies engine prefixes', () => {
		expect(buildPath(ROUTES.leaseHeartbeat.path, { projectId: 'prj_1', leaseId: 'l 1' })).toBe(
			'/api/projects/prj_1/lease/l%201/heartbeat',
		);
		expect(() => buildPath(ROUTES.projectGet.path)).toThrow();
		expect(isEnginePath('/api/projects')).toBe(true);
		expect(isEnginePath('/media/mk_1/poster.jpg')).toBe(true);
		expect(isEnginePath('/health')).toBe(true);
		expect(isEnginePath('/project/prj_1')).toBe(false);
		expect(isEnginePath('/apis')).toBe(false);
	});
	it('shapes errors per S04:ENG-022', () => {
		expect(errorBody('NOT_IMPLEMENTED', 'later')).toEqual({
			code: 'NOT_IMPLEMENTED',
			message: 'later',
			retryable: false,
		});
		expect(errorBody('DISK_FULL', 'x', { free: 0 }).retryable).toBe(true);
	});
});

describe('@jasper/api schemas', () => {
	it('parses events and ignores unknown types', () => {
		expect(ENGINE_EVENT_TYPES).toContain('derivative.ready');
		const e = parseEvent({
			id: 3,
			type: 'derivative.ready',
			createdAt: 'now',
			payload: { mediaKey: 'mk_12345678', kind: 'poster', url: '/media/mk_12345678/poster.jpg' },
		});
		expect(e?.type).toBe('derivative.ready');
		expect(parseEvent({ id: 4, type: 'future.thing', createdAt: 'now', payload: {} })).toBeNull();
		expect(parseEvent({ id: 'x' })).toBeNull();
	});
	it('validates jobs and capabilities', () => {
		const job = {
			id: 'job_1',
			kind: 'export',
			title: 'Export',
			origin: { type: 'user' },
			state: 'queued',
			progress: null,
			createdAt: 't',
			priority: 'user',
			cpuSlots: 6,
		};
		expect(EngineJobSchema.parse(job).kind).toBe('export');
		expect(EngineJobSchema.safeParse({ ...job, state: 'weird' }).success).toBe(false);
		const caps = {
			engine: { version: '0.1.0', apiVersion: 1, mode: 'dev', pathRegistration: true },
			media: { ffmpegVersion: '6.1.1', ffprobeVersion: '6.1.1', encoders: ['libx264'], filters: ['overlay'] },
			render: {
				native: true,
				remotionLocal: 'needs-browser-download',
				fframes: 'unavailable',
				fframesReason: 'no binary',
			},
			fonts: { bundledCatalog: true, systemFonts: false, customUpload: false },
			limits: { maxUploadBytes: null, freeDiskBytes: 1, cpuCount: 12, maxJsonBodyBytes: 20_971_520 },
		};
		expect(EngineCapabilitiesSchema.parse(caps).render.fframes).toBe('unavailable');
	});
	it('round-trips a real envelope, export request and transaction result', () => {
		const ids = createCounterIdSource(1);
		const doc = createEmptyProject({ ids, name: 'A' });
		const env = makeEnvelope(doc, { revision: 3, savedAt: 't', platform: 'web' });
		const seqId = Object.keys(doc.sequences)[0]!;
		expect(ProjectGetResponseSchema.parse({ envelope: env, view: null, revision: 3 }).revision).toBe(3);
		const plan = ExportPlanRequestSchema.parse({
			envelope: env,
			sequenceId: seqId,
			settings: {
				sequenceId: seqId,
				range: { type: 'entire' },
				container: 'mp4',
				video: {
					codec: 'h264',
					width: 1920,
					height: 1080,
					frameRate: { num: 30, den: 1 },
					quality: { mode: 'crf', value: 18 },
					encoderSpeed: 'balanced',
				},
				audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
				engine: 'auto',
			},
		});
		expect(plan.settings.destination).toEqual({ type: 'download' });
		const tx = {
			label: 'Rename',
			origin: { agent: 'bot' },
			commands: [{ type: 'project.rename', name: 'B' }],
		};
		expect(AgentTxRequestSchema.parse({ projectId: doc.projectId, transaction: tx }).transaction.label).toBe(
			'Rename',
		);
		const { result } = applyTransaction(doc, tx, {
			ids,
			now: () => 't',
			revision: 3,
			registries: defaultRegistries(),
		});
		expect(TransactionResultSchema.parse(result).ok).toBe(true);
	});
});
