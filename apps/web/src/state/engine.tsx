import {
	AGENT_INPUT_HEADER,
	type EngineCapabilities,
	type EngineJob,
	type EventEnvelope,
	TERMINAL_JOB_STATES,
	type TypedEvent,
} from '@jasper/api';
import { EngineClient, EngineError, type EventStreamState } from '@jasper/engine-client';
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import { agentInputActive } from '../agent-bridge/agent-input.ts';
import type { Capability } from '../commands/types.ts';

export type EngineStatus = 'connecting' | 'connected' | 'disconnected';

export type EngineState = {
	client: EngineClient;
	status: EngineStatus;
	version: string | null;
	capabilities: EngineCapabilities | null;
	/** Why capabilities could not be loaded. */
	capabilitiesError: string | null;
	events: EventStreamState;
	/** Subscribe to every event envelope. */
	subscribe(listener: (e: TypedEvent | null, raw: EventEnvelope) => void): () => void;
	refresh(): void;
};

const EngineContext = createContext<EngineState | null>(null);

type EarlyRequest = { url: string; response: Promise<Response>; at: number };
/** An early answer is only used while it is this fresh (the page is still starting). */
const EARLY_MAX_AGE_MS = 15_000;

/**
 * polish (project open): `/editor-boot.js` starts fetching the project file before the bundle has loaded; the first
 * GET of exactly that URL takes the answer instead of asking again. A failed early request is asked again normally.
 */
export function fetchWithEarly(real: typeof fetch = (input, init) => fetch(input, init)): typeof fetch {
	return (input, init) => {
		const w = typeof window === 'undefined' ? null : (window as unknown as { __jasperEarly?: EarlyRequest });
		const early = w?.__jasperEarly;
		if (
			w &&
			early &&
			typeof input === 'string' &&
			input === early.url &&
			(!init?.method || init.method.toUpperCase() === 'GET')
		) {
			w.__jasperEarly = undefined;
			if (Date.now() - early.at <= EARLY_MAX_AGE_MS)
				return early.response.then(
					(r) => r,
					() => real(input, init),
				);
		}
		return real(input, init);
	};
}

/**
 * The editor's engine client (same origin). Security review AGT-3: what the editor asks of the engine while it
 * handles an agent's live-UI input (a `ui_click` on Delete in the Effects panel, Preferences ▸ Media Cache ▸
 * Clean…) is the agent's request; it is marked as such, and the engine asks the user about destructive ones like
 * it does for the MCP tools.
 */
export function createEditorEngineClient(): EngineClient {
	return new EngineClient({
		baseUrl: '',
		fetch: fetchWithEarly(),
		requestHeaders: (): Record<string, string> => (agentInputActive() ? { [AGENT_INPUT_HEADER]: '1' } : {}),
	});
}

export function EngineProvider(props: { children?: ReactNode; client?: EngineClient }) {
	const client = useMemo(() => props.client ?? createEditorEngineClient(), [props.client]);
	const [status, setStatus] = useState<EngineStatus>('connecting');
	const [version, setVersion] = useState<string | null>(null);
	const [capabilities, setCapabilities] = useState<EngineCapabilities | null>(null);
	const [capabilitiesError, setCapabilitiesError] = useState<string | null>(null);
	const [events, setEvents] = useState<EventStreamState>('closed');
	const [nonce, setNonce] = useState(0);
	const listeners = useRef(new Set<(e: TypedEvent | null, raw: EventEnvelope) => void>());

	useEffect(() => {
		let cancelled = false;
		void nonce;
		setStatus('connecting');
		client
			.health()
			.then(async (h) => {
				if (cancelled) return;
				setVersion(h.version);
				setStatus('connected');
				try {
					const caps = await client.capabilities();
					if (!cancelled) {
						setCapabilities(caps);
						setCapabilitiesError(null);
					}
				} catch (e) {
					if (!cancelled) setCapabilitiesError(e instanceof EngineError ? e.code : String(e));
				}
			})
			.catch(() => {
				if (!cancelled) setStatus('disconnected');
			});
		return () => {
			cancelled = true;
		};
	}, [client, nonce]);

	useEffect(() => {
		if (status !== 'connected') return;
		const stream = client.openEvents(
			{},
			{
				onEnvelope: (raw) => {
					for (const l of [...listeners.current]) l(null, raw);
				},
				onEvent: (e) => {
					for (const l of [...listeners.current]) l(e, e);
				},
				onStateChange: (s) => setEvents(s),
			},
		);
		return () => stream.close();
	}, [client, status]);

	const subscribe = useCallback<EngineState['subscribe']>((l) => {
		listeners.current.add(l);
		return () => listeners.current.delete(l);
	}, []);
	const refresh = useCallback(() => setNonce((n) => n + 1), []);
	const value = useMemo<EngineState>(
		() => ({ client, status, version, capabilities, capabilitiesError, events, subscribe, refresh }),
		[client, status, version, capabilities, capabilitiesError, events, subscribe, refresh],
	);
	return <EngineContext.Provider value={value}>{props.children}</EngineContext.Provider>;
}

