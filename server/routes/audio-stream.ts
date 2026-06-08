import type { FastifyInstance } from 'fastify';
import { callManager } from '../services/call-manager.js';
import { logger } from '../utils/logger.js';

// Placeholder WebSocket endpoint for future per-call audio monitoring
export async function audioStreamRoute(fastify: FastifyInstance) {
  fastify.get('/twilio/audio-stream/:callSid', { websocket: true }, (ws, request) => {
    const { callSid } = request.params as { callSid: string };
    const call = callManager.getCall(callSid);

    if (!call) {
      logger.warn('audio-stream: unknown callSid', { callSid });
      ws.close(1008, 'Unknown call');
      return;
    }

    logger.info('Audio stream WS connected', { callSid });

    ws.on('close', () => {
      logger.info('Audio stream WS closed', { callSid });
    });
  });
}
