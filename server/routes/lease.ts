import type { FastifyInstance } from 'fastify';
import { numberLeaseManager } from '../services/number-lease-manager.js';
import { env } from '../utils/env.js';
import { validAgentKeys } from '../agents/agent-resolver.js';
import { makeCall } from '../services/twilio-client.js';
import { logger } from '../utils/logger.js';
import { prewarmOpenAI } from './media-stream.js';

export async function leaseRoutes(fastify: FastifyInstance) {
  // Outbound call: user enters their phone number, we call them
  fastify.post('/twilio/call', async (request, reply) => {
    const { toNumber, agentKey } = request.body as { toNumber?: string; agentKey?: string };

    if (!toNumber) {
      return reply.code(400).send({ success: false, error: 'toNumber is required' });
    }
    if (!agentKey) {
      return reply.code(400).send({ success: false, error: 'agentKey is required' });
    }

    const knownKeys = validAgentKeys();
    if (!knownKeys.includes(agentKey)) {
      return reply.code(400).send({ success: false, error: `Unknown agentKey. Valid keys: ${knownKeys.join(', ')}` });
    }

    // Release any stale lease before claiming for the outbound call
    const existing = numberLeaseManager.getLease();
    if (existing.status !== 'free') {
      logger.warn('Releasing stale lease before outbound call', { status: existing.status, agentKey: existing.agentKey });
      numberLeaseManager.release();
    }

    const claimResult = numberLeaseManager.claim(agentKey);
    if (!claimResult.success) {
      return reply.code(409).send(claimResult);
    }

    // TwiML callback — Twilio will hit this when the call is answered
    const twimlCallbackUrl = `https://${env.publicDomain}/twilio/outbound-twiml?agentKey=${encodeURIComponent(agentKey)}`;

    try {
      const callSid = await makeCall(toNumber, twimlCallbackUrl);
      numberLeaseManager.activate(callSid);
      // Fire-and-forget: warm the OpenAI connection while Twilio rings the user
      prewarmOpenAI(callSid, agentKey).catch((err) =>
        logger.error('prewarmOpenAI failed', { callSid, err: err.message })
      );
      return reply.code(200).send({ success: true, callSid });
    } catch (err: any) {
      numberLeaseManager.release();
      logger.error('Failed to make outbound call', { err: err.message });
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  fastify.post('/twilio/claim', async (request, reply) => {
    const { agentKey } = request.body as { agentKey?: string };

    if (!agentKey) {
      return reply.code(400).send({ success: false, error: 'agentKey is required' });
    }

    const knownKeys = validAgentKeys();
    if (!knownKeys.includes(agentKey)) {
      return reply.code(400).send({ success: false, error: `Unknown agentKey. Valid keys: ${knownKeys.join(', ')}` });
    }

    const result = numberLeaseManager.claim(agentKey);

    if (!result.success) {
      return reply.code(409).send(result);
    }

    return reply.code(200).send({
      success: true,
      phoneNumber: env.twilioPhoneNumber,
      expiresAt: result.expiresAt.toISOString(),
    });
  });

  fastify.post('/twilio/release', async (_request, reply) => {
    numberLeaseManager.release();
    return reply.code(200).send({ success: true });
  });

  fastify.get('/twilio/status', async (_request, reply) => {
    const lease = numberLeaseManager.getLease();
    return reply.code(200).send({
      status: lease.status,
      agentKey: lease.agentKey,
      expiresAt: lease.expiresAt?.toISOString() ?? null,
      callSid: lease.callSid,
      phoneNumber: env.twilioPhoneNumber,
    });
  });
}
