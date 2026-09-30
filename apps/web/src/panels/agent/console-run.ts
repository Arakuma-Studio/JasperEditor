// Runs the Agent panel's JSON console input: `{query, args}` runs a query, anything else is a transaction
// (`jasper.tx/1`, protocol optional). Console runs are typed by the user, so they skip the approval card.
import type { AgentBridge } from '../../agent-bridge/bridge.ts';

export type ConsoleOutcome = {
	kind: 'query' | 'transaction' | 'error';
	ok: boolean;
	output: unknown;
	/** One-line status for the result header. */
	status: string;
};

export async function runConsoleInput(
	bridge: AgentBridge,
	text: string,
	opts: { dryRun: boolean },
): Promise<ConsoleOutcome> {
	let input: unknown;
	try {
		input = JSON.parse(text);
	} catch (e) {
		return { kind: 'error', ok: false, output: String(e), status: 'Invalid JSON' };
	}
	if (!input || typeof input !== 'object' || Array.isArray(input))
		return { kind: 'error', ok: false, output: null, status: 'Expected a JSON object' };
	const o = input as Record<string, unknown>;
	if (typeof o.query === 'string') {
		try {
			const result = await bridge.query(o.query, (o.args as Record<string, unknown>) ?? {});
			return { kind: 'query', ok: true, output: result, status: `${o.query} ✓` };
		} catch (e) {
			const code = (e as { code?: string }).code ?? 'E_INTERNAL';
			return {
				kind: 'query',
				ok: false,
				output: { code, message: (e as Error).message },
				status: `${o.query}: ${code}`,
			};
		}
	}
	const tx = { ...o, ...(opts.dryRun ? { dryRun: true } : {}) };
	const result = await bridge.transact(tx, { via: 'console', fallbackAgent: 'console', approved: true });
	return {
		kind: 'transaction',
		ok: result.ok,
		output: result,
		status: result.ok
			? `${opts.dryRun ? 'Dry run' : 'Applied'} ✓ revision ${result.revision}`
			: `Rejected: ${result.errors.map((e) => e.code).join(', ')}`,
	};
}
