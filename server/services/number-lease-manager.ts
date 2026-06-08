import type { NumberLease, LeaseStatus } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { env } from '../utils/env.js';

class NumberLeaseManager {
  private lease: NumberLease = {
    status: 'free',
    agentKey: null,
    leasedAt: null,
    expiresAt: null,
    callSid: null,
  };

  private expiryTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.expiryTimer = setInterval(() => this.checkExpiry(), 60_000);
  }

  claim(agentKey: string): { success: true; expiresAt: Date } | { success: false; error: string; currentAgent: string | null } {
    if (this.isExpired()) {
      this.release();
    }

    if (this.lease.status !== 'free') {
      return {
        success: false,
        error: `Number is busy (status: ${this.lease.status})`,
        currentAgent: this.lease.agentKey,
      };
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + env.leaseTtlMinutes * 60 * 1000);

    this.lease = {
      status: 'leased',
      agentKey,
      leasedAt: now,
      expiresAt,
      callSid: null,
    };

    logger.info('Number leased', { agentKey, expiresAt });
    return { success: true, expiresAt };
  }

  activate(callSid: string): void {
    if (this.lease.status !== 'leased' && this.lease.status !== 'active') {
      logger.warn('activate() called on non-leased number', { status: this.lease.status });
      return;
    }
    this.lease = {
      ...this.lease,
      status: 'active',
      expiresAt: null,
      callSid,
    };
    logger.info('Number activated', { callSid, agentKey: this.lease.agentKey });
  }

  postCall(): void {
    if (this.lease.status !== 'active') {
      logger.warn('postCall() called but status is not active', { status: this.lease.status });
      return;
    }
    this.lease = {
      ...this.lease,
      status: 'post_call',
      callSid: null,
    };
    logger.info('Number moved to post_call', { agentKey: this.lease.agentKey });
  }

  release(): void {
    logger.info('Number released', { previousAgent: this.lease.agentKey });
    this.lease = {
      status: 'free',
      agentKey: null,
      leasedAt: null,
      expiresAt: null,
      callSid: null,
    };
  }

  getLease(): NumberLease {
    if (this.isExpired()) {
      this.release();
    }
    return { ...this.lease };
  }

  isExpired(): boolean {
    return (
      this.lease.status === 'leased' &&
      this.lease.expiresAt !== null &&
      new Date() > this.lease.expiresAt
    );
  }

  checkExpiry(): void {
    if (this.isExpired()) {
      logger.info('Lease expired — releasing number', { agentKey: this.lease.agentKey });
      this.release();
    }
  }

  destroy(): void {
    if (this.expiryTimer) {
      clearInterval(this.expiryTimer);
      this.expiryTimer = null;
    }
  }
}

export const numberLeaseManager = new NumberLeaseManager();
