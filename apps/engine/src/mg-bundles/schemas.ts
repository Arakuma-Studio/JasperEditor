// Props schemas of a bundle's compositions (S08:MGC-011). Remotion does not expose zod schemas as data, so in
// order: (1) the manifest `jasper.mg.json` (project or bundle root), (2) the project's schema module
// (package.json → "jasper": {"schemas": "./src/jasper-schemas.ts"}, a Record<compositionId, ZodType>) bundled
// for Node with esbuild (zod external) and converted in a child process (zod 4 → z.toJSONSchema, zod 3 →
// zod-to-json-schema), (3) inference from defaultProps. Failures fall back to (3) with a warning.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import {
	inferPropsSchema,
	type MgCompositionInfo,
	MgTextDeclSchema,
	type PropsUiHints,
	schemaUiHints,
} from '@jasper/project';
import { z } from 'zod';
import { nodeExecPath } from '../tools/node-runtime.ts';
import { terminateTree } from '../tools/process.ts';

const MANIFEST_FILE = 'jasper.mg.json';

const UiHintSchema = z.looseObject({
	control: z
		.enum(['color', 'text', 'textarea', 'slider', 'asset', 'number', 'toggle', 'select', 'json'])
		.optional(),
	label: z.string().optional(),
	min: z.number().optional(),
	max: z.number().optional(),
	step: z.number().optional(),
});
const MgManifestSchema = z.looseObject({
	compositions: z
		.record(
			z.string(),
			z.looseObject({
				propsSchema: z.record(z.string(), z.unknown()).optional(),
				ui: z.record(z.string(), UiHintSchema).optional(),
				category: z.string().optional(),
				thumbnailFrame: z.number().int().min(0).optional(),
				// wp-m3-mgtext (S08:MGC-036): text layers by prop path; `false` hides a discovered string.
				texts: z.record(z.string(), z.union([z.literal(false), MgTextDeclSchema])).optional(),
			}),
		)
		.optional(),
});
type MgManifest = z.infer<typeof MgManifestSchema>;

/** Reads and validates `jasper.mg.json` in `dir` (null when absent; a warning when invalid). */
export async function readManifest(dir: string, warnings: string[]): Promise<MgManifest | null> {
	const file = join(dir, MANIFEST_FILE);
	if (!existsSync(file)) return null;
	try {
		const parsed = MgManifestSchema.safeParse(JSON.parse(await readFile(file, 'utf8')));
		if (parsed.success) return parsed.data;
		warnings.push(
			`${MANIFEST_FILE} is invalid (${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}); it was ignored`,
		);
	} catch (e) {
		warnings.push(`${MANIFEST_FILE} could not be read: ${(e as Error).message}`);
	}
	return null;
}

