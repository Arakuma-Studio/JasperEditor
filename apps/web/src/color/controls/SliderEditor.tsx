// Slider + scrubby value for one numeric row (Lumetri rows, wheel levels). The slider drag and the value scrub
// are one gesture each (one undo step); typed values and arrow keys are one transaction; double-click on the
// track resets to the default.
import { useRef } from 'react';
import { ScrubbyNumber } from '../../panels/properties/controls/ScrubbyNumber.tsx';
import type { Row } from '../../panels/properties/lib/model.ts';
import { rowDefault, rowNumber } from '../model.ts';
import { type RowWriteContext, useRowWriter } from '../rowEdit.ts';
import { Slider } from './Slider.tsx';

const unitText = (u?: string) => (u === '%' ? '%' : u === 'deg' ? '°' : undefined);

export function SliderEditor(props: {
	row: Row;
	ctx: RowWriteContext;
	disabled?: boolean;
	/** Gradient track (temperature, tint, saturation). */
	trackBackground?: string;
	/** Narrow value field (wheel levels). */
	compact?: boolean;
	'data-testid'?: string;
}) {
	const { row } = props;
	const writer = useRowWriter(row, props.ctx);
	const value = rowNumber(row);
	const scrubBase = useRef(value);
	const min = row.spec.range?.min ?? -100;
	const max = row.spec.range?.max ?? 100;
	const def = rowDefault(row);
	const tid = props['data-testid'];
	return (
		<span className="flex w-full min-w-0 items-center gap-2">
			<Slider
				value={value}
				min={min}
				max={max}
				step={row.spec.range?.step}
				bipolar={row.spec.ui.bipolar ?? min < 0}
				label={row.label}
				disabled={props.disabled}
				trackBackground={props.trackBackground}
				onStart={() => writer.begin()}
				onChange={(x) => writer.update(x)}
				onEnd={(c) => writer.end(c)}
				onReset={() => {
					if (typeof def === 'number' && def !== value) writer.commit(def);
				}}
				data-testid={tid}
			/>
			<ScrubbyNumber
				value={value}
				label={row.label}
				step={row.spec.range?.step ?? 1}
				precision={row.spec.ui.precision}
				unit={props.compact ? undefined : unitText(row.spec.unit)}
				min={min}
				max={max}
				disabled={props.disabled}
				className={props.compact ? 'w-[34px] justify-end' : 'w-[48px] justify-end'}
				onScrubStart={() => {
					scrubBase.current = value;
					writer.begin();
				}}
				onScrub={(d) => writer.update(Math.min(max, Math.max(min, scrubBase.current + d)))}
				onScrubEnd={(c) => writer.end(c)}
				onCommit={(fn) => writer.commit(fn(value))}
				data-testid={tid ? `${tid}-value` : undefined}
			/>
		</span>
	);
}
