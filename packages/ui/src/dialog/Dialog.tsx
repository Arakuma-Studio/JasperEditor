// Dialogs (S05 §14, DG-001…007): Radix Dialog, centered, scrim backdrop, panel frame with menu border,
// radius 6, overlay shadow; 40 px header with 16/600 title and ×; body padding 16; 48 px footer with
// Cancel then the primary pill. Focus is trapped; Esc = Cancel; Enter = primary unless focus is in a
// multi-line field or on another button; focus returns to the invoker on close.
import { Dialog as RDialog } from 'radix-ui';
import { type KeyboardEvent, type ReactNode, useSyncExternalStore } from 'react';
import { cx } from '../cx.ts';
import { Icon } from '../icons/Icon.tsx';
import { Button } from '../primitives/Button.tsx';
import { escapeRevertsField, InDialogContext } from './layer.ts';

export type DialogSize = 'small' | 'medium' | 'large';
const WIDTHS: Record<DialogSize, string> = { small: 'w-[400px]', medium: 'w-[560px]', large: 'w-[880px]' };

export type DialogProps = {
	open: boolean;
	onOpenChange(open: boolean): void;
	title: ReactNode;
	/** Accessible description (visually hidden when not rendered in the body). */
	description?: string;
	size?: DialogSize;
	children?: ReactNode;
	/** Primary action; omit for dialogs without a footer. */
	primaryLabel?: string;
	/** Return `false` (or resolve to it) to keep the dialog open. */
	onPrimary?(): unknown;
	primaryDisabled?: boolean;
	/** Danger styling only for destructive, non-undoable actions (S05:DG-007). */
	danger?: boolean;
	cancelLabel?: string;
	onCancel?(): void;
	/** Extra footer content on the left (e.g. "Restore Defaults"). */
	footerExtra?: ReactNode;
	/** Custom positioning (e.g. the command palette at 20% from the top). */
	contentClassName?: string;
	/** Hide the built-in header (palette). */
	bare?: boolean;
	/** Focus target when opening (DG-002 default: first input or the primary button). */
	initialFocus?: 'auto' | 'primary';
	'data-testid'?: string;
};

export function Dialog(props: DialogProps) {
	const {
		open,
		onOpenChange,
		title,
		description,
		size = 'medium',
		children,
		primaryLabel,
		onPrimary,
		primaryDisabled,
		danger,
		cancelLabel = 'Cancel',
		footerExtra,
		contentClassName,
		bare,
	} = props;

	const runPrimary = async () => {
		if (primaryDisabled || !onPrimary) return;
		const r = await onPrimary();
		if (r !== false) onOpenChange(false);
	};

	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		if (e.key !== 'Enter' || e.defaultPrevented || !onPrimary || e.nativeEvent.isComposing) return;
		const t = e.target as HTMLElement;
		if (t.tagName === 'TEXTAREA' || t.isContentEditable) return;
		if (t.tagName === 'BUTTON' && !t.hasAttribute('data-dialog-primary')) return;
		// Enter on an option of a Select / menu inside the dialog picks that option; React bubbles the event
		// out of the popup's portal to here, where it must not also run the primary action.
		if (t.closest('[role="listbox"],[role="menu"],[role="option"],[role="menuitem"]')) return;
		e.preventDefault();
		void runPrimary();
	};

	return (
		<RDialog.Root open={open} onOpenChange={onOpenChange}>
			<RDialog.Portal>
				<RDialog.Overlay className="fixed inset-0 z-[var(--pr-z-dialog)] bg-[var(--pr-overlay-scrim)]" />
				<RDialog.Content
					data-testid={props['data-testid'] ?? 'dialog'}
					onKeyDown={onKeyDown}
					// A modal dialog: assistive tech AND the app's keyboard dispatcher (which leaves `[role=dialog]
					// [aria-modal=true]` alone) must treat it as one — without it, global shortcuts (Space = play,
					// ↓ = next edit, Enter = render) ran on keys meant for the dialog's controls and swallowed them:
					// a focused Select could not be opened with Enter / Space / ↓.
					aria-modal="true"
					onOpenAutoFocus={(e) => {
						if (props.initialFocus !== 'primary') return;
						e.preventDefault();
						(e.currentTarget as HTMLElement | null)
							?.querySelector<HTMLElement>('[data-dialog-primary]')
							?.focus();
					}}
					onEscapeKeyDown={(e) => {
						// A field that is being edited takes the first Esc to revert its text (DIALOG_ESCAPE_REVERTS);
						// the dialog stays open and the field's own keydown handler reverts.
						if (escapeRevertsField(e.target)) {
							e.preventDefault();
							return;
						}
						props.onCancel?.();
					}}
					className={cx(
						'fixed z-[var(--pr-z-dialog)] flex max-h-[90vh] max-w-[calc(100vw-32px)] flex-col overflow-hidden',
						'rounded-pr-menu border border-pr-menu-border bg-pr-panel font-pr text-pr-ui text-pr-text shadow-pr-overlay outline-none',
						'max-[600px]:inset-0 max-[600px]:max-h-none max-[600px]:w-auto max-[600px]:max-w-none max-[600px]:rounded-none',
						contentClassName ??
							'top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 max-[600px]:translate-x-0 max-[600px]:translate-y-0',
						WIDTHS[size],
					)}
				>
					{bare ? (
						<RDialog.Title className="sr-only">{title}</RDialog.Title>
					) : (
						<div className="flex h-10 shrink-0 items-center gap-2 border-b border-pr-border-subtle pr-2 pl-4">
							<RDialog.Title className="truncate text-[length:var(--pr-font-size-dialog-title)] leading-5 font-semibold text-pr-strong">
								{title}
							</RDialog.Title>
							<RDialog.Close
								aria-label="Close"
								className="ml-auto inline-flex size-6 items-center justify-center rounded-pr-control text-pr-icon hover:bg-pr-hover hover:text-pr-icon-hover"
								onClick={() => props.onCancel?.()}
							>
								<Icon id="app.close" size={14} />
							</RDialog.Close>
						</div>
					)}
					<RDialog.Description className={description ? 'sr-only' : 'hidden'}>
						{description ?? ''}
					</RDialog.Description>
					<div className={cx('min-h-0 flex-1 overflow-auto', bare ? '' : 'p-4')}>
						<InDialogContext.Provider value>{children}</InDialogContext.Provider>
					</div>
					{primaryLabel ? (
						<div className="flex h-12 shrink-0 items-center gap-2 border-t border-pr-border-subtle px-4">
							{footerExtra}
							<div className="ml-auto flex items-center gap-2">
								<Button
									variant="secondary"
									pill
									onClick={() => {
										props.onCancel?.();
										onOpenChange(false);
									}}
								>
									{cancelLabel}
								</Button>
								<Button
									variant={danger ? 'danger' : 'primary'}
									pill
									disabled={primaryDisabled}
									data-dialog-primary=""
									onClick={() => void runPrimary()}
								>
									{primaryLabel}
								</Button>
							</div>
						</div>
					) : null}
				</RDialog.Content>
			</RDialog.Portal>
		</RDialog.Root>
	);
}

