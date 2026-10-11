// Menu primitives (S05:MN-001/002/020/021/030): one data model renders the menubar, dropdowns and
// context menus. The app resolves its command-id menu model into `ResolvedMenuItem`s (labels, shortcuts,
// enabled/checked state from the command registry); this module only draws them.
import { ContextMenu as RContext, DropdownMenu as RDropdown, Menubar as RMenubar } from 'radix-ui';
import type { ReactNode } from 'react';
import { cx } from '../cx.ts';
import { Icon } from '../icons/Icon.tsx';
import type { IconId } from '../icons/registry.ts';
import { Tooltip } from '../primitives/Tooltip.tsx';

export type ResolvedMenuItem =
	| {
			type: 'item';
			id: string;
			label: string;
			shortcut?: string | null;
			icon?: IconId;
			disabled?: boolean;
			/** Why it is disabled (tooltip, S05:SH-031, MN-032). */
			disabledReason?: string;
			/** `undefined` = not checkable; boolean = check column state. */
			checked?: boolean;
			onSelect(): void;
	  }
	| {
			type: 'submenu';
			id: string;
			label: string;
			icon?: IconId;
			disabled?: boolean;
			items: ResolvedMenuItem[];
	  }
	| { type: 'separator'; id: string }
	| { type: 'label'; id: string; label: string };

/** Radix exposes the same part names for DropdownMenu, ContextMenu and Menubar. */
type Kit = Pick<
	typeof RDropdown,
	| 'Item'
	| 'CheckboxItem'
	| 'ItemIndicator'
	| 'Separator'
	| 'Label'
	| 'Sub'
	| 'SubTrigger'
	| 'SubContent'
	| 'Portal'
>;

// All menu kinds expose this Popper height variable; their kind-specific aliases are not interchangeable.
export const MENU_CONTENT =
	'z-[var(--pr-z-popover)] min-w-[200px] max-h-[var(--radix-popper-available-height,calc(100vh_-_16px))] overflow-y-auto ' +
	'rounded-pr-menu border border-pr-menu-border bg-pr-menu p-1 font-pr text-pr-ui text-pr-text shadow-pr-overlay ' +
	'outline-none select-none';

const ITEM =
	'relative flex h-6 cursor-default items-center gap-2 rounded-[3px] pr-2 pl-[26px] outline-none ' +
	'data-[highlighted]:bg-pr-accent-fill data-[highlighted]:text-pr-on-accent ' +
	'data-[disabled]:text-pr-dim data-[disabled]:data-[highlighted]:bg-pr-hover data-[disabled]:data-[highlighted]:text-pr-dim';

function Shortcut({ value }: { value?: string | null }) {
	if (!value) return null;
	return (
		<span
			className="ml-auto pl-6 text-pr-muted pr-tabular group-data-[highlighted]:text-pr-on-accent"
			data-shortcut
		>
			{value}
		</span>
	);
}

function Lead({ icon }: { icon?: IconId }) {
	if (!icon) return null;
	return (
		<span className="absolute left-1.5 inline-flex text-pr-icon">
			<Icon id={icon} size={14} />
		</span>
	);
}

function renderItems(kit: Kit, items: readonly ResolvedMenuItem[], depth = 0): ReactNode[] {
	return items.map((item) => {
		switch (item.type) {
			case 'separator':
				return <kit.Separator key={item.id} className="mx-1 my-1 h-px bg-pr-border" />;
			case 'label':
				return (
					<kit.Label key={item.id} className="px-[26px] pt-1 pb-0.5 text-pr-small text-pr-muted">
						{item.label}
					</kit.Label>
				);
			case 'submenu':
				// MN-032: at most two submenu levels; deeper entries are flattened.
				if (depth >= 2) return renderItems(kit, item.items, depth);
				return (
					<kit.Sub key={item.id}>
						<kit.SubTrigger
							className={cx(ITEM, 'group data-[state=open]:bg-pr-pressed')}
							disabled={item.disabled}
						>
							<Lead icon={item.icon} />
							<span className="truncate">{item.label}</span>
							<span className="ml-auto pl-6 inline-flex">
								<Icon id="app.chevronRight" size={12} />
							</span>
						</kit.SubTrigger>
						<kit.Portal>
							<kit.SubContent className={MENU_CONTENT} sideOffset={2} alignOffset={-5} collisionPadding={8}>
								{renderItems(kit, item.items, depth + 1)}
							</kit.SubContent>
						</kit.Portal>
					</kit.Sub>
				);
			default: {
				const common = {
					className: cx(ITEM, 'group'),
					disabled: item.disabled,
					'data-command-id': item.id,
					'aria-description': item.disabled ? item.disabledReason : undefined,
				};
				const body = (
					<>
						{item.checked !== undefined ? (
							<kit.ItemIndicator className="absolute left-1.5 inline-flex">
								<Icon id="app.check" size={14} />
							</kit.ItemIndicator>
						) : (
							<Lead icon={item.icon} />
						)}
						<span className="truncate">{item.label}</span>
						<Shortcut value={item.shortcut} />
					</>
				);
				const node =
					item.checked !== undefined ? (
						<kit.CheckboxItem
							key={item.id}
							{...common}
							checked={item.checked}
							onSelect={() => item.onSelect()}
						>
							{body}
						</kit.CheckboxItem>
					) : (
						<kit.Item key={item.id} {...common} onSelect={() => item.onSelect()}>
							{body}
						</kit.Item>
					);
				return item.disabled && item.disabledReason ? (
					<Tooltip key={item.id} content={item.label} detail={item.disabledReason} side="right">
						{node}
					</Tooltip>
				) : (
					node
				);
			}
		}
	});
}

