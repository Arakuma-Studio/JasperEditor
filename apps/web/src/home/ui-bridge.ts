// A CommandCtx for WP-2E surfaces (Project panel footer, Export mode, banners). Toasts go to the WP-2E notice
// host. Inside the editor shell the context shares the shell's PanelServices, so shell-driven commands
// (`panel.open.jobs`, `panel.open.motionTemplates`, …) are enabled from these surfaces too.
import { useSessionOrNull } from '@jasper/session/react';
import { useMemo } from 'react';
import { createCommandContext } from '../commands/context.ts';
import { getCommand, runCommand } from '../commands/registry.ts';
import type { CommandCtx, FocusInfo } from '../commands/types.ts';
import { useShellRuntimeOrNull } from '../shell/context.tsx';
import { useCapabilities, useEngine } from '../state/engine.tsx';
import { toastFromRequest } from './notices.tsx';

export function useLocalCommandCtx(focus?: FocusInfo): CommandCtx {
	const engine = useEngine();
	const session = useSessionOrNull();
	const { flags } = useCapabilities();
	const services = useShellRuntimeOrNull()?.services;
	return useMemo(
		() =>
			createCommandContext({
				engine: engine.client,
				session,
				focus,
				capabilities: flags,
				toast: toastFromRequest,
				...(services ? { services } : {}),
			}),
		[engine.client, session, flags, focus, services],
	);
}

/** Runs a UI command if it is registered; returns false when it is not (callers hide/disable the entry). */
export async function runIfRegistered(id: string, ctx: CommandCtx, args?: unknown): Promise<boolean> {
	if (!getCommand(id)) return false;
	const r = await runCommand(id, ctx, args);
	return r.ran;
}
