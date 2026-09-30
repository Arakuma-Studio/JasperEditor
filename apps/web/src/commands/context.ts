// Builds CommandCtx values. The shell (WP-2A) owns the live context; this is the shared factory.
import type { EngineClient } from '@jasper/engine-client';
import { type EditorSession, TransportStore } from '@jasper/session';
import { PanelServices } from '../state/panel-services.ts';
import type { Capability, CommandCtx, FocusInfo, ToastRequest } from './types.ts';

export function createCommandContext(parts: {
	engine: EngineClient;
	session?: EditorSession | null;
	transport?: TransportStore;
	focus?: FocusInfo;
	services?: PanelServices;
	capabilities?: Iterable<Capability>;
	toast?: (r: ToastRequest) => void;
	openDialog?: (kind: string, props?: Record<string, unknown>) => void;
}): CommandCtx {
	const session = parts.session ?? null;
	return {
		session,
		transport: parts.transport ?? session?.transport ?? new TransportStore(),
		focus: parts.focus ?? { panel: null, instanceId: null },
		services: parts.services ?? new PanelServices(),
		engine: parts.engine,
		capabilities: new Set(parts.capabilities ?? []),
		ui: {
			toast: parts.toast ?? ((r) => console.info(`[toast:${r.kind}] ${r.message}`)),
			openDialog: parts.openDialog ?? ((kind) => console.info(`[dialog] ${kind}`)),
		},
	};
}
