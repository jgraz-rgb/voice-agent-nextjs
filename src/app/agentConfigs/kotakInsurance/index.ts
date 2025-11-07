import { RealtimeAgent, tool } from '@openai/agents/realtime';
import { z } from 'zod';
import { KOTAK_INSURANCE_INSTRUCTIONS } from './instructions';
import RAGDATA from './RAG.json';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

interface ApplicationState {
  current_step: number;
  current_field: string;
  conversation_transcript: string[];
  language_preference?: 'English' | 'Hindi';
  full_name?: string;
  gender?: 'Male' | 'Female';
  date_of_birth?: string;
  mobile_number?: string;
  email_id?: string;
  annual_income_bracket?: string;
  monthly_premium?: number;
  pay_for_years?: 5 | 7 | 10 | 20;
  policy_term?: 10 | 12 | 15 | 20 | 66;
  selected_plan?: 'Maximizer' | 'Rising Star' | 'Retire Rich';
  maturity_4_percent?: number;
  maturity_8_percent?: number;
  fund_strategy?: 'Aggressive' | 'Moderate' | 'Conservative';
  marital_status?: string;
  education_level?: string;
  occupation?: string;
  organization_type?: string;
  organization_name?: string;
  years_in_service?: number;
  pincode?: string;
  city?: string;
  state?: string;
  pan_number?: string;
  annual_income_exact?: number;
  mother_name?: string;
  father_spouse_name?: string;
  nationality?: string;
  ckyc_consent?: boolean;
  aadhaar_number?: string;
  aadhaar_consent?: boolean;
  aadhaar_address?: string;
  aadhaar_dob?: string;
  address_type?: string;
  electronic_document_consent?: boolean;
  physical_copy_consent?: boolean;
  country_of_birth?: string;
  place_of_birth?: string;
  criminal_history?: boolean;
  is_pep?: boolean;
  is_pep_relative?: boolean;
  other_country_tax_resident?: boolean;
  has_eia?: boolean;
  nominee_name?: string;
  nominee_relationship?: string;
  nominee_dob?: string;
  nominee_address?: string;
  height_feet?: number;
  height_inches?: number;
  weight_kg?: number;
  cigarette_consumption?: boolean;
  tobacco_consumption?: boolean;
  alcohol_consumption?: boolean;
  narcotics_consumption?: boolean;
  insurance_declined_history?: boolean;
  hiv_aids_history?: boolean;
  cardiovascular_history?: boolean;
  respiratory_digestive_urinary_history?: boolean;
  mental_nervous_congenital_history?: boolean;
  recent_medical_attention?: boolean;
  family_medical_history?: boolean;
  bank_account_number?: string;
  account_holder_name?: string;
  ifsc_code?: string;
  account_type?: 'Savings' | 'Current';
  final_consents_given?: boolean;
  assisted_by_someone?: boolean;
  application_everified?: boolean;
  documents_received?: string[];
  all_documents_received?: boolean;
  payment_completed?: boolean;
  policy_id?: string;
  policy_link?: string;
}

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

class StateManager {
  private state: ApplicationState;

  constructor() {
    this.state = {
      current_step: 1,
      current_field: 'greeting',
      conversation_transcript: [],
    };
  }

  getState(): ApplicationState {
    return { ...this.state };
  }

