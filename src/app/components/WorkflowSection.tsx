"use client";

import React from "react";

function WorkflowSection({ WorkflowImage }: { WorkflowImage?: string }) {

  return (
    <div className="flex flex-col bg-white min-h-0 rounded-xl w-[65%]">
      <div className="flex flex-col flex-1 min-h-0">
        <div className="flex items-center justify-between px-6 py-3 sticky top-0 z-10 text-base border-b bg-white rounded-t-xl">
          <span className="font-semibold">Searchunify Agentic Suite</span>
        </div>

        {/* Transcript Content */}
        <div className="overflow-auto p-4 flex flex-col gap-y-4 h-full">
          {/* Use plain img to bypass Next.js image optimization pipeline (avoids auth issues on proxied deployments) */}
          {WorkflowImage && (
            <img
              src={WorkflowImage}
              alt="Workflow overview for the Searchunify Agentic Suite"
              className="h-auto w-full rounded-lg"
            />
          )}
        </div>
      </div>
    </div>
  );
}

export default WorkflowSection;
