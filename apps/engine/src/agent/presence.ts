// Spec 18 AF-BRF-005: which agents used this engine's agent API recently (`GET /api/agent/presence`), so Home ▸
// Describe your video can tell whether an agent is connected. jasper-mcp names its agent on every request
// (`x-jasper-agent`, the MCP client's name; nothing else sends that header — the editor window never does, and an engine
// without an editor key counts every request as the editor's, so the header alone decides). In memory only: names
// are bounded (AGENT_PRESENCE_MAX, least recently seen dropped), cut to 64 characters by `agentNameOf`.
import {
	AGENT_NAME_HEADER,
	AGENT_PRESENCE_MAX,
	AGENT_PRESENCE_WINDOW_SEC,
	type AgentPresence,
} from '@jasper/api';
import type { FastifyRequest } from 'fastify';
import { agentNameOf } from './user-approval.ts';

export class AgentPresenceTracker {
	private readonly seen = new Map<string, number>();
	constructor(private readonly now: () => number = Date.now) {}

	/** Records the agent of a request that names one. */
	noteRequest(req: Pick<FastifyRequest, 'headers' | 'query'>): void {
		const header = req.headers[AGENT_NAME_HEADER];
		if (header === undefined || header === '') return;
		this.note(agentNameOf(req as FastifyRequest));
	}

	note(name: string): void {
		this.seen.delete(name);
		this.seen.set(name, this.now());
		while (this.seen.size > AGENT_PRESENCE_MAX) {
			const oldest = this.seen.keys().next().value;
			if (oldest === undefined) break;
			this.seen.delete(oldest);
		}
	}

	/** Agents seen within the window, most recent first. */
	list(windowSec = AGENT_PRESENCE_WINDOW_SEC): AgentPresence {
		const cutoff = this.now() - windowSec * 1000;
		const agents = [...this.seen.entries()]
			.filter(([, t]) => t >= cutoff)
			.sort((a, b) => b[1] - a[1])
			.map(([name, t]) => ({ name, lastSeenAt: new Date(t).toISOString() }));
		return { agents, windowSec };
	}
}
