import React, { Suspense } from 'react';
import { TranscriptProvider } from '@/app/contexts/TranscriptContext';
import { EventProvider } from '@/app/contexts/EventContext';
import LICSalesApp from './LICSalesApp';

interface LICSalesAppPageProps {
  welcomeMessage?: string;
  imageUrl?: string;
  WorkflowImage?: string;
}

export default function LICSalesAppPage({ welcomeMessage, imageUrl, WorkflowImage }: LICSalesAppPageProps) {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <TranscriptProvider>
        <EventProvider>
          <LICSalesApp
            welcomeMessage={welcomeMessage}
            imageUrl={imageUrl}
            WorkflowImage={WorkflowImage}
          />
        </EventProvider>
      </TranscriptProvider>
    </Suspense>
  );
}
