/**
 * Patches RTCPeerConnection.createDataChannel so that messages from OpenAI
 * that use legacy event names (pre-GA) are transparently remapped to the GA
 * names that @openai/agents-realtime SDK v0.11.x expects.
 */

const EVENT_REMAP: Record<string, string> = {
  'conversation.item.created': 'conversation.item.added',
};

function patchDataChannel(dc: RTCDataChannel): RTCDataChannel {
  const originalAddEventListener = dc.addEventListener.bind(dc);
  const originalRemoveEventListener = dc.removeEventListener.bind(dc);

  // Single raw logger — attached once, fires before any SDK listener
  let loggerAttached = false;
  const attachLogger = () => {
    if (loggerAttached) return;
    loggerAttached = true;
    const rawLogger = (event: Event) => {
      try {
        const raw = JSON.parse((event as MessageEvent).data);
        console.log('[DataChannel ←] type:', raw?.type);
      } catch { /* non-JSON */ }
    };
    originalAddEventListener('message', rawLogger);
  };

  // Map from original listener → wrapped listener so removeEventListener works.
  // Without this the SDK's removeEventListener('message', onConfigAck) call
  // silently fails because the registered listener is the wrapper, not the
  // original. The SDK relies on this remove to prevent onConfigAck from
  // firing after finish() — when it doesn't unregister, session.updated can
  // arrive after close() has been called, causing a double-finish and the
  // "Connection closed before session config was acknowledged" rejection.
  const wrapperMap = new WeakMap<EventListenerOrEventListenerObject, EventListenerOrEventListenerObject>();

  (dc as any).addEventListener = (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => {
    if (type !== 'message') {
      originalAddEventListener(type, listener, options as any);
      return;
    }
    attachLogger();

    const wrappedListener = (event: Event) => {
      const msgEvent = event as MessageEvent;
      let evt: MessageEvent = msgEvent;
      try {
        const raw = JSON.parse(msgEvent.data);
        if (raw?.type && EVENT_REMAP[raw.type]) {
          const patched = { ...raw, type: EVENT_REMAP[raw.type] };
          evt = new MessageEvent('message', {
            data: JSON.stringify(patched),
            origin: msgEvent.origin,
            lastEventId: msgEvent.lastEventId,
          });
        }
      } catch {
        // not JSON — pass through unchanged
      }
      if (typeof listener === 'function') {
        listener(evt);
      } else {
        listener.handleEvent(evt);
      }
    };

    wrapperMap.set(listener, wrappedListener);
    originalAddEventListener('message', wrappedListener, options as any);
  };

  (dc as any).removeEventListener = (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ) => {
    if (type !== 'message') {
      originalRemoveEventListener(type, listener, options as any);
      return;
    }
    // Remove the wrapper that was actually registered, not the original
    const wrapped = wrapperMap.get(listener);
    if (wrapped) {
      wrapperMap.delete(listener);
      originalRemoveEventListener('message', wrapped, options as any);
    } else {
      // Fallback: try removing the original directly (e.g. listeners added before patch)
      originalRemoveEventListener('message', listener, options as any);
    }
  };

  return dc;
}

if (typeof window !== 'undefined' && typeof RTCPeerConnection !== 'undefined') {
  console.log('[realtimeEventPatch] ✅ patch loaded — RTCPeerConnection.createDataChannel will be intercepted');

  // Intercept RTCPeerConnection constructor to log ICE/connection state changes
  const OrigRTCPeerConnection = window.RTCPeerConnection;
  (window as any).RTCPeerConnection = function(...args: any[]) {
    const pc = new OrigRTCPeerConnection(...args);
    pc.addEventListener('iceconnectionstatechange', () => {
      console.log('[ICE] iceConnectionState:', pc.iceConnectionState);
    });
    pc.addEventListener('connectionstatechange', () => {
      console.log('[ICE] connectionState:', pc.connectionState);
    });
    pc.addEventListener('icegatheringstatechange', () => {
      console.log('[ICE] iceGatheringState:', pc.iceGatheringState);
    });
    pc.addEventListener('icecandidate', (e: RTCPeerConnectionIceEvent) => {
      if (!e.candidate) console.log('[ICE] gathering complete (null candidate)');
    });
    return pc;
  };
  (window as any).RTCPeerConnection.prototype = OrigRTCPeerConnection.prototype;

  const OrigCreateDataChannel = RTCPeerConnection.prototype.createDataChannel;

  RTCPeerConnection.prototype.createDataChannel = function (
    label: string,
    options?: RTCDataChannelInit,
  ) {
    console.log('[realtimeEventPatch] createDataChannel intercepted, label:', label);
    const dc = OrigCreateDataChannel.call(this, label, options);

    // Log data channel lifecycle
    dc.addEventListener('open',  () => console.log('[DataChannel] ✅ open — readyState:', dc.readyState));
    dc.addEventListener('close', () => console.log('[DataChannel] ❌ closed'));
    dc.addEventListener('error', (e: Event) => console.error('[DataChannel] ❌ error:', e));

    // Intercept outbound messages:
    // 1. Strip read-only fields from session.update that cause OpenAI to silently
    //    drop the event (no session.updated reply → 5 s timeout every connect).
    //    audio.input.format, audio.output.format, audio.input.noise_reduction are
    //    set at connection time and cannot be changed via session.update.
    // 2. Log what we actually send.
    const origSend = dc.send.bind(dc);
    (dc as any).send = (data: string) => {
      try {
        const parsed = JSON.parse(data);
        if (parsed?.type === 'session.update' && parsed?.session) {
          const s = parsed.session;
          // Build a minimal valid session.update — only fields the GA endpoint accepts.
          // Unknown/read-only fields cause OpenAI to silently drop the event (no session.updated reply).
          const clean: any = { type: 'realtime' };

          if (s.model)             clean.model             = s.model;
          if (s.instructions)      clean.instructions      = s.instructions;
          if (s.output_modalities) clean.output_modalities = s.output_modalities;
          if (s.tool_choice)       clean.tool_choice       = s.tool_choice;
          if (s.tools)             clean.tools             = s.tools;
          if (s.turn_detection)    clean.turn_detection    = s.turn_detection; // flat, legacy key

          // audio.input: only transcription + turn_detection (no format, no noise_reduction, no speed)
          if (s.audio?.input?.transcription || s.audio?.input?.turn_detection) {
            clean.audio = { input: {} };
            if (s.audio.input.transcription) clean.audio.input.transcription = s.audio.input.transcription;
            if (s.audio.input.turn_detection) clean.audio.input.turn_detection = s.audio.input.turn_detection;
          }
          // audio.output: only voice (no format, no speed)
          if (s.audio?.output?.voice) {
            clean.audio = clean.audio ?? {};
            clean.audio.output = { voice: s.audio.output.voice };
          }

          parsed.session = clean;
          console.log('[DataChannel →] session.update (cleaned):', JSON.stringify(clean));
          origSend(JSON.stringify(parsed));
          return;
        }
        console.log('[DataChannel →] type:', parsed?.type);
      } catch { /* pass through unchanged */ }
      origSend(data);
    };

    return patchDataChannel(dc);
  };

  // Intercept fetch to log the SDP POST to /v1/realtime/calls
  const origFetch = window.fetch.bind(window);
  (window as any).fetch = async (...args: Parameters<typeof fetch>) => {
    const rawUrl = args[0];
    const urlStr: string =
      typeof rawUrl === 'string' ? rawUrl
      : rawUrl instanceof URL    ? rawUrl.href
      : (rawUrl as Request).url  ?? '';
    const res = await origFetch(...args);
    if (urlStr.includes('realtime/calls')) {
      const clone = res.clone();
      const body = await clone.text().catch(() => '(unreadable)');
      if (res.ok) {
        console.log('[SDP POST] ✅ status:', res.status, '| answer SDP length:', body.length);
        console.log('[SDP POST] answer SDP:\n', body);
      } else {
        console.error('[SDP POST] ❌ status:', res.status, '| body:', body.slice(0, 300));
      }
    }
    return res;
  };
}
