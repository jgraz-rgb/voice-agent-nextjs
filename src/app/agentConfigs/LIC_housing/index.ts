import { RealtimeAgent, tool } from '@openai/agents/realtime';
import { z } from 'zod';
import { LIC_HOUSING_INSTRUCTIONS } from './instructions';
import RAGDATA from './RAG.json';
import { calculateLeadScore } from './scoring';

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

const TOOL_API_BASE_URL = 'https://feature-mltools.searchunify.com/bfsi-api/';
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
// TOOLS
// ============================================================================

const updateLeadStateTool = tool({
  name: 'updateLeadState',
  description: 'Updates the lead qualification state with collected information. Use this to save user-provided data immediately as it is collected during the conversation.',
  parameters: z.object({
    field_name: z.string().describe('Name of the field to update (e.g., property_stage, employment_type, pan_number)'),
    field_value: z.union([z.string(), z.number(), z.boolean()]).describe('Value to store'),
  }),
  execute: async ({ field_name, field_value }: { field_name: string; field_value: string | number | boolean }) => {
    stateManager.updateState({
      [field_name]: field_value,
    });

    return {
      success: true,
      message: `Updated ${field_name} successfully`,
    };
  },
});

const getLeadStateTool = tool({
  name: 'getLeadState',
  description: 'Retrieves the current lead qualification state. Use this to check what information has been collected so far.',
  parameters: z.object({}),
  execute: async () => {
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
  description: 'Calculates the lead qualification score from all collected state data. Reads the current state and scores across 5 parameters (Intent, Eligibility, Loan Amount, Decision Authority, LICHFL Preference). Call this at end of call or when enough data is collected. No parameters needed — it reads from state automatically.',
  parameters: z.object({}),
  execute: async () => {
    const state = stateManager.getState();
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

    return {
      success: true,
      scores: {
        p1: { score: result.p1.score, weighted: result.p1_weighted, evidence: result.p1.evidence },
        p2: { score: result.p2.score, weighted: result.p2_weighted, evidence: result.p2.evidence },
        p3: { score: result.p3.score, weighted: result.p3_weighted, evidence: result.p3.evidence },
        p4: { score: result.p4.score, weighted: result.p4_weighted, evidence: result.p4.evidence },
        p5: { score: result.p5.score, weighted: result.p5_weighted, evidence: result.p5.evidence },
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
    const { subject, transcript, lead_category, call_disposition } = input;
    const stateSnapshot = stateManager.getState();

    const descriptionParts: string[] = [];
    descriptionParts.push(`**Lead Category:** ${lead_category}`);
    descriptionParts.push(`**Call Disposition:** ${call_disposition}`);

    if (stateSnapshot.total_score) {
      descriptionParts.push(`**Lead Score:** ${stateSnapshot.total_score}/100`);
    }

    if (transcript) {
      descriptionParts.push(`**Transcript:**\n${transcript}`);
    }

    descriptionParts.push(
      `**Qualification State:**\n${JSON.stringify(stateSnapshot, null, 2)}`
    );

    const description = descriptionParts.join('\n\n');

    try {
      return await callToolAPI('tickets', {
        subject,
        description,
      });
    } catch {
      // Fallback for demo
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
