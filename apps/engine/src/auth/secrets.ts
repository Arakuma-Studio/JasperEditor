import { timingSafeEqual } from 'node:crypto';

export function secretsEqual(a: string | Buffer, b: string | Buffer): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
}