export function useEngine(): EngineState {
	const e = useContext(EngineContext);
	if (!e) throw new Error('useEngine must be used inside <EngineProvider>');
	return e;
}

/** The engine state, or null outside <EngineProvider> (components that also mount standalone/in tests). */
export function useEngineOrNull(): EngineState | null {
	return useContext(EngineContext);
}

export function useEngineClient(): EngineClient {
	return useEngine().client;
}

/** Effective capability flags for command gating (S05:SH-030). */
export function useCapabilities(): {
	capabilities: EngineCapabilities | null;
	flags: ReadonlySet<Capability>;
} {
	const { capabilities, status } = useEngine();
	return useMemo(() => {
		const flags = new Set<Capability>();
		if (status === 'connected') flags.add('engine');
		if (capabilities?.render.native) {
			flags.add('nativeFfmpeg');
			flags.add('proxies');
		}
		if (capabilities?.render.fframes === 'ready') flags.add('fframes');
		if (capabilities?.render.remotionLocal === 'ready') flags.add('remotionServerRender');
		if (capabilities?.features?.speech?.status === 'ready') flags.add('transcription');
		if (typeof window !== 'undefined' && window.jasperDesktop) flags.add('desktop');
		return { capabilities, flags };
	}, [capabilities, status]);
}

/** Calls `handler` for every typed engine event (optionally filtered by type). */
export function useEngineEvents(
	handler: (e: TypedEvent) => void,
	types?: readonly TypedEvent['type'][],
): void {
	const { subscribe } = useEngine();
	const ref = useRef(handler);
	ref.current = handler;
	const key = types?.join(',') ?? '';
	useEffect(
		() =>
			subscribe((e) => {
				if (e && (!key || key.split(',').includes(e.type))) ref.current(e);
			}),
		[subscribe, key],
	);
}

/** Jobs list kept current from `GET /api/jobs` plus job.* events (S04:JB-040/041). */
export function useJobs(opts: { projectId?: string; activeOnly?: boolean } = {}): {
	jobs: EngineJob[];
	error: string | null;
} {
	const { client, status } = useEngine();
	const [jobs, setJobs] = useState<Map<string, EngineJob>>(new Map());
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		if (status !== 'connected') return;
		let cancelled = false;
		client
			.listJobs({
				...(opts.activeOnly ? { active: '1' } : {}),
				...(opts.projectId ? { projectId: opts.projectId } : {}),
			})
			.then((r) => {
				if (!cancelled) setJobs(new Map(r.jobs.map((j) => [j.id, j])));
			})
			.catch((e) => !cancelled && setError(e instanceof EngineError ? e.code : String(e)));
		return () => {
			cancelled = true;
		};
	}, [client, status, opts.projectId, opts.activeOnly]);
	useEngineEvents(
		(e) => {
			if (e.type !== 'job.created' && e.type !== 'job.updated' && e.type !== 'job.finished') return;
			const job = e.payload;
			if (opts.projectId && job.projectId !== opts.projectId) return;
			setJobs((m) => {
				const next = new Map(m);
				if (opts.activeOnly && TERMINAL_JOB_STATES.has(job.state)) next.delete(job.id);
				else next.set(job.id, job);
				return next;
			});
		},
		['job.created', 'job.updated', 'job.finished'],
	);
	return { jobs: [...jobs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)), error };
}
