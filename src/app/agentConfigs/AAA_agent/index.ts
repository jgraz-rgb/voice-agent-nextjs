import { RealtimeAgent, tool } from '@openai/agents/realtime';
import { z } from 'zod';
// import { promises as fs } from 'fs';
import path from 'path';
import { AAA_INSURANCE_INSTRUCTIONS } from './instructions';
import { AAA_INSURANCE_INSTRUCTIONS_V2 } from './instructions_v2';
import RAGDATA from './RAG.json';
import {
  calculateAutoInsurancePremium,
  calculateHomeInsurancePremium,
  calculateBundledQuote,
  type VehicleInfo,
  type DriverProfile,
  type CoverageSelections,
  type DiscountFlags,
  type HomeInfo,
} from './calculations';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

interface ApplicationState {
  current_stage: number;
  current_field: string;
  conversation_transcript: string[];
  language_preference?: 'English' | 'Spanish';

  // Stage 0: Identity
  full_name?: string;
  zip_code?: string;
  city?: string;
  state?: string;
  date_of_birth?: string;
  mobile_number?: string;
  otp_verified?: boolean;

  // Stage 1: Vehicle
  vin?: string;
  vehicle_year?: string;
  vehicle_make?: string;
  vehicle_model?: string;
  vehicle_trim?: string;
  vehicle_usage_category?: string;
  annual_mileage?: number;
  ownership_status?: 'owned' | 'financed';
  has_lienholder?: boolean;
  vehicle_count?: number;
  estimated_vehicle_value?: number;

  // Stage 2: Driver
  gender?: string;
  marital_status?: string;
  education_level?: string;
  employment_status?: string;
  license_state?: string;
  license_year?: number;
  license_status?: string;
  driving_experience_years?: number;
  accidents_last_3_years?: boolean;
  accident_count?: number;
  accident_details?: string;
  violations_last_3_years?: boolean;
  violation_count?: number;
  violation_details?: string;
  defensive_driving_course?: boolean;
  good_student_eligible?: boolean;
  additional_drivers?: boolean;
  additional_driver_count?: number;

  // Stage 3: Current Insurance
  has_current_insurance?: boolean;
  current_carrier?: string;
  current_premium?: number;
  current_policy_expiration?: string;
  coverage_lapse?: boolean;

  // Stage 4: Coverage
  liability_coverage_selection?: string;
  deductible?: number;
  comprehensive?: boolean;
  collision?: boolean;
  roadside_assistance?: boolean;
  rental_reimbursement?: boolean;
  anti_theft_device?: boolean;
  is_homeowner?: boolean;
  bundle_interested?: boolean;

  // Bundle (Home) Details
  home_year_built?: number;
  home_square_footage?: number;
  home_type?: 'single-family' | 'condo' | 'townhouse';
  home_has_mortgage?: boolean;
  home_value?: number;
  home_claims_history?: boolean;
  home_roof_type?: string;
  home_roof_year?: number;
  home_security_system?: boolean;

  // Stage 5: Quote & Payment
  email_id?: string;
  quote_amount?: number;
  bundled_auto_quote?: number;
  bundled_home_quote?: number;
  discounts_applied?: string[];
  total_discount_amount?: number;
  payment_preference?: 'monthly' | 'six_month';
  policy_start_date?: string;
  payment_completed?: boolean;
  policy_id?: string;
  policy_link?: string;

  // AAA Membership
  aaa_member?: boolean;

  // Application Status
  application_status?: 'in_progress' | 'completed' | 'abandoned' | 'transfer_to_underwriting';
}

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

class StateManager {
  private state: ApplicationState;

