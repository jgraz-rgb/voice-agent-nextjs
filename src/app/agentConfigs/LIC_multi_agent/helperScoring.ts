
import OpenAI from 'openai';
import { calculateLeadScore as deterministicScore, LeadScoringInput, LeadScoreResult } from './scoring';

const SCORING_MODEL = 'gpt-4.1-mini';


const SCORING_SYSTEM_PROMPT = `You are a lead scoring engine for LIC Housing Finance Ltd (LICHFL).
You receive the collected qualification state from a voice agent call and score the lead on 5 parameters.

<sop name="lead_scoring" order="strict">

## Scoring Parameters

<tool name="scoreParameters" trigger="state received">

P1: Purchase Intent & Timeline (weight 30%)
  4 = Ready — property shortlisted, loan needed within 3 months
  3 = Shortlisted — property shortlisted, timeline 3-6 months
  2 = Exploring — actively searching, 6-12 month timeline
  1 = Browsing only — no commitment, no timeline

P2: Loan Eligibility Signals (weight 25%)
  4 = Salaried with stable employment, low liabilities, PAN provided
  3 = Self-employed with income proof, PAN provided
  2 = Irregular income or high liabilities (>50% of income)
  1 = Unclear employment or refuses to share information

P3: Loan Amount & Property Value (weight 20%)
  4 = Ticket size ₹30L-₹2Cr with clear property type
  3 = Ticket size outside ₹30L-₹2Cr range but amount is clear
  2 = Vague on amounts, property type known
  1 = No clarity on property or loan amount

P4: Decision-Making Authority (weight 15%)
  4 = Primary decision maker (self/alone)
  3 = Joint decision with spouse (common in India)
  2 = Family approval needed (parents/extended family)
  1 = Not the decision maker

P5: LICHFL Preference (weight 10%)
  4 = LICHFL is first preference
  3 = Comparing 2-3 lenders including LICHFL
  2 = Primarily considering PSU/NBFC competitors
  1 = Already finalized with another lender

</tool>

## Score Calculation

Total = (P1 × 7.5) + (P2 × 6.25) + (P3 × 5) + (P4 × 3.75) + (P5 × 2.5)
Maximum possible = 100

## Lead Categorization

<enum name="LeadCategory">
  HOT  = score 80-100 → FoS Agent Immediate, callback within 15 minutes
  WARM = score 55-79  → FoS Agent Scheduled, callback within 2 hours
  COLD = score 0-54   → Quality Audit Team, nurture drip, re-qualify in 30 days
</enum>

</sop>

## Rules

1. Score ONLY based on data explicitly present in the state. Never infer or assume.
2. If a field is null/missing, use the lowest reasonable score for that parameter.
3. Provide a brief evidence string for each parameter explaining your reasoning.
4. Return valid JSON matching the exact schema below.

## Output Schema

{
  "p1_score": <1-4>,
  "p1_evidence": "<brief reasoning>",
  "p2_score": <1-4>,
  "p2_evidence": "<brief reasoning>",
  "p3_score": <1-4>,
  "p3_evidence": "<brief reasoning>",
  "p4_score": <1-4>,
  "p4_evidence": "<brief reasoning>",
  "p5_score": <1-4>,
  "p5_evidence": "<brief reasoning>",
  "total_score": <0-100>,
  "lead_category": "HOT" | "WARM" | "COLD",
  "routing": "<routing destination>",
  "sla": "<SLA string>"
}`;

// ── Types ──────────────────────────────────────────────────────────────────

export interface HelperScoreResult {
  p1_score: number;
  p1_evidence: string;
  p2_score: number;
  p2_evidence: string;
  p3_score: number;
  p3_evidence: string;
  p4_score: number;
  p4_evidence: string;
  p5_score: number;
  p5_evidence: string;
  total_score: number;
  lead_category: 'HOT' | 'WARM' | 'COLD';
  routing: string;
  sla: string;
  scoring_evidence: string[];
  scored_by: 'helper_llm' | 'deterministic_fallback';
}

// ── Helper LLM scoring call ────────────────────────────────────────────────

