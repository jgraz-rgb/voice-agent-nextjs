'use client';

import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { LeadInfo } from '@/app/types';

interface LeadInfoContextType {
  leadInfo: LeadInfo | null;
  setLeadInfo: (info: LeadInfo) => void;
  clearLeadInfo: () => void;
}

const LeadInfoContext = createContext<LeadInfoContextType | undefined>(undefined);

export function LeadInfoProvider({ children }: { children: ReactNode }) {
  const [leadInfo, setLeadInfo] = useState<LeadInfo | null>(null);

  const clearLeadInfo = useCallback(() => {
    setLeadInfo(null);
  }, []);

  return (
    <LeadInfoContext.Provider value={{ leadInfo, setLeadInfo, clearLeadInfo }}>
      {children}
    </LeadInfoContext.Provider>
  );
}

export function useLeadInfo() {
  const context = useContext(LeadInfoContext);
  if (context === undefined) {
    throw new Error('useLeadInfo must be used within a LeadInfoProvider');
  }
  return context;
}

export default LeadInfoContext;
