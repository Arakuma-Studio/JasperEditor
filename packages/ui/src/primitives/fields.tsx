// Fields (S05:CT-010…013): text field, search field, dropdown select, checkbox, toggle switch.
import { Checkbox as RCheckbox, Select as RSelect, Switch as RSwitch } from 'radix-ui';
import { type ComponentProps, type KeyboardEvent, type ReactNode, useId, useRef } from 'react';
import { cx } from '../cx.ts';
import { Icon } from '../icons/Icon.tsx';

const FIELD =
	'h-[22px] min-w-0 rounded-pr-control border border-transparent bg-pr-field px-2 font-pr text-pr-ui text-pr-text ' +
	'outline-none transition-colors duration-100 placeholder:text-pr-dim hover:border-pr-border-strong ' +
	'focus:border-pr-focus disabled:opacity-40';

export type TextFieldProps = ComponentProps<'input'> & { invalid?: boolean };

/** `--pr-bg-field`, 22 px, no border until hover/focus (S05:CT-010). */
export function TextField({ className, invalid, ...rest }: TextFieldProps) {
	return (
		<input
			type="text"
			spellCheck={false}
			aria-invalid={invalid || undefined}
			className={cx(FIELD, invalid && 'border-pr-danger hover:border-pr-danger', className)}
			{...rest}
		/>
	);
}

export type SearchFieldProps = Omit<ComponentProps<'input'>, 'value' | 'onChange'> & {
	value: string;
	onValueChange(value: string): void;
};

/** Search field: deep field color, magnifier, clear ×, `Esc` clears then blurs (S05:CT-010). */
export function SearchField({ value, onValueChange, className, onKeyDown, ...rest }: SearchFieldProps) {
	const ref = useRef<HTMLInputElement>(null);
	const keyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		onKeyDown?.(e);
		if (e.defaultPrevented || e.key !== 'Escape') return;
		e.preventDefault();
		if (value) onValueChange('');
		else ref.current?.blur();
	};
	return (
		<div
			className={cx(
				'group relative flex h-[22px] min-w-0 items-center rounded-pr-control border border-transparent',
				'bg-pr-field-deep hover:border-pr-border-strong focus-within:border-pr-focus',
				className,
			)}
		>
			<span className="pointer-events-none pl-1.5 text-pr-muted">
				<Icon id="app.search" size={14} />
			</span>
			<input
				ref={ref}
				type="search"
				spellCheck={false}
				value={value}
				onChange={(e) => onValueChange(e.target.value)}
				onKeyDown={keyDown}
				className="h-full min-w-0 flex-1 bg-transparent px-1.5 font-pr text-pr-ui text-pr-text outline-none placeholder:text-pr-dim [&::-webkit-search-cancel-button]:hidden"
				{...rest}
			/>
			{value ? (
				<button
					type="button"
					aria-label="Clear search"
					className="mr-1 inline-flex size-4 items-center justify-center rounded-pr-control text-pr-muted hover:text-pr-text"
					onClick={() => {
						onValueChange('');
						ref.current?.focus();
					}}
				>
					<Icon id="app.close" size={12} />
				</button>
			) : null}
		</div>
	);
}

export type SelectOption = { value: string; label: ReactNode; disabled?: boolean };

export type SelectProps = {
	value: string;
	onValueChange(value: string): void;
	options: readonly SelectOption[];
	label?: string;
	placeholder?: string;
	disabled?: boolean;
	className?: string;
	id?: string;
};