export async function scoreLeadWithHelper(state: Record<string, any>): Promise<HelperScoreResult> {
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const response = await openai.chat.completions.create({
      model: SCORING_MODEL,
      temperature: 0,
      messages: [
        { role: 'system', content: SCORING_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Score this lead based on the collected qualification state:\n\n${JSON.stringify(state, null, 2)}`,
        },
      ],
      response_format: { type: 'json_object' },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error('Empty response from scoring model');

    const parsed = JSON.parse(content);

    // Validate and clamp scores
    const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
    const p1 = clamp(parsed.p1_score, 1, 4);
    const p2 = clamp(parsed.p2_score, 1, 4);
    const p3 = clamp(parsed.p3_score, 1, 4);
    const p4 = clamp(parsed.p4_score, 1, 4);
    const p5 = clamp(parsed.p5_score, 1, 4);

    const total = Math.round((p1 * 7.5 + p2 * 6.25 + p3 * 5 + p4 * 3.75 + p5 * 2.5) * 10) / 10;

    let lead_category: 'HOT' | 'WARM' | 'COLD';
    let routing: string;
    let sla: string;

    if (total >= 80) {
      lead_category = 'HOT';
      routing = 'FoS Agent - Immediate';
      sla = 'Callback within 15 minutes';
    } else if (total >= 55) {
      lead_category = 'WARM';
      routing = 'FoS Agent - Scheduled';
      sla = 'Callback within 2 hours';
    } else {
      lead_category = 'COLD';
      routing = 'Quality Audit Team';
      sla = 'Nurture drip, re-qualify in 30 days';
    }

    const scoring_evidence = [
      `P1 Intent (30%): ${p1}/4 → ${p1 * 7.5} pts — ${parsed.p1_evidence || ''}`,
      `P2 Eligibility (25%): ${p2}/4 → ${p2 * 6.25} pts — ${parsed.p2_evidence || ''}`,
      `P3 Loan Amount (20%): ${p3}/4 → ${p3 * 5} pts — ${parsed.p3_evidence || ''}`,
      `P4 Decision (15%): ${p4}/4 → ${p4 * 3.75} pts — ${parsed.p4_evidence || ''}`,
      `P5 Preference (10%): ${p5}/4 → ${p5 * 2.5} pts — ${parsed.p5_evidence || ''}`,
    ];

    return {
      p1_score: p1,
      p1_evidence: parsed.p1_evidence || '',
      p2_score: p2,
      p2_evidence: parsed.p2_evidence || '',
      p3_score: p3,
      p3_evidence: parsed.p3_evidence || '',
      p4_score: p4,
      p4_evidence: parsed.p4_evidence || '',
      p5_score: p5,
      p5_evidence: parsed.p5_evidence || '',
      total_score: total,
      lead_category,
      routing,
      sla,
      scoring_evidence,
      scored_by: 'helper_llm',
    };
  } catch (error) {
    console.error('Helper LLM scoring failed, falling back to deterministic scorer:', error);
    return fallbackToDeterministic(state);
  }
}

// ── Deterministic fallback ─────────────────────────────────────────────────

function fallbackToDeterministic(state: Record<string, any>): HelperScoreResult {
  const input: LeadScoringInput = {
    property_stage: state.property_stage,
    property_type: state.property_type,
    property_cost_lakhs: state.property_cost_lakhs,
    loan_amount_lakhs: state.loan_amount_lakhs,
    loan_timeline_months: state.loan_timeline_months,
    employment_type: state.employment_type,
    employment_tenure_years: state.employment_tenure_years,
    monthly_income_range: state.monthly_income_range,
    pan_number: state.pan_number,
    existing_emi_amount: state.existing_emi_amount,
    co_applicant: state.co_applicant,
    co_applicant_relation: state.co_applicant_relation,
    co_applicant_employment: state.co_applicant_employment,
    decision_authority: state.decision_authority,
    lichfl_preference: state.lichfl_preference,
    competing_lenders: state.competing_lenders,
  };

  const result: LeadScoreResult = deterministicScore(input);

  return {
    p1_score: result.p1.score,
    p1_evidence: result.p1.evidence,
    p2_score: result.p2.score,
    p2_evidence: result.p2.evidence,
    p3_score: result.p3.score,
    p3_evidence: result.p3.evidence,
    p4_score: result.p4.score,
    p4_evidence: result.p4.evidence,
    p5_score: result.p5.score,
    p5_evidence: result.p5.evidence,
    total_score: result.total_score,
    lead_category: result.lead_category,
    routing: result.routing,
    sla: result.sla,
    scoring_evidence: result.scoring_evidence,
    scored_by: 'deterministic_fallback',
  };
}
