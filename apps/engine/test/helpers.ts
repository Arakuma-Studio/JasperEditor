// Shared helpers for engine tests: temp appdirs, fixture media (generated on demand with the repo script),
// documents built through @jasper/project commands.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RegisteredMedia } from '@jasper/api';
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type IdSource,
	makeEnvelope,
	type ProjectDocument,
} from '@jasper/project';
import { ffmpegPath, ffprobePath } from '@jasper/testkit/oracle';
import type { FastifyInstance } from 'fastify';
import { createServer, engineConfig } from '../src/index.ts';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const FIXTURES = join(ROOT, 'fixtures', 'media');
/**
 * ffmpeg / ffprobe for a test's own checks: the LGPL build in vendor/ when it is there (`pnpm ffmpeg:lgpl`), else the
 * oracle resolution (JASPER_FFMPEG / JASPER_FFPROBE, PATH). A clean CI checkout has no vendor directory: a hard-coded
 * vendor path made `spawnSync(...).stdout` null there (verify workstream).
 */
const VENDOR_FFMPEG = join(ROOT, 'vendor', 'ffmpeg-lgpl', `${process.platform}-${process.arch}`);
export const TEST_FFMPEG = existsSync(join(VENDOR_FFMPEG, 'ffmpeg'))
	? join(VENDOR_FFMPEG, 'ffmpeg')
	: (ffmpegPath() ?? 'ffmpeg');
export const TEST_FFPROBE = existsSync(join(VENDOR_FFMPEG, 'ffprobe'))
	? join(VENDOR_FFMPEG, 'ffprobe')
	: (ffprobePath() ?? 'ffprobe');
export const H = { host: '127.0.0.1:47900' } as const;
export const JSON_H = { ...H, 'content-type': 'application/json' } as const;

/** Makes sure `pnpm fixtures` outputs exist (generates them with the repo script when missing). */
export function ensureFixtures(): void {
	const needed = [
		'clip-a.mp4',
		'clip-b.mp4',
		'tone.wav',
		'still.png',
		'phone-rot90.mp4',
		'overlay-alpha.mov',
		'overlay-alpha.webm',
		'frame-code.mp4',
		'overlay-alpha-vp8.webm',
	];
	if (needed.every((n) => existsSync(join(FIXTURES, n)))) return;
	const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'make-fixtures.mjs')], { stdio: 'inherit' });
	if (r.status !== 0) throw new Error('fixture generation failed');
}

export function fixture(name: string): string {
	return join(FIXTURES, name);
}

export function tempAppdir(prefix = 'jasper-engine-'): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

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
		port: 47900,
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
	return Object.assign(app, { appdir });
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

/** Polls until `fn` returns a truthy value (or throws after `timeoutMs`). */
export async function until<T>(
	fn: () => T | Promise<T>,
	timeoutMs = 20_000,
	stepMs = 50,
): Promise<NonNullable<T>> {
	const end = Date.now() + timeoutMs;
	for (;;) {
		const v = await fn();
		if (v) return v as NonNullable<T>;
		if (Date.now() > end) throw new Error('timed out waiting for condition');
		await new Promise((r) => setTimeout(r, stepMs));
	}
}

/** A small document builder over @jasper/project transactions. */
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
	/** media.register from an engine RegisteredMedia; returns the new mediaId. */
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
