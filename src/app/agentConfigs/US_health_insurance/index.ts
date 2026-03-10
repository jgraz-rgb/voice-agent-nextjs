import { RealtimeAgent, tool } from '@openai/agents/realtime';
import { z } from 'zod';
import { US_HEALTH_INSURANCE_INSTRUCTIONS } from './instructions';
import RAGDATA from './RAG.json';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

interface RenewalState {
  current_stage: number;
  conversation_transcript: string[];
  
  // Client Information
  client_name?: string;
  email_id?: string;
  mobile_number?: string;
  
  // Current Policy Information
  current_plan_name?: string;
  current_carrier?: string;
  yearly_premium?: number;
  renewal_date?: string;
  
  // Data Collection
  household_changes?: string;
  estimated_income?: number;
  previous_income?: number;
  medical_changes?: string;
  doctor_changes?: string;
  prescription_changes?: string;
  travel_plans?: string;
  
  // Documents
  income_document_sent?: boolean;
  income_document_received?: boolean;
  
  // Carrier Submission
  carrier_submission_complete?: boolean;
  chronic_conditions?: string;
  upcoming_diagnostics?: string;
  tobacco_use?: string;
  
  // Quote & Plan Options
  renewal_premium?: number;
  premium_increase_percentage?: number;
  premium_increase_reason?: string;
  deductible?: number;
  coinsurance_percentage?: number;
  out_of_pocket_max?: number;
  
  // Alternative Plans
  alternative_plans?: Array<{
    plan_name: string;
    yearly_premium: number;
    deductible: number;
    coinsurance_percentage: number;
    out_of_pocket_max: number;
  }>;
  
  // Decision
  selected_plan?: string;
  recommendation_given?: string;
  
  // Enrollment
  enrollment_complete?: boolean;
  policy_year?: number;
  policy_documents_sent?: boolean;
  policy_documents_confirmed?: boolean;
  policy_link?: string;
  
  // Status
  renewal_status?: 'in_progress' | 'completed' | 'abandoned' | 'needs_follow_up';
  follow_up_scheduled?: string;
  follow_up_reason?: string;
}

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

class StateManager {
  private state: RenewalState;

  constructor() {
    this.state = {
      current_stage: 1,
      conversation_transcript: [],
      renewal_status: 'in_progress',
    };
  }

  getState(): RenewalState {
    return { ...this.state };
  }