/** The child-process converter (CommonJS so `require` of the project's zod works). */
const RUNNER = String.raw`'use strict';
const Module = require('module');
const path = require('path');
const [bundleFile, projectDir, z2jsPath] = process.argv.slice(2);
const projectRequire = Module.createRequire(path.join(projectDir, 'package.json'));
const projectParent = {
	id: path.join(projectDir, 'package.json'),
	filename: path.join(projectDir, 'package.json'),
	paths: Module._nodeModulePaths(projectDir),
};
const originalResolve = Module._resolveFilename;
// zod (external in the bundled module) resolves from the project, like its own code would.
Module._resolveFilename = function (request, parent, ...rest) {
	if (request === 'zod' || request.startsWith('zod/'))
		return originalResolve.call(this, request, projectParent, ...rest);
	return originalResolve.call(this, request, parent, ...rest);
};
const out = { schemas: {}, warnings: [] };
function toJson(schema) {
	if (schema && typeof schema === 'object' && schema._zod) {
		for (const spec of ['zod', 'zod/v4', 'zod/v4/core']) {
			try {
				const z = projectRequire(spec);
				const fn = z.toJSONSchema || (z.z && z.z.toJSONSchema);
				if (typeof fn === 'function') return fn(schema, { unrepresentable: 'any', io: 'input' });
			} catch (e) {}
		}
		throw new Error('zod 4 schema but no toJSONSchema in the project\'s zod');
	}
	if (schema && typeof schema === 'object' && schema._def) {
		const { zodToJsonSchema } = require(z2jsPath);
		return zodToJsonSchema(schema, { target: 'jsonSchema7', $refStrategy: 'none' });
	}
	return undefined;
}
try {
	const mod = require(bundleFile);
	const isZod = (v) => v && typeof v === 'object' && (v._zod || v._def);
	let record = null;
	for (const cand of [mod.default, mod.schemas, mod]) {
		if (cand && typeof cand === 'object' && !isZod(cand) && Object.values(cand).some(isZod)) {
			record = cand;
			break;
		}
	}
	if (!record) out.warnings.push('the schema module exports no Record<compositionId, ZodType> (default or "schemas")');
	else
		for (const [id, schema] of Object.entries(record)) {
			if (!isZod(schema)) continue;
			try {
				const json = toJson(schema);
				if (json && typeof json === 'object') out.schemas[id] = json;
			} catch (e) {
				out.warnings.push('schema of ' + id + ': ' + (e && e.message ? e.message : String(e)));
			}
		}
} catch (e) {
	out.warnings.push('the schema module failed to load: ' + (e && e.message ? e.message.split('\n')[0] : String(e)));
}
process.stdout.write(JSON.stringify(out));
`;

type SchemaModuleResult = { schemas: Record<string, Record<string, unknown>>; warnings: string[] };

/**
 * Bundles and evaluates the project's schema module; returns the JSON Schemas by composition id. Never throws:
 * problems become warnings (the compositions then use inference).
 */
export async function loadSchemaModule(
	projectDir: string,
	entry: string,
	opts: { scratchDir: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<SchemaModuleResult> {
	const file = isAbsolute(entry) ? entry : resolve(projectDir, entry);
	if (!existsSync(file)) return { schemas: {}, warnings: [`schema module ${entry} not found`] };
	await mkdir(opts.scratchDir, { recursive: true });
	const bundled = join(opts.scratchDir, 'jasper-schemas.cjs');
	const runner = join(opts.scratchDir, 'jasper-schemas-runner.cjs');
	try {
		const esbuild = await import('esbuild');
		await esbuild.build({
			entryPoints: [file],
			outfile: bundled,
			bundle: true,
			platform: 'node',
			format: 'cjs',
			target: 'node20',
			external: ['zod', 'zod/*'],
			jsx: 'automatic',
			logLevel: 'silent',
			absWorkingDir: projectDir,
		});
	} catch (e) {
		return {
			schemas: {},
			warnings: [
				`schema module ${entry} could not be bundled: ${String((e as Error).message).split('\n')[0]}`,
			],
		};
	}
	await writeFile(runner, RUNNER);
	let z2js: string;
	try {
		z2js = createRequire(import.meta.url).resolve('zod-to-json-schema');
	} catch {
		z2js = 'zod-to-json-schema';
	}
	const res = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
		const child = spawn(nodeExecPath(), [runner, bundled, projectDir, z2js], {
			cwd: projectDir,
			env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_ENV: 'production' },
			stdio: ['ignore', 'pipe', 'pipe'],
			detached: process.platform !== 'win32',
		});
		let stdout = '';
		let stderr = '';
		child.stdout?.on('data', (b: Buffer) => {
			stdout += b.toString('utf8');
		});
		child.stderr?.on('data', (b: Buffer) => {
			stderr = (stderr + b.toString('utf8')).slice(-8000);
		});
		const timer = setTimeout(() => void terminateTree(child), opts.timeoutMs ?? 60_000);
		const onAbort = () => void terminateTree(child);
		opts.signal?.addEventListener('abort', onAbort, { once: true });
		child.once('error', (e) => {
			stderr += String(e);
		});
		child.once('close', (code) => {
			clearTimeout(timer);
			opts.signal?.removeEventListener('abort', onAbort);
			done({ code, stdout, stderr });
		});
	});
	await rm(bundled, { force: true }).catch(() => undefined);
	try {
		const parsed = JSON.parse(res.stdout) as SchemaModuleResult;
		return { schemas: parsed.schemas ?? {}, warnings: parsed.warnings ?? [] };
	} catch {
		return {
			schemas: {},
			warnings: [
				`schema module ${entry} could not be evaluated (exit ${res.code}): ${res.stderr.trim().slice(-400)}`,
			],
		};
	}
}

