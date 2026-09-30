// GET /events: NDJSON event stream (S04:ENG-023, §19.3). Replays buffered events after `?since=<id>`,
// then streams live events filtered by `?projectId=`, with a heartbeat every 15 s.
import { HEARTBEAT_INTERVAL_MS } from '@jasper/api';
import type { FastifyInstance } from 'fastify';
import { fail } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';

export default async function eventsRoutes(app: FastifyInstance): Promise<void> {
	const core = coreServices(app);
	const open = new Set<() => void>();
	// preClose: end live streams before the HTTP server waits for its connections to drain.
	app.addHook('preClose', async () => {
		for (const close of [...open]) close();
	});

	app.get('/events', async (req, reply) => {
		const q = req.query as { since?: string; projectId?: string };
		let since: number | null = null;
		if (q.since !== undefined && q.since !== '') {
			since = Number(q.since);
			if (!Number.isInteger(since) || since < 0)
				return fail(reply, 400, 'VALIDATION_FAILED', 'since must be an event id');
		}
		const filter = q.projectId ? { projectId: q.projectId } : {};
		reply.hijack();
		const res = reply.raw;
		res.writeHead(200, {
			'content-type': 'application/x-ndjson; charset=utf-8',
			'cache-control': 'no-store',
			'x-accel-buffering': 'no',
			connection: 'keep-alive',
			'x-jasper-api': '1',
		});
		res.flushHeaders?.();
		const write = (e: unknown) => {
			if (!res.writableEnded) res.write(`${JSON.stringify(e)}\n`);
		};
		// Subscribe first, then replay, so nothing published in between is lost (dedupe by id).
		let lastSent = since ?? core.broadcaster.lastId;
		const buffered: unknown[] = [];
		let replaying = true;
		const unsubscribe = core.broadcaster.subscribe((e) => {
			if (replaying) buffered.push(e);
			else if (e.id > lastSent) {
				lastSent = e.id;
				write(e);
			}
		}, filter);
		if (since !== null) {
			for (const e of core.broadcaster.since(since, filter).events) {
				lastSent = e.id;
				write(e);
			}
		}
		for (const e of buffered as { id: number }[]) {
			if (e.id > lastSent) {
				lastSent = e.id;
				write(e);
			}
		}
		replaying = false;
		// An initial heartbeat tells the client the stream is open (and its current position).
		write(core.broadcaster.heartbeat());
		const timer = setInterval(() => write(core.broadcaster.heartbeat()), HEARTBEAT_INTERVAL_MS);
		timer.unref();
		const close = () => {
			clearInterval(timer);
			unsubscribe();
			open.delete(close);
			if (!res.writableEnded) res.end();
		};
		open.add(close);
		req.raw.on('close', close);
		res.on('error', close);
	});
}