  updateState(updates: Partial<RenewalState>): void {
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

type McpServiceName = "mobile_otp_verification" | "email_tools" | "zendesk";

const mcpServers: Record<McpServiceName, { url: string }> = {
  mobile_otp_verification: { url: "http://MOBILE_Authentication_api:7290/" },
  email_tools: { url: "http://email_sender_api:16500/" },
  zendesk: { url: "http://zendesk_api:5874/" },
};

export async function callToolAPI(
  service: McpServiceName,
  endpoint: string,
  data: any
): Promise<any> {
  try {
    // ✅ Get base URL dynamically based on the service name
    const baseUrl = "https://feature-mltools.searchunify.com/bfsi-api/";

    // ✅ Perform the API call
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // ✅ Return JSON response
    return await response.json();
  } catch (error) {
    console.error(`Tool API call failed for ${service}/${endpoint}:`, error);
    throw error;
  }
}

// ============================================================================
// TOOLS
// ============================================================================

const updateStateTool = tool({
  name: 'updateRenewalState',
  description: 'Updates the renewal state with collected information. Use this to save client-provided data during the renewal workflow.',
  strict: true,
  parameters: z.object({
    field_name: z.string().describe('Name of the field to update'),
    field_value: z.union([z.string(), z.number(), z.boolean(), z.any()]).describe('Value to store'),
  }),
  execute: async (input) => {
    const { field_name, field_value } = input;
    stateManager.updateState({
      [field_name]: field_value,
    });

    return {
      success: true,
      message: `Updated ${field_name} successfully`,
    };
  },
});

const getStateTool = tool({
  name: 'getRenewalState',
  description: 'Retrieves the current renewal state. Use this to check what information has been collected.',
  strict: true,
  parameters: z.object({}),
  execute: async () => {
    const state = stateManager.getState();
    return state;
  },
});





const requestDocumentTool = tool({
  name: 'requestDocument',
  description: 'Request a document from the client (e.g., pay stub for income verification). Use when income changes require documentation.',
  strict: true,
  parameters: z.object({
    document_type: z.string().describe('Type of document being requested (e.g., "pay stub", "income verification")'),
    email: z.string().describe('Email address to send request to'),
  }),
  execute: async (input) => {
    const { document_type, email } = input;
    stateManager.updateState({
      income_document_sent: true,
    });

    return {
      success: true,
      message: `Document request for ${document_type} sent to ${email}`,
    };
  },
});

const confirmDocumentReceivedTool = tool({
  name: 'confirmDocumentReceived',
  description: 'Confirms that a requested document has been received from the client. Call this when client confirms they sent the document.',
  strict: true,
  parameters: z.object({
    document_type: z.string().describe('Type of document received'),
  }),
  execute: async (input) => {
    const { document_type } = input;
    stateManager.updateState({
      income_document_received: true,
    });

    return {
      success: true,
      message: `${document_type} received successfully`,
    };
  },
});

const sendEmailTool = tool({
  name: 'sendEmail',
  description: 'Sends an email to the client with policy documents or renewal confirmation.',
  strict: true,
  parameters: z.object({
    to_email: z.string().describe('Email address'),
    subject: z.string().describe('Email subject line'),
    body: z.string().describe('Email body content'),
  }),
  execute: async (input) => {
    const { to_email, subject, body } = input;
    // Call external tool API
    return await callToolAPI("email_tools",'send_email', { to_email, subject, body });
  },
});

const confirmPolicyDocumentsReceivedTool = tool({
  name: 'confirmPolicyDocumentsReceived',
  description: 'Confirms that the client has received the policy documents via email. Call when client confirms receipt.',
  strict: true,
  parameters: z.object({
    confirmed: z.boolean().describe('Set to true when client confirms they received the email'),
  }),
  execute: async (input) => {
    const { confirmed } = input;
    if (confirmed) {
      stateManager.updateState({ 
        policy_documents_confirmed: true,
        renewal_status: 'completed'
      });
      return {
        success: true,
        message: 'Policy documents receipt confirmed',
      };
    }

    return {
      success: false,
      message: 'Documents not confirmed',
    };
  },
});



const generatePolicyLinkTool = tool({
  name: 'generatePolicyLink',
  description: 'Generates a secure link for policy documents after renewal is complete.',
  strict: true,
  parameters: z.object({
    carrier_name: z.string().describe('Insurance carrier name (e.g., "Humana")'),
    plan_name: z.string().describe('Selected plan name'),
  }),
  execute: async (input) => {
    const { carrier_name, plan_name } = input;
    const random_code = Math.random().toString(36).substring(2, 15).toLowerCase();
    const policy_link = `suinsurance.com/${carrier_name.toLowerCase()}/${random_code}`;

    stateManager.updateState({
      policy_link,
      enrollment_complete: true,
      policy_documents_sent: true,
    });

    return {
      success: true,
      policy_link,
      carrier_name,
      plan_name,
      message: 'Policy documents link generated successfully',
    };
  },
});

const ragSearchTool = tool({
  name: 'ragSearch',
  description: 'Searches health insurance knowledge base for answers to client questions. Returns top matching sections with excerpts about plan terms, coverage, subsidies, etc.',
  strict: true,
  parameters: z.object({
    query: z.string().describe('User query text to search for'),
    top_k: z.number().int().positive().max(10).nullable().default(null).describe('Number of results to return, default 5'),
    filters: z
      .object({
        article_id: z.string().nullable(),
        category: z.string().nullable(),
        section_id: z.string().nullable(),
      })
      .nullable()
      .default(null)
      .describe('Optional filters to narrow search'),
  }),
  execute: async ({ query, top_k, filters }: { query: string; top_k?: number | null; filters?: { article_id: string | null; category: string | null; section_id: string | null } | null }) => {
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
      section_id?: string;
      section_title?: string;
      score: number;
      excerpt: string;
      payload: any;
    }> = [];

    const articles: any[] = (data && data.articles) || [];
    for (const article of articles) {
  if (filters && filters.article_id && String(article.article_id) !== String(filters.article_id)) continue;
  if (filters && filters.category && String(article.category).toLowerCase() !== String(filters.category).toLowerCase()) continue;

      const articleText = extractText({ title: article.title, summary: article.summary, category: article.category, subcategories: article.subcategories });
      const aScore = scoreText(articleText);
      if (aScore > 0) {
        results.push({
          article_id: String(article.article_id),
          article_title: String(article.title || ''),
          category: article.category,
          score: aScore,
          excerpt: makeExcerpt(articleText, q),
          payload: { article_overview: { title: article.title, summary: article.summary, category: article.category, subcategories: article.subcategories } },
        });
      }

      const sections: any[] = article.sections || [];
      for (const section of sections) {
  if (filters && filters.section_id && String(section.section_id) !== String(filters.section_id)) continue;
        const sectionText = extractText({ title: section.title, content: section.content, keywords: section.keywords, data: section });
        const sScore = scoreText(sectionText);
        if (sScore > 0) {
          results.push({
            article_id: String(article.article_id),
            article_title: String(article.title || ''),
            category: article.category,
            section_id: String(section.section_id || ''),
            section_title: String(section.title || ''),
            score: sScore,
            excerpt: makeExcerpt(sectionText, q),
            payload: { section },
          });
        }
      }
    }

    const common: any[] = (data && data.common_queries) || [];
    for (const cq of common) {
      const cText = extractText(cq);
      const cScore = scoreText(cText);
      if (cScore > 0) {
        results.push({
          article_id: 'common_queries',
          article_title: 'Common Queries',
          score: cScore,
          excerpt: makeExcerpt(cText, q),
          payload: { common_query: cq },
        } as any);
      }
    }

    const glossary: any[] = (data && data.glossary) || [];
    for (const g of glossary) {
      const gText = extractText(g);
      const gScore = scoreText(gText);
      if (gScore > 0) {
        results.push({
          article_id: 'glossary',
          article_title: 'Glossary',
          score: gScore,
          excerpt: makeExcerpt(gText, q),
          payload: { glossary_item: g },
        } as any);
      }
    }

    results.sort((a, b) => b.score - a.score);
    const out = results.slice(0, k);
    return { query, total_matches: results.length, results: out };
  },
});

// ----------------------------------------------------------------------------
// ZENDESK TICKET (LOCAL JSON SIMULATION)
// ----------------------------------------------------------------------------

/*
const createZendeskTicketTool = tool({
  name: 'createZendeskTicket',
  description: 'Creates a simulated Zendesk ticket by saving current application snapshot to a local JSON file via API. Call at completion or when abandoned.',
  strict: true,
  parameters: z.object({
    subject: z.string().describe('Ticket subject line including customer name and status'),
    transcript: z.string().nullable().describe('Unused placeholder; we store fields from state, not raw transcript'),
    customer_data: z.any().nullable().describe('Optional additional data; ignored in favor of internal state snapshot'),
    application_status: z.enum(['Completed', 'Abandoned', 'In Progress']).describe('Overall application status for the ticket'),
  }),
  execute: async (input) => {
    const { subject, transcript, customer_data, application_status } = input as {
      subject: string;
      transcript: string | null;
      customer_data: any;
      application_status: 'Completed' | 'Abandoned' | 'In Progress';
    };

    // Call external tool API
    // Note: Tool API will handle ticket creation and storage
    return await callToolAPI("zendesk",'createZendeskTicket', {
      subject,
      transcript,
      customer_data,
      application_status,
    });
  },
});

*/

const createZendeskTicketTool = tool({
  name: "createZendeskTicket",
  description:
    "Creates a Zendesk ticket for the renewal conversation. Call when renewal is completed, abandoned, or needs follow-up.",
  strict: true,
  parameters: z.object({
    subject: z
      .string()
      .describe("Ticket subject line including client name and renewal status"),
    transcript: z
      .string()
      .nullable()
      .describe("Optional conversation transcript"),
    renewal_data: z
      .any()
      .nullable()
      .describe("Renewal state data including client info, plan selections, etc."),
    renewal_status: z
      .enum(["Completed", "Abandoned", "In Progress", "Needs Follow-up"])
      .describe("Overall renewal status"),
  }),
  execute: async (input) => {
    const { subject, transcript, renewal_data, renewal_status } = input;

    const descriptionParts: string[] = [];

    descriptionParts.push(`**Renewal Status:** ${renewal_status}`);

    if (transcript) {
      descriptionParts.push(`**Call Transcript:**\n${transcript}`);
    }

    if (renewal_data) {
      descriptionParts.push(
        `**Renewal Information:**\n${JSON.stringify(renewal_data, null, 2)}`
      );
    }

    const description = descriptionParts.join("\n\n");
    
    return await callToolAPI("zendesk", "tickets", {
      subject,
      description,
    });
  },
});

// ============================================================================
// CREATE AGENT
// ============================================================================

export const usHealthInsuranceAgent = new RealtimeAgent({
  name: 'US Health Insurance Renewal Agent',
  voice: 'alloy',
  instructions: US_HEALTH_INSURANCE_INSTRUCTIONS,
  tools: [
    updateStateTool,
    getStateTool,
    requestDocumentTool,
    confirmDocumentReceivedTool,
    sendEmailTool,
    confirmPolicyDocumentsReceivedTool,
    generatePolicyLinkTool,
    ragSearchTool,
    createZendeskTicketTool,
  ],
  handoffs: [],
});

export const usHealthInsuranceCompanyName = 'SU Insurance';

const healthInsuranceAgents = [usHealthInsuranceAgent];

export default healthInsuranceAgents;