// ------------------------------------------------------------------ dialog host (S05:SH-004)

/** Props every hosted dialog receives: `close()` resolves the `openDialog` promise with `result`. */
export type HostedDialogProps<P = Record<string, unknown>> = P & { close(result?: unknown): void };
type Registered = (props: HostedDialogProps<any>) => ReactNode;

const registry = new Map<string, Registered>();
type Open = { id: number; kind: string; props: Record<string, unknown>; resolve(v: unknown): void };
let stack: Open[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => {
	for (const l of [...listeners]) l();
};

/** Registers a dialog kind (panels register theirs at module load; later registrations replace). */
export function registerDialog<P>(
	kind: string,
	component: (props: HostedDialogProps<P>) => ReactNode,
): () => void {
	registry.set(kind, component as Registered);
	emit();
	return () => {
		if (registry.get(kind) === (component as Registered)) registry.delete(kind);
	};
}

/**
 * Opens a registered dialog; resolves with the value passed to `close(result)` (undefined on cancel).
 * Modal dialogs never stack except confirmations spawned from a dialog (S05:DG-004): opening a second
 * non-confirm dialog replaces the first.
 */
export function openDialog<T = unknown>(
	kind: string,
	props: Record<string, unknown> = {},
): Promise<T | undefined> {
	return new Promise((resolve) => {
		if (!registry.has(kind)) {
			console.warn(`[dialog] no dialog registered for "${kind}"`);
			resolve(undefined);
			return;
		}
		const entry: Open = { id: nextId++, kind, props, resolve: resolve as (v: unknown) => void };
		if (kind !== CONFIRM_KIND) {
			for (const o of stack) o.resolve(undefined);
			stack = [];
		}
		stack = [...stack, entry];
		emit();
	});
}

function closeEntry(id: number, result?: unknown) {
	const e = stack.find((o) => o.id === id);
	if (!e) return;
	stack = stack.filter((o) => o.id !== id);
	e.resolve(result);
	emit();
}

/** Closes every hosted dialog (workspace switch, tests). */
export function closeAllDialogs(): void {
	for (const o of stack) o.resolve(undefined);
	stack = [];
	emit();
}

const subscribe = (l: () => void) => {
	listeners.add(l);
	return () => listeners.delete(l);
};
const getStack = () => stack;

/** Mount once per window. */
export function DialogHost() {
	const open = useSyncExternalStore(subscribe, getStack, getStack);
	return (
		<>
			{open.map((o) => {
				const C = registry.get(o.kind);
				if (!C) return null;
				return <C key={o.id} {...o.props} close={(r?: unknown) => closeEntry(o.id, r)} />;
			})}
		</>
	);
}

// ------------------------------------------------------------------ confirmation (S05:DG-007)

const CONFIRM_KIND = 'jasper.confirm';

export type ConfirmOptions = {
	/** Names the object: "Delete 3 tracks?" */
	title: string;
	/** Names the consequence: "Clips on these tracks will be removed. You can undo this." */
	body?: ReactNode;
	/** Action verb: "Delete Tracks". */
	confirmLabel: string;
	cancelLabel?: string;
	/** Only for destructive, non-undoable actions. */
	danger?: boolean;
};

function ConfirmDialog(props: HostedDialogProps<ConfirmOptions>) {
	return (
		<Dialog
			open
			onOpenChange={(o) => !o && props.close(false)}
			title={props.title}
			size="small"
			primaryLabel={props.confirmLabel}
			cancelLabel={props.cancelLabel}
			danger={props.danger}
			initialFocus="primary"
			onPrimary={() => {
				props.close(true);
				return false;
			}}
			data-testid="confirm-dialog"
		>
			{props.body ? <div className="text-pr-text">{props.body}</div> : null}
		</Dialog>
	);
}
registerDialog(CONFIRM_KIND, ConfirmDialog);

/** Confirmation dialog; resolves true when confirmed. */
export async function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
	return (await openDialog<boolean>(CONFIRM_KIND, opts)) === true;
}
