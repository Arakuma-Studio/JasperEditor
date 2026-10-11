export function createSessionId(): string {
	const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
	return `ses_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
