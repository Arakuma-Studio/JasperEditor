import type { RegisteredMedia } from '@jasper/api';
import { DEFAULT_ENGINE_PORT } from '@jasper/config';
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type IdSource,
	makeEnvelope,
	type ProjectDocument,
} from '@jasper/project';
import type { FastifyInstance } from 'fastify';
import { createServer, engineConfig } from '../src/index.ts';
import { coreServices } from '../src/tools/services.ts';
import { tempAppdir } from './temp.ts';

export { ensureFixtures, FIXTURES, fixture, ROOT, TEST_FFMPEG, TEST_FFPROBE } from './fixtures.ts';
export { tempAppdir } from './temp.ts';

/**
 * The port test engines are configured with (`makeApp`; inject-only engines never listen). Port 1 has no server:
 * binding it needs root and Chrome refuses it as an unsafe port, so a URL a test engine signs for a headless renderer
 * or a child process (`origin()`) can never reach a real engine — the default dev port (47900) is the user's live
 * engine on their machine. Tests that need a reachable engine use `startEngine({ port: 0 })` (the actual port).
 */
export const TEST_PORT = 1;
/** `127.0.0.1:<TEST_PORT>`: the Host header a test engine accepts. */
export const TEST_HOST = `127.0.0.1:${TEST_PORT}`;
/** The editor's session cookies (their port-scoped names) for a test engine with `token` and `editorKey`. */
export const editorCookie = (token: string, key: string): string =>
	`jasper_session_${TEST_PORT}=${token}; jasper_editor_${TEST_PORT}=${key}`;
export const H = { host: TEST_HOST } as const;
export const JSON_H = { ...H, 'content-type': 'application/json' } as const;

export type TestApp = FastifyInstance & { appdir: string };

const opened: FastifyInstance[] = [];

/** A dev-mode engine on a temp appdir, ready (queue started). Close with `closeApps()`. */
export async function makeApp(
	opts: {
		appdir?: string;
		token?: string | null;
		/** Editor attestation (security review AGT-2); null/omitted: every authenticated client is the editor. */
		editorKey?: string | null;
		dev?: boolean;
		totalSlots?: number;
		env?: Record<string, string>;
	} = {},
): Promise<TestApp> {
	const appdir = opts.appdir ?? tempAppdir();
	const { prepareAppdir } = await import('../src/index.ts');
	prepareAppdir(appdir);
	const config = engineConfig({
		appdir,
		port: TEST_PORT,
		dev: opts.dev ?? true,
		token: opts.token ?? null,
		editorKey: opts.editorKey ?? null,
		webDir: null,
		env: {},
	});
	const app = await createServer(config, {
		env: { PATH: process.env.PATH, ...(opts.env ?? {}) },
		totalSlots: opts.totalSlots,
	});
	await app.ready();
	opened.push(app);
	assertNotDevPort(coreServices(app).origin());
	return Object.assign(app, { appdir });
}

/**
 * Fails when a test engine would sign URLs on the default dev port: a headless renderer or a child process handed such
 * a URL reaches whatever runs there (the user's live engine).
 */
function assertNotDevPort(origin: string): void {
	if (new URL(origin).port === String(DEFAULT_ENGINE_PORT))
		throw new Error(
			`test engine origin ${origin} is the default dev port; use TEST_PORT or startEngine({ port: 0 })`,
		);
}

export async function closeApps(): Promise<void> {
	for (const a of opened.splice(0)) await a.close();
}

export async function register(
	app: FastifyInstance,
	path: string,
	extraHeaders: Record<string, string> = {},
): Promise<RegisteredMedia> {
	const r = await app.inject({
		method: 'POST',
		url: '/api/media/register',
		headers: { ...JSON_H, ...extraHeaders },
		payload: { projectId: 'prj_0000000000000001', paths: [path] },
	});
	if (r.statusCode !== 200) throw new Error(`register failed: ${r.body}`);
	const body = r.json() as { items: RegisteredMedia[]; errors: unknown[] };
	if (body.items.length !== 1) throw new Error(`register failed: ${r.body}`);
	return body.items[0]!;
}

export class DocBuilder {
	doc: ProjectDocument;
	readonly ids: IdSource;
	revision = 0;
	constructor(preset = 'hd-1080p-30', seed = 11) {
		this.ids = createCounterIdSource(seed);
		this.doc = createEmptyProject({ ids: this.ids, name: 'Engine test', preset });
	}
	get seqId(): string {
		return Object.keys(this.doc.sequences)[0]!;
	}
	track(label: string): string {
		const seq = this.doc.sequences[this.seqId]!;
		const list = label.startsWith('V') ? seq.videoTracks : seq.audioTracks;
		return list[Number(label.slice(1)) - 1]!.id;
	}
	tx(commands: unknown[]): { refs: Record<string, string>; results: unknown[] } {
		const { document, result } = applyTransaction(
			this.doc,
			{ label: 'test', origin: 'user', sequenceId: this.seqId, commands: commands as never },
			{
				ids: this.ids,
				now: () => '2026-09-30T10:00:00.000Z',
				revision: this.revision,
				registries: defaultRegistries(),
			},
		);
		if (!result.ok) throw new Error(`transaction failed: ${JSON.stringify(result.errors)}`);
		this.doc = document;
		this.revision = result.revision;
		return { refs: result.refs, results: result.results };
	}
	addMedia(m: RegisteredMedia): string {
		const { mediaKey: _k, browserPlayable: _b, ...asset } = m;
		const r = this.tx([{ type: 'media.register', asset: { ...asset, derivation: null } }]);
		return (r.results[0] as { mediaId: string }).mediaId;
	}
	clipIds(): string[] {
		return Object.keys(this.doc.sequences[this.seqId]!.clips);
	}
	envelope() {
		return makeEnvelope(this.doc, {
			revision: this.revision,
			savedAt: '2026-09-30T10:00:00.000Z',
			platform: 'test',
		});
	}
}
