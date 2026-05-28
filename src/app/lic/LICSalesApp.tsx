'use client';
import React, { useEffect, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import Image from 'next/image';

// UI components (shared with main app)
import Transcript from '@/app/components/Transcript';
import WorkflowSection from '@/app/components/WorkflowSection';
import BottomToolbar from '@/app/components/BottomToolbar';

// Types
import { SessionStatus } from '@/app/types';

// Context
import { useTranscript } from '@/app/contexts/TranscriptContext';
import { useEvent } from '@/app/contexts/EventContext';

// LIC-specific session hook (text modality + TTS WS)
import { useLICSalesSession } from '@/app/hooks/useLICSalesSession';

// Agent config
import licSalesScenario, { licHousingCompanyName as licSalesCompanyName, formatZendeskSubject, formatZendeskDescription, getZendeskGroupId } from '@/app/agentConfigs/LICSales';
import { calculateLeadScore } from '@/app/agentConfigs/LICSales/scoring';
import { createModerationGuardrail } from '@/app/agentConfigs/guardrails';

import useAudioDownload from '@/app/hooks/useAudioDownload';

// ─── Props ────────────────────────────────────────────────────────────────────

interface LICSalesAppProps {
  welcomeMessage?: string;
  imageUrl?: string;
  WorkflowImage?: string;
  leadInfo: {
    firstName: string;
    lastName: string;
    phoneNumber: string;
    propertyLocation: string;
    areaOffice: string;
  };
}

// ─── Component ────────────────────────────────────────────────────────────────

function LICSalesApp({ welcomeMessage, imageUrl, WorkflowImage, leadInfo }: LICSalesAppProps) {

  const { addTranscriptMessage, addTranscriptBreadcrumb } = useTranscript();
  const { logClientEvent, logServerEvent } = useEvent();

  const [sessionStatus, setSessionStatus] = useState<SessionStatus>('DISCONNECTED');
  const [userText, setUserText] = useState('');
  const [isPTTActive, setIsPTTActive] = useState(false);
  const [isPTTUserSpeaking, setIsPTTUserSpeaking] = useState(false);
  const [isEventsPaneExpanded, setIsEventsPaneExpanded] = useState(true);
  const [isAudioPlaybackEnabled, setIsAudioPlaybackEnabled] = useState(() => {
    if (typeof window === 'undefined') return true;
    const stored = localStorage.getItem('audioPlaybackEnabled');
    return stored ? stored === 'true' : true;
  });

  const handoffTriggeredRef = useRef(false);
  const agentStateRef = useRef<Record<string, unknown>>({});
  const callStartTimeRef = useRef<number | null>(null);

  // ── LIC session hook (text-only modality, TTS WS) ─────────────────────────
  const {
    connect,
    disconnect,
    sendUserText,
    sendEvent,
    updateSessionConfig,
    interrupt,
    mute,
  } = useLICSalesSession({
    onConnectionChange: (s) => setSessionStatus(s as SessionStatus),
    onAgentHandoff: () => {
      handoffTriggeredRef.current = true;
    },
    onAgentSpeakingChange: (_speaking: boolean) => {
      // Could be used to animate a speaking indicator
    },
  });

  const { startRecording, stopRecording, downloadRecording } = useAudioDownload();

  // ── Ephemeral key fetch ────────────────────────────────────────────────────

  const fetchEphemeralKey = async (): Promise<string | null> => {
    logClientEvent({ url: '/session' }, 'fetch_session_token_request');
    // Pass agent instructions + text-only modality at key creation time.
    // gpt-realtime-1.5 ignores post-connect session.update for instructions,
    // so they must be embedded when the ephemeral key is minted.
    const rootAgent = licSalesScenario[0];
    const instructions =
      typeof rootAgent?.instructions === 'string'
        ? rootAgent.instructions
        : undefined;
    const tokenResponse = await fetch('/bfsi-agentic-suite/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instructions,
        output_modalities: ['text'],
        transcription_language: 'hi',
      }),
    });
    const data = await tokenResponse.json();
    logServerEvent(data, 'fetch_session_token_response');

    if (!data.client_secret?.value) {
      logClientEvent(data, 'error.no_ephemeral_key');
      console.error('No ephemeral key provided by the server');
      setSessionStatus('DISCONNECTED');
      return null;
    }

    return data.client_secret.value;
  };

  // ── Connect ────────────────────────────────────────────────────────────────

  const connectToRealtime = async () => {
    if (sessionStatus !== 'DISCONNECTED') return;
    setSessionStatus('CONNECTING');

    try {
      // Store lead info in session state BEFORE connecting so the agent has it on first response
      if (leadInfo) {
        await fetch('/bfsi-agentic-suite/api/state', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            first_name: leadInfo.firstName,
            last_name: leadInfo.lastName,
            phone_number: leadInfo.phoneNumber,
            property_location: leadInfo.propertyLocation,
            preferred_area_office: leadInfo.areaOffice,
          }),
        }).catch((err) => {
          console.error('Failed to store lead info:', err);
        });
      }

      const EPHEMERAL_KEY = await fetchEphemeralKey();
      if (!EPHEMERAL_KEY) return;

      await connect({
        getEphemeralKey: async () => EPHEMERAL_KEY,
        initialAgents: licSalesScenario,
        outputGuardrails: [createModerationGuardrail(licSalesCompanyName)],
        extraContext: { addTranscriptBreadcrumb },
      });
    } catch (err) {
      console.error('Error connecting LICSales session:', err);
      setSessionStatus('DISCONNECTED');
    }
  };

  // ── Zendesk ticket on disconnect ──────────────────────────────────────────

  const createAbandonedZendeskTicket = async () => {
    if (sessionStatus !== 'CONNECTED') return;

    let stateSnapshot: any = agentStateRef.current;
    try {
      const res = await fetch('/bfsi-agentic-suite/api/state');
      if (res.ok) stateSnapshot = await res.json();
    } catch {}

    // If the agent never called calculateLeadScore (early disconnect), compute it now
    if (stateSnapshot.total_score == null) {
      const result = calculateLeadScore(stateSnapshot);
      stateSnapshot = {
        ...stateSnapshot,
        p1_score: result.p1.score,
        p2_score: result.p2.score,
        p3_score: result.p3.score,
        p4_score: result.p4.score,
        p5_score: result.p5.score,
        total_score: result.total_score,
        lead_category: stateSnapshot.lead_category ?? result.lead_category,
        scoring_evidence: result.scoring_evidence,
      };
    }

    const callDurationSeconds = callStartTimeRef.current != null
      ? Math.round((Date.now() - callStartTimeRef.current) / 1000)
      : undefined;

    const subject = formatZendeskSubject(stateSnapshot);
    const description = formatZendeskDescription(stateSnapshot, callDurationSeconds);
    const group_id = getZendeskGroupId(stateSnapshot.lead_category as string | undefined);

    fetch('https://bfsi.searchunify.com/bfsi-api/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject, description, group_id }),
    }).catch(() => {});
  };

  // ── Disconnect ─────────────────────────────────────────────────────────────

  const disconnectFromRealtime = async () => {
    await createAbandonedZendeskTicket();
    disconnect();
    setSessionStatus('DISCONNECTED');
    setIsPTTUserSpeaking(false);
  };

  // ── Auto-connect on mount ──────────────────────────────────────────────────

  useEffect(() => {
    if (sessionStatus === 'DISCONNECTED') {
      connectToRealtime();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Session update (turn detection) ───────────────────────────────────────

  const updateSession = (shouldTriggerResponse = false) => {
    // Use SDK's updateSessionConfig — do NOT send instructions here.
    // The SDK already sends them at connect via initialSessionConfig from the RealtimeAgent.
    // A second raw session.update overwrites with the new GA nested format which
    // gpt-realtime-1.5 may partially apply, dropping the instructions field.
    const turnDetection = isPTTActive
      ? null
      : {
          type: 'server_vad',
          threshold: 0.6,
          prefix_padding_ms: 300,
          silence_duration_ms: 600,
          create_response: true,
        };

    updateSessionConfig({
      outputModalities: ['text'], // text-only → routes to Sarvam TTS
      audio: {
        input: {
          transcription: { model: 'gpt-4o-transcribe', language: 'hi' },
          turnDetection: turnDetection as any,
        },
      },
    } as any);

    if (shouldTriggerResponse) {
      sendSimulatedUserMessage('hi!');
    }
  };

  useEffect(() => {
    if (sessionStatus === 'CONNECTED') {
      callStartTimeRef.current = Date.now();
      addTranscriptBreadcrumb(`Agent: ${licSalesScenario[0]?.name}`);
      updateSession(true);
      // Persist call_start_time into agent state so formatZendeskDescription can use it
      fetch('/bfsi-agentic-suite/api/state', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ call_start_time: new Date().toISOString() }),
      }).catch(() => {});
    } else {
      callStartTimeRef.current = null;
    }
  }, [sessionStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (sessionStatus === 'CONNECTED') {
      updateSession();
    }
  }, [isPTTActive]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Audio playback toggle ──────────────────────────────────────────────────

  useEffect(() => {
    try { mute(!isAudioPlaybackEnabled); } catch { /* noop */ }
  }, [isAudioPlaybackEnabled]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (sessionStatus === 'CONNECTED') {
      try { mute(!isAudioPlaybackEnabled); } catch { /* noop */ }
    }
  }, [sessionStatus, isAudioPlaybackEnabled]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── State polling ──────────────────────────────────────────────────────────

  useEffect(() => {
    if (sessionStatus !== 'CONNECTED') return;
    const poll = async () => {
      try {
        const res = await fetch('/bfsi-agentic-suite/api/state');
        if (res.ok) agentStateRef.current = await res.json();
      } catch {}
    };
    poll();
    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, [sessionStatus]);

  // ── Zendesk ticket on tab close / navigation ──────────────────────────────

  useEffect(() => {
    const handleBeforeUnload = () => {
      if (sessionStatus !== 'CONNECTED') return;

      let state: any = agentStateRef.current;
      if (state.total_score == null) {
        const result = calculateLeadScore(state);
        state = {
          ...state,
          p1_score: result.p1.score,
          p2_score: result.p2.score,
          p3_score: result.p3.score,
          p4_score: result.p4.score,
          p5_score: result.p5.score,
          total_score: result.total_score,
          lead_category: state.lead_category ?? result.lead_category,
          scoring_evidence: result.scoring_evidence,
        };
      }

      const callDurationSeconds = callStartTimeRef.current != null
        ? Math.round((Date.now() - callStartTimeRef.current) / 1000)
        : undefined;

      const subject = formatZendeskSubject(state);
      const description = formatZendeskDescription(state, callDurationSeconds);
      const group_id = getZendeskGroupId(state.lead_category);

      navigator.sendBeacon(
        'https://bfsi.searchunify.com/bfsi-api/tickets',
        new Blob([JSON.stringify({ subject, description, group_id })], { type: 'application/json' }),
      );
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [sessionStatus]);

  // ── Mic recording (for download) ───────────────────────────────────────────
  // Note: Since TTS audio is played via AudioContext (not a MediaStream),
  // recording captures only the microphone input in this mode.
  useEffect(() => {
    if (sessionStatus === 'CONNECTED') {
      navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
        startRecording(stream);
      }).catch(() => {});
    }
    return () => { stopRecording(); };
  }, [sessionStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Local storage persistence ──────────────────────────────────────────────

  useEffect(() => {
    const stored = localStorage.getItem('pushToTalkUI');
    if (stored) setIsPTTActive(stored === 'true');
    const storedLogs = localStorage.getItem('logsExpanded');
    if (storedLogs) setIsEventsPaneExpanded(storedLogs === 'true');
    const storedAudio = localStorage.getItem('audioPlaybackEnabled');
    if (storedAudio) setIsAudioPlaybackEnabled(storedAudio === 'true');
  }, []);

  useEffect(() => { localStorage.setItem('pushToTalkUI', isPTTActive.toString()); }, [isPTTActive]);
  useEffect(() => { localStorage.setItem('logsExpanded', isEventsPaneExpanded.toString()); }, [isEventsPaneExpanded]);
  useEffect(() => { localStorage.setItem('audioPlaybackEnabled', isAudioPlaybackEnabled.toString()); }, [isAudioPlaybackEnabled]);

  // ── Message helpers ────────────────────────────────────────────────────────

  const sendClientEvent = (eventObj: any, eventNameSuffix = '') => {
    try {
      sendEvent(eventObj);
      logClientEvent(eventObj, eventNameSuffix);
    } catch (err) {
      console.error('Failed to send event:', err);
    }
  };

  const sendSimulatedUserMessage = (text: string) => {
    const id = uuidv4().slice(0, 32);
    addTranscriptMessage(id, 'user', text, true);
    sendClientEvent({
      type: 'conversation.item.create',
      item: { id, type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    });
    sendClientEvent({ type: 'response.create' }, '(simulated user text message)');
  };

  const handleSendTextMessage = () => {
    if (!userText.trim() || sessionStatus !== 'CONNECTED') return;
    interrupt();
    try { sendUserText(userText.trim()); } catch (err) { console.error('Failed to send:', err); }
    setUserText('');
  };

  // ── PTT handlers ───────────────────────────────────────────────────────────

  const handleTalkButtonDown = () => {
    if (sessionStatus !== 'CONNECTED') return;
    interrupt();
    setIsPTTUserSpeaking(true);
    sendClientEvent({ type: 'input_audio_buffer.clear' }, 'clear PTT buffer');
  };

  const handleTalkButtonUp = () => {
    if (sessionStatus !== 'CONNECTED' || !isPTTUserSpeaking) return;
    setIsPTTUserSpeaking(false);
    sendClientEvent({ type: 'input_audio_buffer.commit' }, 'commit PTT');
    sendClientEvent({ type: 'response.create' }, 'trigger response PTT');
  };

  const onToggleConnection = () => {
    if (sessionStatus === 'CONNECTED' || sessionStatus === 'CONNECTING') {
      disconnectFromRealtime();
    } else {
      connectToRealtime();
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="text-base flex flex-col h-screen bg-gray-100 text-gray-800 relative">
      {/* Header */}
      <div className="p-5 text-lg font-semibold flex justify-between items-center">
        <div className="flex items-center cursor-pointer" onClick={() => window.location.reload()}>
          {imageUrl && (
            <Image src={imageUrl} alt="Logo" width={60} height={30} className="mr-2" />
          )}
          <div>{welcomeMessage}</div>
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-1 gap-2 px-2 overflow-hidden relative">
        <WorkflowSection WorkflowImage={WorkflowImage} />
        <Transcript
          userText={userText}
          setUserText={setUserText}
          onSendMessage={handleSendTextMessage}
          downloadRecording={downloadRecording}
          canSend={sessionStatus === 'CONNECTED'}
        />
      </div>

      {/* Footer toolbar */}
      <BottomToolbar
        sessionStatus={sessionStatus}
        onToggleConnection={onToggleConnection}
        isPTTActive={isPTTActive}
        setIsPTTActive={setIsPTTActive}
        isPTTUserSpeaking={isPTTUserSpeaking}
        handleTalkButtonDown={handleTalkButtonDown}
        handleTalkButtonUp={handleTalkButtonUp}
        isEventsPaneExpanded={isEventsPaneExpanded}
        setIsEventsPaneExpanded={setIsEventsPaneExpanded}
        isAudioPlaybackEnabled={isAudioPlaybackEnabled}
        setIsAudioPlaybackEnabled={setIsAudioPlaybackEnabled}
      />
    </div>
  );
}

export default LICSalesApp;
