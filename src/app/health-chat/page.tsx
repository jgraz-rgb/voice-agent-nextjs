"use client";

import { useEffect, useRef, useState } from 'react';
import { Send } from 'lucide-react';
import ChatMessage from '@/components/chat/ChatMessage';
import TypingIndicator from '@/components/chat/TypingIndicator';
import ActionTray from '@/components/chat/ActionTray';
import { InlineSelectWithConfirm, DualInlineSelect } from '@/components/chat/InlineSelect';
import { useChatEngine } from '@/hooks/useChatEngine';

export default function HealthChatPage() {
  const {
    messages,
    isTyping,
    actionsEnabled,
    inputEnabled, // ✅ FIX: use this from hook
    flowState,
    initialize,
    handleStateSelection,
    handleAction,
    handlePolicySelect,
    handleCompareSelect,
    handleSummarizeSelect,
    handleUserInput,
    resetChat,
    policies,
  } = useChatEngine();

  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);

  const isCompleted = flowState === 'completed';
  const isFlowActive =
    !actionsEnabled &&
    !['onboarding', 'select-state'].includes(flowState);

  /* ───────────────── INIT ───────────────── */

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      initialize();
    }
  }, [initialize]);

  /* ───────────────── AUTO SCROLL ───────────────── */

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isTyping, flowState]);

  /* ───────────────── INPUT HANDLERS ───────────────── */

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || !inputEnabled) return;

    handleUserInput(trimmed);
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  /* ───────────────── UI HELPERS ───────────────── */

  const policyNames = policies.map((p) => p.name); // ✅ FIX: correct type for dropdown

  /* ───────────────── RENDER ───────────────── */

  return (
    <div className="flex flex-col h-screen max-w-3xl mx-auto bg-background">

      {/* HEADER */}
      <div className="flex items-center gap-3 px-5 py-4 border-b border-border bg-card">
        <div className="w-10 h-10 rounded-full bg-primary flex items-center justify-center text-primary-foreground font-bold text-sm">
          IA
        </div>
        <div>
          <h1 className="text-base font-semibold text-foreground">
            InsureAssist
          </h1>
          <p className="text-xs text-muted-foreground">
            AI Health Insurance Copilot
          </p>
        </div>
        <div className="ml-auto w-2 h-2 rounded-full bg-green-500" />
      </div>

      {/* CHAT AREA */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-5 py-6 space-y-4"
      >
        {messages.map((msg) => (
          <ChatMessage key={msg.id} message={msg} />
        ))}

        {/* STATE SELECT */}
        {flowState === 'select-state' && (
          <BotBubble>
            <p className="text-sm">
              Please select your state:
            </p>
            <InlineSelectWithConfirm
              options={['Florida', 'Texas']}
              placeholder="Select a state"
              onConfirm={handleStateSelection}
            />
          </BotBubble>
        )}

        {/* PITCH SELECT */}
        {flowState === 'pitch-select-policy' && (
          <BotBubble>
            <p className="text-sm">
              Select a policy for your pitch:
            </p>
            <InlineSelectWithConfirm
              options={policyNames}
              placeholder="Select a policy"
              onConfirm={handlePolicySelect}
            />
          </BotBubble>
        )}

        {/* COMPARE SELECT */}
        {flowState === 'compare-select' && (
          <BotBubble>
            <p className="text-sm">
              Select two policies to compare:
            </p>
            <DualInlineSelect
              options1={policyNames}
              options2={policyNames}
              onConfirm={handleCompareSelect}
            />
          </BotBubble>
        )}

        {/* SUMMARIZE SELECT */}
        {flowState === 'summarize-select' && (
          <BotBubble>
            <p className="text-sm">
              Select a policy to summarize:
            </p>
            <InlineSelectWithConfirm
              options={policyNames}
              placeholder="Select a policy"
              onConfirm={handleSummarizeSelect}
            />
          </BotBubble>
        )}

        {isTyping && <TypingIndicator />}
      </div>

      {/* FOOTER */}
      <div className="border-t border-border bg-card px-5 py-3 space-y-3">
        <ActionTray
          onAction={handleAction}
          disabled={!actionsEnabled}
          showRefresh={isFlowActive || isCompleted}
          onRefresh={resetChat}
          hideActions={isCompleted}
        />

        <div className="flex items-center gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type your message..."
            disabled={!inputEnabled} // ✅ FIX
            className="flex-1 rounded-xl border px-4 py-2.5 text-sm focus:outline-none disabled:opacity-40"
          />

          <button
            onClick={handleSend}
            disabled={!input.trim() || !inputEnabled} // ✅ FIX
            className="w-10 h-10 rounded-xl bg-primary text-white flex items-center justify-center disabled:opacity-40"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

/* ───────────────── SMALL REUSABLE BOT BUBBLE ───────────────── */

function BotBubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 animate-fade-in">
      <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-primary-foreground text-xs font-bold shrink-0">
        IA
      </div>
      <div className="chat-bubble-bot max-w-[75%] space-y-2">
        {children}
      </div>
    </div>
  );
}