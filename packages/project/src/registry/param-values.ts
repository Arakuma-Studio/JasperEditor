import type { ParamValue } from '../schema/common.ts';

export const numberParam = (value: ParamValue | undefined, defaultValue = 0): number =>
	typeof value === 'number' && Number.isFinite(value) ? value : defaultValue;

export const booleanParam = (value: ParamValue | undefined, defaultValue = false): boolean =>
	typeof value === 'boolean' ? value : defaultValue;

export const stringParam = (value: ParamValue | undefined, defaultValue: string): string =>
	typeof value === 'string' ? value : defaultValue;

export const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export function mediaParamId(value: ParamValue | undefined): string {
	return value && typeof value === 'object' && 'mediaId' in value && typeof value.mediaId === 'string'
		? value.mediaId
		: '';
}
