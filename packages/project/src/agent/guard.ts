// Agent transaction guard rails (S01:AGT-011, ARCHITECTURE §11): limits, normalization, the approval
// classification shared by the in-page bridge and the engine relay, and history pseudo-commands (UND-008).

import { utf8Length } from '../clipboard/payload.ts';
import { DEFAULT_MAX_COMMANDS } from '../commands/apply.ts';
import { APPROVAL_COMMANDS } from '../commands/catalog.ts';
import { type Issue, TX_PROTOCOL } from '../commands/types.ts';

/** Per-transaction limits for agents (S01:AGT-011). */
export const AGENT_TX_LIMITS = { maxCommands: DEFAULT_MAX_COMMANDS, maxBytes: 20 * 1024 * 1024 } as const;

/** Agent-only pseudo-commands handled by the session (not by @jasper/project handlers). */
export const HISTORY_PSEUDO_COMMANDS = ['history.undo', 'history.redo'] as const;
export type HistoryPseudoCommand = (typeof HISTORY_PSEUDO_COMMANDS)[number];

export type AgentOrigin = { agent: string; runId?: string };

/** A transaction as received from an agent (loosely shaped until validated). */
export type AgentTxInput = {
	protocol?: string;
	label?: string;
	origin?: unknown;
	expectedRevision?: number;
	dryRun?: boolean;
	sequenceId?: string;
	commands?: unknown[];
	[k: string]: unknown;
};

function hasForce(v: unknown, depth = 0): boolean {
	if (depth > 8 || !v || typeof v !== 'object') return false;
	if (Array.isArray(v)) return v.some((x) => hasForce(x, depth + 1));
	for (const [k, x] of Object.entries(v)) {
		if (k === 'force' && x === true) return true;
		if (hasForce(x, depth + 1)) return true;
	}
	return false;
}

/**
 * Why a transaction needs the user's approval (empty = it does not). Destructive command types and any
 * `force: true` argument require approval (S01:AGT-011); dry runs never do (they change nothing).
 */
export function approvalReasons(tx: Pick<AgentTxInput, 'commands' | 'dryRun'>): string[] {
	if (tx.dryRun) return [];
	const reasons: string[] = [];
	(tx.commands ?? []).forEach((c, i) => {
		const type = (c as { type?: unknown })?.type;
		if (typeof type === 'string' && (APPROVAL_COMMANDS as readonly string[]).includes(type))
			reasons.push(`${type} (command ${i + 1})`);
		else if (hasForce(c)) reasons.push(`force: true in ${String(type)} (command ${i + 1})`);
		// Spec 12 §0: only the user lets agents apply sound proposals without review; an agent may not grant it itself.
		else if (
			type === 'soundDesign.setSettings' &&
			(c as { agentsMayApply?: unknown }).agentsMayApply === true
		)
			reasons.push(
				`agentsMayApply: true in soundDesign.setSettings (command ${i + 1}) lets agents apply sound proposals`,
			);
	});
	return reasons;
}

/** Command-count and payload-size limits (S01:AGT-011). Returns the E_LIMIT issue, or null. */
export function checkAgentTxLimits(tx: AgentTxInput, byteLength?: number): Issue | null {
	const n = Array.isArray(tx.commands) ? tx.commands.length : 0;
	if (n > AGENT_TX_LIMITS.maxCommands)
		return {
			commandIndex: -1,
			code: 'E_LIMIT',
			message: `A transaction may hold at most ${AGENT_TX_LIMITS.maxCommands} commands (got ${n})`,
		};
	const bytes = byteLength ?? utf8Length(JSON.stringify(tx) ?? '');
	if (bytes > AGENT_TX_LIMITS.maxBytes)
		return {
			commandIndex: -1,
			code: 'E_LIMIT',
			message: `A transaction may be at most ${AGENT_TX_LIMITS.maxBytes} bytes (got ${bytes})`,
		};
	return null;
}

/** The agent origin of a transaction; non-agent origins are replaced (agents never act as the user). */
function agentOriginOf(origin: unknown, fallbackAgent: string): AgentOrigin {
	if (origin && typeof origin === 'object' && typeof (origin as AgentOrigin).agent === 'string') {
		const o = origin as AgentOrigin;
		if (o.agent.trim())
			return o.runId !== undefined ? { agent: o.agent, runId: o.runId } : { agent: o.agent };
	}
	return { agent: fallbackAgent };
}

/**
 * Fills `protocol`, forces an agent origin and a non-empty label. The result is ready for
 * `applyTransaction` / `EditorSession.submit` (commands are validated there).
 */
export function normalizeAgentTransaction(
	raw: AgentTxInput,
	fallbackAgent = 'agent',
): AgentTxInput & { protocol: typeof TX_PROTOCOL; label: string; origin: AgentOrigin; commands: unknown[] } {
	return {
		...raw,
		protocol: TX_PROTOCOL,
		label: typeof raw.label === 'string' && raw.label.trim() ? raw.label : 'Agent transaction',
		origin: agentOriginOf(raw.origin, fallbackAgent),
		commands: Array.isArray(raw.commands) ? raw.commands : [],
	};
}

/** `history.undo` / `history.redo` when the transaction is exactly that one pseudo-command. */
export function historyPseudoCommand(tx: Pick<AgentTxInput, 'commands'>): HistoryPseudoCommand | null {
	const cmds = tx.commands ?? [];
	if (cmds.length !== 1) return null;
	const type = (cmds[0] as { type?: unknown })?.type;
	return type === 'history.undo' || type === 'history.redo' ? type : null;
}

/** A one-line human summary of a transaction for approval cards and the activity feed. */
export function summarizeTransaction(tx: Pick<AgentTxInput, 'commands' | 'label'>): string {
	const counts = new Map<string, number>();
	for (const c of tx.commands ?? []) {
		const t = String((c as { type?: unknown })?.type ?? '?');
		counts.set(t, (counts.get(t) ?? 0) + 1);
	}
	const parts = [...counts].map(([t, n]) => (n > 1 ? `${n}× ${t}` : t));
	return parts.length ? parts.join(', ') : 'no commands';
}
