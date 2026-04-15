import { useState, useCallback, useEffect, useRef, ReactNode } from 'react';
import { ChatMessageData } from '@/components/chat/ChatMessage';
import { streamChat, checkBackendHealth, APIMessage } from './useAgentAPI';

/* ───────────────── TYPES ───────────────── */

type FlowState =
  | 'onboarding'
  | 'select-state'
  | 'ready'
  | 'pitch-select-policy'
  | 'pitch-benefits'
  | 'pitch-customer-info'
  | 'compare-select'
  | 'compare-benefits'
  | 'compare-customer-info'
  | 'summarize-select'
  | 'completed';

type Policy = {
  name: string;
  states: string[];
};

type FlowContext = {
  state?: string;
  policy?: string;
  policy1?: string;
  policy2?: string;
  benefits?: string;
  customer_info?: string;
  availablePolicies?: Policy[];
};

/* ───────────────── DATA ───────────────── */

const POLICIES: Policy[] = [
  {
    name: 'Ambetter from Sunshine Health: Complete Gold',
    states: ['Florida', 'Texas'],
  },
  {
    name: 'Ambetter from Sunshine Health: Everyday Silver',
    states: ['Florida', 'Texas'],
  },
  {
    name: 'Blue Cross Blue Shield of Texas : Blue Advantage Gold HMO 206',
    states: ['Texas'],
  },
  {
    name: 'Blue Cross Blue Shield of Texas : Blue Advantage Silver HMO 205',
    states: ['Texas'],
  },
  {
    name: 'Florida Health Care Plans : Essential Plus Silver HMO 53',
    states: ['Florida'],
  },
  {
    name: 'Florida Health Care Plans : Platinum POS 4000',
    states: ['Florida'],
  },
];

/* ───────────────── HELPERS ───────────────── */

const normalize = (val: string) => val.trim().toLowerCase();

const getPoliciesByState = (state: string): Policy[] => {
  const normalized = normalize(state);
  return POLICIES.filter((p) =>
    p.states.some((s) => normalize(s) === normalized)
  );
};

const buildApiContext = (ctx: FlowContext): Record<string, string> => {
  return Object.fromEntries(
    Object.entries(ctx).filter(([, v]) => typeof v === 'string')
  ) as Record<string, string>;
};

let msgId = 0;
const genId = () => `msg-${++msgId}`;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ───────────────── HOOK ───────────────── */

