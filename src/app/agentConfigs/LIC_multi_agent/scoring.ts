// ============================================================================
// LEAD SCORING — EXTRACTED FOR TESTABILITY
// ============================================================================

export interface LeadScoringInput {
  // Phase 2: Intent Discovery
  property_stage?: string;
  property_type?: string;
  property_cost_lakhs?: number;
  loan_amount_lakhs?: number;
  loan_timeline_months?: number;

  // Phase 3: Eligibility Probing
  employment_type?: string;
  employment_tenure_years?: number;
  monthly_income_range?: string;
  pan_number?: string;
  existing_emi_amount?: number;
  co_applicant?: boolean;
  co_applicant_relation?: string;
  co_applicant_employment?: string;
  decision_authority?: string;

  // Phase 4: Preference & Competition
  lichfl_preference?: string;
  competing_lenders?: string[];
}

export interface ParameterScore {
  score: number;
  evidence: string;
}

export interface LeadScoreResult {
  p1: ParameterScore;
  p2: ParameterScore;
  p3: ParameterScore;
  p4: ParameterScore;
  p5: ParameterScore;
  p1_weighted: number;
  p2_weighted: number;
  p3_weighted: number;
  p4_weighted: number;
  p5_weighted: number;
  total_score: number;
  lead_category: 'HOT' | 'WARM' | 'COLD';
  routing: string;
  sla: string;
  scoring_evidence: string[];
}

// ── P1: Purchase Intent & Timeline (30%) ────────────────────────────────────

export function scoreP1_Intent(state: LeadScoringInput): ParameterScore {
  const stage = (state.property_stage || '').toLowerCase();
  const timeline = state.loan_timeline_months;

  if (stage.includes('shortlist') || stage.includes('selected') || stage.includes('finalized')) {
    if (timeline != null && timeline <= 3) return { score: 4, evidence: 'Property shortlisted, loan needed within 3 months' };
    if (timeline != null && timeline <= 6) return { score: 3, evidence: 'Property shortlisted, timeline 3-6 months' };
    return { score: 3, evidence: 'Property shortlisted, timeline not confirmed' };
  }
  if (stage.includes('search') || stage.includes('looking') || stage.includes('exploring')) {
    if (timeline != null && timeline <= 6) return { score: 3, evidence: 'Searching but near-term timeline' };
    if (timeline != null && timeline <= 12) return { score: 2, evidence: 'Exploring, 6-12 month timeline' };
    return { score: 2, evidence: 'Actively searching' };
  }
  if (stage.includes('brows') || stage.includes('just looking')) {
    return { score: 1, evidence: 'Browsing only, no commitment' };
  }
  if (timeline != null) {
    if (timeline <= 3) return { score: 4, evidence: `Loan needed within ${timeline} months` };
    if (timeline <= 6) return { score: 3, evidence: `Loan needed within ${timeline} months` };
    if (timeline <= 12) return { score: 2, evidence: `Loan needed within ${timeline} months` };
    return { score: 1, evidence: `Long timeline: ${timeline} months` };
  }
  return { score: 1, evidence: 'No intent or timeline data collected' };
}

// ── P2: Loan Eligibility Signals (25%) ──────────────────────────────────────

export function scoreP2_Eligibility(state: LeadScoringInput): ParameterScore {
  const emp = (state.employment_type || '').toLowerCase();
  const hasPAN = !!state.pan_number;
  const hasIncome = !!state.monthly_income_range;
  const emi = state.existing_emi_amount || 0;
  const tenure = state.employment_tenure_years || 0;
  const hasCoApplicant = state.co_applicant === true;

  if (emp.includes('salaried') || emp.includes('salary')) {
    let score = 3;
    const parts: string[] = ['Salaried'];
    if (tenure >= 3) { parts.push(`${tenure}yr tenure`); }
    if (hasPAN) { parts.push('PAN provided'); }
    if (hasIncome) { parts.push(`income: ${state.monthly_income_range}`); }
    if (hasCoApplicant) { parts.push('co-applicant available'); }
    if (hasPAN && tenure >= 2 && emi < 50000) { score = 4; }
    return { score, evidence: parts.join(', ') };
  }
  if (emp.includes('self') || emp.includes('business') || emp.includes('freelance')) {
    if (hasPAN && hasIncome) return { score: 3, evidence: 'Self-employed with income proof and PAN' };
    if (hasPAN || hasIncome) return { score: 2, evidence: 'Self-employed, partial documentation' };
    return { score: 2, evidence: 'Self-employed, limited documentation' };
  }
  if (emp) {
    return { score: 2, evidence: `Employment: ${emp}, irregular profile` };
  }
  return { score: 1, evidence: 'Employment/income data not collected' };
}

// ── P3: Loan Amount & Property Value (20%) ──────────────────────────────────

export function scoreP3_LoanAmount(state: LeadScoringInput): ParameterScore {
  const loan = state.loan_amount_lakhs;
  const propCost = state.property_cost_lakhs;
  const propType = state.property_type;
  const amount = loan || propCost;

  if (amount != null) {
    const hasType = !!propType;
    if (amount >= 30 && amount <= 200) {
      return { score: 4, evidence: `₹${amount}L ${hasType ? propType : ''} — within sweet spot (30L-2Cr)`.trim() };
    }
    return { score: 3, evidence: `₹${amount}L ${hasType ? propType : ''} — outside typical range but clear`.trim() };
  }
  if (propType) {
    return { score: 2, evidence: `Property type: ${propType}, but amount unclear` };
  }
  return { score: 1, evidence: 'No loan amount or property value data' };
}

