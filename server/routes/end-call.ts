import type { FastifyInstance } from 'fastify';
import { callManager } from '../services/call-manager.js';
import { endCall } from '../services/twilio-client.js';
import { numberLeaseManager } from '../services/number-lease-manager.js';
import { logger } from '../utils/logger.js';

export async function endCallRoute(fastify: FastifyInstance) {
  fastify.post('/twilio/end-call', async (request, reply) => {
    const { callSid } = request.body as { callSid?: string };

    if (!callSid) {
      return reply.code(400).send({ success: false, error: 'callSid is required' });
    }

    try {
      await endCall(callSid);
      callManager.updateCall(callSid, { status: 'completed' });
      numberLeaseManager.postCall();
      return reply.code(200).send({ success: true });
    } catch (err: any) {
      const message = err?.message ?? String(err);
      logger.error('Failed to end call', { callSid, message });
      return reply.code(500).send({ success: false, error: message });
    }
  });
}
