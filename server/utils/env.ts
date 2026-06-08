import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const env = {
  openaiApiKey: required('OPENAI_API_KEY'),
  twilioAccountSid: required('TWILIO_ACCOUNT_SID'),
  twilioAuthToken: required('TWILIO_AUTH_TOKEN'),
  twilioPhoneNumber: required('TWILIO_PHONE_NUMBER'),
  publicDomain: required('PUBLIC_DOMAIN'),
  port: parseInt(optional('TWILIO_SERVER_PORT', optional('PORT', '5050')), 10),
  leaseTtlMinutes: parseInt(optional('LEASE_TTL_MINUTES', '10'), 10),
};
