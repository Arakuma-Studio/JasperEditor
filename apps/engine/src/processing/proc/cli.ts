#!/usr/bin/env node
// jasper-proc (S07:PRC-011): the clip processor CLI. The engine runs it as a child process for local jobs and
// over SSH for remote jobs — one code path.
//
//   jasper-proc --version            → {"name":"jasper-proc","version","recipeVersion","onnx":{"providers"},"vidstab":{…}}
//   jasper-proc run --spec spec.json → processes; NDJSON events on stderr; exit 0 ok, 2 invalid spec,
//                                      3 cancelled (SIGTERM/SIGINT), 1 other
import { mkdirSync, readFileSync } from 'node:fs';
import { ProcessStepSchema } from '@jasper/project';
import { z } from 'zod';
import { PROC_NAME, PROC_VERSION, RECIPE_VERSION } from './recipe.ts';
import { cleanupPartial, ProcError, runProc } from './runner.ts';
import { createStepImpl } from './steps.ts';
import { PROC_EXIT, type ProcEvent, type ProcSpec } from './types.ts';
import { ortProviders } from './upscale.ts';

export const ProcSpecSchema = z.object({
	input: z.string().min(1),
	output: z.string().min(1),
	steps: z.array(ProcessStepSchema).min(1),
	range: z.object({ startFrame: z.number().int().min(0), endFrame: z.number().int().min(1) }).optional(),
	ffmpeg: z.string().min(1),
	ffprobe: z.string().min(1),
	models: z
		.record(
			z.string(),
			z.object({ path: z.string(), sha256: z.string(), scale: z.number().int().optional() }),
		)
		.default({}),
	threads: z.number().int().min(1).max(256).default(4),
	device: z.enum(['cpu', 'cuda']).default('cpu'),
	scratch: z.string().min(1),
	vidstabEngine: z.enum(['auto', 'wasm', 'ffmpeg']).optional(),
});

function emitLine(e: ProcEvent): void {
	process.stderr.write(`${JSON.stringify(e)}\n`);
}

export async function versionInfo(): Promise<Record<string, unknown>> {
	let vidstab: Record<string, unknown> = { wasm: false };
	try {
		const m = await import('./vidstab/index.ts');
		vidstab = { wasm: await m.vidstabWasmAvailable() };
	} catch (e) {
		vidstab = { wasm: false, error: (e as Error).message };
	}
	return {
		name: PROC_NAME,
		version: PROC_VERSION,
		recipeVersion: RECIPE_VERSION,
		node: process.version,
		onnx: { providers: ortProviders() },
		vidstab,
	};
}

export async function main(argv: string[]): Promise<number> {
	if (argv.includes('--version') || argv[0] === 'version') {
		process.stdout.write(`${JSON.stringify(await versionInfo())}\n`);
		return PROC_EXIT.ok;
	}
	if (argv[0] !== 'run') {
		process.stderr.write('usage: jasper-proc --version | jasper-proc run --spec <spec.json>\n');
		return PROC_EXIT.invalidSpec;
	}
	const i = argv.indexOf('--spec');
	const file = i >= 0 ? argv[i + 1] : undefined;
	let spec: ProcSpec;
	try {
		if (!file) throw new Error('--spec <file> is required');
		spec = ProcSpecSchema.parse(JSON.parse(readFileSync(file, 'utf8'))) as ProcSpec;
	} catch (e) {
		emitLine({ event: 'error', code: 'INVALID_SPEC', message: (e as Error).message.slice(0, 2000) });
		return PROC_EXIT.invalidSpec;
	}
	mkdirSync(spec.scratch, { recursive: true });
	const ac = new AbortController();
	const onSignal = () => ac.abort();
	process.once('SIGTERM', onSignal);
	process.once('SIGINT', onSignal);
	try {
		const res = await runProc(spec, { emit: emitLine, signal: ac.signal, createStep: createStepImpl });
		emitLine({ event: 'done', frames: res.frames, output: spec.output, sidecar: res.sidecar });
		return PROC_EXIT.ok;
	} catch (e) {
		cleanupPartial(spec);
		if (ac.signal.aborted) {
			emitLine({ event: 'error', code: 'CANCELLED', message: 'cancelled' });
			return PROC_EXIT.cancelled;
		}
		const code = e instanceof ProcError ? e.code : ((e as { code?: string }).code ?? 'PROCESS_FAILED');
		emitLine({ event: 'error', code, message: (e as Error).message.slice(0, 4000) });
		return PROC_EXIT.other;
	}
}

// Run when executed directly (bundle or tsx), not when imported by tests.
const entry = process.argv[1] ?? '';
if (/jasper-proc(\.m?js)?$|proc[\\/]cli\.ts$/.test(entry)) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(e) => {
			emitLine({ event: 'error', code: 'PROCESS_FAILED', message: String(e) });
			process.exit(PROC_EXIT.other);
		},
	);
}