export type DropdownMenuProps = {
	/** A single element used as the trigger (usually an IconButton or a text button). */
	trigger: ReactNode;
	items: readonly ResolvedMenuItem[] | (() => readonly ResolvedMenuItem[]);
	align?: 'start' | 'center' | 'end';
	side?: 'top' | 'right' | 'bottom' | 'left';
	open?: boolean;
	onOpenChange?(open: boolean): void;
	modal?: boolean;
};

/** Dropdown menu below its trigger; flips when there is no room (S05:MN-020/021). */
export function DropdownMenu({
	trigger,
	items,
	align = 'start',
	side = 'bottom',
	open,
	onOpenChange,
	modal = false,
}: DropdownMenuProps) {
	return (
		<RDropdown.Root open={open} onOpenChange={onOpenChange} modal={modal}>
			<RDropdown.Trigger asChild>{trigger}</RDropdown.Trigger>
			<RDropdown.Portal>
				<RDropdown.Content
					className={MENU_CONTENT}
					align={align}
					side={side}
					sideOffset={2}
					collisionPadding={8}
				>
					<LazyItems kit={RDropdown} items={items} />
				</RDropdown.Content>
			</RDropdown.Portal>
		</RDropdown.Root>
	);
}

export type ContextMenuProps = {
	children: ReactNode;
	/** Evaluated when the menu opens so enabled/checked state is fresh. */
	items: readonly ResolvedMenuItem[] | (() => readonly ResolvedMenuItem[]);
	onOpenChange?(open: boolean): void;
	disabled?: boolean;
};

/** Right-click / long-press / Shift+F10 context menu (S05:MN-030). */
export function ContextMenu({ children, items, onOpenChange, disabled }: ContextMenuProps) {
	return (
		<RContext.Root onOpenChange={onOpenChange} modal={false}>
			<RContext.Trigger asChild disabled={disabled}>
				{children}
			</RContext.Trigger>
			<RContext.Portal>
				<RContext.Content className={MENU_CONTENT} collisionPadding={8}>
					<LazyItems kit={RContext} items={items} />
				</RContext.Content>
			</RContext.Portal>
		</RContext.Root>
	);
}

export type MenuBarMenu = {
	id: string;
	label: string;
	disabled?: boolean;
	items: () => readonly ResolvedMenuItem[];
};

export type MenuBarProps = {
	menus: readonly MenuBarMenu[];
	className?: string;
	value?: string;
	onValueChange?(value: string): void;
};

/** In-app menubar (Radix Menubar; S05:HD-001, MN-001/003). Items are resolved when a menu opens. */
export function MenuBar({ menus, className, value, onValueChange }: MenuBarProps) {
	return (
		<RMenubar.Root
			className={cx('flex h-full items-center gap-0.5', className)}
			value={value}
			onValueChange={onValueChange}
			data-testid="menubar"
		>
			{menus.map((m) => (
				<RMenubar.Menu key={m.id} value={m.id}>
					<RMenubar.Trigger
						disabled={m.disabled}
						className="h-[22px] rounded-pr-control px-2 font-pr text-pr-ui text-pr-text outline-none select-none hover:bg-pr-hover data-[disabled]:text-pr-dim data-[highlighted]:bg-pr-hover data-[state=open]:bg-pr-pressed"
						data-menu-id={m.id}
					>
						{m.label}
					</RMenubar.Trigger>
					<RMenubar.Portal>
						<RMenubar.Content className={MENU_CONTENT} align="start" sideOffset={2} collisionPadding={8}>
							<MenuBarItems menu={m} />
						</RMenubar.Content>
					</RMenubar.Portal>
				</RMenubar.Menu>
			))}
		</RMenubar.Root>
	);
}

/**
 * Radix mounts this component only when the menu opens, avoiding command-state resolution on unrelated panel renders.
 */
function LazyItems({
	kit,
	items,
}: {
	kit: Kit;
	items: readonly ResolvedMenuItem[] | (() => readonly ResolvedMenuItem[]);
}) {
	return <>{renderItems(kit, typeof items === 'function' ? items() : items)}</>;
}

function MenuBarItems({ menu }: { menu: MenuBarMenu }) {
	return <>{renderItems(RMenubar, menu.items())}</>;
}
