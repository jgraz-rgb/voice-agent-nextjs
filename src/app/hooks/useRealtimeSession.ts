import { useCallback, useRef, useState } from 'react';
import {
  RealtimeSession,
  RealtimeAgent,
  OpenAIRealtimeWebRTC,
} from '@openai/agents/realtime';

import { applyCodecPreferences } from '../lib/codecUtils';
import { useEvent } from '../contexts/EventContext';
import { useHandleSessionHistory } from './useHandleSessionHistory';
import { SessionStatus } from '../types';

export interface RealtimeSessionCallbacks {
  onConnectionChange?: (status: SessionStatus) => void;
  onAgentHandoff?: (agentName: string) => void;
  onAgentSpeakingChange?: (speaking: boolean) => void;
}

export interface ConnectOptions {
  getEphemeralKey: () => Promise<string>;
  initialAgents: RealtimeAgent[];
  audioElement?: HTMLAudioElement;
  extraContext?: Record<string, any>;
  outputGuardrails?: any[];
}

export function useRealtimeSession(callbacks: RealtimeSessionCallbacks = {}) {
  const sessionRef = useRef<RealtimeSession | null>(null);
  const [status, setStatus] = useState<SessionStatus>('DISCONNECTED');
  const { logClientEvent } = useEvent();

  const updateStatus = useCallback(
    (s: SessionStatus) => {
      setStatus(s);
      callbacks.onConnectionChange?.(s);
      logClientEvent({}, s);
    },
    [callbacks],
  );

  const { logServerEvent } = useEvent();

  const historyHandlersRef = useHandleSessionHistory();

  let agentSpeaking = false;

  function handleTransportEvent(event: any) {
    switch (event.type) {
      // ── Interruption detection ────────────────────────────────────────────
      case "input_audio_buffer.speech_started": {
        if (agentSpeaking) {
          console.log('[Interrupt] 🎤 User started speaking while agent was talking — VAD interruption');
        }
        break;
      }
      // ── User speech transcription ─────────────────────────────────────────
      case "conversation.item.input_audio_transcription.completed": {
        console.log('[Transcribe] ✅ completed — text:', event.transcript ?? '(empty)');
        // Inject role='user' — the raw event has no role field so handleTranscriptionCompleted
        // would default to 'assistant', causing the user's words to appear on the wrong side.
        historyHandlersRef.current.handleTranscriptionCompleted({ ...event, role: 'user' });
        break;
      }
      case "conversation.item.input_audio_transcription.failed": {
        console.warn('[Transcribe] ❌ failed —', event.error?.message ?? event.error ?? 'unknown error');
        break;
      }
      // ── Agent audio transcript (OpenAI API current names) ─────────────────
      // The API renamed response.audio_transcript.* → response.output_audio_transcript.*
      case "response.output_audio_transcript.done":
      // Legacy name kept as fallback in case older API versions are used
      case "response.audio_transcript.done": {
        // Inject role='assistant' explicitly so the item is always on the right side.
        historyHandlersRef.current.handleTranscriptionCompleted({ ...event, role: 'assistant' });
        break;
      }
      case "response.output_audio_transcript.delta":
      // Legacy name kept as fallback
      case "response.audio_transcript.delta": {
        historyHandlersRef.current.handleTranscriptionDelta({ ...event, role: 'assistant' });
        break;
      }
      // ── Agent speaking state ──────────────────────────────────────────────
      case "response.output_audio.delta":
      case "response.output_audio.started": {
        if (!agentSpeaking) {
          agentSpeaking = true;
          callbacks.onAgentSpeakingChange?.(true);
        }
        break;
      }
      case "response.output_audio.done":
      case "response.completed":
      case "response.done": {
        if (agentSpeaking) {
          agentSpeaking = false;
          callbacks.onAgentSpeakingChange?.(false);
        }
        break;
      }
      default: {
        logServerEvent(event);
        break;
      }
    }
  }

  const codecParamRef = useRef<string>(
    (typeof window !== 'undefined'
      ? (new URLSearchParams(window.location.search).get('codec') ?? 'opus')
      : 'opus')
      .toLowerCase(),
  );

  const applyCodec = useCallback(
    (pc: RTCPeerConnection) => applyCodecPreferences(pc, codecParamRef.current),
    [],
  );

  const handleAgentHandoff = (item: any) => {
    const history = item.context.history;
    const lastMessage = history[history.length - 1];
    const agentName = lastMessage.name.split("transfer_to_")[1];
    callbacks.onAgentHandoff?.(agentName);
  };

  // Register all event handlers immediately on a given session instance
  const registerEventHandlers = useCallback((session: RealtimeSession) => {
    console.log("[useRealtimeSession] registerEventHandlers called — attaching listeners to session:", session);

    session.on("error", (...args: any[]) => {
      console.error("[useRealtimeSession] error event:", args[0]);
      logServerEvent({ type: "error", message: args[0] });
    });

    session.on("agent_handoff", handleAgentHandoff);
    session.on("agent_tool_start", (details: any, agent: any, functionCall: any) => {
      historyHandlersRef.current.handleAgentToolStart(details, agent, functionCall);
    });
    session.on("agent_tool_end", (details: any, agent: any, functionCall: any, result: any) => {
      historyHandlersRef.current.handleAgentToolEnd(details, agent, functionCall, result);
    });
    session.on("history_updated", (items: any[]) => {
      console.log("[useRealtimeSession] history_updated fired, items count:", items?.length);
      historyHandlersRef.current.handleHistoryUpdated(items);
    });
    session.on("history_added", (item: any) => {
      console.log("[useRealtimeSession] history_added fired:", item);
      historyHandlersRef.current.handleHistoryAdded(item);
    });
    session.on("guardrail_tripped", (details: any, agent: any, guardrail: any) => {
      historyHandlersRef.current.handleGuardrailTripped(details, agent, guardrail);
    });

    // Raw transport log — log every event type so we can confirm events are flowing
    session.on("transport_event", (event: any) => {
      console.log("[transport_event] type:", event?.type);
      handleTransportEvent(event);
    });
  }, [historyHandlersRef]);

  const connect = useCallback(
    async ({
      getEphemeralKey,
      initialAgents,
      audioElement,
      extraContext,
      outputGuardrails,
    }: ConnectOptions) => {
      if (sessionRef.current) return; // already connected

      updateStatus('CONNECTING');

      const ek = await getEphemeralKey();
      const rootAgent = initialAgents[0];

      const realtimeModel = process.env.NEXT_PUBLIC_REALTIME_MODEL || 'gpt-realtime-1.5';

      const session = new RealtimeSession(rootAgent, {
        transport: new OpenAIRealtimeWebRTC({
          audioElement,
          changePeerConnection: async (pc: RTCPeerConnection) => {
            applyCodec(pc);
            return pc;
          },
        }),
        model: realtimeModel,
        config: {
          inputAudioTranscription: {
            model: 'gpt-4o-transcribe',
            language: 'en',
          },
        },
        outputGuardrails: outputGuardrails ?? [],
        context: extraContext ?? {},
      });

      // Attach handlers BEFORE connecting to avoid missing early events
      registerEventHandlers(session);

      // Sanity check: verify that the session's on() method actually registers listeners
      let _historyUpdatedReceived = false;
      session.once('history_updated', (items: any[]) => {
        _historyUpdatedReceived = true;
        console.log('[useRealtimeSession] ✅ once(history_updated) fired — EventEmitter works! items:', items?.length);
      });

      sessionRef.current = session;
      await session.connect({ apiKey: ek });
      console.log('[useRealtimeSession] connect() resolved — _historyUpdatedReceived:', _historyUpdatedReceived);
      updateStatus('CONNECTED');
    },
    [callbacks, updateStatus, registerEventHandlers],
  );

  const disconnect = useCallback(() => {
    sessionRef.current?.close();
    sessionRef.current = null;
    updateStatus('DISCONNECTED');
  }, [updateStatus]);

  const assertconnected = () => {
    if (!sessionRef.current) throw new Error('RealtimeSession not connected');
  };

  const interrupt = useCallback(() => {
    console.log('[Interrupt] 🛑 interrupt() called — stopping agent response');
    sessionRef.current?.interrupt();
  }, []);

  const sendUserText = useCallback((text: string) => {
    assertconnected();
    sessionRef.current!.sendMessage(text);
  }, []);

  const sendEvent = useCallback((ev: any) => {
    sessionRef.current?.transport.sendEvent(ev);
  }, []);

  // Use SDK's updateSessionConfig so the correct nested GA format is sent.
  // This is the proper way to update turn_detection etc. without bypassing
  // the SDK's payload builder (which adds type:"realtime", model, etc.).
  const updateSessionConfig = useCallback((config: any) => {
    sessionRef.current?.transport.updateSessionConfig(config);
  }, []);

  const mute = useCallback((m: boolean) => {
    sessionRef.current?.mute(m);
  }, []);

  const pushToTalkStart = useCallback(() => {
    if (!sessionRef.current) return;
    sessionRef.current.transport.sendEvent({ type: 'input_audio_buffer.clear' } as any);
  }, []);

  const pushToTalkStop = useCallback(() => {
    if (!sessionRef.current) return;
    sessionRef.current.transport.sendEvent({ type: 'input_audio_buffer.commit' } as any);
    sessionRef.current.transport.sendEvent({ type: 'response.create' } as any);
  }, []);

  return {
    status,
    connect,
    disconnect,
    sendUserText,
    sendEvent,
    updateSessionConfig,
    mute,
    pushToTalkStart,
    pushToTalkStop,
    interrupt,
    agentSpeaking
  } as const;
}