// ── P4: Decision-Making Authority (15%) ─────────────────────────────────────

export function scoreP4_Decision(state: LeadScoringInput): ParameterScore {
  const decision = (state.decision_authority || '').toLowerCase();
  const coApplicant = (state.co_applicant_relation || '').toLowerCase();

  if (decision.includes('self') || decision.includes('primary') || decision.includes('alone') || decision.includes('akele')) {
    return { score: 4, evidence: 'Primary decision maker' };
  }
  if (decision.includes('spouse') || decision.includes('wife') || decision.includes('husband') ||
      coApplicant.includes('spouse') || coApplicant.includes('wife') || coApplicant.includes('husband')) {
    return { score: 3, evidence: 'Joint decision with spouse' };
  }
  if (decision.includes('family') || decision.includes('parent') || decision.includes('father') || decision.includes('mother')) {
    return { score: 2, evidence: 'Family approval needed' };
  }
  if (decision.includes('not') || decision.includes('someone else')) {
    return { score: 1, evidence: 'Not the decision maker' };
  }
  if (state.co_applicant && coApplicant.includes('spouse')) {
    return { score: 3, evidence: 'Joint with spouse (inferred from co-applicant)' };
  }
  if (state.employment_type) {
    return { score: 3, evidence: 'Decision authority not explicitly discussed, assumed primary/joint' };
  }
  return { score: 2, evidence: 'Decision authority unknown' };
}

// ── P5: LICHFL Preference (10%) ─────────────────────────────────────────────

export function scoreP5_Preference(state: LeadScoringInput): ParameterScore {
  const pref = (state.lichfl_preference || '').toLowerCase();
  const competitors = state.competing_lenders || [];

  if (pref.includes('finalized') || pref.includes('already') || pref.includes('done')) {
    return { score: 1, evidence: 'Already finalized with another lender' };
  }
  if (pref.includes('first') || pref.includes('only') || pref.includes('lichfl') || pref.includes('lic only')) {
    return { score: 4, evidence: 'LICHFL is first preference' };
  }
  if (pref.includes('comparing') || pref.includes('compare') || competitors.length > 0) {
    if (competitors.length <= 3) return { score: 3, evidence: `Comparing ${competitors.length + 1} lenders including LICHFL` };
    return { score: 2, evidence: `Comparing many lenders: ${competitors.join(', ')}` };
  }
  if (pref.includes('other') || pref.includes('psu') || pref.includes('nbfc')) {
    return { score: 2, evidence: 'Primarily considering other lenders' };
  }
  return { score: 3, evidence: 'Registered on LICHFL website, preference not explicitly discussed' };
}

// ── COMPOSITE SCORER ────────────────────────────────────────────────────────

export function calculateLeadScore(state: LeadScoringInput): LeadScoreResult {
  const p1 = scoreP1_Intent(state);
  const p2 = scoreP2_Eligibility(state);
  const p3 = scoreP3_LoanAmount(state);
  const p4 = scoreP4_Decision(state);
  const p5 = scoreP5_Preference(state);

  const p1_weighted = p1.score * 7.5;
  const p2_weighted = p2.score * 6.25;
  const p3_weighted = p3.score * 5;
  const p4_weighted = p4.score * 3.75;
  const p5_weighted = p5.score * 2.5;

  const total_score = Math.round((p1_weighted + p2_weighted + p3_weighted + p4_weighted + p5_weighted) * 10) / 10;

  let lead_category: 'HOT' | 'WARM' | 'COLD';
  let routing: string;
  let sla: string;

  if (total_score >= 80) {
    lead_category = 'HOT';
    routing = 'FoS Agent - Immediate';
    sla = 'Callback within 15 minutes';
  } else if (total_score >= 55) {
    lead_category = 'WARM';
    routing = 'FoS Agent - Scheduled';
    sla = 'Callback within 2 hours';
  } else {
    lead_category = 'COLD';
    routing = 'Quality Audit Team';
    sla = 'Nurture drip, re-qualify in 30 days';
  }

  const scoring_evidence = [
    `P1 Intent (30%): ${p1.score}/4 → ${p1_weighted} pts — ${p1.evidence}`,
    `P2 Eligibility (25%): ${p2.score}/4 → ${p2_weighted} pts — ${p2.evidence}`,
    `P3 Loan Amount (20%): ${p3.score}/4 → ${p3_weighted} pts — ${p3.evidence}`,
    `P4 Decision (15%): ${p4.score}/4 → ${p4_weighted} pts — ${p4.evidence}`,
    `P5 Preference (10%): ${p5.score}/4 → ${p5_weighted} pts — ${p5.evidence}`,
  ];

  return {
    p1, p2, p3, p4, p5,
    p1_weighted, p2_weighted, p3_weighted, p4_weighted, p5_weighted,
    total_score,
    lead_category,
    routing,
    sla,
    scoring_evidence,
  };
}