  updateState(updates: Partial<ApplicationState>): void {
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
// TOOLS
// ============================================================================

const verifyPANTool = tool({
  name: 'verifyPAN',
  description: 'Verifies a PAN card number against CKYC records. Returns validation status and name if valid.',
  parameters: z.object({
    pan_number: z.string().length(10).describe('PAN card number (10 characters, format: AAAAA9999A)'),
  }),
  execute: async ({ pan_number }: { pan_number: string }) => {
    const isValid = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(pan_number);

    if (isValid) {
      stateManager.updateState({ pan_number });
      return {
        valid: true,
        name: stateManager.getState().full_name || 'Unknown',
        message: 'PAN verified successfully against CKYC records',
      };
    } else {
      return {
        valid: false,
        message: 'PAN card number appears to be invalid or not found in CKYC records',
      };
    }
  },
});

const lookupPincodeTool = tool({
  name: 'lookupPincode',
  description: 'Looks up city and state information for a given pincode.',
  parameters: z.object({
    pincode: z.string().length(6).describe('6-digit Indian pincode'),
  }),
  execute: async ({ pincode }: { pincode: string }) => {
    const mockPincodeData: Record<string, { city: string; state: string }> = {
      '400101': { city: 'Mumbai', state: 'Maharashtra' },
      '110001': { city: 'New Delhi', state: 'Delhi' },
      '560001': { city: 'Bangalore', state: 'Karnataka' },
      '700001': { city: 'Kolkata', state: 'West Bengal' },
    };

    const data = mockPincodeData[pincode] || { city: 'Mumbai', state: 'Maharashtra' };

    stateManager.updateState({
      pincode,
      city: data.city,
      state: data.state,
    });

    return {
      city: data.city,
      state: data.state,
      pincode: pincode,
    };
  },
});

const sendAadhaarOTPTool = tool({
  name: 'sendAadhaarOTP',
  description: 'Sends OTP to the mobile number registered with the provided Aadhaar number.',
  parameters: z.object({
    aadhaar_number: z.string().describe('12-digit Aadhaar number (with or without spaces)'),
  }),
  execute: async ({ aadhaar_number }: { aadhaar_number: string }) => {
    const normalized = aadhaar_number.replace(/\s/g, '');
    stateManager.updateState({ aadhaar_number: normalized });

    const otp_reference_id = `AAD_${Date.now()}`;

    return {
      success: true,
      otp_reference_id,
      message: 'OTP sent to registered mobile number',
    };
  },
});

const verifyAadhaarOTPTool = tool({
  name: 'verifyAadhaarOTP',
  description: 'Verifies the OTP sent to Aadhaar registered mobile number.',
  parameters: z.object({
    otp_reference_id: z.string().describe('OTP reference ID from sendAadhaarOTP'),
    otp_code: z.string().describe('6-digit OTP code provided by user'),
  }),
  execute: async ({ otp_code }: { otp_reference_id: string; otp_code: string }) => {
    const state = stateManager.getState();
    const isValid = /^\d{6}$/.test(otp_code);

    if (isValid) {
      const mockAddress = state.city
        ? `101, Hill View, ${state.city} - ${state.pincode}`
        : '101, Hill View, Mumbai - 400101';

      stateManager.updateState({
        aadhaar_address: mockAddress,
        aadhaar_dob: state.date_of_birth || '09/06/1992',
      });

      return {
        success: true,
        address: mockAddress,
        dob: state.date_of_birth || '09/06/1992',
        name: state.full_name || 'Unknown',
      };
    } else {
      return {
        success: false,
        message: 'Invalid OTP. Please try again.',
      };
    }
  },
});

const sendGeneralOTPTool = tool({
  name: 'sendGeneralOTP',
  description: 'Sends OTP to the registered mobile number for e-verification.',
  parameters: z.object({
    phone_number: z.string().describe('10-digit mobile number'),
  }),
  execute: async () => {
    const otp_reference_id = `GEN_${Date.now()}`;

    return {
      success: true,
      otp_reference_id,
      message: 'OTP sent successfully',
    };
  },
});

const verifyGeneralOTPTool = tool({
  name: 'verifyGeneralOTP',
  description: 'Verifies the OTP sent for e-verification.',
  parameters: z.object({
    otp_reference_id: z.string().describe('OTP reference ID from sendGeneralOTP'),
    otp_code: z.string().describe('6-digit OTP code provided by user'),
  }),
  execute: async ({ otp_code }: { otp_reference_id: string; otp_code: string }) => {
    const isValid = /^\d{6}$/.test(otp_code);

    if (isValid) {
      stateManager.updateState({ application_everified: true });
      return {
        success: true,
        message: 'Application e-verified successfully',
      };
    } else {
      return {
        success: false,
        message: 'Invalid OTP. Please try again.',
      };
    }
  },
});

const sendWhatsAppMessageTool = tool({
  name: 'sendWhatsAppMessage',
  description: 'Sends a WhatsApp message to the user with policy details or updates.',
  parameters: z.object({
    phone_number: z.string().describe('10-digit mobile number'),
    message_text: z.string().describe('Message content to send'),
  }),
  execute: async () => {
    return {
      success: true,
      message_id: `WA_${Date.now()}`,
      message: 'WhatsApp message sent successfully',
    };
  },
});

const receiveWhatsAppDocumentTool = tool({
  name: 'receiveWhatsAppDocument',
  description: 'Simulates receiving a document upload from WhatsApp. Call this when user says they have uploaded a document.',
  parameters: z.object({
    document_type: z.enum(['identity', 'address', 'income', 'age']).describe('Type of document being uploaded'),
  }),
  execute: async ({ document_type }: { document_type: string }) => {
    const state = stateManager.getState();
    const documents = state.documents_received || [];

    if (!documents.includes(document_type)) {
      documents.push(document_type);

      stateManager.updateState({
        documents_received: documents,
        all_documents_received: documents.length === 4,
      });
    }

    return {
      success: true,
      document_type,
      total_received: documents.length,
      remaining: 4 - documents.length,
      message: `${document_type} proof received. ${4 - documents.length} documents remaining.`,
    };
  },
});

const sendEmailTool = tool({
  name: 'sendEmail',
  description: 'Sends an email to the user (payment link or policy documents).',
  parameters: z.object({
    to_address: z.string().describe('Email address'),
    subject: z.string().describe('Email subject line'),
    body: z.string().describe('Email body content'),
  }),
  execute: async () => {
    return {
      success: true,
      email_id: `EMAIL_${Date.now()}`,
      message: 'Email sent successfully',
    };
  },
});

const confirmPaymentTool = tool({
  name: 'confirmPayment',
  description: 'Confirms that the user has completed the payment. Call this when user says "Done" or "Paid" or "Completed".',
  parameters: z.object({
    confirmation: z.boolean().describe('Set to true when user confirms payment'),
  }),
  execute: async ({ confirmation }: { confirmation: boolean }) => {
    if (confirmation) {
      stateManager.updateState({ payment_completed: true });
      return {
        success: true,
        message: 'Payment confirmed successfully',
      };
    }

    return {
      success: false,
      message: 'Payment not confirmed',
    };
  },
});

const receiveEmailDocumentTool = tool({
  name: 'receiveEmailDocument',
  description: 'Confirms all documents received via email when user says they uploaded everything. Call this when user confirms document upload completion.',
  parameters: z.object({
    all_uploaded: z.boolean().describe('Set to true when user confirms all documents are uploaded'),
  }),
  execute: async ({ all_uploaded }: { all_uploaded: boolean }) => {
    if (all_uploaded) {
      const allDocs = ['identity', 'address', 'income', 'age'];
      stateManager.updateState({
        documents_received: allDocs,
        all_documents_received: true,
      });

      return {
        success: true,
        total_received: 4,
        all_documents_received: true,
        message: 'All 4 documents (Identity, Address, Income, Age proof) confirmed received via email.',
      };
    }

    return {
      success: false,
      message: 'Document upload not confirmed.',
    };
  },
});

const generatePolicyTool = tool({
  name: 'generatePolicy',
  description: 'Generates a policy ID and document link for the completed application.',
  parameters: z.object({}),
  execute: async () => {
    const policy_id = Math.floor(100000000 + Math.random() * 900000000).toString();
    const random_code = Math.random().toString(36).substring(2, 11).toUpperCase();
    const policy_link = `sfsr.in/policy/${random_code}`;

    stateManager.updateState({
      policy_id,
      policy_link,
    });

    return {
      success: true,
      policy_id,
      policy_link,
      message: 'Policy documents generated successfully',
    };
  },
});

const updateStateTool = tool({
  name: 'updateApplicationState',
  description: 'Updates the application state with collected information. Use this to save user-provided data.',
  parameters: z.object({
    field_name: z.string().describe('Name of the field to update'),
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

const getStateTool = tool({
  name: 'getApplicationState',
  description: 'Retrieves the current application state. Use this to check what information has been collected.',
  parameters: z.object({}),
  execute: async () => {
    const state = stateManager.getState();
    return state;
  },
});

const ragSearchTool = tool({
  name: 'ragSearch',
  description: 'Searches Kotak Insurance RAG data for answers. Returns top matching sections with excerpts.',
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
    const { subject, application_status } = input as {
      subject: string;
      application_status: 'Completed' | 'Abandoned' | 'In Progress';
    };
    const snapshot = stateManager.getState();

    // Build a compact ticket payload focused on collected fields (not full transcript)
    const ticket = {
      subject,
  application_status,
      created_at: new Date().toISOString(),
      customer: {
        full_name: snapshot.full_name ?? null,
        gender: snapshot.gender ?? null,
        mobile_number: snapshot.mobile_number ?? null,
        email_id: snapshot.email_id ?? null,
        date_of_birth: snapshot.date_of_birth ?? null,
        pincode: snapshot.pincode ?? null,
        city: snapshot.city ?? null,
        state: snapshot.state ?? null,
        nationality: snapshot.nationality ?? null,
      },
      plan: {
        monthly_premium: snapshot.monthly_premium ?? null,
        pay_for_years: snapshot.pay_for_years ?? null,
        policy_term: snapshot.policy_term ?? null,
        selected_plan: snapshot.selected_plan ?? null,
        fund_strategy: snapshot.fund_strategy ?? null,
        maturity_4_percent: snapshot.maturity_4_percent ?? null,
        maturity_8_percent: snapshot.maturity_8_percent ?? null,
      },
      kyc: {
        pan_number: snapshot.pan_number ?? null,
        aadhaar_number: snapshot.aadhaar_number ?? null,
        aadhaar_address: snapshot.aadhaar_address ?? null,
        aadhaar_dob: snapshot.aadhaar_dob ?? null,
        ckyc_consent: snapshot.ckyc_consent ?? null,
        aadhaar_consent: snapshot.aadhaar_consent ?? null,
      },
      background: {
        marital_status: snapshot.marital_status ?? null,
        education_level: snapshot.education_level ?? null,
        occupation: snapshot.occupation ?? null,
        organization_type: snapshot.organization_type ?? null,
        organization_name: snapshot.organization_name ?? null,
        years_in_service: snapshot.years_in_service ?? null,
        country_of_birth: snapshot.country_of_birth ?? null,
        place_of_birth: snapshot.place_of_birth ?? null,
        criminal_history: snapshot.criminal_history ?? null,
        is_pep: snapshot.is_pep ?? null,
        is_pep_relative: snapshot.is_pep_relative ?? null,
        other_country_tax_resident: snapshot.other_country_tax_resident ?? null,
        has_eia: snapshot.has_eia ?? null,
      },
      nominee: {
        nominee_name: snapshot.nominee_name ?? null,
        nominee_relationship: snapshot.nominee_relationship ?? null,
        nominee_dob: snapshot.nominee_dob ?? null,
        nominee_address: snapshot.nominee_address ?? null,
      },
      health: {
        height_feet: snapshot.height_feet ?? null,
        height_inches: snapshot.height_inches ?? null,
        weight_kg: snapshot.weight_kg ?? null,
        cigarette_consumption: snapshot.cigarette_consumption ?? null,
        tobacco_consumption: snapshot.tobacco_consumption ?? null,
        alcohol_consumption: snapshot.alcohol_consumption ?? null,
        narcotics_consumption: snapshot.narcotics_consumption ?? null,
        insurance_declined_history: snapshot.insurance_declined_history ?? null,
        hiv_aids_history: snapshot.hiv_aids_history ?? null,
        cardiovascular_history: snapshot.cardiovascular_history ?? null,
        respiratory_digestive_urinary_history: snapshot.respiratory_digestive_urinary_history ?? null,
        mental_nervous_congenital_history: snapshot.mental_nervous_congenital_history ?? null,
        recent_medical_attention: snapshot.recent_medical_attention ?? null,
        family_medical_history: snapshot.family_medical_history ?? null,
      },
      bank: {
        account_type: snapshot.account_type ?? null,
        account_holder_name: snapshot.account_holder_name ?? null,
        bank_account_number: snapshot.bank_account_number ?? null,
        ifsc_code: snapshot.ifsc_code ?? null,
      },
      documents: {
        documents_received: snapshot.documents_received ?? [],
        all_documents_received: snapshot.all_documents_received ?? false,
      },
      policy: {
        policy_id: snapshot.policy_id ?? null,
        policy_link: snapshot.policy_link ?? null,
      },
      progress: {
        current_step: snapshot.current_step,
        final_consents_given: snapshot.final_consents_given ?? null,
        application_everified: snapshot.application_everified ?? null,
        payment_completed: snapshot.payment_completed ?? null,
      },
      transcript_included: false,
    };

    try {
      await fetch('/api/zendesk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ticket),
      });
      return { success: true, message: 'Ticket saved locally' };
    } catch (err) {
      return { success: false, message: 'Failed to save ticket', error: String(err) };
    }
  },
});

// ============================================================================
// CREATE AGENT (Instructions imported from instructions.ts)
// ============================================================================

// CREATE AGENT
// ============================================================================

export const kotakInsuranceAgent = new RealtimeAgent({
  name: 'Kotak Insurance Agent',
  voice: 'shimmer',
  instructions: KOTAK_INSURANCE_INSTRUCTIONS,
  tools: [
    verifyPANTool,
    lookupPincodeTool,
    sendAadhaarOTPTool,
    verifyAadhaarOTPTool,
    sendGeneralOTPTool,
    verifyGeneralOTPTool,
    sendWhatsAppMessageTool,
    receiveWhatsAppDocumentTool,
    sendEmailTool,
    confirmPaymentTool,
    generatePolicyTool,
    updateStateTool,
    getStateTool,
    ragSearchTool,
    receiveEmailDocumentTool,
    createZendeskTicketTool,
  ],
  handoffs: [],
});

export const kotakInsuranceCompanyName = 'Kotak Life Insurance';

const kotakAgents = [kotakInsuranceAgent];

export default kotakAgents;