/** Raw composition metadata as `getCompositions` returns it. */
export type RawComposition = {
	id: string;
	width: number;
	height: number;
	fps: number;
	durationInFrames: number;
	defaultProps: Record<string, unknown>;
};

/** JSON-safe copy (drops functions, Dates become strings) so documents stay plain JSON. */
function plain(v: unknown): Record<string, unknown> {
	try {
		const out = JSON.parse(JSON.stringify(v ?? {}));
		return out && typeof out === 'object' && !Array.isArray(out) ? out : {};
	} catch {
		return {};
	}
}

/** Composition infos with their schema, source and UI hints (manifest → schema module → inference). */
export function buildCompositionInfos(
	raw: readonly RawComposition[],
	opts: { manifest: MgManifest | null; moduleSchemas: Record<string, Record<string, unknown>> },
): MgCompositionInfo[] {
	return raw.map((c) => {
		const defaultProps = plain(c.defaultProps);
		// `"*"` = defaults for every composition (registry-style projects whose shots share runtime props); an
		// entry for the id wins field by field.
		const all = opts.manifest?.compositions ?? {};
		const m = all[c.id] || all['*'] ? { ...(all['*'] ?? {}), ...(all[c.id] ?? {}) } : undefined;
		// Text declarations merge entry by entry (the id's own win), like `ui`.
		const texts = { ...(all['*']?.texts ?? {}), ...(all[c.id]?.texts ?? {}) };
		const inferred = inferPropsSchema(defaultProps);
		let propsSchema: Record<string, unknown>;
		let schemaSource: MgCompositionInfo['schemaSource'];
		let ui: PropsUiHints;
		const ownSchema = !!all[c.id]?.propsSchema;
		if (m?.propsSchema && !ownSchema && !opts.moduleSchemas[c.id]) {
			// The "*" schema (shared runtime props) plus what the composition's own defaultProps infer.
			const shared = m.propsSchema as { properties?: Record<string, unknown> };
			const inferredProps = (inferred.schema.properties ?? {}) as Record<string, unknown>;
			propsSchema = {
				...m.propsSchema,
				properties: { ...inferredProps, ...(shared.properties ?? {}) },
			};
			schemaSource = 'manifest';
			ui = { ...inferred.ui, ...schemaUiHints(propsSchema, defaultProps) };
		} else if (m?.propsSchema && ownSchema) {
			propsSchema = m.propsSchema;
			schemaSource = 'manifest';
			ui = schemaUiHints(propsSchema, defaultProps);
		} else if (opts.moduleSchemas[c.id]) {
			propsSchema = opts.moduleSchemas[c.id]!;
			schemaSource = 'bundle';
			ui = schemaUiHints(propsSchema, defaultProps);
		} else {
			propsSchema = inferred.schema;
			schemaSource = 'inferred';
			ui = inferred.ui;
		}
		const mergedUi = { ...ui, ...((m?.ui as PropsUiHints | undefined) ?? {}) };
		return {
			id: c.id,
			width: c.width,
			height: c.height,
			fps: c.fps,
			durationInFrames: c.durationInFrames,
			defaultProps,
			propsSchema,
			schemaSource,
			...(Object.keys(mergedUi).length ? { ui: mergedUi } : {}),
			...(m?.category ? { category: m.category } : {}),
			...(m?.thumbnailFrame !== undefined ? { thumbnailFrame: m.thumbnailFrame } : {}),
			...(Object.keys(texts).length ? { texts } : {}),
		} as MgCompositionInfo;
	});
}