export const useChatEngine = () => {
  const [messages, setMessages] = useState<ChatMessageData[]>([]);
  const [flowState, setFlowState] = useState<FlowState>('onboarding');
  const [flowContext, setFlowContext] = useState<FlowContext>({});
  const [isTyping, setIsTyping] = useState(false);
  const [inputEnabled, setInputEnabled] = useState(false);
  const [actionsEnabled, setActionsEnabled] = useState(false);
  const [backendAvailable, setBackendAvailable] = useState(false);

  const checkedRef = useRef(false);

  /* ───────────────── INIT ───────────────── */

  useEffect(() => {
    if (!checkedRef.current) {
      checkedRef.current = true;
      checkBackendHealth().then(setBackendAvailable);
    }
  }, []);

  /* ───────────────── MESSAGE HELPERS ───────────────── */

  const addBotMessage = useCallback((content: string, richContent?: ReactNode) => {
    setMessages((prev) => [...prev, { id: genId(), role: 'bot', content, richContent }]);
  }, []);

  const addUserMessage = useCallback((content: string) => {
    setMessages((prev) => [...prev, { id: genId(), role: 'user', content }]);
  }, []);

  const simulateTyping = useCallback(async (ms = 1000) => {
    setIsTyping(true);
    await delay(ms);
    setIsTyping(false);
  }, []);

  /* ───────────────── STREAM ───────────────── */

  const streamBotResponse = useCallback(async (
    action: string | null,
    context: Record<string, string>,
    messages: APIMessage[] = []
  ) => {
    const id = genId();

    setMessages((prev) => [...prev, { id, role: 'bot', content: '' }]);
    setIsTyping(false);

    try {
      await streamChat(
        { messages, action, flow_context: context },
        (token) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === id ? { ...m, content: m.content + token } : m
            )
          );
        }
      );
    } catch {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === id
            ? { ...m, content: 'Error occurred. Please try again.' }
            : m
        )
      );
    }
  }, []);

  /* ───────────────── FLOW ───────────────── */

  const initialize = useCallback(async () => {
    await delay(500);
    addBotMessage(
    `Hello! I am <strong>InsureAssist</strong>, your personalised health insurance support agent.
    <p>I have been trained on a comprehensive set of health insurance policy documents to assist you with accurate and contextual information.</p>
    <p>I can assist you to:</p>
    <ul>
      <li>Get answers to questions related to specific health insurance policies</li>
      <li>Craft tailored, persona-based sales pitches to accelerate customer onboarding</li>
      <li>Provide detailed comparisons across policies to support informed decision-making</li>
      <li>Generate concise or comprehensive summaries of policy benefits</li>
    </ul>
    <p><strong>Let’s get started!</strong></p>`
  );
    setFlowState('select-state');
  }, [addBotMessage]);

  const handleStateSelection = useCallback(async (state: string) => {
    const policies = getPoliciesByState(state);

    setFlowContext((prev) => ({
      ...prev,
      state,
      availablePolicies: policies,
    }));

    await simulateTyping();

    if (!policies.length) {
      addBotMessage(`Great! You've selected <strong>${state}</strong>. You're all set to start exploring policies. Use the quick actions below or type a message to begin.`);
      return;
    }

    addBotMessage(
      `Policies in <strong>${state}</strong>:<br/>
      <ul>${policies.map((p) => `<li>${p.name}</li>`).join('')}</ul>`
    );

    setInputEnabled(true);
    setActionsEnabled(true);
    setFlowState('ready');
  }, [addBotMessage, simulateTyping]);

  const handleAction = useCallback(async (action: 'pitch' | 'compare' | 'summarize') => {
    setActionsEnabled(false);
    setInputEnabled(false);
    await simulateTyping();

    if (action === 'pitch') setFlowState('pitch-select-policy');
    else if (action === 'compare') setFlowState('compare-select');
    else setFlowState('summarize-select');
  }, [simulateTyping]);

  const handlePolicySelect = useCallback(async (policy: string) => {
    setFlowContext((prev) => {
      const valid = prev.availablePolicies?.some((p) => p.name === policy);
      if (!valid) return prev;
      return { ...prev, policy };
    });

    await simulateTyping();

    addBotMessage(`Thank you for choosing <strong>${policy}</strong>! Could you please share which benefits your customer is looking for? For example, hearing aid benefits, dental benefits, or something else.`);
    setInputEnabled(true);
    setFlowState('pitch-benefits');
  }, [addBotMessage, simulateTyping]);

  const handleCompareSelect = useCallback(async (p1: string, p2: string) => {
    setFlowContext((prev) => ({
      ...prev,
      policy1: p1,
      policy2: p2,
    }));

    await simulateTyping();

    addBotMessage(`Excellent choices! I'll compare <strong>${p1}</strong> and <strong>${p2}</strong>. First, could you share which benefits your customer is most interested in?`);
    setInputEnabled(true);
    setFlowState('compare-benefits');
  }, [addBotMessage, simulateTyping]);

  const handleSummarizeSelect = useCallback(async (policy: string) => {
    setFlowContext((prev) => ({ ...prev, policy }));
    setFlowState('completed');
    if (backendAvailable) {
      setIsTyping(true);
      await streamBotResponse('summarize', buildApiContext({ policy }));
    }
  }, [backendAvailable, streamBotResponse]);

  const handleUserInput = useCallback(async (text: string) => {
    addUserMessage(text);

    if (flowState === 'pitch-benefits') {
      setFlowContext((p) => ({ ...p, benefits: text }));
      await simulateTyping();
      addBotMessage(`Lastly, can you share some more information about your customer, like their age and location? This will help us tailor a more personalized pitch for them.`);
      setFlowState('pitch-customer-info');
    }

    else if (flowState === 'pitch-customer-info') {
      const ctx = buildApiContext({ ...flowContext, customer_info: text });

      if (backendAvailable) {
        setIsTyping(true);
        await streamBotResponse('pitch', ctx);
      }

      setFlowState('completed');
    }

    else if (flowState === 'compare-benefits') {
      setFlowContext((p) => ({ ...p, benefits: text }));
      await simulateTyping();
      addBotMessage(`Can you also share your customer's age and location? This helps me highlight the most relevant differences.`);
      setFlowState('compare-customer-info');
    }

    else if (flowState === 'compare-customer-info') {
      const ctx = buildApiContext({ ...flowContext, customer_info: text });

      if (backendAvailable) {
        setIsTyping(true);
        await streamBotResponse('compare', ctx);
      }

      setFlowState('completed');
    }

    else {
      if (backendAvailable) {
        setIsTyping(true);
        await streamBotResponse(null, {}, [{ role: 'user', content: text }]);
      }
    }
  }, [
    flowState,
    flowContext,
    backendAvailable,
    addUserMessage,
    addBotMessage,
    simulateTyping,
    streamBotResponse
  ]);

  const resetChat = useCallback(() => {
    setMessages([]);
    setFlowContext({});
    setFlowState('onboarding');
    setInputEnabled(false);
    setActionsEnabled(false);
    initialize();
  }, [initialize]);

  return {
    messages,
    isTyping,
    inputEnabled,
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
    policies: flowContext.availablePolicies || [],
  };
};