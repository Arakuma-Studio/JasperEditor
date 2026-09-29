import type { HTMLAttributes } from 'react';
import { cx } from '../cx.ts';

export type TimecodeTextProps = HTMLAttributes<HTMLSpanElement> & {
	/** Pre-formatted timecode (see formatTimecode in @jasper/project). */
	value: string;
	/** `timecode` = current-time blue; `primary` = durations; `muted` = secondary. */
	tone?: 'timecode' | 'primary' | 'muted';
	size?: 'timeline' | 'monitor' | 'ui';
};

const SIZES = {
	timeline: 'text-[length:var(--pr-font-size-timeline-tc)]',
	monitor: 'text-[length:var(--pr-font-size-monitor-tc)]',
	ui: 'text-pr-ui',
};
const TONES = { timecode: 'text-pr-timecode', primary: 'text-pr-text', muted: 'text-pr-muted' };

/** Timecode display with tabular numerals so digits never jitter (S05:TY-004/005). */
export function TimecodeText({
	value,
	tone = 'timecode',
	size = 'ui',
	className,
	...rest
}: TimecodeTextProps) {
	return (
		<span
			className={cx('pr-tabular font-pr whitespace-nowrap', SIZES[size], TONES[tone], className)}
			style={{ fontVariantNumeric: 'tabular-nums' }}
			{...rest}
		>
			{value}
		</span>
	);
}
