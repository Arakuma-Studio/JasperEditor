// One decision point. `bad` reproduces a real mistake, `guard` protects a good behaviour a text change could lose,
// `control` is ordinary work where a trigger word must not pull in the tools.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Checks } from './grade.ts';

const CallMatch = z.strictObject({
	tool: z.union([z.string(), z.array(z.string())]),
	args: z.record(z.string(), z.unknown()).optional(),
});

export const ChecksSchema = z.strictObject({
	calls: z.array(CallMatch).optional(),
	mustNotCall: z.array(CallMatch).optional(),
	order: z.array(z.string()).optional(),
	maxCalls: z.number().int().optional(),
	maxCallsOf: z.record(z.string(), z.number().int()).optional(),
	maxAppliedOf: z.record(z.string(), z.number().int()).optional(),
	endsAfter: z.union([z.string(), z.array(z.string())]).optional(),
	noErrors: z.array(z.string()).optional(),
	shellMustNot: z.array(z.string()).optional(),
	replyMust: z.array(z.string()).optional(),
	replyMustNot: z.array(z.string()).optional(),
});

const PriorTurn = z.strictObject({
	role: z.enum(['user', 'assistant']),
	text: z.string().optional(),
	/** Calls the assistant made on this turn, with the results it saw (in the server's real shapes). */
	calls: z
		.array(
			z.strictObject({
				tool: z.string(),
				args: z.record(z.string(), z.unknown()),
				result: z.string(),
				isError: z.boolean().optional(),
			}),
		)
		.optional(),
});

const EngineFault = z.strictObject({
	error: z
		.strictObject({
			code: z.string(),
			message: z.string(),
			status: z.number().int().optional(),
			detail: z.unknown().optional(),
		})
		.optional(),
	result: z.unknown().optional(),
	times: z.number().int().optional(),
	/** Cuts the request off like a lost connection (`afterApply`: after the engine applied it), or never answers. */
	abort: z.enum(['connection-lost', 'timeout']).optional(),
	afterApply: z.boolean().optional(),
});

export const CaseSchema = z.strictObject({
	id: z.string().regex(/^[a-z0-9-]+$/),
	kind: z.enum(['bad', 'guard', 'control']),
	/** What happened, in a sentence. */
	what: z.string().min(1),
	/** The current text at issue, or "none". */
	text: z.string().min(1),
	/** Where it comes from: a chat and date, a commit, a measurement, or a baseline probe. */
	source: z.string().min(1),
	prompt: z.string().min(1),
	priorTurns: z.array(PriorTurn).optional(),
	setup: z
		.strictObject({
			project: z.enum(['none', 'empty', 'interview']).optional(),
			projectName: z.string().optional(),
			preset: z.string().optional(),
			toolsets: z.string().optional(),
			/** Files of the throwaway cwd: relative path → content. */
			files: z.record(z.string(), z.string()).optional(),
			shell: z.array(z.strictObject({ match: z.string(), output: z.string() })).optional(),
			faults: z.record(z.string(), EngineFault).optional(),
			review: z.enum(['accept', 'reject']).optional(),
			brief: z.record(z.string(), z.unknown()).optional(),
			seed: z.array(z.record(z.string(), z.unknown())).optional(),
			exportPolls: z.number().int().optional(),
			/** A file is already at every export's outputPath (`fake-engine.ts` `EngineSetup.outputExists`). */
			outputExists: z.boolean().optional(),
			/** A queued transcription still running for `polls` reads: `{{pendingJob}}` (`EngineSetup.pendingTranscription`). */
			pendingTranscription: z.strictObject({ polls: z.number().int().min(1) }).optional(),
			verify: z.strictObject({ failRow: z.string().optional() }).optional(),
			/** A finished export wrote this path in an earlier session (`fake-engine.ts` `EngineSetup.pastExport`). */
			pastExport: z.string().optional(),
			/** A still logo.png on V2: `{{still}}` (`fake-engine.ts` `EngineSetup.logo`). */
			logo: z.boolean().optional(),
		})
		.optional(),
	checks: ChecksSchema,
});

export type EvalCase = Omit<z.infer<typeof CaseSchema>, 'checks'> & { checks: Checks };

export const CASES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'cases');

export function parseCases(text: string, origin: string): EvalCase[] {
	return text
		.split('\n')
		.map((line, i) => ({ line: line.trim(), i }))
		.filter(({ line }) => line.length > 0)
		.map(({ line, i }) => {
			try {
				return CaseSchema.parse(JSON.parse(line)) as EvalCase;
			} catch (e) {
				throw new Error(`${origin}:${i + 1}: ${e instanceof Error ? e.message : String(e)}`);
			}
		});
}

export function loadCases(dir = CASES_DIR): EvalCase[] {
	const files = readdirSync(dir)
		.filter((f) => f.endsWith('.jsonl'))
		.sort();
	const cases = files.flatMap((f) => parseCases(readFileSync(join(dir, f), 'utf8'), f));
	const seen = new Set<string>();
	for (const c of cases) {
		if (seen.has(c.id)) throw new Error(`Duplicate case id: ${c.id}`);
		seen.add(c.id);
	}
	return cases;
}

/** Replaces `{{name}}` with the fake engine's ids and the sample's paths, in any JSON value. */
export function fillVars<T>(value: T, vars: Readonly<Record<string, string>>): T {
	return JSON.parse(
		JSON.stringify(value).replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
			Object.hasOwn(vars, name) ? JSON.stringify(vars[name]).slice(1, -1) : whole,
		),
	) as T;
}
