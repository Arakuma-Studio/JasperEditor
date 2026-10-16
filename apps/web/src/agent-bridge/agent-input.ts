// Whether input the editor is handling comes from an agent's live-UI automation (security review AGT-1).
//
// The `ui_*` MCP tools act like the user in the window (synthetic DOM events, ui-automation.ts). Without a guard
// an agent could do through the UI what the approval gate (S01:AGT-011) forbids through `apply_commands`: press
// Delete on project items, run Remove Unused, clear the undo history with `{confirmed: true}`, revert unsaved
// work — or simply click Approve on its own pending request. So:
//  - every live-UI input action runs inside `runAgentInput`; while it runs, and for a short grace period after it
//    (asynchronous handlers: confirmation dialogs, a fetch before the commit) unless the user has since pressed a
//    key or the pointer, `agentInputActive()` is true;
//  - the session refuses transactions that need approval while agent input is active (agent-bridge/index.ts
//    installs the guard), and the UI command runner refuses the irreversible commands below;
//  - approval decisions accept only trusted (real user) events (shell/AgentApprovals.tsx), which synthetic input
//    never is.
import { approvalReasons, type Issue } from '@jasper/project';
import type { SessionTxInput } from '@jasper/session';

/** How long after an agent input action asynchronous effects still count as agent-driven. */
export const AGENT_INPUT_GRACE_MS = 1500;

/** UI commands an agent may not run through the live UI (irreversible, outside the undo history). */
export const AGENT_UI_REFUSED_COMMANDS: ReadonlySet<string> = new Set(['history.clear', 'file.revert']);

let depth = 0;
let lastAgentInputAt = Number.NEGATIVE_INFINITY;
let lastUserInputAt = Number.NEGATIVE_INFINITY;
let listening = false;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function listen(): void {
	if (listening || typeof window === 'undefined') return;
	listening = true;
	const mark = (e: Event) => {
		if (e.isTrusted) lastUserInputAt = now();
	};
	for (const type of ['pointerdown', 'keydown', 'wheel'])
		window.addEventListener(type, mark, { capture: true, passive: true });
}

/** Runs one live-UI input action as agent input. */
export async function runAgentInput<T>(fn: () => Promise<T>): Promise<T> {
	listen();
	depth++;
	lastAgentInputAt = now();
	try {
		return await fn();
	} finally {
		depth--;
		lastAgentInputAt = now();
	}
}

/** True while an agent's live-UI input (or its asynchronous aftermath) is being handled. */
export function agentInputActive(at = now()): boolean {
	if (depth > 0) return true;
	return at - lastAgentInputAt < AGENT_INPUT_GRACE_MS && lastUserInputAt < lastAgentInputAt;
}

/** How recent a real key press or click must be for a command it ran to count as the user's own gesture. */
export const USER_GESTURE_MS = 1500;

/** Starts noting real (trusted) user input early, so `userGestureActive` can answer for the first gesture. */
export function trackUserInput(): void {
	listen();
}

/**
 * Whether the command running now was started by the user's own key press or click (a keyboard shortcut, a menu, the
 * palette): a trusted input within `USER_GESTURE_MS` and no agent live-UI input in flight. Used where only a trusted
 * user gesture may act (Apply of a proposal, spec 12 §2.5): an agent's `ui_key` / `ui_command` never counts.
 */
export function userGestureActive(at = now()): boolean {
	listen();
	if (agentInputActive(at)) return false;
	return at - lastUserInputAt < USER_GESTURE_MS;
}

/** Tests: as if the user just pressed a key. */
export function markUserInputForTests(): void {
	lastUserInputAt = now();
}

/** The session guard: transactions that need approval are refused while agent input is active. */
export function agentUiTxGuard(tx: SessionTxInput): Issue | null {
	if (tx.origin !== 'user' || tx.dryRun || !agentInputActive()) return null;
	const reasons = approvalReasons(tx);
	if (reasons.length === 0) return null;
	return {
		commandIndex: -1,
		code: 'E_APPROVAL_DENIED',
		message: `Agent UI automation cannot make destructive edits (${reasons.join('; ')}): run them with apply_commands, which asks the user for approval`,
	};
}

/** Tests: forget all input. */
export function resetAgentInputForTests(): void {
	depth = 0;
	lastAgentInputAt = Number.NEGATIVE_INFINITY;
	lastUserInputAt = Number.NEGATIVE_INFINITY;
}
