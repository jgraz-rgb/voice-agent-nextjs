/**
 * LIC Housing Lead Qualification — End-to-End Test Harness
 *
 * Simulates the full conversation flow (Phase 1→6) for three lead profiles:
 *   1. HOT  — Rajesh Sharma  (PRD reference, expected 93.8)
 *   2. WARM — Anita Desai    (exploring, self-employed, family decision)
 *   3. COLD — Vikram Patel   (browsing, unclear income, finalized elsewhere)
 *
 * Each scenario walks through every tool call the voice agent would make,
 * in the same order, and asserts the final score + category.
 *
 * Run:  npx tsx tests/lic_housing_test_harness.ts
 */

import { calculateLeadScore, type LeadScoringInput } from '../src/app/agentConfigs/LIC_housing/scoring';

// ── Helpers ─────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${msg}`);
    failed++;
  }
}

function header(text: string) {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${text}`);
  console.log('═'.repeat(70));
}

function phaseLog(phase: number, name: string) {
  console.log(`\n  ── Phase ${phase}: ${name} ──`);
}

// Simulates the StateManager + updateLeadState tool
function createStateSim() {
  let state: Record<string, any> = {};

  return {
    update(field: string, value: any) {
      state[field] = value;
      return { success: true, message: `Updated ${field}` };
    },
    updateBatch(fields: Record<string, any>) {
      Object.assign(state, fields);
    },
    get() { return { ...state }; },
    // Simulates validatePAN tool
    validatePAN(pan: string) {
      const normalized = pan.toUpperCase().replace(/\s/g, '');
      const valid = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(normalized);
      if (valid) state.pan_number = normalized;
      return { success: true, valid, formatted_pan: normalized };
    },
    // Simulates calculateLeadScore tool (reads from state)
    score() {
      return calculateLeadScore(state as LeadScoringInput);
    },
    // Simulates syncToLeadSquared tool
    sync(category: string, disposition: string) {
      state.lead_category = category;
      state.call_status = disposition;
      state.call_end_time = new Date().toISOString();
      return { success: true, leadsquared_activity_id: `LSQ_${Date.now()}` };
    },
    // Simulates createZendeskTicket tool
    ticket(subject: string, category: string) {
      return { success: true, ticket_id: `ZD-LIC-${Date.now().toString().slice(-8)}`, subject };
    },
  };
}

// ── SCENARIO 1: HOT LEAD — Rajesh Sharma (PRD reference) ───────────────────

function testHotLead() {
  header('SCENARIO 1: HOT LEAD — Rajesh Sharma (Pune, Wakad)');
  console.log('  PRD reference example. Expected: 93.8 / HOT');

  const sim = createStateSim();

  // Phase 0: Pre-call (auto — webhook from LeadSquared)
  phaseLog(0, 'Pre-call');
  sim.updateBatch({
    lead_id: 'LSQ-001',
    first_name: 'Rajesh',
    last_name: 'Sharma',
    phone_number: '+91-8197163924',
    property_location: 'Pune',
    preferred_area_office: 'Wakad',
    call_start_time: new Date().toISOString(),
  });
  console.log('    → Lead data loaded from LeadSquared');

  // Phase 1: Introduction
  phaseLog(1, 'Introduction');
  // Agent: "Namaste! Kya main Rajesh Sharma ji se baat kar sakta hoon?"
  // Lead: "Haan, main hi hoon."
  // Agent: "Main Priya hoon, LIC Housing Finance ki taraf se..."
  // Lead: "Haan, theek hai. Boliye."
  sim.update('language_preference', 'Hindi');
  sim.update('current_phase', 1);
  console.log('    → Lead confirmed identity, consented to continue');

  // Phase 2: Intent Discovery
  phaseLog(2, 'Intent Discovery');
  // Agent: "Aap Pune mein property dekh rahe hain..."
  // Lead: "Wakad mein ek 2BHK flat dekha hai. Builder ka under construction project hai. Price around 85 lakh. Requirement 65-70 lakh."
  sim.update('property_stage', 'shortlisted');
  sim.update('property_type', '2BHK');
  sim.update('property_location_detail', 'Wakad, Pune');
  sim.update('property_cost_lakhs', 85);
  sim.update('loan_amount_lakhs', 67.5);
  console.log('    → Property: 2BHK Wakad, ₹85L, loan ₹67.5L');

  // Agent: "Loan ki zaroorat roughly kitne mahine mein hogi?"
  // Lead: "Agreement 2-3 mahine mein hoga toh tab loan chahiye."
  sim.update('loan_timeline_months', 3);
  console.log('    → Timeline: 3 months');

  // Agent: "Aapke property ka RERA registration ho gaya hai?"
  // Lead: "Mera wala RERA registered hai."
  sim.update('rera_registered', true);
  sim.update('current_phase', 2);
  console.log('    → RERA: registered');

  // Phase 3: Eligibility Probing
  phaseLog(3, 'Eligibility Probing');
  // Lead: "Main salaried hoon. IT company mein hoon Hinjewadi mein. 10 saal se same company."
  sim.update('employment_type', 'salaried');
  sim.update('employer_detail', 'IT company, Hinjewadi');
  sim.update('employment_tenure_years', 10);
  console.log('    → Salaried, IT, 10yr tenure');

  // Lead: "Around 1.2 lakh take-home hai"
  sim.update('monthly_income_range', '1.2 lakh');
  console.log('    → Income: 1.2L/month');

  // Lead: "Sure AAAPA1111A"
  const panResult = sim.validatePAN('AAAPA1111A');
  assert(panResult.valid, `PAN validation: ${panResult.formatted_pan} → valid=${panResult.valid}`);

  // Lead: "Ek car loan chal raha hai, 18,000 EMI."
  sim.update('existing_emi_amount', 18000);
  sim.update('existing_emi_details', 'Car loan ₹18,000 EMI');
  console.log('    → Existing EMI: ₹18K (car loan)');

  // Lead: "Haan, wife bhi working hai, school teacher hai. Jointly apply karenge."
  sim.update('co_applicant', true);
  sim.update('co_applicant_relation', 'wife');
  sim.update('co_applicant_employment', 'school teacher');
  sim.update('current_phase', 3);
  console.log('    → Co-applicant: wife (school teacher), joint application');

  // Phase 4: Preference & Competition
  phaseLog(4, 'Preference & Competition');
  // Lead: "HDFC aur SBI bhi dekh raha hoon. LIC ka naam familiar tha toh form bhara."
  sim.update('lichfl_preference', 'comparing');
  sim.update('competing_lenders', ['HDFC', 'SBI']);
  sim.update('current_phase', 4);
  console.log('    → Comparing: HDFC, SBI + LICHFL');

  // Phase 5: Soft Sell & Next Step
  phaseLog(5, 'Soft Sell & Next Step');
  // Agent pitches LICHFL USPs...
  // Lead: "Haan, 6 baje theek hai."
  sim.update('preferred_callback_time', '6:00 PM');
  sim.update('callback_date', '2026-04-13');
  sim.update('current_phase', 5);
  console.log('    → Callback: 6:00 PM today');

  // Phase 6: Close + Score + Sync
  phaseLog(6, 'Close → Score → Sync → Ticket');
  const scoreResult = sim.score();

  console.log(`\n    SCORING BREAKDOWN:`);
  for (const line of scoreResult.scoring_evidence) {
    console.log(`      ${line}`);
  }
  console.log(`\n    TOTAL: ${scoreResult.total_score} / 100`);
  console.log(`    CATEGORY: ${scoreResult.lead_category}`);
  console.log(`    ROUTING: ${scoreResult.routing}`);
  console.log(`    SLA: ${scoreResult.sla}`);

  // Assertions
  assert(scoreResult.p1.score === 4, `P1 Intent = ${scoreResult.p1.score} (expected 4)`);
  assert(scoreResult.p2.score === 4, `P2 Eligibility = ${scoreResult.p2.score} (expected 4)`);
  assert(scoreResult.p3.score === 4, `P3 Loan Amount = ${scoreResult.p3.score} (expected 4)`);
  assert(scoreResult.p4.score === 3, `P4 Decision = ${scoreResult.p4.score} (expected 3)`);
  assert(scoreResult.p5.score === 3, `P5 Preference = ${scoreResult.p5.score} (expected 3)`);
  assert(scoreResult.total_score === 93.8, `Total score = ${scoreResult.total_score} (expected 93.8)`);
  assert(scoreResult.lead_category === 'HOT', `Category = ${scoreResult.lead_category} (expected HOT)`);

  // Sync + Ticket
  const syncResult = sim.sync('HOT', 'completed');
  assert(syncResult.success, `LeadSquared sync: ${syncResult.leadsquared_activity_id}`);

  const ticketResult = sim.ticket('Rajesh Sharma — HOT Lead — Pune Wakad', 'HOT');
  assert(ticketResult.success, `Zendesk ticket: ${ticketResult.ticket_id}`);
}

// ── SCENARIO 2: WARM LEAD — Anita Desai (Bangalore) ────────────────────────

function testWarmLead() {
  header('SCENARIO 2: WARM LEAD — Anita Desai (Bangalore, Whitefield)');
  console.log('  Self-employed, exploring, family decision. Expected: WARM (45-74)');

  const sim = createStateSim();

  // Phase 0: Pre-call
  phaseLog(0, 'Pre-call');
  sim.updateBatch({
    lead_id: 'LSQ-002',
    first_name: 'Anita',
    last_name: 'Desai',
    phone_number: '+91-9876543210',
    property_location: 'Bangalore',
    preferred_area_office: 'Whitefield',
    call_start_time: new Date().toISOString(),
  });

  // Phase 1: Introduction
  phaseLog(1, 'Introduction');
  sim.update('language_preference', 'Hindi');
  sim.update('current_phase', 1);
  console.log('    → Lead confirmed identity, consented');

  // Phase 2: Intent Discovery
  phaseLog(2, 'Intent Discovery');
  // Lead: "Abhi toh search chal raha hai, Whitefield area mein 3BHK dekh rahi hoon"
  sim.update('property_stage', 'searching');
  sim.update('property_type', '3BHK');
  sim.update('property_location_detail', 'Whitefield, Bangalore');
  console.log('    → Property: searching, 3BHK Whitefield');

  // Lead: "Maybe 8-10 months mein"
  sim.update('loan_timeline_months', 9);
  console.log('    → Timeline: ~9 months');

  // Lead: "RERA toh check nahi kiya abhi"
  sim.update('rera_registered', false);

  // Lead: "Budget 1.2 crore ke around hai, loan shayad 80 lakh chahiye"
  sim.update('property_cost_lakhs', 120);
  sim.update('loan_amount_lakhs', 80);
  sim.update('current_phase', 2);
  console.log('    → Property: ₹1.2Cr, loan ₹80L');

  // Phase 3: Eligibility Probing
  phaseLog(3, 'Eligibility Probing');
  // Lead: "Apna business hai, boutique interior design firm"
  sim.update('employment_type', 'self-employed');
  sim.update('employer_detail', 'Interior design firm');
  console.log('    → Self-employed, interior design');

  // Lead: "Roughly 2-2.5 lakh monthly hota hai"
  sim.update('monthly_income_range', '2-2.5 lakh');
  console.log('    → Income: 2-2.5L/month');

  // Lead: "Haan PAN hai — BTTPD4567K"
  const panResult = sim.validatePAN('BTTPD4567K');
  assert(panResult.valid, `PAN validation: ${panResult.formatted_pan} → valid=${panResult.valid}`);

  // Lead: "Credit card EMI hai, around 25,000"
  sim.update('existing_emi_amount', 25000);
  sim.update('existing_emi_details', 'Credit card EMI ₹25K');
  console.log('    → Existing EMI: ₹25K (credit card)');

  // Lead: "Nahi, akele hi apply karungi. Parents se discuss karungi final decision ke liye"
  sim.update('co_applicant', false);
  sim.update('decision_authority', 'family — parents se discuss');
  sim.update('current_phase', 3);
  console.log('    → No co-applicant, family decision');

  // Phase 4: Preference & Competition
  phaseLog(4, 'Preference & Competition');
  // Lead: "SBI aur HDFC bhi dekh rahi hoon"
  sim.update('lichfl_preference', 'comparing');
  sim.update('competing_lenders', ['SBI', 'HDFC']);
  sim.update('current_phase', 4);
  console.log('    → Comparing: SBI, HDFC + LICHFL');

  // Phase 5: Soft Sell & Next Step
  phaseLog(5, 'Soft Sell & Next Step');
  sim.update('preferred_callback_time', '11:00 AM');
  sim.update('callback_date', '2026-04-14');
  sim.update('current_phase', 5);
  console.log('    → Callback: 11 AM tomorrow');

  // Phase 6: Score
  phaseLog(6, 'Close → Score → Sync → Ticket');
  const scoreResult = sim.score();

  console.log(`\n    SCORING BREAKDOWN:`);
  for (const line of scoreResult.scoring_evidence) {
    console.log(`      ${line}`);
  }
  console.log(`\n    TOTAL: ${scoreResult.total_score} / 100`);
  console.log(`    CATEGORY: ${scoreResult.lead_category}`);
  console.log(`    ROUTING: ${scoreResult.routing}`);

  assert(scoreResult.p1.score === 2, `P1 Intent = ${scoreResult.p1.score} (expected 2 — searching, 9mo)`);
  assert(scoreResult.p2.score === 3, `P2 Eligibility = ${scoreResult.p2.score} (expected 3 — self-employed + PAN + income)`);
  assert(scoreResult.p3.score === 4, `P3 Loan Amount = ${scoreResult.p3.score} (expected 4 — ₹80L in sweet spot)`);
  assert(scoreResult.p4.score === 2, `P4 Decision = ${scoreResult.p4.score} (expected 2 — family approval)`);
  assert(scoreResult.p5.score === 3, `P5 Preference = ${scoreResult.p5.score} (expected 3 — comparing 3)`);
  assert(scoreResult.total_score >= 45 && scoreResult.total_score < 75,
    `Total ${scoreResult.total_score} is in WARM range (45-74)`);
  assert(scoreResult.lead_category === 'WARM', `Category = ${scoreResult.lead_category} (expected WARM)`);

  const syncResult = sim.sync('WARM', 'completed');
  assert(syncResult.success, `LeadSquared sync: ${syncResult.leadsquared_activity_id}`);

  const ticketResult = sim.ticket('Anita Desai — WARM Lead — Bangalore Whitefield', 'WARM');
  assert(ticketResult.success, `Zendesk ticket: ${ticketResult.ticket_id}`);
}

// ── SCENARIO 3: COLD LEAD — Vikram Patel (Delhi) ───────────────────────────

function testColdLead() {
  header('SCENARIO 3: COLD LEAD — Vikram Patel (Delhi)');
  console.log('  Browsing, unclear income, finalized elsewhere. Expected: COLD (<45)');

  const sim = createStateSim();

  // Phase 0: Pre-call
  phaseLog(0, 'Pre-call');
  sim.updateBatch({
    lead_id: 'LSQ-003',
    first_name: 'Vikram',
    last_name: 'Patel',
    phone_number: '+91-7654321098',
    property_location: 'Delhi',
    preferred_area_office: 'Dwarka',
    call_start_time: new Date().toISOString(),
  });

  // Phase 1: Introduction
  phaseLog(1, 'Introduction');
  sim.update('language_preference', 'Hindi');
  sim.update('current_phase', 1);
  console.log('    → Lead confirmed identity');

  // Phase 2: Intent Discovery
  phaseLog(2, 'Intent Discovery');
  // Lead: "Bas aise hi dekh raha tha website pe, abhi koi plan nahi hai"
  sim.update('property_stage', 'browsing');
  sim.update('property_type', '');
  sim.update('property_location_detail', 'Delhi');
  console.log('    → Browsing only, no specific property');

  // Lead: "Pata nahi, shayad 1-2 saal baad"
  sim.update('loan_timeline_months', 18);
  sim.update('current_phase', 2);
  console.log('    → Timeline: 18 months (vague)');

  // Phase 3: Eligibility Probing
  phaseLog(3, 'Eligibility Probing');
  // Lead: "Contract basis pe kaam karta hoon"
  sim.update('employment_type', 'contract');
  console.log('    → Contract employment (irregular)');

  // Lead: "Income vary karta hai... nahi batana chahta"
  // No income or PAN shared
  sim.update('current_phase', 3);
  console.log('    → No income range, no PAN shared');

  // Phase 4: Preference & Competition
  phaseLog(4, 'Preference & Competition');
  // Lead: "Already SBI se loan le liya hai ek property ke liye"
  sim.update('lichfl_preference', 'already finalized with SBI');
  sim.update('competing_lenders', ['SBI']);
  sim.update('current_phase', 4);
  console.log('    → Already finalized with SBI');

  // Phase 5: Soft Sell (abbreviated — lead not interested)
  phaseLog(5, 'Soft Sell (abbreviated)');
  // Lead: "Abhi nahi chahiye, baad mein dekhenge"
  console.log('    → Lead not interested in callback');

  // Phase 6: Score
  phaseLog(6, 'Close → Score → Sync → Ticket');
  const scoreResult = sim.score();

  console.log(`\n    SCORING BREAKDOWN:`);
  for (const line of scoreResult.scoring_evidence) {
    console.log(`      ${line}`);
  }
  console.log(`\n    TOTAL: ${scoreResult.total_score} / 100`);
  console.log(`    CATEGORY: ${scoreResult.lead_category}`);
  console.log(`    ROUTING: ${scoreResult.routing}`);

  assert(scoreResult.p1.score === 1, `P1 Intent = ${scoreResult.p1.score} (expected 1 — browsing)`);
  assert(scoreResult.p2.score === 2, `P2 Eligibility = ${scoreResult.p2.score} (expected 2 — contract, irregular)`);
  assert(scoreResult.p3.score === 1, `P3 Loan Amount = ${scoreResult.p3.score} (expected 1 — no data)`);
  assert(scoreResult.p4.score === 3, `P4 Decision = ${scoreResult.p4.score} (expected 3 — has employment, assumed primary/joint)`);
  assert(scoreResult.p5.score === 1, `P5 Preference = ${scoreResult.p5.score} (expected 1 — finalized elsewhere)`);
  assert(scoreResult.total_score < 50,
    `Total ${scoreResult.total_score} is low (COLD or low-WARM range)`);
  assert(scoreResult.lead_category === 'COLD' || scoreResult.lead_category === 'WARM',
    `Category = ${scoreResult.lead_category} (expected COLD or low-WARM)`);

  const syncResult = sim.sync(scoreResult.lead_category, 'not_interested');
  assert(syncResult.success, `LeadSquared sync: ${syncResult.leadsquared_activity_id}`);

  const ticketResult = sim.ticket('Vikram Patel — COLD Lead — Delhi Dwarka', 'COLD');
  assert(ticketResult.success, `Zendesk ticket: ${ticketResult.ticket_id}`);
}

// ── SCENARIO 4: EDGE CASE — Partial data (call dropped at Phase 2) ─────────

function testPartialData() {
  header('SCENARIO 4: EDGE CASE — Call dropped mid-conversation');
  console.log('  Only Phase 1-2 completed. Expected: scoring handles missing data gracefully');

  const sim = createStateSim();

  sim.updateBatch({
    lead_id: 'LSQ-004',
    first_name: 'Meera',
    last_name: 'Nair',
    phone_number: '+91-9988776655',
    property_location: 'Chennai',
    preferred_area_office: 'OMR',
  });

  // Only Phase 2 partial data
  sim.update('property_stage', 'shortlisted');
  sim.update('loan_timeline_months', 2);
  sim.update('property_cost_lakhs', 55);
  // Call dropped — no eligibility, no preference data

  phaseLog(6, 'Score with partial data');
  const scoreResult = sim.score();

  console.log(`\n    SCORING BREAKDOWN:`);
  for (const line of scoreResult.scoring_evidence) {
    console.log(`      ${line}`);
  }
  console.log(`\n    TOTAL: ${scoreResult.total_score} / 100`);
  console.log(`    CATEGORY: ${scoreResult.lead_category}`);

  assert(scoreResult.p1.score === 4, `P1 = ${scoreResult.p1.score} (shortlisted + 2mo → 4)`);
  assert(scoreResult.p2.score === 1, `P2 = ${scoreResult.p2.score} (no employment data → 1)`);
  assert(scoreResult.p3.score === 4, `P3 = ${scoreResult.p3.score} (₹55L in sweet spot → 4)`);
  assert(scoreResult.p4.score === 2, `P4 = ${scoreResult.p4.score} (unknown → 2)`);
  assert(scoreResult.p5.score === 3, `P5 = ${scoreResult.p5.score} (default — registered → 3)`);
  assert(typeof scoreResult.total_score === 'number', `Score is a number: ${scoreResult.total_score}`);
  assert(['HOT', 'WARM', 'COLD'].includes(scoreResult.lead_category),
    `Category is valid: ${scoreResult.lead_category}`);

  const syncResult = sim.sync(scoreResult.lead_category, 'dropped');
  assert(syncResult.success, `Sync as dropped: ${syncResult.leadsquared_activity_id}`);
}

// ── SCENARIO 5: EDGE CASE — PAN validation failures ────────────────────────

function testPANValidation() {
  header('SCENARIO 5: PAN Validation Edge Cases');

  const sim = createStateSim();

  const cases = [
    { input: 'AAAPA1111A', expected: true,  label: 'Valid PAN' },
    { input: 'aaapa1111a', expected: true,  label: 'Lowercase (should normalize)' },
    { input: 'BTTPD4567K', expected: true,  label: 'Another valid PAN' },
    { input: 'AAA1A1111A', expected: false, label: 'Digit in wrong position' },
    { input: 'AAAPA111',   expected: false, label: 'Too short' },
    { input: 'AAAPA11111A', expected: false, label: 'Too long' },
    { input: '1234567890', expected: false, label: 'All digits' },
    { input: '',           expected: false, label: 'Empty string' },
  ];

  for (const c of cases) {
    const result = sim.validatePAN(c.input);
    assert(result.valid === c.expected,
      `${c.label}: "${c.input}" → valid=${result.valid} (expected ${c.expected})`);
  }
}

// ── SCENARIO 6: Boundary — Score exactly at HOT/WARM/COLD thresholds ───────

function testBoundaryScores() {
  header('SCENARIO 6: Boundary Score Thresholds');

  // All 4s → 100 (HOT)
  let result = calculateLeadScore({
    property_stage: 'shortlisted', loan_timeline_months: 1,
    employment_type: 'salaried', employment_tenure_years: 5, pan_number: 'AAAPA1111A',
    monthly_income_range: '2L', existing_emi_amount: 0,
    loan_amount_lakhs: 80, property_type: '3BHK',
    decision_authority: 'self',
    lichfl_preference: 'first choice',
  });
  assert(result.total_score === 100, `All 4s → ${result.total_score} (expected 100)`);
  assert(result.lead_category === 'HOT', `Category: ${result.lead_category}`);

  // All 1s → 25 (COLD)
  result = calculateLeadScore({
    property_stage: 'browsing', loan_timeline_months: 24,
    lichfl_preference: 'already finalized',
  });
  assert(result.total_score <= 35, `All 1s (minimal input) → ${result.total_score} (expected ≤35, COLD)`);
  assert(result.lead_category === 'COLD', `Category: ${result.lead_category}`);

  // Right at WARM/COLD boundary (45)
  // P1=2(15) + P2=2(12.5) + P3=2(10) + P4=1(3.75) + P5=2(5) = 46.3 → WARM
  result = calculateLeadScore({
    property_stage: 'searching', loan_timeline_months: 10,
    employment_type: 'self-employed',
    property_type: '2BHK',
    decision_authority: 'someone else',
    lichfl_preference: 'psu banks',
  });
  console.log(`  Near WARM/COLD boundary: ${result.total_score} → ${result.lead_category}`);
  assert(result.total_score >= 25 && result.total_score <= 100, `Score in valid range: ${result.total_score}`);

  // Right at HOT/WARM boundary
  // P1=3(22.5) + P2=3(18.75) + P3=3(15) + P4=3(11.25) + P5=3(7.5) = 75 → HOT
  result = calculateLeadScore({
    property_stage: 'shortlisted', loan_timeline_months: 5,
    employment_type: 'self-employed', pan_number: 'ABCDE1234F', monthly_income_range: '1L',
    loan_amount_lakhs: 250, property_type: 'villa',
    lichfl_preference: 'comparing', competing_lenders: ['HDFC'],
  });
  console.log(`  At HOT/WARM boundary: ${result.total_score} → ${result.lead_category}`);
  assert(result.total_score === 75, `Score at boundary = ${result.total_score} (expected 75)`);
  assert(result.lead_category === 'HOT', `At 75 → ${result.lead_category} (expected HOT)`);
}

// ── RUN ALL ─────────────────────────────────────────────────────────────────

console.log('\n🏠 LIC Housing Finance — Lead Qualification Test Harness');
console.log('  Testing full end-to-end flow across 6 scenarios\n');

testHotLead();
testWarmLead();
testColdLead();
testPartialData();
testPANValidation();
testBoundaryScores();

// Summary
console.log(`\n${'═'.repeat(70)}`);
console.log(`  RESULTS: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log('═'.repeat(70));

if (failed > 0) {
  process.exit(1);
}
