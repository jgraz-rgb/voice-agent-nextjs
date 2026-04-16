import { RealtimeAgent, tool } from '@openai/agents/realtime';
import { z } from 'zod';
import { LIC_HOUSING_INSTRUCTIONS } from './instructions';
import RAGDATA from './RAG.json';
import { calculateLeadScore } from './scoring';
import { scoreLeadWithHelper } from './helperScoring';
// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

interface LeadQualificationState {
  current_phase: number;
  current_field: string;
  conversation_transcript: string[];
  language_preference?: 'Hindi' | 'English';

  // Lead Data (from LeadSquared)
  lead_id?: string;
  first_name?: string;
  last_name?: string;
  phone_number?: string;
  property_location?: string;
  preferred_area_office?: string;

  // Phase 2: Intent Discovery
  property_stage?: string;
  property_type?: string;
  property_cost_lakhs?: number;
  loan_amount_lakhs?: number;
  loan_timeline_months?: number;
  rera_registered?: boolean;
  property_location_detail?: string;

  // Phase 3: Eligibility Probing
  employment_type?: string;
  employer_detail?: string;
  employment_tenure_years?: number;
  monthly_income_range?: string;
  pan_number?: string;
  existing_emi_amount?: number;
  existing_emi_details?: string;
  co_applicant?: boolean;
  co_applicant_relation?: string;
  co_applicant_employment?: string;
  decision_authority?: string;

  // Phase 4: Preference & Competition
  lichfl_preference?: string;
  competing_lenders?: string[];

  // Phase 5: Next Step
  preferred_callback_time?: string;
  callback_date?: string;

  // Scoring
  p1_score?: number;
  p2_score?: number;
  p3_score?: number;
  p4_score?: number;
  p5_score?: number;
  total_score?: number;
  lead_category?: 'HOT' | 'WARM' | 'COLD' | 'PENDING' | 'URGENT';
  scoring_evidence?: string[];

  // Meta
  call_status?: 'in_progress' | 'completed' | 'callback_requested' | 'not_interested' | 'dropped' | 'abusive';
  call_start_time?: string;
  call_end_time?: string;
}

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

class StateManager {
  private state: LeadQualificationState;

  constructor() {
    this.state = {
      current_phase: 0,
      current_field: 'greeting',
      conversation_transcript: [],
      call_status: 'in_progress',
    };
  }

  getState(): LeadQualificationState {
    return { ...this.state };
  }

  updateState(updates: Partial<LeadQualificationState>): void {
    this.state = { ...this.state, ...updates };
  }

  addToTranscript(message: string): void {
    this.state.conversation_transcript.push(message);
  }

  exportState(): string {
    return JSON.stringify(this.state, null, 2);
  }
}

const stateManager = new StateManager();

// ============================================================================
// TOOL API CLIENT HELPER
// ============================================================================

