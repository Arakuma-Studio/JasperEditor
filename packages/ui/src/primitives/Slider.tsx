import { Slider as RSlider } from 'radix-ui';
import { cx } from '../cx.ts';

export type SliderProps = {
	value: number;
	min: number;
	max: number;
	step?: number;
	/** Double-click on the thumb resets to this value. */
	defaultValue?: number;
	/** Fill from the center (gain, pan, color controls). */
	bipolar?: boolean;
	label: string;
	/** Spoken value, e.g. "Scale 120 percent" (S05:A11Y-003). */
	valueText?: string;
	disabled?: boolean;
	/** Drag started (map to session.beginGesture). */
	onChangeStart?(): void;
	onChange?(value: number): void;
	/** Drag/keyboard change finished: commit once. */
	onCommit?(value: number): void;
	className?: string;
};

export function Slider(props: SliderProps) {
	const { value, min, max, step = 1, bipolar, label, disabled, className } = props;
	const span = max - min || 1;
	const pct = ((value - min) / span) * 100;
	const center = bipolar ? ((Math.min(Math.max(0, min), max) - min) / span) * 100 : 0;
	const left = Math.min(center, pct);
	const width = Math.abs(pct - center);
	return (
		<RSlider.Root
			value={[value]}
			min={min}
			max={max}
			step={step}
			disabled={disabled}
			aria-label={label}
			onPointerDown={() => {
				if (disabled) return;
				props.onChangeStart?.();
			}}
			onValueChange={([v]) => props.onChange?.(v ?? value)}
			onValueCommit={([v]) => props.onCommit?.(v ?? value)}
			className={cx(
				'relative flex h-4 w-full min-w-16 touch-none items-center select-none',
				disabled && 'opacity-40',
				className,
			)}
		>
			<RSlider.Track className="relative h-0.5 w-full grow rounded-full bg-pr-border-strong">
				<span
					className="absolute top-0 h-full rounded-full bg-pr-muted"
					style={{ left: `${left}%`, width: `${width}%` }}
					data-testid="slider-fill"
				/>
			</RSlider.Track>
			<RSlider.Thumb
				aria-label={label}
				aria-valuetext={props.valueText}
				onDoubleClick={() => {
					if (props.defaultValue === undefined || disabled) return;
					props.onChange?.(props.defaultValue);
					props.onCommit?.(props.defaultValue);
				}}
				className="block size-3 rounded-full border-2 border-pr-text bg-pr-panel outline-none focus-visible:outline-2 focus-visible:outline-pr-focus"
			/>
		</RSlider.Root>
	);
}
