import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import websocket from '@fastify/websocket';

import { env } from './utils/env.js';
import { logger } from './utils/logger.js';

import { leaseRoutes } from './routes/lease.js';
import { incomingCallRoute, outboundTwimlRoute } from './routes/incoming-call.js';
import { mediaStreamRoute } from './routes/media-stream.js';
import { eventsRoute } from './routes/events.js';
import { audioStreamRoute } from './routes/audio-stream.js';
import { endCallRoute } from './routes/end-call.js';
import { healthRoute } from './routes/health.js';

async function start() {
  const fastify = Fastify({ logger: false });

  await fastify.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
  });
  await fastify.register(formbody);
  await fastify.register(websocket);

  await fastify.register(leaseRoutes);
  await fastify.register(incomingCallRoute);
  await fastify.register(outboundTwimlRoute);
  await fastify.register(mediaStreamRoute);
  await fastify.register(eventsRoute);
  await fastify.register(audioStreamRoute);
  await fastify.register(endCallRoute);
  await fastify.register(healthRoute);

  try {
    await fastify.listen({ port: env.port, host: '0.0.0.0' });
    logger.info(`Fastify server running on port ${env.port}`);
    logger.info(`Twilio webhook URL: https://${env.publicDomain}/twilio/incoming-call`);
    logger.info(`Media stream URL:   wss://${env.publicDomain}/twilio/media-stream`);
  } catch (err) {
    logger.error('Failed to start server', err);
    process.exit(1);
  }
}

start();
