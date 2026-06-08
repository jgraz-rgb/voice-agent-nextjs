export type LeaseStatus = 'free' | 'leased' | 'active' | 'post_call';

export interface NumberLease {
  status: LeaseStatus;
  agentKey: string | null;
  leasedAt: Date | null;
  expiresAt: Date | null;
  callSid: string | null;
}

export interface CallMetadata {
  callSid: string;
  from: string;
  agentKey: string;
  startedAt: Date;
  status: 'initiated' | 'in-progress' | 'completed' | 'failed';
}

export interface TwilioMediaMessage {
  event: string;
  sequenceNumber?: string;
  media?: {
    track: string;
    chunk: string;
    timestamp: string;
    payload: string;
  };
  start?: {
    streamSid: string;
    accountSid: string;
    callSid: string;
    tracks: string[];
    mediaFormat: {
      encoding: string;
      sampleRate: number;
      channels: number;
    };
    customParameters?: Record<string, string>;
  };
  stop?: {
    accountSid: string;
    callSid: string;
  };
  streamSid?: string;
}
