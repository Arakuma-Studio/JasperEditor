import type { EngineJob } from '@jasper/api';
import type { FastifyReply } from 'fastify';
import { HttpError } from '../tools/reply.ts';
import type { JobQueue } from './queue.ts';

export async function replyWithJob(
	queue: Pick<JobQueue, 'wait'>,
	job: EngineJob,
	wait: string | undefined,
	reply: FastifyReply,
	failureCode: string,
): Promise<EngineJob | FastifyReply> {
	if (wait !== '1') return reply.code(202).send(job);
	const done = await queue.wait(job.id);
	if (done.state !== 'succeeded')
		throw new HttpError(422, done.error?.code ?? failureCode, done.error?.message ?? done.state, {
			jobId: done.id,
		});
	return done;
}
