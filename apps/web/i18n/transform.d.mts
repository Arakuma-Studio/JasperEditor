export const ATTRS: Set<string>;
export const KEYS: Set<string>;
export function isUiText(s: string): boolean;
export function scan(
	code: string,
	fileName: string,
	cb: { edit?(start: number, end: number, text: string): void; found?(key: string): void },
): void;
export function transformI18n(code: string, fileName: string, runtime: string): string | null;
