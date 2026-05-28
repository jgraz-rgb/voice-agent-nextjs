"use client";

import { useRef } from "react";
import { useTranscript } from "@/app/contexts/TranscriptContext";
import { useEvent } from "@/app/contexts/EventContext";

export function useHandleSessionHistory() {
  const {
    transcriptItems,
    addTranscriptBreadcrumb,
    addTranscriptMessage,
    updateTranscriptMessage,
    updateTranscriptItem,
  } = useTranscript();

  const { logServerEvent } = useEvent();

  /* ----------------------- helpers ------------------------- */

  const extractMessageText = (content: any[] = []): string => {
    if (!Array.isArray(content)) return "";

    return content
      .map((c) => {
        if (!c || typeof c !== "object") return "";
        if (c.type === "input_text") return c.text ?? "";
        if (c.type === "output_text") return c.text ?? "";
        // SDK uses output_audio for assistant audio, input_audio for user audio.
        // Legacy "audio" name kept for backwards compatibility.
        if (c.type === "output_audio") return c.transcript ?? "";
        if (c.type === "input_audio") return c.transcript ?? "";
        if (c.type === "audio") return c.transcript ?? "";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  };

  const extractFunctionCallByName = (name: string, content: any[] = []): any => {
    if (!Array.isArray(content)) return undefined;
    return content.find((c: any) => c.type === 'function_call' && c.name === name);
  };

  const maybeParseJson = (val: any) => {
    if (typeof val === 'string') {
      try {
        return JSON.parse(val);
      } catch {
        console.warn('Failed to parse JSON:', val);
        return val;
      }
    }
    return val;
  };

  const extractLastAssistantMessage = (history: any[] = []): any => {
    if (!Array.isArray(history)) return undefined;
    // Use findLast (or a spread+reverse) to avoid mutating the SDK's history array in place.
    // Mutating it with .reverse() can corrupt the SDK's internal state and cause dropped events.
    return [...history].reverse().find((c: any) => c.type === 'message' && c.role === 'assistant');
  };

  const extractModeration = (obj: any) => {
    if ('moderationCategory' in obj) return obj;
    if ('outputInfo' in obj) return extractModeration(obj.outputInfo);
    if ('output' in obj) return extractModeration(obj.output);
    if ('result' in obj) return extractModeration(obj.result);
  };

  // Temporary helper until the guardrail_tripped event includes the itemId in the next version of the SDK
  const sketchilyDetectGuardrailMessage = (text: string) => {
    return text.match(/Failure Details: (\{.*?\})/)?.[1];
  };

  /* ----------------------- event handlers ------------------------- */

  function handleAgentToolStart(details: any, _agent: any, functionCall: any) {
    const lastFunctionCall = extractFunctionCallByName(functionCall.name, details?.context?.history);
    const function_name = lastFunctionCall?.name;
    const function_args = lastFunctionCall?.arguments;

    addTranscriptBreadcrumb(
      `function call: ${function_name}`,
      function_args
    );    
  }
  function handleAgentToolEnd(details: any, _agent: any, _functionCall: any, result: any) {
    const lastFunctionCall = extractFunctionCallByName(_functionCall.name, details?.context?.history);
    addTranscriptBreadcrumb(
      `function call result: ${lastFunctionCall?.name}`,
      maybeParseJson(result)
    );
  }

  function handleHistoryAdded(item: any) {
    console.log("[handleHistoryAdded] ", item);
    if (!item || item.type !== 'message') return;
    const itemId = item.itemId ?? item.id;
    const role = item.role;
    const content = Array.isArray(item.content) ? item.content : [];
    if (itemId && role) {
      const isUser = role === "user";
      let text = extractMessageText(content);

      if (isUser && !text) {
        text = "[Transcribing...]";
      }

      // If the guardrail has been tripped, this message is a message that gets sent to the
      // assistant to correct it, so we add it as a breadcrumb instead of a message.
      const guardrailMessage = sketchilyDetectGuardrailMessage(text);
      if (guardrailMessage) {
        const failureDetails = JSON.parse(guardrailMessage);
        addTranscriptBreadcrumb('Output Guardrail Active', { details: failureDetails });
      } else {
        addTranscriptMessage(itemId, role, text ?? "");
      }
    }
  }

  function handleHistoryUpdated(items: any[]) {
    if (!items || items.length === 0) return; // SDK fires an empty snapshot early — nothing to update yet
    console.log("[handleHistoryUpdated] items count:", items.length);
    items.forEach((item: any) => {
      if (!item || item.type !== 'message') return;

      const itemId = item.itemId ?? item.id;
      const role = item.role as "user" | "assistant";
      const content = Array.isArray(item.content) ? item.content : [];
      const text = extractMessageText(content);
      const isCompleted = item.status === 'completed';

      if (!itemId || !role) return;

      // Ensure the item exists in the transcript (in case history_added was missed
      // or fired before the role/content was fully populated).
      addTranscriptMessage(itemId, role, text ?? "");

      // For in-progress items, audio-transcript deltas are responsible for
      // updating the text incrementally — don't overwrite with empty/partial
      // history snapshots that arrive mid-stream and would clear what deltas wrote.
      // Only update text from history when:
      //   - the item is completed (final state), OR
      //   - it's a user message (text typed, no delta path), OR
      //   - history actually has non-empty text to set
      if (isCompleted || role === 'user') {
        if (text) updateTranscriptMessage(itemId, text, false);
      }
    });
  }

  function handleTranscriptionDelta(item: any) {
    // item_id from transport events (snake_case); itemId/id from SDK history events
    const itemId = item.item_id ?? item.itemId ?? item.id;
    const deltaText = item.delta || "";
    // Caller injects role so we create the item on the correct side.
    const role: "user" | "assistant" = item.role === 'user' ? 'user' : 'assistant';
    console.log('[handleTranscriptionDelta] itemId:', itemId, '| role:', role, '| delta:', JSON.stringify(deltaText));
    if (itemId) {
      // Create the item if it doesn't exist yet (history_added may arrive after the
      // first delta, so we eagerly create it here with the correct role).
      addTranscriptMessage(itemId, role, '');
      updateTranscriptMessage(itemId, deltaText, true);
    }
  }

  function handleTranscriptionCompleted(item: any) {
    // History updates don't reliably end in a completed item,
    // so we need to handle finishing up when the transcription is completed.
    // item_id comes from transport events (snake_case); itemId/id from SDK history events.
    // Callers inject role='user' or role='assistant' explicitly so we never default incorrectly.
    const itemId = item.item_id ?? item.itemId ?? item.id;
    const role: "user" | "assistant" = item.role === "user" ? "user" : "assistant";
    const finalTranscript =
        !item.transcript || item.transcript === "\n"
        ? "[inaudible]"
        : item.transcript;
    console.log('[handleTranscriptionCompleted] itemId:', itemId, '| role:', role, '| final:', JSON.stringify(finalTranscript));
    if (itemId) {
      // Ensure the item exists with the correct role before updating.
      // addTranscriptMessage is a no-op if the item already exists.
      addTranscriptMessage(itemId, role, finalTranscript);
      updateTranscriptMessage(itemId, finalTranscript, false);
      const transcriptItem = transcriptItems.find((i) => i.itemId === itemId);
      updateTranscriptItem(itemId, { status: 'DONE' });

      // If guardrailResult still pending, mark PASS.
      if (transcriptItem?.guardrailResult?.status === 'IN_PROGRESS') {
        updateTranscriptItem(itemId, {
          guardrailResult: {
            status: 'DONE',
            category: 'NONE',
            rationale: '',
          },
        });
      }
    }
  }

  function handleGuardrailTripped(details: any, _agent: any, guardrail: any) {
    console.log("[guardrail tripped]", details, _agent, guardrail);
    const moderation = extractModeration(guardrail.result.output.outputInfo);
    logServerEvent({ type: 'guardrail_tripped', payload: moderation });

    // find the last assistant message in details.context.history
    const lastAssistant = extractLastAssistantMessage(details?.context?.history);

    if (lastAssistant && moderation) {
      const category = moderation.moderationCategory ?? 'NONE';
      const rationale = moderation.moderationRationale ?? '';
      const offendingText: string | undefined = moderation?.testText;

      updateTranscriptItem(lastAssistant.itemId, {
        guardrailResult: {
          status: 'DONE',
          category,
          rationale,
          testText: offendingText,
        },
      });
    }
  }

  const handlersRef = useRef({
    handleAgentToolStart,
    handleAgentToolEnd,
    handleHistoryUpdated,
    handleHistoryAdded,
    handleTranscriptionDelta,
    handleTranscriptionCompleted,
    handleGuardrailTripped,
  });

  handlersRef.current = {
    handleAgentToolStart,
    handleAgentToolEnd,
    handleHistoryUpdated,
    handleHistoryAdded,
    handleTranscriptionDelta,
    handleTranscriptionCompleted,
    handleGuardrailTripped,
  };

  return handlersRef;
}