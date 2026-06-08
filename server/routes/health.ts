import type { FastifyInstance } from 'fastify';
import { numberLeaseManager } from '../services/number-lease-manager.js';

export async function healthRoute(fastify: FastifyInstance) {
  fastify.get('/twilio/health', async (_request, reply) => {
    const lease = numberLeaseManager.getLease();
    return reply.code(200).send({
      status: 'ok',
      uptime: process.uptime(),
      lease: {
        status: lease.status,
        agentKey: lease.agentKey,
      },
    });
  });
}
