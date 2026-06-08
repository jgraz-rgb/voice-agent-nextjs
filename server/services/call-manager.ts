import type { CallMetadata } from '../types/index.js';
import { logger } from '../utils/logger.js';

class CallManager {
  private calls = new Map<string, CallMetadata>();

  addCall(metadata: CallMetadata): void {
    this.calls.set(metadata.callSid, metadata);
    logger.info('Call added', { callSid: metadata.callSid, agentKey: metadata.agentKey });
  }

  getCall(callSid: string): CallMetadata | undefined {
    return this.calls.get(callSid);
  }

  updateCall(callSid: string, update: Partial<CallMetadata>): void {
    const existing = this.calls.get(callSid);
    if (!existing) return;
    this.calls.set(callSid, { ...existing, ...update });
  }

  removeCall(callSid: string): void {
    this.calls.delete(callSid);
    logger.info('Call removed', { callSid });
  }

  getActiveCalls(): CallMetadata[] {
    return Array.from(this.calls.values()).filter((c) => c.status === 'in-progress');
  }
}

export const callManager = new CallManager();
