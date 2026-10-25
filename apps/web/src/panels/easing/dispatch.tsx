// Easing panel ▸ how the panel runs its actions: through the UI command registry (the same commands as the
// palette, menus and shortcuts), so a disabled action shows the command's reason and a refusal its toast. Tests
// provide a stub with <EaseDispatchProvider>.
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import type { Platform } from '../../commands/keymap-defaults.ts';
import { getCommand, isCommandEnabled } from '../../commands/registry.ts';
import type { ToastRequest } from '../../commands/types.ts';
import { t } from '../../i18n/runtime.ts';
import { detectPlatform } from '../../runtime/platform.ts';
import { useShellRuntimeOrNull } from '../../shell/context.tsx';

export type EaseDispatch = {
	/** Runs a UI command by id; resolves true when it ran. */
	run(id: string, args?: unknown): Promise<boolean>;
	/** Why the command cannot run now (undefined = it can). */
	reason(id: string): string | undefined;
	toast(r: ToastRequest): void;
	platform: Platform;
};

const Ctx = createContext<EaseDispatch | null>(null);

export function EaseDispatchProvider(props: { value: EaseDispatch; children?: ReactNode }) {
	return <Ctx.Provider value={props.value}>{props.children}</Ctx.Provider>;
}

const noShell = () => t('The editor is still starting');

/** The dispatch of the surrounding provider, else the shell's command runtime. */
export function useEaseDispatch(): EaseDispatch {
	const given = useContext(Ctx);
	const shell = useShellRuntimeOrNull();
	return useMemo((): EaseDispatch => {
		if (given) return given;
		const platform = shell?.platform ?? detectPlatform();
		if (!shell) return { run: async () => false, reason: () => noShell(), toast: () => {}, platform };
		return {
			run: (id, args) => shell.run(id, args),
			reason(id) {
				const cmd = getCommand(id);
				if (!cmd) return noShell();
				const ctx = shell.getCtx();
				if (isCommandEnabled(cmd, ctx)) return undefined;
				try {
					return cmd.disabledReason?.(ctx) ?? t('Not available right now');
				} catch {
					return t('Not available right now');
				}
			},
			toast: (r) => shell.getCtx().ui.toast(r),
			platform,
		};
	}, [given, shell]);
}
