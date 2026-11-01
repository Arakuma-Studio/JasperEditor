// Agents the engine reports as present (spec 18 AF-ACT-002 with AF-BRF-005's `GET /api/agent/presence`): jasper-mcp
// names its agent on every engine request, so an agent that only reads is known to the engine, not to this window.
// One poller per engine client, running only while something shows agent presence (the header chip, the Agent
// Activity panel) and the engine is connected. A failed or malformed answer empties the list quietly: the chip falls
// back to the window's own inference, and the next poll tries again.
import { AgentPresenceSchema } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import { useSyncExternalStore } from 'react';
import { useEngineOrNull } from '../state/engine.tsx';

/** How often the list is re-read while shown (the engine's own window is 15 min). */
export const PRESENCE_POLL_MS = 15_000;

export type ConnectedAgent = { name: string; lastSeenAt: string };

const NONE: readonly ConnectedAgent[] = [];

export class EnginePresencePoller {
	private agents: readonly ConnectedAgent[] = NONE;
	private readonly listeners = new Set<() => void>();
	private timer: ReturnType<typeof setTimeout> | null = null;
	/** Bumped when polling stops, so an answer that arrives later is dropped. */
	private generation = 0;

	constructor(
		private readonly fetch: () => Promise<unknown>,
		private readonly intervalMs = PRESENCE_POLL_MS,
	) {}

	getSnapshot = (): readonly ConnectedAgent[] => this.agents;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		if (this.listeners.size === 1) void this.poll(this.generation);
		return () => {
			this.listeners.delete(listener);
			if (this.listeners.size > 0) return;
			this.generation++;
			if (this.timer) clearTimeout(this.timer);
			this.timer = null;
		};
	};

	private async poll(generation: number): Promise<void> {
		let next: readonly ConnectedAgent[] = NONE;
		try {
			const parsed = AgentPresenceSchema.safeParse(await this.fetch());
			if (parsed.success) next = parsed.data.agents;
		} catch {
			// offline or refused: the window's own inference stands until the next poll
		}
		if (generation !== this.generation) return;
		// the chip shows names only: the same names keep the same snapshot (no re-render)
		if (!sameNames(next, this.agents)) {
			this.agents = next;
			for (const l of [...this.listeners]) l();
		}
		this.timer = setTimeout(() => void this.poll(generation), this.intervalMs);
	}
}

function sameNames(a: readonly ConnectedAgent[], b: readonly ConnectedAgent[]): boolean {
	return a.length === b.length && a.every((x, i) => x.name === b[i]!.name);
}

const pollers = new WeakMap<EngineClient, EnginePresencePoller>();
const idle = { subscribe: () => () => {}, getSnapshot: () => NONE };

/** The agents the engine reports as present (none without a connected engine). */
export function useEngineAgents(): readonly ConnectedAgent[] {
	const engine = useEngineOrNull();
	const client = engine?.status === 'connected' ? engine.client : null;
	let source: Pick<EnginePresencePoller, 'subscribe' | 'getSnapshot'> = idle;
	if (client) {
		let p = pollers.get(client);
		if (!p) {
			p = new EnginePresencePoller(() => client.agentPresence());
			pollers.set(client, p);
		}
		source = p;
	}
	return useSyncExternalStore(source.subscribe, source.getSnapshot);
}
