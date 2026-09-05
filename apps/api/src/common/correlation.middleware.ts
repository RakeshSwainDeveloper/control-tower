import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { runWithContext } from './correlation.js';

/** Establishes the correlation id for the whole request lifecycle and echoes
 *  it back so a user can quote it in a support ticket. */
export function correlationHook(
  req: FastifyRequest,
  reply: FastifyReply,
  done: () => void,
): void {
  const incoming = req.headers['x-correlation-id'];
  const id = (Array.isArray(incoming) ? incoming[0] : incoming) ?? randomUUID();
  void reply.header('x-correlation-id', id);
  runWithContext({ correlationId: id, source: 'api', ip: req.ip }, done);
}