  constructor() {
    this.state = {
      current_stage: 0,
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
// VIN LOOKUP DATA
// ============================================================================

const VIN_DATABASE: Record<string, { year: string; make: string; model: string; trim: string; value: number }> = {
  '1HGBH41JXMN109186': { year: '2021', make: 'Honda', model: 'Accord', trim: 'Sport', value: 28000 },
  '1FAFP404X1F192837': { year: '2020', make: 'Ford', model: 'Mustang', trim: 'EcoBoost', value: 32000 },
  '2T1BURHE5JC045612': { year: '2019', make: 'Toyota', model: 'Corolla', trim: 'LE', value: 18000 },
  '5NPE24AF4FH123456': { year: '2021', make: 'Hyundai', model: 'Sonata', trim: 'SEL', value: 26000 },
  '1C4RJFBG8LC334455': { year: '2020', make: 'Jeep', model: 'Grand Cherokee', trim: 'Limited', value: 42000 },
  '3VW2B7AJ5HM098765': { year: '2018', make: 'Volkswagen', model: 'Jetta', trim: 'SE', value: 16000 },
  '1G1BE5SM7H7154321': { year: '2017', make: 'Chevrolet', model: 'Cruze', trim: 'LT', value: 14000 },
  'JN1EV7AR0JM654321': { year: '2018', make: 'Infiniti', model: 'Q50', trim: 'Premium', value: 28000 },
  'WAUENAF48KN112233': { year: '2019', make: 'Audi', model: 'A4', trim: 'Premium Plus', value: 35000 },
};

const DEFAULT_VEHICLE = { year: '2020', make: 'Land Rover', model: 'Range Rover Sport', trim: 'Standard', value: 65000 };

// ============================================================================
// ZIP CODE LOOKUP DATA
// ============================================================================

const ZIP_DATABASE: Record<string, { city: string; state: string }> = {
  '90210': { city: 'Beverly Hills', state: 'California' },
  '10001': { city: 'New York', state: 'New York' },
  '60601': { city: 'Chicago', state: 'Illinois' },
  '77001': { city: 'Houston', state: 'Texas' },
  '85001': { city: 'Phoenix', state: 'Arizona' },
  '19101': { city: 'Philadelphia', state: 'Pennsylvania' },
  '78201': { city: 'San Antonio', state: 'Texas' },
  '92101': { city: 'San Diego', state: 'California' },
  '75201': { city: 'Dallas', state: 'Texas' },
  '95101': { city: 'San Jose', state: 'California' },
};

// ============================================================================
// TOOLS
// ============================================================================

const lookupVINTool = tool({
  name: 'lookupVIN',
  description: 'Looks up vehicle details from a VIN number. Returns year, make, model, trim, and estimated value.',
  parameters: z.object({
    vin_number: z.string().describe('17-character Vehicle Identification Number'),
  }),
  execute: async ({ vin_number }: { vin_number: string }) => {
    const normalized = vin_number.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const vehicle = VIN_DATABASE[normalized] || DEFAULT_VEHICLE;

    stateManager.updateState({
      vin: normalized,
      vehicle_year: vehicle.year,
      vehicle_make: vehicle.make,
      vehicle_model: vehicle.model,
      vehicle_trim: vehicle.trim,
      estimated_vehicle_value: vehicle.value,
    });

    return {
      success: true,
      vin: normalized,
      year: vehicle.year,
      make: vehicle.make,
      model: vehicle.model,
      trim: vehicle.trim,
      estimated_value: vehicle.value,
    };
  },
});

const lookupZipCodeTool = tool({
  name: 'lookupZipCode',
  description: 'Looks up city and state information for a given US ZIP code.',
  parameters: z.object({
    zip_code: z.string().length(5).describe('5-digit US ZIP code'),
  }),
  execute: async ({ zip_code }: { zip_code: string }) => {
    const data = ZIP_DATABASE[zip_code] || { city: 'Los Angeles', state: 'California' };

    stateManager.updateState({
      zip_code,
      city: data.city,
      state: data.state,
    });

    return {
      success: true,
      zip_code,
      city: data.city,
      state: data.state,
    };
  },
});

const sendGeneralOTPTool = tool({
  name: 'sendGeneralOTP',
  description: 'Sends OTP to the provided mobile number for identity verification.',
  parameters: z.object({
    phone_number: z.string().describe('10-digit mobile number'),
  }),
  execute: async ({ phone_number }: { phone_number: string }) => {
    try {
      return await callToolAPI('sendGeneralOTP', { phone_number });
    } catch {
      // Fallback for demo
      const otp_reference_id = `OTP_${Date.now()}`;
      return {
        success: true,
        otp_reference_id,
        message: 'OTP sent to mobile number',
      };
    }
  },
});

const verifyGeneralOTPTool = tool({
  name: 'verifyGeneralOTP',
  description: 'Verifies the OTP sent for identity verification.',
  parameters: z.object({
    otp_reference_id: z.string().describe('OTP reference ID from sendGeneralOTP'),
    otp_code: z.string().describe('6-digit OTP code provided by user'),
  }),
  execute: async ({ otp_reference_id, otp_code }: { otp_reference_id: string; otp_code: string }) => {
    try {
      const result = await callToolAPI('verifyGeneralOTP', { otp_reference_id, otp_code });
      if (result.success) {
        stateManager.updateState({ otp_verified: true });
      }
      return result;
    } catch {
      // Fallback for demo - accept any 6-digit code
      const isValid = /^\d{6}$/.test(otp_code);
      if (isValid) {
        stateManager.updateState({ otp_verified: true });
        return { success: true, message: 'OTP verified successfully' };
      }
      return { success: false, message: 'Invalid OTP. Please try again.' };
    }
  },
});

const calculateQuoteTool = tool({
  name: 'calculateQuote',
  description: 'Calculates the insurance quote based on all collected information. Returns monthly premium and applied discounts.',
  parameters: z.object({}),
  execute: async () => {
    const state = stateManager.getState();

    // Base rate components
    let basePremium = 140; // $140 base (liability + collision + comprehensive + uninsured motorist)

    // Adjust for deductible
    if (state.deductible === 1000) {
      basePremium -= 7; // Save $7 with $1000 deductible
    } else if (state.deductible === 2000) {
      basePremium -= 14; // Save $14 with $2000 deductible
    }

    // Calculate age from DOB
    let age = 40; // Default
    if (state.date_of_birth) {
      const dob = new Date(state.date_of_birth);
      const today = new Date();
      age = today.getFullYear() - dob.getFullYear();
    }

    // Risk multipliers
    let multiplier = 1.0;

    // Age factor
    if (age >= 40 && age <= 60) multiplier *= 0.95;
    else if (age >= 20 && age < 40) multiplier *= 0.97;
    else multiplier *= 0.99;

    // ZIP code factor
    if (state.zip_code === '90210') multiplier *= 1.08;
    else multiplier *= 1.09;

    // Driving experience
    if (state.driving_experience_years && state.driving_experience_years > 20) {
      multiplier *= 0.97;
    } else {
      multiplier *= 0.99;
    }

    // Violations
    if (state.violation_count === 0 || !state.violations_last_3_years) {
      multiplier *= 1.10;
    } else if (state.violation_count === 1) {
      multiplier *= 1.12;
    } else {
      multiplier *= 1.15;
    }

    // Mileage
    if (state.annual_mileage && state.annual_mileage < 10000) {
      multiplier *= 0.99;
    }

    // Calculate risk-adjusted base
    let riskAdjustedBase = Math.round(basePremium * multiplier);

    // Add optional coverages
    if (state.roadside_assistance) riskAdjustedBase += 8;
    if (state.rental_reimbursement) riskAdjustedBase += 12;

    // Calculate discounts
    const discounts: string[] = [];
    let totalDiscount = 0;

    // Good driver discount
    if (!state.violations_last_3_years && !state.accidents_last_3_years) {
      totalDiscount += 39;
      discounts.push('Good driver discount: $39');
    } else if (state.violation_count === 1) {
      totalDiscount += 29;
      discounts.push('Good driver discount: $29');
    } else if (state.violation_count === 2) {
      totalDiscount += 19;
      discounts.push('Good driver discount: $19');
    }

    // Safety features discount
    if (state.anti_theft_device) {
      totalDiscount += 7;
      discounts.push('Safety features discount: $7');
    }

    // Low mileage discount
    if (state.annual_mileage && state.annual_mileage < 7500) {
      totalDiscount += 5;
      discounts.push('Low mileage discount: $5');
    }

    // Defensive driving discount
    if (state.defensive_driving_course) {
      totalDiscount += 2;
      discounts.push('Defensive driving discount: $2');
    }

    // Good student discount
    if (state.good_student_eligible) {
      totalDiscount += 3;
      discounts.push('Good student discount: $3');
    }

    // AAA membership discount
    if (state.aaa_member) {
      totalDiscount += 5;
      discounts.push('AAA membership discount: $5');
    }

    // Calculate final auto premium
    const finalAutoPremium = Math.max(riskAdjustedBase - totalDiscount, 50);

    // Calculate home insurance if bundle interested
    let homeStandalone = 0;
    let bundledAuto = finalAutoPremium;
    let bundledHome = 0;

    if (state.bundle_interested && state.home_value) {
      // Home insurance calculation
      const baseDwelling = Math.round(state.home_value * 0.00024); // 0.024% monthly
      homeStandalone = baseDwelling + 37; // Add other costs

      // Apply 15% bundle discount
      bundledAuto = Math.round(finalAutoPremium * 0.85);
      bundledHome = Math.round(homeStandalone * 0.85);

      // Additional home safety discount
      if (state.home_security_system) {
        bundledHome -= 4;
        discounts.push('Home safety discount: $4');
      }
    }

    stateManager.updateState({
      quote_amount: finalAutoPremium,
      bundled_auto_quote: bundledAuto,
      bundled_home_quote: bundledHome,
      discounts_applied: discounts,
      total_discount_amount: totalDiscount,
    });

    return {
      success: true,
      auto_premium_standalone: finalAutoPremium,
      home_premium_standalone: homeStandalone,
      bundled_auto_premium: bundledAuto,
      bundled_home_premium: bundledHome,
      bundled_total: bundledAuto + bundledHome,
      standalone_total: finalAutoPremium + homeStandalone,
      monthly_savings: (finalAutoPremium + homeStandalone) - (bundledAuto + bundledHome),
      discounts_applied: discounts,
      total_discount_amount: totalDiscount,
    };
  },
});

const calculateInsuranceQuoteTool = tool({
  name: 'calculateInsuranceQuote',
  description: 'Comprehensive insurance quote calculator using actual calculation logic. Calculates auto insurance premium, optionally with home insurance bundle. Returns detailed breakdown with all discounts applied.',
  parameters: z.object({
    vehicle_year: z.string().describe('Vehicle year'),
    vehicle_make: z.string().describe('Vehicle make'),
    vehicle_model: z.string().describe('Vehicle model'),
    vehicle_trim: z.string().describe('Vehicle trim'),
    estimated_vehicle_value: z.number().describe('Estimated vehicle value in dollars'),

    driver_age: z.number().describe('Driver age in years'),
    zip_code: z.string().describe('ZIP code'),
    driving_experience_years: z.number().describe('Years of driving experience'),
    violation_count: z.number().describe('Number of violations in last 3 years'),
    accident_count: z.number().describe('Number of accidents in last 3 years'),
    annual_mileage: z.number().describe('Annual mileage'),

    liability_level: z.enum(['15/30/5', '25/50/25', '50/100/50', '100/300/100', '250/500/100']).describe('Liability coverage level'),
    deductible: z.enum(['500', '1000', '2000']).describe('Deductible amount'),
    comprehensive: z.boolean().describe('Include comprehensive coverage'),
    collision: z.boolean().describe('Include collision coverage'),
    roadside_assistance: z.boolean().describe('Include roadside assistance'),
    rental_reimbursement: z.boolean().describe('Include rental reimbursement'),

    anti_theft_device: z.boolean().describe('Has anti-theft device'),
    defensive_driving_course: z.boolean().describe('Completed defensive driving course'),
    good_student_eligible: z.boolean().describe('Eligible for good student discount'),
    aaa_member: z.boolean().describe('AAA member'),
    clean_driving_record: z.boolean().describe('Has clean driving record (for good driver discount)'),

    include_home_bundle: z.boolean().optional().nullable().describe('Whether to calculate home insurance bundle'),
    home_value: z.number().optional().nullable().describe('Home value (required if include_home_bundle is true)'),
    home_year_built: z.number().optional().nullable().describe('Year home was built'),
    home_square_footage: z.number().optional().nullable().describe('Home square footage'),
    home_has_security_system: z.boolean().optional().nullable().describe('Home has security system'),
    home_has_mortgage: z.boolean().optional().nullable().describe('Home has mortgage'),
    home_roof_age: z.number().optional().nullable().describe('Age of roof in years'),
  }),
  execute: async (params: any) => {
    const vehicle: VehicleInfo = {
      year: params.vehicle_year,
      make: params.vehicle_make,
      model: params.vehicle_model,
      trim: params.vehicle_trim,
      estimated_value: params.estimated_vehicle_value,
    };

    const driver: DriverProfile = {
      age: params.driver_age,
      zip_code: params.zip_code,
      driving_experience_years: params.driving_experience_years,
      violation_count: params.violation_count,
      accident_count: params.accident_count,
      annual_mileage: params.annual_mileage,
    };

    const coverage: CoverageSelections = {
      liability_level: params.liability_level,
      deductible: parseInt(params.deductible) as 500 | 1000 | 2000,
      comprehensive: params.comprehensive,
      collision: params.collision,
      roadside_assistance: params.roadside_assistance,
      rental_reimbursement: params.rental_reimbursement,
    };

    const discounts: DiscountFlags = {
      anti_theft_device: params.anti_theft_device,
      defensive_driving_course: params.defensive_driving_course,
      good_student_eligible: params.good_student_eligible,
      aaa_member: params.aaa_member,
      low_mileage: params.annual_mileage < 7500,
      clean_driving_record: params.clean_driving_record,
      violation_count: params.violation_count,
    };

    let result;

    if (params.include_home_bundle && params.home_value) {
      const home: HomeInfo = {
        home_value: params.home_value,
        year_built: params.home_year_built || 2000,
        square_footage: params.home_square_footage || 2000,
        has_security_system: params.home_has_security_system || false,
        has_mortgage: params.home_has_mortgage || false,
        roof_age: params.home_roof_age || 10,
      };

      result = calculateBundledQuote(vehicle, driver, coverage, discounts, home);

      stateManager.updateState({
        quote_amount: result.auto_premium,
        bundled_auto_quote: result.bundled_auto_premium,
        bundled_home_quote: result.bundled_home_premium,
        discounts_applied: result.discounts_applied.map(d => `${d.name}: $${d.amount}`),
        total_discount_amount: result.total_discount_amount,
      });
    } else {
      result = calculateAutoInsurancePremium(vehicle, driver, coverage, discounts);

      stateManager.updateState({
        quote_amount: result.auto_premium,
        discounts_applied: result.discounts_applied.map(d => `${d.name}: $${d.amount}`),
        total_discount_amount: result.total_discount_amount,
      });
    }

    return {
      success: true,
      calculation_method: 'advanced_actuarial',
      ...result,
    };
  },
});

const sendEmailTool = tool({
  name: 'sendEmail',
  description: 'Sends an email to the user (payment link or policy documents).',
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
    // 👇 Build dynamic message template
    const message = `Thank you for applying for Through SU Insurance.
Here are the details:

${body}`;

    // 👇 Call API
    return await callToolAPI("email_tools", "send_email", {
      to_email,
      subject,
      body,
      message,
    });
  },
});



const confirmPaymentTool = tool({
  name: 'confirmPayment',
  description: 'Confirms that the user has completed the payment.',
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

const generatePolicyTool = tool({
  name: 'generatePolicy',
  description: 'Generates a policy ID and document link for the completed application.',
  parameters: z.object({}),
  execute: async () => {
    const policy_id = `SU-AUTO-${Date.now().toString().slice(-8)}`;
    const random_code = Math.random().toString(36).substring(2, 11).toUpperCase();
    const policy_link = `suinsurance.com/policy/${random_code}`;

    stateManager.updateState({
      policy_id,
      policy_link,
      application_status: 'completed',
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
  description: 'Searches the auto insurance knowledge base for answers to customer questions. Returns relevant information.',
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
  description: 'Creates a Zendesk ticket with all collected application information. Call at completion, abandonment, or transfer to underwriting.',
  parameters: z.object({
    subject: z.string().describe('Ticket subject line including customer name and status'),
    application_status: z.enum(['Completed', 'Abandoned', 'Transfer to Underwriting', 'In Progress']).describe('Overall application status'),
  }),
  execute: async ({ subject, application_status }: { subject: string; application_status: string }) => {
    const state = stateManager.getState();

    // Generate ticket ID
    const ticket_id = Math.floor(10000000 + Math.random() * 90000000).toString();

    try {
      return await callToolAPI('createZendeskTicket', {
        subject,
        application_status,
        customer_data: state,
        ticket_id,
      });
    } catch {
      // Fallback for demo
      return {
        success: true,
        ticket_id,
        message: `Zendesk ticket created: ${subject}`,
        status: application_status,
      };
    }
  },
});

// ============================================================================
// CREATE AGENT
// ============================================================================

export const aaaInsuranceAgent = new RealtimeAgent({
  name: 'AAA Auto Insurance Agent',
  voice: 'alloy', // Using alloy voice for American English
  instructions: AAA_INSURANCE_INSTRUCTIONS_V2, // Using new dynamic instructions
  tools: [
    lookupVINTool,
    lookupZipCodeTool,
    sendGeneralOTPTool,
    verifyGeneralOTPTool,
    calculateQuoteTool, // Keep legacy tool for backward compatibility
    calculateInsuranceQuoteTool, // New comprehensive calculation tool
    sendEmailTool,
    confirmPaymentTool,
    generatePolicyTool,
    updateStateTool,
    getStateTool,
    ragSearchTool,
    createZendeskTicketTool,
  ],
  handoffs: [],
});

export const aaaInsuranceCompanyName = 'SU Insurance (AAA Affiliated)';

const aaaAgents = [aaaInsuranceAgent];

export default aaaAgents;
