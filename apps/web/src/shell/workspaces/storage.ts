// Shell storage (S05:SH-020/021): a versioned key-value adapter. Every persisted shape carries a
// `version`; unsupported versions and corrupt values are discarded and the caller shows a warning toast.

export interface ShellStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

export function browserStorage(): ShellStorage | null {
	try {
		if (typeof localStorage === 'undefined') return null;
		const probe = '__jasper_probe__';
		localStorage.setItem(probe, '1');
		localStorage.removeItem(probe);
		return localStorage;
	} catch {
		return null;
	}
}

/** In-memory storage (tests, private mode). */
export function memoryStorage(
	seed: Record<string, string> = {},
): ShellStorage & { data: Map<string, string> } {
	const data = new Map(Object.entries(seed));
	return {
		data,
		getItem: (k) => data.get(k) ?? null,
		setItem: (k, v) => void data.set(k, v),
		removeItem: (k) => void data.delete(k),
	};
}

export type LoadResult<T> =
	| { status: 'ok'; value: T }
	| { status: 'missing'; value: T }
	| { status: 'reset'; value: T; reason: 'corrupt' | 'newer' | 'invalid' };

export type VersionedKey<T> = {
	key: string;
	version: number;
	/** Validates the payload; return null when invalid. */
	parse(data: unknown): T | null;
	fallback(): T;
};

/** Loads a versioned value; corrupt or newer data discards the key and returns the fallback. */
export function loadVersioned<T>(storage: ShellStorage | null, spec: VersionedKey<T>): LoadResult<T> {
	const raw = storage?.getItem(spec.key) ?? null;
	if (raw === null) return { status: 'missing', value: spec.fallback() };
	const reset = (reason: 'corrupt' | 'newer' | 'invalid'): LoadResult<T> => {
		try {
			storage?.removeItem(spec.key);
		} catch {
			/* ignore */
		}
		return { status: 'reset', value: spec.fallback(), reason };
	};
	let envelope: unknown;
	try {
		envelope = JSON.parse(raw);
	} catch {
		return reset('corrupt');
	}
	if (
		!envelope ||
		typeof envelope !== 'object' ||
		typeof (envelope as { version?: unknown }).version !== 'number'
	)
		return reset('corrupt');
	const { version, data } = envelope as { version: number; data: unknown };
	if (version > spec.version) return reset('newer');
	if (version < spec.version) return reset('invalid');
	let value: T | null = null;
	try {
		value = spec.parse(data);
	} catch {
		value = null;
	}
	return value === null ? reset('invalid') : { status: 'ok', value };
}

export function saveVersioned<T>(
	storage: ShellStorage | null,
	spec: Pick<VersionedKey<T>, 'key' | 'version'>,
	value: T,
): void {
	try {
		storage?.setItem(spec.key, JSON.stringify({ version: spec.version, data: value }));
	} catch {
		/* quota exceeded: keep working in memory */
	}
}
