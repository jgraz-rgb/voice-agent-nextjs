import { useState, useCallback, useEffect, useRef, ReactNode } from 'react';
import { ChatMessageData } from '@/components/chat/ChatMessage';
import { streamChat, checkBackendHealth, APIMessage } from './useAgentAPI';

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

const POLICIES = [
  'Ambetter from Sunshine Health : Complete Gold',
  'Ambetter from Sunshine Health : Everyday Silver',
  'Blue Cross Blue Shield of Texas : Blue Advantage Gold HMO 206',
  'Blue Cross Blue Shield of Texas : Blue Advantage Silver HMO 205',
  'Florida Health Care Plans : Gym Access IND Essential Plus Silver HMO 53',
  'Florida Health Care Plans : Gym Access IND Platinum POS 4000',
];

const GUARDRAIL_RESPONSE =
  "I'm sorry, I can't assist with that. I'm only able to help with health insurance policy questions. Please enter another query or use the quick actions below.";

/**
 * Client-side guardrail: rejects inputs that fall outside health-insurance scope.
 * Catches general-knowledge questions, competitor research, coding help, etc.
 */
function isOffTopicInput(text: string): boolean {
  const lower = text.toLowerCase().trim();

  // General knowledge patterns
  const generalKnowledgePatterns = [
    /who is the (president|king|queen|prime minister|ceo)/,
    /what is the capital of/,
    /tell me (about|a) (joke|story|fun fact)/,
    /what('s| is) the (weather|time|date|population)/,
    /how (tall|old|far|long) is/,
    /when (was|did|is) .+ (born|founded|invented|discovered|happen)/,
    /where (is|are|was) .+ (located|born|from)/,
    /who (won|invented|discovered|created|wrote|directed)/,
  ];

  // Competitor / off-brand research
  const competitorPatterns = [
    /tell me about (a |another |other )?(competitor|company|brand|insurer)/,
    /compare .+ (to|with|vs|versus) .+(?!paramount)/,
    /what (does|is) (aetna|cigna|humana|united ?health|kaiser|anthem|blue ?cross|blue ?shield|oscar|ambetter|molina|centene)/i,
  ];

  // Out-of-scope technical / coding queries
  const outOfScopePatterns = [
    /how (do|can|to) (i |you )?(code|program|write|build|create|implement|debug|deploy)/,
    /\b(python|javascript|typescript|java|c\+\+|ruby|rust|golang|sql|html|css)\b.*\b(function|class|method|variable|loop|array|list|code)\b/,
    /\b(function|class|method|def |import |const |let |var )\b.*\b(return|print|console|log)\b/,
    /write (me |a )?(script|code|program|function|algorithm)/,
    /\b(recipe|cook|workout|exercise|movie|song|lyrics|translate)\b/,
  ];

  const allPatterns = [...generalKnowledgePatterns, ...competitorPatterns, ...outOfScopePatterns];

  return allPatterns.some((pattern) => pattern.test(lower));
}

let msgId = 0;
const genId = () => `msg-${++msgId}`;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const useChatEngine = () => {
  const [messages, setMessages] = useState<ChatMessageData[]>([]);
  const [flowState, setFlowState] = useState<FlowState>('onboarding');
  const [isTyping, setIsTyping] = useState(false);
  const [inputEnabled, setInputEnabled] = useState(false);
  const [actionsEnabled, setActionsEnabled] = useState(false);
  const [flowContext, setFlowContext] = useState<Record<string, string>>({});
  const [pendingRichMessage, setPendingRichMessage] = useState<{ content?: string; richContent?: ReactNode } | null>(null);
  const [backendAvailable, setBackendAvailable] = useState(false);

  // Check backend health on mount
  const checkedRef = useRef(false);
  useEffect(() => {
    if (!checkedRef.current) {
      checkedRef.current = true;
      checkBackendHealth().then(setBackendAvailable);
    }
  }, []);

  const addBotMessage = useCallback((content: string, richContent?: ReactNode) => {
    setMessages((prev) => [...prev, { id: genId(), role: 'bot', content, richContent }]);
  }, []);

  const addUserMessage = useCallback((content: string) => {
    setMessages((prev) => [...prev, { id: genId(), role: 'user', content }]);
  }, []);

  const simulateTyping = useCallback(async (ms = 1200) => {
    setIsTyping(true);
    await delay(ms);
    setIsTyping(false);
  }, []);

  /**
   * Stream a response from the LangGraph backend.
   * Adds a bot message and updates it token by token.
   */
  const streamBotResponse = useCallback(async (
    action: string | null,
    context: Record<string, string>,
    extraMessages: APIMessage[] = []
  ) => {
    const botMsgId = genId();
    setMessages((prev) => [...prev, { id: botMsgId, role: 'bot', content: '' }]);
    setIsTyping(false);

    // Build message history for the API
    const apiMessages: APIMessage[] = extraMessages;

    try {
      await streamChat(
        {
          messages: apiMessages,
          action,
          flow_context: context,
        },
        (token) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === botMsgId ? { ...m, content: m.content + token } : m
            )
          );
        }
      );
    } catch (err) {
      console.error('Stream error:', err);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === botMsgId
            ? { ...m, content: 'Sorry, an error occurred. Please try again.' }
            : m
        )
      );
    }
  }, []);

  // ── Flow handlers (with backend integration) ──

  const initialize = useCallback(async () => {
    await delay(500);
    addBotMessage(
      `Hello! I am <strong>InsureAssist</strong>, your personalised health insurance support agent. 🩺<br/><br/>I can assist you to:<ul><li>Get answers to your health insurance questions</li><li>Craft tailored sales pitches for specific policies</li><li>Provide side-by-side policy comparisons</li><li>Generate comprehensive policy summaries</li></ul>`
    );
    await delay(800);
    setFlowState('select-state');
  }, [addBotMessage]);

  const handleStateSelection = useCallback(async (state: string) => {
    setFlowContext((p) => ({ ...p, state }));
    await simulateTyping(1000);
    addBotMessage(`Great! You've selected <strong>${state}</strong>. You're all set to start exploring policies. Use the quick actions below or type a message to begin.`);
    setInputEnabled(true);
    setActionsEnabled(true);
    setFlowState('ready');
  }, [addBotMessage, simulateTyping]);

  const handleAction = useCallback(async (action: 'pitch' | 'compare' | 'summarize') => {
    setActionsEnabled(false);
    setInputEnabled(false);

    if (action === 'pitch') {
      await simulateTyping();
      setFlowState('pitch-select-policy');
    } else if (action === 'compare') {
      await simulateTyping();
      setFlowState('compare-select');
    } else {
      await simulateTyping();
      setFlowState('summarize-select');
    }
  }, [simulateTyping]);

  const handlePolicySelect = useCallback(async (policy: string) => {
    setFlowContext((p) => ({ ...p, policy }));
    await simulateTyping();
    addBotMessage(`Thank you for choosing <strong>${policy}</strong>! Could you please share which benefits your customer is looking for? For example, hearing aid benefits, dental benefits, or something else.`);
    setInputEnabled(true);
    setFlowState('pitch-benefits');
  }, [addBotMessage, simulateTyping]);

  const handleCompareSelect = useCallback(async (p1: string, p2: string) => {
    setFlowContext((p) => ({ ...p, policy1: p1, policy2: p2 }));
    await simulateTyping();
    addBotMessage(`Excellent choices! I'll compare <strong>${p1}</strong> and <strong>${p2}</strong>. First, could you share which benefits your customer is most interested in?`);
    setInputEnabled(true);
    setFlowState('compare-benefits');
  }, [addBotMessage, simulateTyping]);

  const handleSummarizeSelect = useCallback(async (policy: string) => {
    setFlowContext((p) => ({ ...p, policy }));

    if (backendAvailable) {
      setIsTyping(true);
      await streamBotResponse('summarize', { policy });
      setInputEnabled(false);
      setActionsEnabled(false);
      setFlowState('completed');
      return;
    }

    // Mock fallback
    await simulateTyping(1500);
    addBotMessage(
      `Here's a comprehensive summary of <strong>${policy}</strong>:<br/><br/>` +
      `<ul>` +
      `<li><strong>Coverage Type:</strong> HMO (Health Maintenance Organization)</li>` +
      `<li><strong>Individual Deductible:</strong> $6,500 per year</li>` +
      `<li><strong>Family Deductible:</strong> $13,000 per year</li>` +
      `<li><strong>Out-of-Pocket Maximum:</strong> $8,000 (Individual) / $16,000 (Family)</li>` +
      `<li><strong>Primary Care Visit:</strong> $30 copay after deductible</li>` +
      `<li><strong>Specialist Visit:</strong> $50 copay after deductible</li>` +
      `<li><strong>Preventive Care:</strong> No charge (covered 100%)</li>` +
      `<li><strong>Emergency Room:</strong> $350 copay after deductible</li>` +
      `<li><strong>Prescription Drugs:</strong> Tier 1 Generic $15 / Tier 2 Preferred $40 / Tier 3 Non-Preferred $80</li>` +
      `<li><strong>Mental Health Services:</strong> $30 copay (outpatient) after deductible</li>` +
      `</ul><br/>` +
      `This policy offers solid coverage for individuals looking for an affordable HMO plan with predictable copays.`
    );
    setInputEnabled(false);
    setActionsEnabled(false);
    setFlowState('completed');
  }, [addBotMessage, simulateTyping, backendAvailable, streamBotResponse]);

  const handleUserInput = useCallback(async (text: string) => {
    addUserMessage(text);

    if (flowState === 'pitch-benefits') {
      setFlowContext((p) => ({ ...p, benefits: text }));
      await simulateTyping();
      addBotMessage(`Lastly, can you share some more information about your customer, like their age and location? This will help us tailor a more personalized pitch for them.`);
      setFlowState('pitch-customer-info');

    } else if (flowState === 'pitch-customer-info') {
      setInputEnabled(false);

      if (backendAvailable) {
        setIsTyping(true);
        const ctx = { ...flowContext, customer_info: text };
        await streamBotResponse('pitch', ctx);
      } else {
        await simulateTyping(2000);
        const policy = flowContext.policy || 'Paramount Gold 1';
        addBotMessage(
          `Here's your tailored sales pitch for <strong>${policy}</strong>:<br/><br/>` +
          `<strong>🏥 Urgent Care Benefits — ${policy}</strong><br/><br/>` +
          `Your customer deserves fast, reliable access to care when they need it most. Here's what makes this plan stand out:<br/><br/>` +
          `<ul>` +
          `<li><strong>Affordable Copay:</strong> Just $25 per urgent care visit — no surprise bills</li>` +
          `<li><strong>No Deductible Requirement:</strong> Urgent care copay applies without needing to meet the deductible first</li>` +
          `<li><strong>Quick Access to Care:</strong> Extensive network of urgent care facilities for walk-in convenience</li>` +
          `<li><strong>Comprehensive Coverage:</strong> Includes X-rays, lab work, and minor procedures during the visit</li>` +
          `<li><strong>Telehealth Option:</strong> $0 copay for virtual urgent care — care from anywhere</li>` +
          `</ul><br/>` +
          `<em>"With ${policy}, your customer gets peace of mind knowing that quality urgent care is always affordable and accessible."</em>`
        );
      }

      setInputEnabled(false);
      setActionsEnabled(false);
      setFlowState('completed');

    } else if (flowState === 'compare-benefits') {
      setFlowContext((p) => ({ ...p, benefits: text }));
      await simulateTyping();
      addBotMessage(`Can you also share your customer's age and location? This helps me highlight the most relevant differences.`);
      setFlowState('compare-customer-info');

    } else if (flowState === 'compare-customer-info') {
      setInputEnabled(false);

      if (backendAvailable) {
        setIsTyping(true);
        const ctx = { ...flowContext, customer_info: text };
        await streamBotResponse('compare', ctx);
      } else {
        await simulateTyping(2000);
        const p1 = flowContext.policy1 || 'Paramount Gold 1';
        const p2 = flowContext.policy2 || 'Paramount Silver 1';
        addBotMessage(
          `Here's a detailed comparison of <strong>${p1}</strong> vs <strong>${p2}</strong>:<br/><br/>` +
          `<table>` +
          `<thead><tr><th>Benefit</th><th>${p1}</th><th>${p2}</th></tr></thead>` +
          `<tbody>` +
          `<tr><td>Preferred Generic Drugs</td><td>$10 copay</td><td>$15 copay</td></tr>` +
          `<tr><td>Non-Preferred Generic Drugs</td><td>$20 copay</td><td>$25 copay</td></tr>` +
          `<tr><td>Primary Care Visit</td><td>$15 copay</td><td>No specified cost</td></tr>` +
          `<tr><td>Specialist Visit</td><td>$35 copay</td><td>$50 copay</td></tr>` +
          `<tr><td>Preventive Care</td><td>No charge</td><td>No charge</td></tr>` +
          `<tr><td>Emergency Room</td><td>$250 copay</td><td>$350 copay</td></tr>` +
          `<tr><td>Urgent Care</td><td>$25 copay</td><td>$40 copay</td></tr>` +
          `<tr><td>Out-of-Pocket Max</td><td>$6,000</td><td>$8,000</td></tr>` +
          `</tbody></table><br/>` +
          `<strong>${p1}</strong> offers lower copays across the board, making it ideal for customers who prioritize lower out-of-pocket costs per visit.`
        );
      }

      setInputEnabled(false);
      setActionsEnabled(false);
      setFlowState('completed');

    } else {
      // Guardrail — reject off-topic queries before they reach the backend
      if (isOffTopicInput(text)) {
        await simulateTyping(800);
        addBotMessage(GUARDRAIL_RESPONSE);
        return;
      }

      // Fallback — general chat
      if (backendAvailable) {
        setIsTyping(true);
        await streamBotResponse(null, {}, [{ role: 'user', content: text }]);
      } else {
        await simulateTyping();
        addBotMessage(`I'm unable to assist with that request. I can only provide information related to a specific set of health insurance policies. Please try again by asking a different question, or use the quick actions below.`);
      }
    }
  }, [flowState, flowContext, addUserMessage, addBotMessage, simulateTyping, backendAvailable, streamBotResponse]);

  const resetChat = useCallback(() => {
    setMessages([]);
    setFlowState('onboarding');
    setIsTyping(false);
    setInputEnabled(false);
    setActionsEnabled(false);
    setFlowContext({});
    setPendingRichMessage(null);
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
    policies: POLICIES,
  };
};
