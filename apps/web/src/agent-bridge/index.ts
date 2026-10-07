// Agent bridge entry points (ARCHITECTURE §11): one AgentBridge per open session, `window.jasper` in dev
// and Electron builds, and React hooks for the session host and the shell's approval cards (shell/AgentApprovals.tsx).
import type { EngineClient } from '@jasper/engine-client';
import type { EditorSession } from '@jasper/session';
import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { useEngineClient } from '../state/engine.tsx';
import { AgentBridge, type AgentBridgeState, type JasperAgentApi } from './bridge.ts';

export * from './bridge.ts';
export * from './relay-client.ts';
export * from './ui-automation.ts';

declare global {
	interface Window {
		/** In-page agent API (dev and Electron builds; `localStorage['jasper:agent-bridge'] = '1'` elsewhere). */
		jasper?: JasperAgentApi;
	}
}

const bridges = new WeakMap<EditorSession, AgentBridge>();
const listeners = new Set<() => void>();

/** Whether `window.jasper` is installed (ARCHITECTURE §11: dev and Electron builds). */
function shouldExposeWindowApi(): boolean {
	if (typeof window === 'undefined') return false;
	if (import.meta.env?.DEV) return true;
	if ((window as { jasperDesktop?: unknown }).jasperDesktop) return true;
	try {
		return window.localStorage?.getItem('jasper:agent-bridge') === '1';
	} catch {
		return false;
	}
}

/** Starts the bridge for a session; returns the stop function. */
function startAgentBridge(session: EditorSession, engine: EngineClient): () => void {
	const existing = bridges.get(session);
	if (existing) existing.dispose();
	// Every session registers with the engine relay (the in-memory `demo` project too, so agents can
	// drive it live; with no editor open its id is unknown to the engine store → 404).
	const bridge = new AgentBridge(session, engine, { relay: true }).start();
	bridges.set(session, bridge);
	const expose = shouldExposeWindowApi();
	const api = bridge.api();
	if (expose) window.jasper = api;
	for (const l of [...listeners]) l();
	return () => {
		bridge.dispose();
		if (bridges.get(session) === bridge) bridges.delete(session);
		if (expose && window.jasper === api) delete window.jasper;
		for (const l of [...listeners]) l();
	};
}

/**
 * Session-host hook (apps/web/src/state/session-host.tsx): runs the bridge while `session` is open.
 */
export function useAgentBridge(session: EditorSession | null): void {
	const engine = useEngineClient();
	useEffect(() => (session ? startAgentBridge(session, engine) : undefined), [session, engine]);
}

/** The bridge for a session, re-rendering when bridges start or stop. */
export function useAgentBridgeFor(session: EditorSession | null): AgentBridge | null {
	const [, setTick] = useState(0);
	useEffect(() => {
		const l = () => setTick((n) => n + 1);
		listeners.add(l);
		return () => {
			listeners.delete(l);
		};
	}, []);
	return session ? (bridges.get(session) ?? null) : null;
}

const EMPTY: AgentBridgeState = { activity: [], approvals: [], relay: 'off' };
const emptyStore = {
	getState: () => EMPTY,
	getInitialState: () => EMPTY,
	setState: () => undefined,
	subscribe: () => () => undefined,
};

/** Selects from a bridge's store (the empty state when there is no bridge). */
export function useAgentBridgeState<T>(bridge: AgentBridge | null, selector: (s: AgentBridgeState) => T): T {
	return useStore((bridge?.store ?? emptyStore) as AgentBridge['store'], selector);
}
