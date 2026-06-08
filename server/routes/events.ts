import type { FastifyInstance } from 'fastify';
import { logger } from '../utils/logger.js';

type Listener = (event: object) => void;

class EventBroadcaster {
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  broadcast(event: object): void {
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch (err) {
        logger.error('Event broadcast error', err);
      }
    }
  }
}

export const eventBroadcaster = new EventBroadcaster();

export async function eventsRoute(fastify: FastifyInstance) {
  // Server-Sent Events endpoint so the UI can receive real-time call status
  fastify.get('/twilio/events', async (request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const send = (event: object) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    send({ type: 'connected' });

    const unsubscribe = eventBroadcaster.subscribe(send);

    request.raw.on('close', () => {
      unsubscribe();
    });

    // Keep connection open
    await new Promise<void>((resolve) => {
      request.raw.on('close', resolve);
    });
  });
}
