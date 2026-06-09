'use client';
import React from 'react';

interface PhoneModeLeadInfo {
  firstName: string;
  lastName: string;
  phoneNumber: string;
  propertyLocation: string;
  areaOffice: string;
}

export function PhoneModePanel({ agentKey, leadInfo }: { agentKey: string; leadInfo?: PhoneModeLeadInfo }) {
  const [toNumber, setToNumber] = React.useState('');
  const [callSid, setCallSid] = React.useState<string | null>(null);
  const [callStatus, setCallStatus] = React.useState<'idle' | 'calling' | 'active' | 'ended'>('idle');
  const [error, setError] = React.useState<string | null>(null);
  const pollRef = React.useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = React.useCallback(async () => {
    try {
      const res = await fetch('/bfsi-agentic-suite/api/twilio/status');
      if (!res.ok) return;
      const data = await res.json();
      if (data.status === 'active' && data.callSid) {
        setCallStatus('active');
        setCallSid(data.callSid);
      } else if (data.status === 'post_call' || data.status === 'free') {
        if (callStatus === 'active') setCallStatus('ended');
      }
    } catch {}
  }, [callStatus]);

  React.useEffect(() => {
    if (callStatus === 'calling' || callStatus === 'active') {
      pollRef.current = setInterval(fetchStatus, 3000);
    } else {
      if (pollRef.current) clearInterval(pollRef.current);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [callStatus, fetchStatus]);

  const handleCall = async () => {
    const trimmed = toNumber.trim();
    if (!trimmed) { setError('Enter a phone number first'); return; }
    setError(null);
    setCallStatus('calling');
    try {
      // Persist lead info to state BEFORE placing the call so the server-side
      // agent (getLeadState / updateLeadState tools) has it on first response.
      // In phone mode the browser never opens a WebRTC session, so this is the
      // only place the pre-collected lead data reaches /api/state.
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
        }).catch((err) => console.error('Failed to store lead info:', err));
      }

      const res = await fetch('/bfsi-agentic-suite/api/twilio/call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toNumber: trimmed, agentKey }),
      });
      const data = await res.json();
      if (data.success) {
        setCallSid(data.callSid);
        setCallStatus('active');
      } else {
        setError(data.error ?? 'Call failed');
        setCallStatus('idle');
      }
    } catch {
      setError('Server unavailable');
      setCallStatus('idle');
    }
  };

  const handleEndCall = async () => {
    if (!callSid) return;
    try {
      await fetch('/bfsi-agentic-suite/api/twilio/end-call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callSid }),
      });
    } catch {}
    await fetch('/bfsi-agentic-suite/api/twilio/release', { method: 'POST' });
    fetch('/bfsi-agentic-suite/api/state', { method: 'DELETE' }).catch(() => {});
    setCallStatus('ended');
    setCallSid(null);
  };

  const handleReset = () => {
    setCallStatus('idle');
    setCallSid(null);
    setError(null);
  };

  if (callStatus === 'idle' || callStatus === 'calling') {
    return (
      <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-xl px-3 py-1.5 shadow-sm">
        <input
          type="tel"
          placeholder="+91XXXXXXXXXX"
          value={toNumber}
          onChange={e => { setToNumber(e.target.value); setError(null); }}
          onKeyDown={e => e.key === 'Enter' && callStatus === 'idle' && handleCall()}
          disabled={callStatus === 'calling'}
          className="text-sm border border-gray-300 rounded px-2 py-1 w-40 focus:outline-none focus:ring-1 focus:ring-blue-400 disabled:opacity-50"
        />
        <button
          onClick={handleCall}
          disabled={callStatus === 'calling'}
          className="text-sm font-medium text-white rounded-lg px-3 py-1.5 disabled:opacity-60"
          style={{ backgroundColor: 'rgb(0,82,156)' }}
        >
          {callStatus === 'calling' ? 'Calling…' : 'Call'}
        </button>
        {error && <span className="text-xs text-red-600">{error}</span>}
      </div>
    );
  }

  if (callStatus === 'active') {
    return (
      <div className="flex items-center gap-3 bg-green-50 border border-green-200 rounded-xl px-4 py-2 shadow-sm">
        <span className="inline-block w-2 h-2 rounded-full bg-green-500 animate-pulse" />
        <span className="text-sm font-medium text-green-800">Call active — {toNumber}</span>
        <button
          onClick={handleEndCall}
          className="text-xs font-medium text-white rounded px-2 py-1"
          style={{ backgroundColor: 'rgb(185,28,28)' }}
        >
          End Call
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 bg-gray-50 border border-gray-200 rounded-xl px-4 py-2 shadow-sm">
      <span className="text-sm text-gray-600">Call ended.</span>
      <button onClick={handleReset} className="text-xs text-blue-600 underline">Call again</button>
    </div>
  );
}
