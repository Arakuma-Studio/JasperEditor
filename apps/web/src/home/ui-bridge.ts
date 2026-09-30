// A CommandCtx for WP-2E surfaces (Project panel footer, Export mode, banners) until the shell (WP-2A)
// provides the live context. Toasts go to the WP-2E notice host.
import type { EditorSession } from '@jasper/session';
import { useSessionOrNull } from '@jasper/session/react';
import { useMemo } from 'react';
import { createCommandContext } from '../commands/context.ts';
import { getCommand, runCommand } from '../commands/registry.ts';
import type { CommandCtx, FocusInfo } from '../commands/types.ts';
import { useCapabilities, useEngine } from '../state/engine.tsx';
import { toastFromRequest } from './notices.tsx';

export function useLocalCommandCtx(focus?: FocusInfo): CommandCtx {
	const engine = useEngine();
	const session = useSessionOrNull();
	const { flags } = useCapabilities();
	return useMemo(
		() =>
			createCommandContext({
				engine: engine.client,
				session: session as EditorSession | null,
				focus,
				capabilities: flags,
				toast: (r) => toastFromRequest(r),
			}),
		[engine.client, session, flags, focus],
	);
}

/** Runs a UI command if it is registered; returns false when it is not (callers hide/disable the entry). */
export async function runIfRegistered(id: string, ctx: CommandCtx, args?: unknown): Promise<boolean> {
	if (!getCommand(id)) return false;
	const r = await runCommand(id, ctx, args);
	return r.ran;
}
