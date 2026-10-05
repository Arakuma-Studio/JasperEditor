// Row A — title/menu bar (S05:HD-001/002/005/006): app mark, in-app menubar built from the menu model
// (MN-001), centered document title "<project> — <sequence> • Edited" / "(Read-only)", and window
// controls on Electron. Empty areas are a window drag region on Electron/WCO.
import type { SessionState } from '@jasper/session';
import { useSessionOrNull, useStoreSelector } from '@jasper/session/react';
import { DropdownMenu, IconButton, MenuBar, type MenuBarMenu } from '@jasper/ui';
import { useMemo } from 'react';
import { WindowControls } from '../../runtime/window-controls.tsx';
import { useCommandCtx, useShellRuntime } from '../context.tsx';
import type { MenubarMenuModel } from '../menus/model.ts';
import { type MenuEnv, resolveMenu } from '../menus/resolve.ts';

const NULL_STORE = { getState: (): SessionState | null => null, subscribe: () => () => {} };

type DocumentTitle = { full: string; hint: string } | null;

export function activeSequenceName(s: SessionState | null): string | null {
	if (!s?.activeSequenceId) return null;
	for (const it of Object.values(s.document.items))
		if (it.kind === 'sequence' && (it as { sequenceId?: string }).sequenceId === s.activeSequenceId)
			return it.name;
	return null;
}

/** HD-002 title text. */
export function useDocumentTitle(): DocumentTitle {
	const session = useSessionOrNull();
	const t = useStoreSelector(session?.store ?? NULL_STORE, (s: SessionState | null) =>
		s
			? `${s.document.name}\u0000${activeSequenceName(s) ?? ''}\u0000${s.dirty ? 1 : 0}\u0000${s.readOnly ? 1 : 0}`
			: null,
	);
	if (!t || !session) return null;
	const [name = '', seq, dirty, ro] = t.split('\u0000');
	const full = `${name}${seq ? ` — ${seq}` : ''}${dirty === '1' ? ' • Edited' : ''}${ro === '1' ? ' (Read-only)' : ''}`;
	return { full, hint: `Project id: ${session.projectId}` };
}

export function useMenubarMenus(
	menus: readonly MenubarMenuModel[],
	env: Omit<MenuEnv, 'ctx'>,
	editMode: boolean,
): MenuBarMenu[] {
	const getCtx = useCommandCtx();
	return useMemo(
		() =>
			menus.map((m) => ({
				id: m.id,
				label: m.label,
				items: () =>
					resolveMenu(m.items, {
						...env,
						ctx: getCtx(),
						disabledReason: m.editOnly && !editMode ? 'Not available outside Edit mode' : undefined,
					}),
			})),
		[menus, env, getCtx, editMode],
	);
}

export function TitleBar(props: {
	menus: readonly MenubarMenuModel[];
	env: Omit<MenuEnv, 'ctx'>;
	editMode: boolean;
}) {
	const title = useDocumentTitle();
	const runtime = useShellRuntime();
	const menus = useMenubarMenus(props.menus, props.env, props.editMode);
	return (
		<div
			className="pr-drag relative flex h-[var(--pr-title-h)] shrink-0 items-center gap-1 bg-pr-header pl-1.5"
			data-testid="title-bar"
		>
			<span
				aria-hidden
				className="mr-1 inline-flex size-[18px] shrink-0 items-center justify-center rounded-[4px] bg-pr-accent-fill font-pr text-[11px] font-semibold text-pr-on-accent"
			>
				J
			</span>
			<div className="pr-no-drag h-full">
				<MenuBar menus={menus} />
			</div>
			<div className="pointer-events-none absolute inset-x-0 flex justify-center">
				<span
					className="pointer-events-auto max-w-[40%] truncate font-pr text-pr-ui text-pr-text"
					title={title ? `${title.full}\n${title.hint}` : undefined}
					data-testid="document-title"
				>
					{title?.full ?? 'JasperEditor'}
				</span>
			</div>
			<div className="ml-auto flex h-full items-center">
				{runtime.runtime === 'desktop' ? <WindowControls /> : null}
			</div>
		</div>
	);
}

/** ≡ app menu (compact header, HD-005): the menubar menus as submenus. */
export function AppMenu({ menus }: { menus: MenuBarMenu[] }) {
	return (
		<DropdownMenu
			trigger={
				<IconButton icon="app.menu" label="Application menu" className="pr-no-drag" data-testid="app-menu" />
			}
			items={() =>
				menus.map((m) => ({ type: 'submenu' as const, id: m.id, label: m.label, items: [...m.items()] }))
			}
		/>
	);
}
