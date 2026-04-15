'use client';

import React, { Suspense, useState } from 'react';
import { TranscriptProvider } from '@/app/contexts/TranscriptContext';
import { EventProvider } from '@/app/contexts/EventContext';
import { LeadInfoProvider } from '@/app/contexts/LeadInfoContext';
import LICSalesApp from './LICSalesApp';
import PreConnectionForm from '@/app/components/PreConnectionForm';
import { LeadInfo } from '@/app/types';

interface LICSalesAppPageProps {
  welcomeMessage?: string;
  imageUrl?: string;
  WorkflowImage?: string;
}

export default function LICSalesAppPage({ welcomeMessage, imageUrl, WorkflowImage }: LICSalesAppPageProps) {
  const [leadInfo, setLeadInfoState] = useState<LeadInfo | null>(null);

  const handleFormSubmit = (info: LeadInfo) => {
    setLeadInfoState(info);
  };

  return (
    <Suspense fallback={<div>Loading...</div>}>
      <LeadInfoProvider>
        <TranscriptProvider>
          <EventProvider>
            <PreConnectionForm
              isOpen={leadInfo === null}
              onSubmit={handleFormSubmit}
            />
            {leadInfo && (
              <LICSalesApp
                welcomeMessage={welcomeMessage}
                imageUrl={imageUrl}
                WorkflowImage={WorkflowImage}
                leadInfo={leadInfo}
              />
            )}
          </EventProvider>
        </TranscriptProvider>
      </LeadInfoProvider>
    </Suspense>
  );
}
