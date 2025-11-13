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
      case "conversation.item.input_audio_transcription.completed": {
        historyHandlersRef.current.handleTranscriptionCompleted(event);
        break;
      }
      case "response.audio_transcript.done": {
        historyHandlersRef.current.handleTranscriptionCompleted(event);
        break;
      }
      case "response.audio_transcript.delta": {
        historyHandlersRef.current.handleTranscriptionDelta(event);
        break;
      }
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
    session.on("error", (...args: any[]) => {
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
      historyHandlersRef.current.handleHistoryUpdated(items);
    });
    session.on("history_added", (item: any) => {
      historyHandlersRef.current.handleHistoryAdded(item);
    });
    session.on("guardrail_tripped", (details: any, agent: any, guardrail: any) => {
      historyHandlersRef.current.handleGuardrailTripped(details, agent, guardrail);
    });

    session.on("transport_event", handleTransportEvent);
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

      const session = new RealtimeSession(rootAgent, {
        transport: new OpenAIRealtimeWebRTC({
          audioElement,
          changePeerConnection: async (pc: RTCPeerConnection) => {
            applyCodec(pc);
            return pc;
          },
        }),
        model: process.env.NEXT_PUBLIC_REALTIME_MODEL || 'gpt-realtime',
        config: {
          inputAudioTranscription: {
            model: 'gpt-4o-mini-transcribe',
            language:"hi"
          },
        },
        outputGuardrails: outputGuardrails ?? [],
        context: extraContext ?? {},
      });

      // Attach handlers BEFORE connecting to avoid missing early events
      registerEventHandlers(session);

      sessionRef.current = session;
      await session.connect({ apiKey: ek });
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
    sessionRef.current?.interrupt();
  }, []);

  const sendUserText = useCallback((text: string) => {
    assertconnected();
    sessionRef.current!.sendMessage(text);
  }, []);

  const sendEvent = useCallback((ev: any) => {
    sessionRef.current?.transport.sendEvent(ev);
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
    mute,
    pushToTalkStart,
    pushToTalkStop,
    interrupt,
    agentSpeaking
  } as const;
}
