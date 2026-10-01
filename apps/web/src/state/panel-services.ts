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

type Entry = { instanceId: string; service: unknown };

export class PanelServices {
	private readonly map = new Map<string, Entry[]>();

	/** Publishes a service; returns the unregister function (call it on unmount). */
	register<K extends PanelServiceName>(name: K, instanceId: string, service: PanelServiceMap[K]): () => void {
		const list = (this.map.get(name) ?? []).filter((e) => e.instanceId !== instanceId);
		const entry = { instanceId, service };
		list.push(entry);
		this.map.set(name, list);
		return () => {
			const cur = this.map.get(name);
			if (!cur) return;
			const next = cur.filter((e) => e !== entry);
			if (next.length) this.map.set(name, next);
			else this.map.delete(name);
		};
	}

	/** A specific instance, or the most recently mounted one; null when not mounted. */
	get<K extends PanelServiceName>(name: K, instanceId?: string): PanelServiceMap[K] | null {
		const list = this.map.get(name);
		if (!list?.length) return null;
		const e = instanceId ? list.find((x) => x.instanceId === instanceId) : list.at(-1);
		return (e?.service as PanelServiceMap[K]) ?? null;
	}
}
