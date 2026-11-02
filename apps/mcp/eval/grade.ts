// Deterministic checks on what a sample did. No model judges a sample. MCP calls come from the stub's own log, so
// the same case grades identically on every harness; `call_tool` counts as a call of the tool it ran.

export type McpCall = {
	tool: string;
	args: Record<string, unknown>;
	isError: boolean;
	errorCode?: string;
	/** Reached through `call_tool`. */
	viaCallTool?: boolean;
	/** The fake engine had no answer for it: an eval bug, not agent behaviour. */
	unmodelled?: string[];
};

export type SampleRecord = {
	calls: McpCall[];
	shell: string[];
	reply: string;
	/** Tools the model loaded from the harness's deferred list, for reporting. */
	toolSearches?: string[];
};

export type CallMatch = { tool: string | string[]; args?: Record<string, unknown> };

export type Checks = {
	calls?: CallMatch[];
	mustNotCall?: CallMatch[];
	/** These tools appear in this relative order (first occurrence of each). */
	order?: string[];
	maxCalls?: number;
	maxCallsOf?: Record<string, number>;
	/** The last call is this tool (or none of the tools after it were called). */
	endsAfter?: string | string[];
	/** No call was refused with these codes; "*" is any error. */
	noErrors?: string[];
	shellMustNot?: string[];
	replyMust?: string[];
	replyMustNot?: string[];
};

export type Grade = { pass: boolean; failures: string[]; invalid?: string };

/** Partial deep match: every key in `want` matches in `got`; a string starting with `/` and ending in `/` is a regex. */
export function partialMatch(got: unknown, want: unknown): boolean {
	if (typeof want === 'string' && want.length > 1 && want.startsWith('/') && want.endsWith('/'))
		return typeof got === 'string' && new RegExp(want.slice(1, -1), 'i').test(got);
	if (Array.isArray(want))
		return Array.isArray(got) && want.every((w) => got.some((g) => partialMatch(g, w)));
	if (want !== null && typeof want === 'object') {
		if (got === null || typeof got !== 'object') return false;
		return Object.entries(want).every(([k, v]) => partialMatch((got as Record<string, unknown>)[k], v));
	}
	return got === want;
}

const toolsOf = (m: CallMatch): string[] => (Array.isArray(m.tool) ? m.tool : [m.tool]);
const describeMatch = (m: CallMatch): string =>
	`${toolsOf(m).join('|')}${m.args ? ` ${JSON.stringify(m.args)}` : ''}`;
const matches = (c: McpCall, m: CallMatch): boolean =>
	toolsOf(m).includes(c.tool) && (m.args === undefined || partialMatch(c.args, m.args));

export function grade(sample: SampleRecord, checks: Checks): Grade {
	const failures: string[] = [];
	const unmodelled = sample.calls.flatMap((c) => c.unmodelled ?? []);
	for (const want of checks.calls ?? [])
		if (!sample.calls.some((c) => matches(c, want))) failures.push(`missing call: ${describeMatch(want)}`);
	for (const ban of checks.mustNotCall ?? [])
		if (sample.calls.some((c) => matches(c, ban))) failures.push(`forbidden call: ${describeMatch(ban)}`);
	if (checks.order) {
		const firsts = checks.order.map((t) => sample.calls.findIndex((c) => c.tool === t));
		const missing = checks.order.filter((_, i) => firsts[i] === -1);
		if (missing.length) failures.push(`order: never called ${missing.join(', ')}`);
		else if (firsts.some((v, i) => i > 0 && v < firsts[i - 1]!))
			failures.push(`order: expected ${checks.order.join(' → ')}`);
	}
	if (checks.maxCalls !== undefined && sample.calls.length > checks.maxCalls)
		failures.push(`${sample.calls.length} tool calls, at most ${checks.maxCalls}`);
	for (const [tool, max] of Object.entries(checks.maxCallsOf ?? {})) {
		const n = sample.calls.filter((c) => c.tool === tool).length;
		if (n > max) failures.push(`${tool} called ${n} times, at most ${max}`);
	}
	if (checks.endsAfter) {
		const last = sample.calls.at(-1)?.tool;
		const ends = Array.isArray(checks.endsAfter) ? checks.endsAfter : [checks.endsAfter];
		if (!last || !ends.includes(last))
			failures.push(`last call ${last ?? '(none)'}, wanted ${ends.join('|')}`);
	}
	if (checks.noErrors)
		for (const c of sample.calls)
			if (c.isError && (checks.noErrors.includes('*') || checks.noErrors.includes(c.errorCode ?? '')))
				failures.push(`${c.tool} refused: ${c.errorCode ?? 'error'}`);
	for (const pattern of checks.shellMustNot ?? []) {
		const re = new RegExp(pattern, 'i');
		const hit = sample.shell.find((s) => re.test(s));
		if (hit) failures.push(`shell /${pattern}/: ${hit.slice(0, 120)}`);
	}
	for (const pattern of checks.replyMust ?? [])
		if (!new RegExp(pattern, 'i').test(sample.reply)) failures.push(`reply lacks /${pattern}/`);
	for (const pattern of checks.replyMustNot ?? []) {
		const hit = new RegExp(pattern, 'i').exec(sample.reply);
		if (hit) failures.push(`reply has /${pattern}/: "${hit[0].slice(0, 80)}"`);
	}
	return {
		pass: failures.length === 0,
		failures,
		...(unmodelled.length
			? { invalid: `unmodelled engine calls: ${[...new Set(unmodelled)].join(', ')}` }
			: {}),
	};
}

/** Two samples, a third when they disagree. */
export function needsThirdSample(passes: readonly boolean[]): boolean {
	return passes.length === 2 && passes[0] !== passes[1];
}

/** A case fails when half or more of its samples fail. */
export function casePasses(passes: readonly boolean[]): boolean {
	const failed = passes.filter((p) => !p).length;
	return passes.length > 0 && failed * 2 < passes.length;
}

export type ResultRow = { caseId: string; pass: boolean };

/** Cases that passed every baseline sample and now fail, and cases now fixed. */
export function compareToBaseline(baseline: readonly ResultRow[], current: readonly ResultRow[]) {
	const group = (rows: readonly ResultRow[]) => {
		const by = new Map<string, boolean[]>();
		for (const r of rows) by.set(r.caseId, [...(by.get(r.caseId) ?? []), r.pass]);
		return by;
	};
	const before = group(baseline);
	const after = group(current);
	const regressions: string[] = [];
	const fixed: string[] = [];
	for (const [id, passes] of after) {
		const was = before.get(id);
		if (!was) continue;
		if (was.every(Boolean) && !casePasses(passes)) regressions.push(id);
		if (!casePasses(was) && casePasses(passes)) fixed.push(id);
	}
	return { regressions, fixed };
}