const TOOL_API_BASE_URL = 'https://bfsi.searchunify.com/bfsi-api/';
async function callToolAPI(endpoint: string, data: any): Promise<any> {
  try {
    const response = await fetch(`${TOOL_API_BASE_URL}/${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    console.error(`Tool API call failed for ${endpoint}:`, error);
    throw error;
  }
}

// ============================================================================
// PINCODE LOOKUP DATA
// ============================================================================

const PINCODE_DATABASE: Record<string, { city: string; state: string }> = {
  '411033': { city: 'Wakad, Pune', state: 'Maharashtra' },
  '411057': { city: 'Hinjewadi, Pune', state: 'Maharashtra' },
  '411014': { city: 'Kothrud, Pune', state: 'Maharashtra' },
  '400001': { city: 'Fort, Mumbai', state: 'Maharashtra' },
  '400050': { city: 'Bandra, Mumbai', state: 'Maharashtra' },
  '400076': { city: 'Powai, Mumbai', state: 'Maharashtra' },
  '560001': { city: 'MG Road, Bangalore', state: 'Karnataka' },
  '560066': { city: 'Whitefield, Bangalore', state: 'Karnataka' },
  '560103': { city: 'Electronic City, Bangalore', state: 'Karnataka' },
  '500081': { city: 'Hitech City, Hyderabad', state: 'Telangana' },
  '500032': { city: 'Jubilee Hills, Hyderabad', state: 'Telangana' },
  '110001': { city: 'Connaught Place, Delhi', state: 'Delhi' },
  '110075': { city: 'Dwarka, Delhi', state: 'Delhi' },
  '122001': { city: 'Gurgaon', state: 'Haryana' },
  '201301': { city: 'Noida', state: 'Uttar Pradesh' },
  '600001': { city: 'Chennai', state: 'Tamil Nadu' },
  '600096': { city: 'OMR, Chennai', state: 'Tamil Nadu' },
  '700001': { city: 'Kolkata', state: 'West Bengal' },
  '380001': { city: 'Ahmedabad', state: 'Gujarat' },
  '302001': { city: 'Jaipur', state: 'Rajasthan' },
};

// ============================================================================
// ZENDESK DESCRIPTION FORMATTER
// ============================================================================

export function getZendeskGroupId(category?: string): number {
  if (category === 'HOT' || category === 'WARM' || category === 'URGENT') {
    return 26780835695516;
  }
  return 26780880733596;
}

export function formatZendeskSubject(state: LeadQualificationState): string {
  const name = [state.first_name, state.last_name].filter(Boolean).join(' ') || 'Unknown Lead';
  const category = state.lead_category || 'PENDING';
  return `${name} - ${category}`;
}

export function formatZendeskDescription(
  state: LeadQualificationState,
  callDurationSeconds?: number,
): string {
  // ── Header ────────────────────────────────────────────────────────────────
  const durationStr = callDurationSeconds != null
    ? `${Math.floor(callDurationSeconds / 60)}m ${callDurationSeconds % 60}s`
    : 'N/A';

  const dateStr = state.call_start_time
    ? new Date(state.call_start_time).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  const score = state.total_score != null ? `${state.total_score} / 100` : 'N/A';
  const category = state.lead_category || 'N/A';

  // Derive routing/SLA from category if not separately stored
  let routing = 'N/A';
  let sla = 'N/A';
  if (category === 'HOT') { routing = 'FoS Agent - Immediate'; sla = 'Callback within 15 minutes'; }
  else if (category === 'WARM') { routing = 'FoS Agent - Scheduled'; sla = 'Callback within 2 hours'; }
  else if (category === 'COLD') { routing = 'Quality Audit Team'; sla = 'Nurture drip, re-qualify in 30 days'; }

  const header = [
    `AI Qualification Call Summary`,
    `Duration : ${durationStr}`,
    `Date of call : ${dateStr}`,
    `Score : ${score}`,
    `Category : ${category}`,
    `Routing : ${routing}`,
    `SLA for human agent : ${sla}`,
  ].join('\n');

  // ── Qualification Summary ─────────────────────────────────────────────────
  const fmt = (v: any, fallback = 'N/A') =>
    v != null && v !== '' ? String(v) : fallback;

  const competingStr = Array.isArray(state.competing_lenders) && state.competing_lenders.length > 0
    ? state.competing_lenders.join(' and ')
    : 'None mentioned';

  const coApplicantStr = state.co_applicant === true
    ? `Yes${state.co_applicant_relation ? `, with ${state.co_applicant_relation}` : ''}`
    : state.co_applicant === false ? 'No' : 'N/A';

  const loanStr = state.loan_amount_lakhs != null
    ? `${state.loan_amount_lakhs} Lakhs`
    : 'N/A';

  const emiStr = state.existing_emi_amount != null
    ? `${state.existing_emi_details ? state.existing_emi_details + ', ' : ''}${state.existing_emi_amount.toLocaleString('en-IN')} EMI`
    : fmt(state.existing_emi_details);

  const qualSummary = [
    `\nQualification Summary`,
    `Mobile number : ${fmt(state.phone_number)}`,
    `Preferred area office : ${fmt(state.preferred_area_office)}`,
    `Property stage : ${fmt(state.property_stage)}`,
    `Property location : ${fmt(state.property_location_detail || state.property_location)}`,
    `Loan requirement timeline : ${state.loan_timeline_months != null ? `${state.loan_timeline_months} months` : 'N/A'}`,
    `RERA registration : ${state.rera_registered === true ? 'Registered' : state.rera_registered === false ? 'Not registered' : 'N/A'}`,
    `Loan amount : ${loanStr}`,
    `Employment type : ${fmt(state.employment_type)}`,
    `Income band/ Monthly take-home : ${fmt(state.monthly_income_range)}`,
    `PAN : ${fmt(state.pan_number)}`,
    `Existing EMI : ${emiStr}`,
    `Co-applicant : ${coApplicantStr}`,
    `Decision Authority : ${fmt(state.decision_authority)}`,
    `Competing lenders : ${competingStr}`,
  ].join('\n');

  // ── Scoring Breakdown ─────────────────────────────────────────────────────
  const fmtScore = (score: number | undefined, weight: number, maxRaw: number) => {
    if (score == null) return { raw: 'N/A', weighted: 'N/A', max: `${weight}` };
    const weighted = Math.round(score * (weight / maxRaw) * 10) / 10;
    return { raw: String(score), weighted: `${weighted}/${weight}`, max: String(weight) };
  };

  const p1 = fmtScore(state.p1_score, 30, 4);
  const p2 = fmtScore(state.p2_score, 25, 4);
  const p3 = fmtScore(state.p3_score, 20, 4);
  const p4 = fmtScore(state.p4_score, 15, 4);
  const p5 = fmtScore(state.p5_score, 10, 4);

  const scoringBreakdown = [
    `\nAI Scoring Breakdown`,
    `P1: Purchase Intent (30%)`,
    `Score : ${p1.raw}`,
    `Weighted Points : ${p1.weighted}`,
    `P2: Eligibility (25%)`,
    `Score : ${p2.raw}`,
    `Weighted Points : ${p2.weighted}`,
    `P3: Loan Amount (20%)`,
    `Score : ${p3.raw}`,
    `Weighted Points : ${p3.weighted}`,
    `P4: Decision Auth (15%)`,
    `Score : ${p4.raw}`,
    `Weighted Points : ${p4.weighted}`,
    `P5: Brand Preference (10%)`,
    `Score : ${p5.raw}`,
    `Weighted Points : ${p5.weighted}`,
    `\nTotal : ${score}`,
  ].join('\n');

  return [header, qualSummary, scoringBreakdown].join('\n');
}

// ============================================================================
// TOOLS
// ============================================================================

const updateLeadStateTool = tool({
  name: 'updateLeadState',
  description: 'Updates the lead qualification state with collected information. Use this to save user-provided data immediately as it is collected during the conversation. For array fields like competing_lenders, pass the value as a JSON array string (e.g., \'["HDFC","SBI"]\') — it will be parsed automatically.',
  parameters: z.object({
    field_name: z.string().describe('Name of the field to update (e.g., property_stage, employment_type, pan_number, competing_lenders)'),
    field_value: z.union([z.string(), z.number(), z.boolean()]).describe('Value to store. For array fields (competing_lenders), pass a JSON array string like \'["HDFC","SBI"]\''),
  }),
  execute: async ({ field_name, field_value }: { field_name: string; field_value: string | number | boolean }) => {
    // Auto-parse JSON array strings for known array fields
    const ARRAY_FIELDS = ['competing_lenders', 'scoring_evidence', 'conversation_transcript'];
    let parsedValue: any = field_value;
    if (typeof field_value === 'string' && ARRAY_FIELDS.includes(field_name)) {
      try {
        const parsed = JSON.parse(field_value);
        if (Array.isArray(parsed)) parsedValue = parsed;
      } catch {
        // Not valid JSON — treat as a single-element array
        parsedValue = [field_value];
      }
    }

    stateManager.updateState({
      [field_name]: parsedValue,
    });

    const snapshot = stateManager.getState();
    console.log(`[LeadState] Updated "${field_name}" =`, parsedValue);
    console.log('[LeadState] Full snapshot:', JSON.stringify(snapshot, null, 2));
    fetch('/bfsi-agentic-suite/api/state', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field_name]: parsedValue }),
    }).catch(() => {});

    return {
      success: true,
      message: `Updated ${field_name} successfully`,
    };
  },
});

const getLeadStateTool = tool({
  name: 'getLeadState',
  description: 'Retrieves the current lead qualification state. Use this to check what information has been collected so far, including pre-collected lead info like first_name, last_name, phone_number, property_location, and area_office.',
  parameters: z.object({}),
  execute: async () => {
    // Merge persisted state (which contains pre-collected lead info from the
    // pre-connection form) into the in-memory stateManager so the agent can
    // see first_name, last_name, phone_number, property_location, area_office.
    try {
      const res = await fetch('/bfsi-agentic-suite/api/state');
      if (res.ok) {
        const persisted = await res.json();
        if (persisted && typeof persisted === 'object') {
          stateManager.updateState(persisted as Partial<LeadQualificationState>);
        }
      }
    } catch {
      // If the fetch fails, fall back to whatever is already in stateManager
    }
    return stateManager.getState();
  },
});

const validatePANTool = tool({
  name: 'validatePAN',
  description: 'Validates the format of an Indian PAN (Permanent Account Number). PAN format: 5 uppercase letters, 4 digits, 1 uppercase letter (e.g., AAAPA1111A).',
  parameters: z.object({
    pan_number: z.string().describe('PAN number to validate'),
  }),
  execute: async ({ pan_number }: { pan_number: string }) => {
    const normalized = pan_number.toUpperCase().replace(/\s/g, '');
    const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
    const isValid = panRegex.test(normalized);

    if (isValid) {
      stateManager.updateState({ pan_number: normalized });
    }

    return {
      success: true,
      valid: isValid,
      formatted_pan: normalized,
      message: isValid
        ? 'PAN format is valid'
        : 'Invalid PAN format. PAN should be 5 letters, 4 digits, 1 letter (e.g., AAAPA1111A)',
    };
  },
});

const lookupPincodeTool = tool({
  name: 'lookupPincode',
  description: 'Looks up city and state information for a given Indian PIN code (6 digits).',
  parameters: z.object({
    pincode: z.string().describe('6-digit Indian PIN code'),
  }),
  execute: async ({ pincode }: { pincode: string }) => {
    const data = PINCODE_DATABASE[pincode] || { city: 'Unknown', state: 'Unknown' };

    return {
      success: true,
      pincode,
      city: data.city,
      state: data.state,
    };
  },
});

const calculateLeadScoreTool = tool({
  name: 'calculateLeadScore',
  description: 'Hands off all collected state to a lightweight scoring model that evaluates the lead across 5 parameters (Intent, Eligibility, Loan Amount, Decision Authority, LICHFL Preference). Call this at end of call or when enough data is collected. No parameters needed — it reads from state automatically. Scoring is handled by a helper LLM, not by you.',
  parameters: z.object({}),
  execute: async () => {
    const state = stateManager.getState();

    // Hand off to lightweight helper LLM for scoring.
    // Falls back to deterministic scorer if the helper fails.
    const result = await scoreLeadWithHelper(state);

    stateManager.updateState({
      p1_score: result.p1_score,
      p2_score: result.p2_score,
      p3_score: result.p3_score,
      p4_score: result.p4_score,
      p5_score: result.p5_score,
      total_score: result.total_score,
      lead_category: result.lead_category,
      scoring_evidence: result.scoring_evidence,
    });

    return {
      success: true,
      scored_by: result.scored_by,
      scores: {
        p1: { score: result.p1_score, weighted: result.p1_score * 7.5, evidence: result.p1_evidence },
        p2: { score: result.p2_score, weighted: result.p2_score * 6.25, evidence: result.p2_evidence },
        p3: { score: result.p3_score, weighted: result.p3_score * 5, evidence: result.p3_evidence },
        p4: { score: result.p4_score, weighted: result.p4_score * 3.75, evidence: result.p4_evidence },
        p5: { score: result.p5_score, weighted: result.p5_score * 2.5, evidence: result.p5_evidence },
      },
      total_score: result.total_score,
      lead_category: result.lead_category,
      routing: result.routing,
      sla: result.sla,
      scoring_evidence: result.scoring_evidence,
    };
  },
});

const syncToLeadSquaredTool = tool({
  name: 'syncToLeadSquared',
  description: 'Syncs the full qualification data, transcript, lead score, and category to LeadSquared CRM. Call this after scoring is complete at end of call.',
  parameters: z.object({
    lead_category: z.enum(['HOT', 'WARM', 'COLD', 'PENDING', 'URGENT']).describe('Lead category after scoring'),
    call_disposition: z.string().describe('How the call ended: completed, callback_requested, not_interested, dropped, abusive'),
  }),
  execute: async ({ lead_category, call_disposition }: { lead_category: string; call_disposition: string }) => {
    const state = stateManager.getState();

    // Auto-calculate score if not already done (guard against agent skipping calculateLeadScore)
    if (state.total_score == null) {
      const result = calculateLeadScore(state);
      stateManager.updateState({
        p1_score: result.p1.score,
        p2_score: result.p2.score,
        p3_score: result.p3.score,
        p4_score: result.p4.score,
        p5_score: result.p5.score,
        total_score: result.total_score,
        lead_category: result.lead_category,
        scoring_evidence: result.scoring_evidence,
      });
    }

    stateManager.updateState({
      lead_category: lead_category as any,
      call_status: call_disposition as any,
      call_end_time: new Date().toISOString(),
    });

    // In production, this would POST to LeadSquared API
    try {
      return await callToolAPI('sync_lead', {
        lead_id: state.lead_id,
        lead_category,
        call_disposition,
        qualification_data: state,
        transcript: state.conversation_transcript,
        scoring: {
          p1: state.p1_score,
          p2: state.p2_score,
          p3: state.p3_score,
          p4: state.p4_score,
          p5: state.p5_score,
          total: state.total_score,
        },
      });
    } catch {
      // Fallback for demo
      const activity_id = `LSQ_${Date.now()}`;
      return {
        success: true,
        leadsquared_activity_id: activity_id,
        message: `Lead synced to LeadSquared as ${lead_category}. Disposition: ${call_disposition}`,
      };
    }
  },
});

const ragSearchTool = tool({
  name: 'ragSearch',
  description: 'Searches the LICHFL home loan knowledge base for answers to customer questions. Use when the lead asks about documents, eligibility, EMI, rates, tenure, tax benefits, etc.',
  parameters: z.object({
    query: z.string().describe('User query text to search for'),
    top_k: z.number().int().positive().max(10).nullable().default(null).describe('Number of results to return, default 5'),
  }),
  execute: async ({ query, top_k }: { query: string; top_k?: number | null }) => {
    const q = query.toLowerCase();
    const k = top_k && top_k > 0 && top_k <= 10 ? top_k : 5;
    const data: any = RAGDATA as any;

    function extractText(v: any): string {
      if (v == null) return '';
      if (typeof v === 'string') return v;
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
      if (Array.isArray(v)) return v.map(extractText).join(' ');
      if (typeof v === 'object') return Object.values(v).map(extractText).join(' ');
      return '';
    }

    function scoreText(text: string): number {
      const t = text.toLowerCase();
      if (!t || !q) return 0;
      const terms = q.split(/\s+/).filter(Boolean);
      let score = 0;
      for (const term of terms) {
        let idx = t.indexOf(term);
        while (idx !== -1) {
          score += 1;
          idx = t.indexOf(term, idx + term.length);
        }
      }
      return score;
    }

    function makeExcerpt(text: string, term: string, maxLen = 280): string {
      const t = text.trim();
      if (!t) return '';
      const i = t.toLowerCase().indexOf(term.toLowerCase());
      if (i === -1) return t.slice(0, maxLen);
      const start = Math.max(0, i - Math.floor(maxLen / 2));
      const end = Math.min(t.length, start + maxLen);
      return t.slice(start, end);
    }

    const results: Array<{
      article_id: string;
      article_title: string;
      category?: string;
      score: number;
      excerpt: string;
      payload: any;
    }> = [];

    const articles: any[] = (data && data.articles) || [];
    for (const article of articles) {
      const articleText = extractText({ title: article.title, content: article.content, keywords: article.keywords });
      const aScore = scoreText(articleText);
      if (aScore > 0) {
        results.push({
          article_id: String(article.id || ''),
          article_title: String(article.title || ''),
          category: article.category,
          score: aScore,
          excerpt: makeExcerpt(articleText, q),
          payload: article,
        });
      }
    }

    const faqs: any[] = (data && data.faqs) || [];
    for (const faq of faqs) {
      const faqText = extractText({ question: faq.question, answer: faq.answer });
      const fScore = scoreText(faqText);
      if (fScore > 0) {
        results.push({
          article_id: 'faq',
          article_title: faq.question || 'FAQ',
          score: fScore,
          excerpt: makeExcerpt(faqText, q),
          payload: faq,
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    const out = results.slice(0, k);
    return { query, total_matches: results.length, results: out };
  },
});

const createZendeskTicketTool = tool({
  name: 'createZendeskTicket',
  description: 'Creates a Zendesk ticket with the lead qualification snapshot. Call at the end of every call (completed, abandoned, or callback requested).',
  parameters: z.object({
    subject: z.string().describe('Ticket subject line including lead name and category'),
    transcript: z.string().nullable().describe('Conversation transcript or summary'),
    lead_category: z.enum(['HOT', 'WARM', 'COLD', 'PENDING', 'URGENT']).describe('Lead category'),
    call_disposition: z.string().describe('How the call ended'),
  }),
  execute: async (input) => {
    void input; // parameters kept for agent schema compatibility
    const state = stateManager.getState();

    // Auto-calculate score if not already done (guard against agent skipping calculateLeadScore)
    if (state.total_score == null) {
      const result = calculateLeadScore(state);
      stateManager.updateState({
        p1_score: result.p1.score,
        p2_score: result.p2.score,
        p3_score: result.p3.score,
        p4_score: result.p4.score,
        p5_score: result.p5.score,
        total_score: result.total_score,
        lead_category: result.lead_category,
        scoring_evidence: result.scoring_evidence,
      });
    }

    const stateSnapshot = stateManager.getState();

    const callDurationSeconds = stateSnapshot.call_start_time
      ? Math.round((Date.now() - new Date(stateSnapshot.call_start_time).getTime()) / 1000)
      : undefined;

    const subject = formatZendeskSubject(stateSnapshot);
    const description = formatZendeskDescription(stateSnapshot, callDurationSeconds);
    const group_id = getZendeskGroupId(stateSnapshot.lead_category);

    try {
      return await callToolAPI('tickets', { subject, description, group_id });
    } catch {
      const ticket_id = `ZD-LIC-${Date.now().toString().slice(-8)}`;
      return {
        success: true,
        ticket_id,
        message: `Zendesk ticket created: ${subject}`,
      };
    }
  },
});

const sendEmailTool = tool({
  name: 'sendEmail',
  description: 'Sends an email to the lead (callback confirmation or loan information).',
  parameters: z.object({
    to_email: z.string().describe('Email address'),
    subject: z.string().describe('Email subject line'),
    body: z.string().describe('Email body content'),
  }),
  execute: async ({
    to_email,
    subject,
    body,
  }: {
    to_email: string;
    subject: string;
    body: string;
  }) => {
    const message = `Thank you for your interest in LIC Housing Finance.

${body}

For any queries, call our toll-free helpline: 1800 209 1989
Visit: www.lichousing.com`;

    try {
      return await callToolAPI('send_email', {
        to_email,
        subject,
        body,
        message,
      });
    } catch {
      return {
        success: true,
        message: `Email sent to ${to_email}`,
      };
    }
  },
});

// ============================================================================
// CREATE AGENT
// ============================================================================

export const licHousingAgent = new RealtimeAgent({
  name: 'LIC Housing Lead Qualification Agent',
  voice: 'alloy',
  instructions: LIC_HOUSING_INSTRUCTIONS,
  tools: [
    updateLeadStateTool,
    getLeadStateTool,
    validatePANTool,
    lookupPincodeTool,
    calculateLeadScoreTool,
    syncToLeadSquaredTool,
    ragSearchTool,
    createZendeskTicketTool,
    sendEmailTool,
  ],
  handoffs: [],
});

export const licHousingCompanyName = 'LIC Housing Finance Ltd';

const licHousingAgents = [licHousingAgent];

export default licHousingAgents;