/** Dropdown: field color, chevron right, menu-styled list; type-ahead, arrows, Enter/Space (S05:CT-011). */
export function Select({
	value,
	onValueChange,
	options,
	label,
	placeholder,
	disabled,
	className,
	id,
}: SelectProps) {
	return (
		<RSelect.Root value={value} onValueChange={onValueChange} disabled={disabled}>
			<RSelect.Trigger
				id={id}
				aria-label={label}
				className={cx(
					FIELD,
					'inline-flex h-[var(--pr-control-h)] items-center justify-between gap-2 pr-1 text-left data-[state=open]:bg-pr-pressed',
					className,
				)}
			>
				<RSelect.Value placeholder={placeholder} />
				<RSelect.Icon className="text-pr-muted">
					<Icon id="app.chevronDown" size={14} />
				</RSelect.Icon>
			</RSelect.Trigger>
			<RSelect.Portal>
				<RSelect.Content
					position="popper"
					sideOffset={2}
					className="z-[var(--pr-z-popover)] max-h-[var(--radix-select-content-available-height)] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-pr-menu border border-pr-menu-border bg-pr-menu p-1 shadow-pr-overlay"
				>
					<RSelect.Viewport>
						{options.map((o) => (
							<RSelect.Item
								key={o.value}
								value={o.value}
								disabled={o.disabled}
								className="relative flex h-6 cursor-default items-center rounded-[3px] pr-3 pl-5 font-pr text-pr-ui text-pr-text outline-none select-none data-[disabled]:text-pr-dim data-[highlighted]:bg-pr-accent-fill data-[highlighted]:text-pr-on-accent"
							>
								<RSelect.ItemIndicator className="absolute left-1 inline-flex">
									<Icon id="app.check" size={12} />
								</RSelect.ItemIndicator>
								<RSelect.ItemText>{o.label}</RSelect.ItemText>
							</RSelect.Item>
						))}
					</RSelect.Viewport>
				</RSelect.Content>
			</RSelect.Portal>
		</RSelect.Root>
	);
}

export type CheckboxProps = {
	checked: boolean | 'mixed';
	onCheckedChange(checked: boolean): void;
	label?: ReactNode;
	disabled?: boolean;
	id?: string;
	className?: string;
	'aria-label'?: string;
};

/** 14 px gray checkbox (not blue, like Premiere); mixed shows a dash (S05:CT-012). */
export function Checkbox({
	checked,
	onCheckedChange,
	label,
	disabled,
	id,
	className,
	...aria
}: CheckboxProps) {
	const autoId = useId();
	const boxId = id ?? autoId;
	const box = (
		<RCheckbox.Root
			id={boxId}
			checked={checked === 'mixed' ? 'indeterminate' : checked}
			onCheckedChange={(c) => onCheckedChange(c === true)}
			disabled={disabled}
			aria-label={aria['aria-label']}
			className={cx(
				'inline-flex size-3.5 shrink-0 items-center justify-center rounded-[2px] border border-pr-muted',
				'data-[state=checked]:border-pr-text data-[state=checked]:bg-pr-text',
				'data-[state=indeterminate]:border-pr-text data-[state=indeterminate]:bg-pr-text disabled:opacity-40',
			)}
		>
			<RCheckbox.Indicator className="text-pr-panel">
				{checked === 'mixed' ? (
					<Icon id="app.remove" size={12} strokeWidth={3} />
				) : (
					<Icon id="app.check" size={12} strokeWidth={3} />
				)}
			</RCheckbox.Indicator>
		</RCheckbox.Root>
	);
	if (!label) return box;
	return (
		<label
			htmlFor={boxId}
			className={cx('inline-flex items-center gap-2 font-pr text-pr-ui text-pr-text select-none', className)}
		>
			{box}
			<span className={disabled ? 'text-pr-dim' : undefined}>{label}</span>
		</label>
	);
}

export type ToggleProps = {
	checked: boolean;
	onCheckedChange(checked: boolean): void;
	label?: ReactNode;
	disabled?: boolean;
	'aria-label'?: string;
};

/** Toggle switch for preferences: 28×16, on = accent fill (S05:CT-013). */
export function Toggle({ checked, onCheckedChange, label, disabled, ...aria }: ToggleProps) {
	const swId = useId();
	const sw = (
		<RSwitch.Root
			id={swId}
			checked={checked}
			onCheckedChange={onCheckedChange}
			disabled={disabled}
			aria-label={aria['aria-label']}
			className="relative inline-flex h-4 w-7 shrink-0 items-center rounded-full bg-pr-border-strong transition-colors duration-100 data-[state=checked]:bg-pr-accent-fill disabled:opacity-40"
		>
			<RSwitch.Thumb className="block size-3 translate-x-0.5 rounded-full bg-pr-text transition-transform duration-100 data-[state=checked]:translate-x-[14px]" />
		</RSwitch.Root>
	);
	if (!label) return sw;
	return (
		<label
			htmlFor={swId}
			className="inline-flex items-center gap-2 font-pr text-pr-ui text-pr-text select-none"
		>
			{sw}
			<span>{label}</span>
		</label>
	);
}
