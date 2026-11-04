// A stand-in editor window for MCP approval tests, using the engine's `/agent` WebSocket and editor cookies.
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import type { Duplex } from 'node:stream';

/**
 * A stand-in editor window: the engine's `/agent` WebSocket with the editor cookies (a minimal RFC 6455 client on
 * node:http, so the test needs no WebSocket package). It collects approval cards and answers them.
 */
export async function editorWindow(o: { port: number; token: string; editorKey: string; projectId: string }) {
	const { port: PORT, token, editorKey, projectId } = o;
	const socket = await new Promise<Duplex>((resolve, reject) => {
		const req = request({
			host: '127.0.0.1',
			port: PORT,
			path: '/agent',
			headers: {
				Connection: 'Upgrade',
				Upgrade: 'websocket',
				'Sec-WebSocket-Version': '13',
				'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
				Origin: `http://127.0.0.1:${PORT}`,
				Cookie: `jasper_session=${token}; jasper_editor=${editorKey}`,
			},
		});
		req.on('upgrade', (_res, s) => resolve(s));
		req.on('response', (res) => reject(new Error(`no upgrade: HTTP ${res.statusCode}`)));
		req.on('error', reject);
		req.end();
	});
	const cards: { approvalId: string; answerKey: string; label: string; summary: string }[] = [];
	let pending = Buffer.alloc(0);
	const send = (obj: unknown, opcode = 1) => {
		const payload = Buffer.from(opcode === 1 ? JSON.stringify(obj) : '');
		const head =
			payload.length < 126
				? Buffer.from([0x80 | opcode, 0x80 | payload.length])
				: Buffer.from([0x80 | opcode, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
		const mask = randomBytes(4);
		const body = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]!));
		socket.write(Buffer.concat([head, mask, body]));
	};
	let failure: Error | undefined;
	let welcomed!: () => void;
	let failedWelcome!: (error: Error) => void;
	const welcome = new Promise<void>((resolve, reject) => {
		welcomed = resolve;
		failedWelcome = reject;
	});
	const waiting = new Set<{ n: number; resolve: () => void; reject: (error: Error) => void }>();
	const fail = (error: Error) => {
		failure = error;
		failedWelcome(error);
		for (const waiter of waiting) waiter.reject(error);
		waiting.clear();
	};
	socket.on('error', fail);
	socket.on('close', () => fail(new Error('Editor WebSocket closed before its pending receipt')));
	socket.on('data', (chunk: Buffer) => {
		pending = Buffer.concat([pending, chunk]);
		for (;;) {
			if (pending.length < 2) return;
			const opcode = pending[0]! & 0x0f;
			let len = pending[1]! & 0x7f;
			let off = 2;
			if (len === 126) {
				if (pending.length < 4) return;
				len = pending.readUInt16BE(2);
				off = 4;
			} else if (len === 127) {
				if (pending.length < 10) return;
				len = Number(pending.readBigUInt64BE(2));
				off = 10;
			}
			if (pending.length < off + len) return;
			const payload = pending.subarray(off, off + len);
			pending = pending.subarray(off + len);
			if (opcode === 9) send(null, 10);
			if (opcode !== 1) continue;
			let m: { type: string; event?: string; payload?: unknown };
			try {
				m = JSON.parse(payload.toString('utf8'));
			} catch (error) {
				fail(error as Error);
				socket.destroy();
				return;
			}
			if (m.type === 'welcome') welcomed();
			if (m.type === 'event' && m.event === 'agent.approval.requested') {
				cards.push(m.payload as (typeof cards)[number]);
				for (const waiter of waiting)
					if (cards.length >= waiter.n) {
						waiting.delete(waiter);
						waiter.resolve();
					}
			}
		}
	});
	send({ type: 'hello', projectId, sessionId: 'ses_soundtest', leaseId: 'lease_soundtest' });
	await welcome;
	return {
		cards,
		async card(n: number) {
			if (failure) throw failure;
			if (cards.length < n) await new Promise<void>((resolve, reject) => waiting.add({ n, resolve, reject }));
			return cards[n - 1]!;
		},
		answer(c: (typeof cards)[number], decision: 'approved' | 'denied') {
			send({
				type: 'event',
				event: 'agent.approval.resolve',
				payload: { approvalId: c.approvalId, decision, answerKey: c.answerKey },
			});
		},
		close() {
			socket.destroy();
		},
	};
}
