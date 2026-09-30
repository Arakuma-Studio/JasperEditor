// Event fan-out for `GET /events` (S04:ENG-023, §19.3, ARCHITECTURE §9.2): monotonic ids, a ring buffer
// so reconnecting clients resume with `?since=<id>`, and projectId filtering.
import type { EngineEventType, EventEnvelope, EventPayload } from '@jasper/api';

export type EventListener = (e: EventEnvelope) => void;
export type EventFilter = { projectId?: string };

export const DEFAULT_RING_SIZE = 2000;

/** Events without a projectId are global and reach every subscriber. */
export function matchesFilter(e: EventEnvelope, f: EventFilter): boolean {
	return !f.projectId || e.projectId === undefined || e.projectId === f.projectId;
}

export class Broadcaster {
	private nextId = 1;
	private readonly ring: EventEnvelope[] = [];
	private readonly listeners = new Set<{ fn: EventListener; filter: EventFilter }>();

	constructor(
		private readonly ringSize = DEFAULT_RING_SIZE,
		private readonly now: () => Date = () => new Date(),
	) {}

	/** Id of the most recent event (0 before the first). */
	get lastId(): number {
		return this.nextId - 1;
	}

	/** Publishes a typed event; returns the envelope. */
	publish<T extends EngineEventType>(type: T, payload: EventPayload<T>, projectId?: string): EventEnvelope;
	publish(type: string, payload: unknown, projectId?: string): EventEnvelope;
	publish(type: string, payload: unknown, projectId?: string): EventEnvelope {
		const e: EventEnvelope = {
			id: this.nextId++,
			type,
			createdAt: this.now().toISOString(),
			...(projectId ? { projectId } : {}),
			payload,
		};
		this.ring.push(e);
		if (this.ring.length > this.ringSize) this.ring.splice(0, this.ring.length - this.ringSize);
		for (const l of this.listeners) {
			if (!matchesFilter(e, l.filter)) continue;
			try {
				l.fn(e);
			} catch {
				// a broken subscriber never breaks publishing
			}
		}
		return e;
	}

	/**
	 * Events after `since` still in the ring buffer. `complete` is false when events between `since` and
	 * the oldest buffered event were dropped (the client should re-fetch state).
	 */
	since(since: number, filter: EventFilter = {}): { events: EventEnvelope[]; complete: boolean } {
		const oldest = this.ring[0]?.id ?? this.nextId;
		const complete = since + 1 >= oldest || since >= this.lastId;
		return { events: this.ring.filter((e) => e.id > since && matchesFilter(e, filter)), complete };
	}

	subscribe(fn: EventListener, filter: EventFilter = {}): () => void {
		const entry = { fn, filter };
		this.listeners.add(entry);
		return () => this.listeners.delete(entry);
	}

	get subscriberCount(): number {
		return this.listeners.size;
	}

	/** A heartbeat envelope (not buffered, id = current last id so resuming stays correct). */
	heartbeat(): EventEnvelope {
		return { id: this.lastId, type: 'engine.heartbeat', createdAt: this.now().toISOString(), payload: {} };
	}
}
