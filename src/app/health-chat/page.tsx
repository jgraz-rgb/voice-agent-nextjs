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

  const isFlowActive = !actionsEnabled && !['onboarding', 'select-state'].includes(flowState);
  const isCompleted = flowState === 'completed';

  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      initialize();
    }
  }, [initialize]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isTyping, flowState]);

  const handleSend = () => {
    if (!input.trim()) return;
    handleUserInput(input.trim());
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex flex-col h-screen max-w-3xl mx-auto bg-background">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-4 border-b border-border bg-card">
        <div className="w-10 h-10 rounded-full bg-primary flex items-center justify-center text-primary-foreground font-bold text-sm">
          IA
        </div>
        <div>
          <h1 className="text-base font-semibold text-foreground">InsureAssist</h1>
          <p className="text-xs text-muted-foreground">AI Health Insurance Copilot</p>
        </div>
        <div className="ml-auto w-2 h-2 rounded-full bg-green-500" />
      </div>

      {/* Chat area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-6 space-y-4">
        {messages.map((msg) => (
          <ChatMessage key={msg.id} message={msg} />
        ))}

        {/* Inline state selector after onboarding */}
        {flowState === 'select-state' && (
          <div className="flex items-start gap-3 animate-fade-in">
            <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-primary-foreground text-xs font-bold shrink-0">
              IA
            </div>
            <div className="chat-bubble-bot max-w-[75%]">
              <p className="text-sm leading-relaxed">Please select the state where your insurance services are available to continue:</p>
              <InlineSelectWithConfirm
                options={['Florida', 'Texas']}
                placeholder="Select a state"
                onConfirm={handleStateSelection}
              />
            </div>
          </div>
        )}

        {/* Pitch policy selector */}
        {flowState === 'pitch-select-policy' && (
          <div className="flex items-start gap-3 animate-fade-in">
            <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-primary-foreground text-xs font-bold shrink-0">
              IA
            </div>
            <div className="chat-bubble-bot max-w-[75%]">
              <p className="text-sm leading-relaxed">Absolutely! I'm here to help you create a personalized sales pitch that highlights the key benefits of a policy. Let's begin by selecting a policy from the options below.</p>
              <InlineSelectWithConfirm
                options={policies}
                placeholder="Select a policy"
                onConfirm={handlePolicySelect}
              />
            </div>
          </div>
        )}

        {/* Compare policy selector */}
        {flowState === 'compare-select' && (
          <div className="flex items-start gap-3 animate-fade-in">
            <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-primary-foreground text-xs font-bold shrink-0">
              IA
            </div>
            <div className="chat-bubble-bot max-w-[75%]">
              <p className="text-sm leading-relaxed">Great! I'm here to help you compare two insurance policies. Simply select the two policies, and I'll generate a clear, detailed comparison to support your decision.</p>
              <DualInlineSelect
                options1={policies}
                options2={policies}
                onConfirm={handleCompareSelect}
              />
            </div>
          </div>
        )}

        {/* Summarize policy selector */}
        {flowState === 'summarize-select' && (
          <div className="flex items-start gap-3 animate-fade-in">
            <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-primary-foreground text-xs font-bold shrink-0">
              IA
            </div>
            <div className="chat-bubble-bot max-w-[75%]">
              <p className="text-sm leading-relaxed">Absolutely! I'm here to assist you summarize the benefits of any insurance policy. Please select the policy you're interested in from the options below.</p>
              <InlineSelectWithConfirm
                options={policies}
                placeholder="Select a policy"
                onConfirm={handleSummarizeSelect}
              />
            </div>
          </div>
        )}

        {isTyping && <TypingIndicator />}
      </div>

      {/* Bottom region */}
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
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type your message..."
            className="flex-1 rounded-xl border border-border bg-background px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary disabled:opacity-40 disabled:cursor-not-allowed"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim()}
            className="w-10 h-10 rounded-xl bg-primary text-primary-foreground flex items-center justify-center hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
