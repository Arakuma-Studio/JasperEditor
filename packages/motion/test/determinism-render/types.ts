import type { SequenceCompositionProps } from '../../../compositions/src/types.ts';

export type ParityProps = SequenceCompositionProps;
export type Stats = { median: number; p95: number; max: number; mean: number };

export type ParityPlayer = {
	mount(props: ParityProps): void;
	seek(frame: number): Promise<void>;
	bench(units: number, frames: number): { values: Stats };
};

declare global {
	interface Window {
		__parity: ParityPlayer;
	}
}
