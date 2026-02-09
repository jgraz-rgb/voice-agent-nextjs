import React, { Suspense } from "react";
import { TranscriptProvider } from "@/app/contexts/TranscriptContext";
import { EventProvider } from "@/app/contexts/EventContext";
import App from "./App";

export default function AgentAppPage({welcomeMessage, imageUrl,WorkflowImage}) {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <TranscriptProvider>
        <EventProvider>
          <App welcomeMessage={welcomeMessage} imageUrl={imageUrl} WorkflowImage={WorkflowImage}/>
        </EventProvider>
      </TranscriptProvider>
    </Suspense>
  );
}
