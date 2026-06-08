import type { FastifyInstance } from 'fastify';
import { numberLeaseManager } from '../services/number-lease-manager.js';
import { callManager } from '../services/call-manager.js';
import { env } from '../utils/env.js';
import { logger } from '../utils/logger.js';

// ── Outbound call TwiML callback ──────────────────────────────────────────────
// Twilio hits this when the called party answers. We return TwiML that connects
// the call audio to our media-stream WebSocket (bidirectional).
export async function outboundTwimlRoute(fastify: FastifyInstance) {
  fastify.post('/twilio/outbound-twiml', async (request, reply) => {
    const body = request.body as Record<string, string>;
    const query = request.query as Record<string, string>;

    const callSid = body.CallSid ?? '';
    const from = body.To ?? '';           // "To" is the number we called
    const agentKey = query.agentKey ?? numberLeaseManager.getLease().agentKey ?? 'aaaInsurance';

    logger.info('Outbound call answered — generating TwiML', { callSid, from, agentKey });

    // Register the call so media-stream can look it up
    callManager.addCall({ callSid, from, agentKey, startedAt: new Date(), status: 'in-progress' });

    const streamUrl = `wss://${env.publicDomain}/twilio/media-stream`;
    logger.info('Connecting outbound call to media stream', { callSid, agentKey, streamUrl });

    return reply.code(200).header('Content-Type', 'text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}">
      <Parameter name="agentKey" value="${agentKey}"/>
      <Parameter name="callSid" value="${callSid}"/>
    </Stream>
  </Connect>
</Response>`);
  });
}

// Suppress Twilio retries: once we accept a call, reject all new callSids for 30s
let lastAcceptedCallSid: string | null = null;
let lastAcceptedAt = 0;
const COOLDOWN_MS = 30_000;

export async function incomingCallRoute(fastify: FastifyInstance) {
  fastify.post('/twilio/incoming-call', async (request, reply) => {
    const body = request.body as Record<string, string>;
    const callSid = body.CallSid ?? '';
    const from = body.From ?? '';

    logger.info('Incoming call', { callSid, from });

    const now = Date.now();

    // If we accepted a different call recently, hang up retries
    if (
      lastAcceptedCallSid &&
      lastAcceptedCallSid !== callSid &&
      now - lastAcceptedAt < COOLDOWN_MS
    ) {
      logger.warn('Twilio retry suppressed during cooldown', { callSid, lastAcceptedCallSid });
      return reply.code(200).header('Content-Type', 'text/xml').send(
        `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`
      );
    }

    const lease = numberLeaseManager.getLease();

    if (lease.status === 'free' || numberLeaseManager.isExpired()) {
      logger.warn('No active lease — rejecting call', { callSid });
      return reply.code(200).header('Content-Type', 'text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Sorry, no agent is currently configured on this number. Goodbye.</Say>
  <Hangup/>
</Response>`);
    }

    // Same callSid retrying (Twilio duplicate) — just hang up, WS is already open
    if (lease.status === 'active' && lease.callSid === callSid) {
      logger.warn('Duplicate webhook for same callSid — ignoring', { callSid });
      return reply.code(200).header('Content-Type', 'text/xml').send(
        `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`
      );
    }

    // Stale active call from a previous server run — reset
    if (lease.status === 'active' && lease.callSid !== callSid) {
      logger.warn('Stale active call — resetting', { staleSid: lease.callSid, newSid: callSid });
      numberLeaseManager.release();
      numberLeaseManager.claim(lease.agentKey!);
    }

    // After post_call, re-activate for a new call
    if (lease.status === 'post_call') {
      numberLeaseManager.release();
      numberLeaseManager.claim(lease.agentKey!);
    }

    const freshLease = numberLeaseManager.getLease();
    const agentKey = freshLease.agentKey ?? lease.agentKey!;

    numberLeaseManager.activate(callSid);
    callManager.addCall({ callSid, from, agentKey, startedAt: new Date(), status: 'initiated' });

    // Record accepted call — suppress retries
    lastAcceptedCallSid = callSid;
    lastAcceptedAt = now;

    const streamUrl = `wss://${env.publicDomain}/twilio/media-stream`;
    logger.info('Connecting call to media stream', { callSid, agentKey, streamUrl });

    return reply.code(200).header('Content-Type', 'text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}">
      <Parameter name="agentKey" value="${agentKey}"/>
      <Parameter name="callSid" value="${callSid}"/>
    </Stream>
  </Connect>
</Response>`);
  });
}
