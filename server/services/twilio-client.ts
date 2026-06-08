import twilio from 'twilio';
import { env } from '../utils/env.js';
import { logger } from '../utils/logger.js';

const client = twilio(env.twilioAccountSid, env.twilioAuthToken);

export async function endCall(callSid: string): Promise<void> {
  try {
    await client.calls(callSid).update({ status: 'completed' });
    logger.info('Call ended via Twilio API', { callSid });
  } catch (err) {
    logger.error('Failed to end call', { callSid, err });
    throw err;
  }
}

export async function makeCall(toNumber: string, twimlCallbackUrl: string): Promise<string> {
  logger.info('Making outbound call', { to: toNumber, from: env.twilioPhoneNumber });
  const call = await client.calls.create({
    to: toNumber,
    from: env.twilioPhoneNumber,
    url: twimlCallbackUrl,
    method: 'POST',
  });
  logger.info('Outbound call created', { callSid: call.sid, to: toNumber });
  return call.sid;
}

export { client as twilioClient };
