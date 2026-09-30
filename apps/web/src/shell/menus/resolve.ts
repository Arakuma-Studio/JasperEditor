// Menu model → rendered items (S05:MN-001/002/004/010/032, SH-031). Menus are data whose entries are
// command ids; labels, shortcuts, enabled and checked state come from the command registry. Commands
// that are not registered or not available stay visible but disabled, with the reason in a tooltip.
import type { ResolvedMenuItem } from '@jasper/ui';
import type { Platform, Runtime } from '../../commands/keymap-defaults.ts';
import { getCommand, isCommandChecked, isCommandEnabled } from '../../commands/registry.ts';
import type { Capability, CommandCtx } from '../../commands/types.ts';
import { shortcutFor } from '../keymap/format.ts';

/** Shell menu entries: the panel MenuModel (panels/types.ts) plus args, labels and dynamic providers. */
export type ShellMenuItem =
	| {
			type: 'command';
			command: string;
			label?: string;
			args?: unknown;
			/** Overrides for parameterized entries (workspace list, panel list). */
			checked?: boolean;
			shortcut?: string | null;
	  }
	| { type: 'submenu'; label: string; items: ShellMenuItem[] }
	| { type: 'separator' }
	| { type: 'label'; label: string }
	| { type: 'dynamic'; provider: string };

export type MenuEnv = {
	ctx: CommandCtx;
	platform: Platform;
	runtime: Runtime;
	run(commandId: string, args?: unknown): void;
	/** Dynamic sections (workspace list, panel list, recent projects…). */
	providers?: Record<string, (env: MenuEnv) => ShellMenuItem[]>;
	/** Everything disabled with this reason (menus that don't apply to the current mode, MN-010). */
	disabledReason?: string;
};

export const CAPABILITY_REASONS: Record<Capability, string> = {
	engine: 'Requires the engine. Start it with “pnpm dev:engine”.',
	nativeFfmpeg: 'Requires the native engine. Connect to an engine in Preferences ▸ Engine.',
	fframes: 'Requires the fframes renderer (jasper-mg) on the engine.',
	remotionServerRender: 'Requires Remotion rendering on the engine.',
	transcription: 'Requires transcription on the engine.',
	proxies: 'Requires the native engine to create proxies.',
	desktop: 'Available in the desktop app only.',
};

export const NOT_AVAILABLE_REASON = 'Not available yet in this build';

function humanize(id: string): string {
	const last = id.split('.').pop() ?? id;
	const words = last.replace(/([a-z])([A-Z])/g, '$1 $2');
	return words.charAt(0).toUpperCase() + words.slice(1);
}

export type CommandState = {
	label: string;
	enabled: boolean;
	reason?: string;
	checked?: boolean;
	shortcut: string | null;
	registered: boolean;
};

/** Label, enabled/checked state, disabled reason and shortcut for a command id. */
export function commandState(
	id: string,
	env: Pick<MenuEnv, 'ctx' | 'platform' | 'runtime'>,
	fallbackLabel?: string,
): CommandState {
	const cmd = getCommand(id);
	const shortcut = shortcutFor(id, env);
	if (!cmd)
		return {
			label: fallbackLabel ?? humanize(id),
			enabled: false,
			reason: NOT_AVAILABLE_REASON,
			shortcut,
			registered: false,
		};
	let label = cmd.label;
	try {
		label = cmd.labelFor?.(env.ctx) ?? cmd.label;
	} catch {
		/* keep static label */
	}
	const enabled = isCommandEnabled(cmd, env.ctx);
	let reason: string | undefined;
	if (!enabled) {
		if (cmd.capability && !env.ctx.capabilities.has(cmd.capability))
			reason = CAPABILITY_REASONS[cmd.capability];
		else {
			try {
				reason = cmd.disabledReason?.(env.ctx);
			} catch {
				reason = undefined;
			}
			reason ??= 'Not available in the current context';
		}
	}
	return {
		label,
		enabled,
		reason,
		checked: cmd.checked ? isCommandChecked(cmd, env.ctx) : undefined,
		shortcut,
		registered: true,
	};
}

let seq = 0;

/** Resolves a menu model for rendering; cleans up leading/trailing/double separators. */
export function resolveMenu(items: readonly ShellMenuItem[], env: MenuEnv, path = 'm'): ResolvedMenuItem[] {
	const out: ResolvedMenuItem[] = [];
	items.forEach((item, i) => {
		const key = `${path}.${i}`;
		switch (item.type) {
			case 'separator':
				out.push({ type: 'separator', id: `${key}.sep${++seq}` });
				break;
			case 'label':
				out.push({ type: 'label', id: key, label: item.label });
				break;
			case 'dynamic': {
				const provided = env.providers?.[item.provider]?.(env) ?? [];
				out.push(...resolveMenu(provided, env, `${key}.${item.provider}`));
				break;
			}
			case 'submenu': {
				const children = resolveMenu(item.items, env, key);
				out.push({
					type: 'submenu',
					id: key,
					label: item.label,
					items: children,
					disabled: children.every((c) => c.type !== 'item' || c.disabled) || undefined,
				});
				break;
			}
			default: {
				const st = commandState(item.command, env, item.label);
				const disabled = !!env.disabledReason || !st.enabled;
				out.push({
					type: 'item',
					id: item.args === undefined ? item.command : `${item.command}:${JSON.stringify(item.args)}`,
					// Parameterized/dynamic entries (workspace and panel lists) keep their own label.
					label:
						item.label && (item.args !== undefined || item.checked !== undefined) ? item.label : st.label,
					shortcut: item.shortcut !== undefined ? item.shortcut : st.shortcut,
					disabled,
					disabledReason: env.disabledReason ?? st.reason,
					checked: item.checked ?? st.checked,
					onSelect: () => env.run(item.command, item.args),
				});
			}
		}
	});
	// Separator hygiene.
	const cleaned: ResolvedMenuItem[] = [];
	for (const it of out) {
		if (it.type === 'separator' && (cleaned.length === 0 || cleaned.at(-1)?.type === 'separator')) continue;
		cleaned.push(it);
	}
	while (cleaned.at(-1)?.type === 'separator') cleaned.pop();
	return cleaned;
}
