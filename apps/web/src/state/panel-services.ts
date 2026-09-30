// Cross-panel services (S05:SH-005): panels publish handles (Program player, timeline viewport…)
// keyed by service name and instance id. Callers must tolerate "not mounted".

/** Known services; wave-2 packages extend this map additively (declaration merging). */
export interface PanelServiceMap {
	programPlayer: {
		seekTo(frame: number): void;
		play(): void;
		pause(): void;
		getContainer(): HTMLElement | null;
	};
	sourcePlayer: { seekTo(frame: number): void; play(): void; pause(): void };
	timelineViewport: {
		scrollToFrame(frame: number): void;
		frameAtClientX(x: number): number;
		getScrollContainer(): HTMLElement | null;
	};
}
export type PanelServiceName = keyof PanelServiceMap;

export class ServiceNotMountedError extends Error {
	constructor(readonly service: string) {
		super(`${service} is not mounted`);
		this.name = 'ServiceNotMountedError';
	}
}

type Entry = { instanceId: string; service: unknown; at: number };

export class PanelServices {
	private readonly map = new Map<string, Entry[]>();
	private readonly listeners = new Set<() => void>();
	private seq = 0;

	/** Publishes a service; returns the unregister function (call it on unmount). */
	register<K extends PanelServiceName>(name: K, instanceId: string, service: PanelServiceMap[K]): () => void {
		const list = (this.map.get(name) ?? []).filter((e) => e.instanceId !== instanceId);
		const entry = { instanceId, service, at: ++this.seq };
		list.push(entry);
		this.map.set(name, list);
		this.emit();
		return () => {
			const cur = this.map.get(name);
			if (!cur) return;
			const next = cur.filter((e) => e !== entry);
			if (next.length) this.map.set(name, next);
			else this.map.delete(name);
			this.emit();
		};
	}

	/** A specific instance, or the most recently mounted one; null when not mounted. */
	get<K extends PanelServiceName>(name: K, instanceId?: string): PanelServiceMap[K] | null {
		const list = this.map.get(name);
		if (!list?.length) return null;
		const e = instanceId
			? list.find((x) => x.instanceId === instanceId)
			: list.reduce((a, b2) => (a.at > b2.at ? a : b2));
		return (e?.service as PanelServiceMap[K]) ?? null;
	}

	require<K extends PanelServiceName>(name: K, instanceId?: string): PanelServiceMap[K] {
		const s = this.get(name, instanceId);
		if (!s) throw new ServiceNotMountedError(name);
		return s;
	}

	/** Calls into a service if mounted; otherwise runs `onMissing` (e.g. a toast) and returns undefined. */
	with<K extends PanelServiceName, R>(
		name: K,
		fn: (s: PanelServiceMap[K]) => R,
		onMissing?: () => void,
	): R | undefined {
		const s = this.get(name);
		if (!s) {
			onMissing?.();
			return undefined;
		}
		return fn(s);
	}

	isMounted(name: PanelServiceName): boolean {
		return !!this.map.get(name)?.length;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	private emit() {
		for (const l of [...this.listeners]) l();
	}
}
