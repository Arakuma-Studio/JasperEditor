// A case's prior turns as a Claude Code transcript the sample resumes, so the model reads them as its own history.
import { randomUUID } from 'node:crypto';
import type { EvalCase } from './case.ts';

const MCP_PREFIX = 'mcp__jasper__';

/** The transcript lines of `turns`, ending on the last turn; the sample's prompt follows as the next user message. */
export function historyLines(
	sessionId: string,
	cwd: string,
	turns: NonNullable<EvalCase['priorTurns']>,
): string[] {
	const lines: string[] = [];
	let parentUuid: string | null = null;
	const push = (entry: Record<string, unknown>) => {
		const uuid = randomUUID();
		lines.push(
			JSON.stringify({
				parentUuid,
				isSidechain: false,
				userType: 'external',
				cwd,
				sessionId,
				version: '2.1.307',
				gitBranch: 'main',
				uuid,
				timestamp: new Date().toISOString(),
				...entry,
			}),
		);
		parentUuid = uuid;
	};
	const assistant = (content: unknown[]) =>
		push({
			type: 'assistant',
			message: {
				id: `msg_${randomUUID()}`,
				type: 'message',
				role: 'assistant',
				model: 'claude-sonnet-5-5',
				content,
				stop_reason: 'end_turn',
				stop_sequence: null,
				usage: { input_tokens: 1, output_tokens: 1 },
			},
		});
	for (const turn of turns) {
		if (turn.role === 'user') {
			push({ type: 'user', message: { role: 'user', content: turn.text ?? '' } });
			continue;
		}
		const calls = (turn.calls ?? []).map((c) => ({ ...c, id: `toolu_${randomUUID().replace(/-/g, '')}` }));
		if (calls.length) {
			assistant([
				...(turn.text ? [{ type: 'text', text: turn.text }] : []),
				...calls.map((c) => ({ type: 'tool_use', id: c.id, name: `${MCP_PREFIX}${c.tool}`, input: c.args })),
			]);
			push({
				type: 'user',
				message: {
					role: 'user',
					content: calls.map((c) => ({
						type: 'tool_result',
						tool_use_id: c.id,
						content: c.result,
						...(c.isError ? { is_error: true } : {}),
					})),
				},
			});
		} else assistant([{ type: 'text', text: turn.text ?? '' }]);
	}
	return lines;
}

/** Prior turns as plain text, for a harness that cannot resume an invented session. */
export function historyAsText(turns: NonNullable<EvalCase['priorTurns']>): string {
	const out = ['Earlier in this conversation:'];
	for (const turn of turns) {
		if (turn.text) out.push(`${turn.role === 'user' ? 'User' : 'You'}: ${turn.text}`);
		for (const c of turn.calls ?? [])
			out.push(`You called ${c.tool} ${JSON.stringify(c.args)} and got: ${c.result}`);
	}
	return `${out.join('\n')}\n\nNow the user says:\n`;
}
