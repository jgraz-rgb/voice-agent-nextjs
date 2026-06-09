import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';

// ── shared helpers ────────────────────────────────────────────────────────────

const DATA_DIR   = path.join(process.cwd(), 'data');
const STATE_PATH = path.join(DATA_DIR, 'session_state.json');

async function readState(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(STATE_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

async function writeState(data: Record<string, unknown>): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

async function patchState(partial: Record<string, unknown>): Promise<void> {
  const existing = await readState();
  await writeState({ ...existing, ...partial });
}

const TOOL_API_BASE = 'https://bfsi.searchunify.com/bfsi-api';
async function callToolAPI(endpoint: string, data: unknown): Promise<unknown> {
  const res = await fetch(`${TOOL_API_BASE}/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Tool API ${endpoint} → HTTP ${res.status}`);
  return res.json();
}

// ── RAG helpers (shared across agents) ───────────────────────────────────────

function extractText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(extractText).join(' ');
  if (typeof v === 'object') return Object.values(v as Record<string, unknown>).map(extractText).join(' ');
  return '';
}

function scoreText(text: string, terms: string[]): number {
  const t = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    let idx = t.indexOf(term);
    while (idx !== -1) { score += Math.max(1, term.length / 3); idx = t.indexOf(term, idx + term.length); }
  }
  return score;
}

function makeExcerpt(text: string, q: string, maxLen = 280): string {
  const t = text.trim();
  if (!t) return '';
  const i = t.toLowerCase().indexOf(q.toLowerCase());
  if (i === -1) return t.slice(0, maxLen);
  const start = Math.max(0, i - Math.floor(maxLen / 2));
  return t.slice(start, Math.min(t.length, start + maxLen));
}

// ── LIC tools ─────────────────────────────────────────────────────────────────

import licRag from '@/app/agentConfigs/LICSales/RAG.json';
import { calculateLeadScore } from '@/app/agentConfigs/LICSales/scoring';
import { scoreLeadWithHelper } from '@/app/agentConfigs/LICSales/helperScoring';
import {
  formatZendeskSubject,
  formatZendeskDescription,
  getZendeskGroupId,
} from '@/app/agentConfigs/LICSales/index';

const PINCODE_DB: Record<string, { city: string; state: string }> = {
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

async function licTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
  const state = await readState();

  if (toolName === 'getLeadState') {
    return state;
  }

  if (toolName === 'updateLeadState') {
    const { field_name, field_value } = args as { field_name: string; field_value: unknown };
    const ARRAY_FIELDS = ['competing_lenders', 'scoring_evidence', 'conversation_transcript'];
    let parsedValue: unknown = field_value;
    if (typeof field_value === 'string' && ARRAY_FIELDS.includes(field_name)) {
      try {
        const p = JSON.parse(field_value);
        if (Array.isArray(p)) parsedValue = p;
      } catch { parsedValue = [field_value]; }
    }
    await patchState({ [field_name]: parsedValue });
    return { success: true, message: `Updated ${field_name} successfully` };
  }

  if (toolName === 'validatePAN') {
    const { pan_number } = args as { pan_number: string };
    const normalized = pan_number.toUpperCase().replace(/\s/g, '');
    const isValid = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(normalized);
    if (isValid) await patchState({ pan_number: normalized });
    return {
      success: true,
      valid: isValid,
      formatted_pan: normalized,
      message: isValid ? 'PAN format is valid' : 'Invalid PAN format. PAN should be 5 letters, 4 digits, 1 letter (e.g., AAAPA1111A)',
    };
  }

  if (toolName === 'lookupPincode') {
    const { pincode } = args as { pincode: string };
    const data = PINCODE_DB[pincode] ?? { city: 'Unknown', state: 'Unknown' };
    return { success: true, pincode, ...data };
  }

  if (toolName === 'calculateLeadScore') {
    const presetCategory = state.lead_category as string | undefined;
    if (presetCategory === 'URGENT' || presetCategory === 'PENDING') {
      const evidence = presetCategory === 'URGENT'
        ? 'Lead escalated to human agent immediately — no qualification data collected'
        : 'Lead requested callback — no qualification data collected';
      await patchState({ p1_score: 0, p2_score: 0, p3_score: 0, p4_score: 0, p5_score: 0, total_score: 0, scoring_evidence: [`Score: 0 — ${evidence}`] });
      return { success: true, scored_by: 'skipped', total_score: 0, lead_category: presetCategory };
    }
    const result = await scoreLeadWithHelper(state as any);
    await patchState({
      p1_score: result.p1_score, p2_score: result.p2_score, p3_score: result.p3_score,
      p4_score: result.p4_score, p5_score: result.p5_score, total_score: result.total_score,
      lead_category: result.lead_category, scoring_evidence: result.scoring_evidence,
    });
    return { success: true, scored_by: result.scored_by, total_score: result.total_score, lead_category: result.lead_category };
  }

  if (toolName === 'syncToLeadSquared') {
    const { lead_category, call_disposition } = args as { lead_category: string; call_disposition: string };
    let currentState = await readState();
    if (currentState.total_score == null) {
      const scored = calculateLeadScore(currentState as any);
      await patchState({
        p1_score: scored.p1.score, p2_score: scored.p2.score, p3_score: scored.p3.score,
        p4_score: scored.p4.score, p5_score: scored.p5.score, total_score: scored.total_score,
        lead_category: scored.lead_category, scoring_evidence: scored.scoring_evidence,
      });
      currentState = await readState();
    }
    await patchState({ lead_category, call_status: call_disposition, call_end_time: new Date().toISOString() });
    currentState = await readState();
    try {
      return await callToolAPI('sync_lead', {
        lead_id: currentState.lead_id,
        lead_category,
        call_disposition,
        qualification_data: currentState,
      });
    } catch {
      return { success: true, leadsquared_activity_id: `LSQ_${Date.now()}`, message: `Lead synced as ${lead_category}` };
    }
  }

  if (toolName === 'createZendeskTicket') {
    if (state.zendesk_ticket_created) {
      return { success: true, skipped: true, message: 'Ticket already created for this session.' };
    }
    await patchState({ zendesk_ticket_created: true });
    let currentState = await readState();
    if (currentState.total_score == null) {
      const scored = calculateLeadScore(currentState as any);
      await patchState({
        p1_score: scored.p1.score, p2_score: scored.p2.score, p3_score: scored.p3.score,
        p4_score: scored.p4.score, p5_score: scored.p5.score, total_score: scored.total_score,
        lead_category: scored.lead_category, scoring_evidence: scored.scoring_evidence,
      });
      currentState = await readState();
    }
    const callDuration = currentState.call_start_time
      ? Math.round((Date.now() - new Date(currentState.call_start_time as string).getTime()) / 1000)
      : undefined;
    const subject     = formatZendeskSubject(currentState as any);
    const description = formatZendeskDescription(currentState as any, callDuration);
    const group_id    = getZendeskGroupId(currentState.lead_category as string | undefined);
    try {
      return await callToolAPI('tickets', { subject, description, group_id });
    } catch {
      return { success: true, ticket_id: `ZD-LIC-${Date.now().toString().slice(-8)}`, message: `Zendesk ticket created: ${subject}` };
    }
  }

  if (toolName === 'sendEmail') {
    const { to_email, subject, body } = args as { to_email: string; subject: string; body: string };
    const message = `Thank you for your interest in LIC Housing Finance.\n\n${body}\n\nFor any queries, call our toll-free helpline: 1800 209 1989\nVisit: www.lichousing.com`;
    try {
      return await callToolAPI('send_email', { to_email, subject, body, message });
    } catch {
      return { success: true, message: `Email sent to ${to_email}` };
    }
  }

  if (toolName === 'ragSearch') {
    const { query, top_k } = args as { query: string; top_k?: number | null };
    const k = top_k && top_k > 0 && top_k <= 10 ? top_k : 5;
    const data = licRag as any;
    const searchTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 1);
    const results: any[] = [];
    for (const article of (data.articles || [])) {
      const text = extractText({ title: article.title, content: article.content, keywords: article.keywords });
      const s = scoreText(text, searchTerms);
      if (s > 0) results.push({ type: 'article', title: String(article.title || ''), content: String(article.content || ''), score: s });
    }
    for (const faq of (data.faqs || [])) {
      const text = extractText({ question: faq.question, answer: faq.answer });
      const s = scoreText(text, searchTerms);
      if (s > 0) results.push({ type: 'faq', title: String(faq.question || ''), content: String(faq.answer || ''), score: s });
    }
    results.sort((a, b) => b.score - a.score);
    return { query, total_matches: results.length, results: results.slice(0, k) };
  }

  return { success: false, error: `Unknown LIC tool: ${toolName}` };
}

// ── AAA Insurance tools ───────────────────────────────────────────────────────

import aaaRag from '@/app/agentConfigs/AAA_agent/RAG.json';
import {
  calculateAutoInsurancePremium,
  calculateBundledQuote,
} from '@/app/agentConfigs/AAA_agent/calculations';

const VIN_DB: Record<string, { year: string; make: string; model: string; trim: string; value: number }> = {
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

const ZIP_DB: Record<string, { city: string; state: string }> = {
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

async function aaaTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
  const state = await readState();

  if (toolName === 'getApplicationState') {
    return state;
  }

  if (toolName === 'updateApplicationState') {
    const { field_name, field_value } = args as { field_name: string; field_value: unknown };
    await patchState({ [field_name]: field_value });
    return { success: true, message: `Updated ${field_name} successfully` };
  }

  if (toolName === 'lookupVIN') {
    const { vin_number } = args as { vin_number: string };
    const normalized = vin_number.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const vehicle = VIN_DB[normalized] ?? DEFAULT_VEHICLE;
    await patchState({ vin: normalized, vehicle_year: vehicle.year, vehicle_make: vehicle.make, vehicle_model: vehicle.model, vehicle_trim: vehicle.trim, estimated_vehicle_value: vehicle.value });
    return { success: true, vin: normalized, year: vehicle.year, make: vehicle.make, model: vehicle.model, trim: vehicle.trim, estimated_value: vehicle.value };
  }

  if (toolName === 'lookupZipCode') {
    const { zip_code } = args as { zip_code: string };
    const data = ZIP_DB[zip_code] ?? { city: 'Los Angeles', state: 'California' };
    await patchState({ zip_code, city: data.city, state: data.state });
    return { success: true, zip_code, city: data.city, state: data.state };
  }

  if (toolName === 'sendGeneralOTP') {
    const { phone_number } = args as { phone_number: string };
    try {
      return await callToolAPI('send_otp', { phone_number });
    } catch {
      return { success: true, otp_reference_id: `OTP_${Date.now()}`, message: 'OTP sent to mobile number' };
    }
  }

  if (toolName === 'verifyGeneralOTP') {
    const { otp_reference_id, otp_code } = args as { otp_reference_id: string; otp_code: string };
    try {
      const result = await callToolAPI('verify_otp', { otp_reference_id, otp_code }) as any;
      if (result.success) await patchState({ otp_verified: true });
      return result;
    } catch {
      const isValid = /^\d{6}$/.test(otp_code);
      if (isValid) { await patchState({ otp_verified: true }); return { success: true, message: 'OTP verified successfully' }; }
      return { success: false, message: 'Invalid OTP. Please try again.' };
    }
  }

  if (toolName === 'calculateQuote') {
    const s = state as any;
    let basePremium = 140;
    if (s.deductible === 1000) basePremium -= 7;
    else if (s.deductible === 2000) basePremium -= 14;
    let age = 40;
    if (s.date_of_birth) { const dob = new Date(s.date_of_birth); age = new Date().getFullYear() - dob.getFullYear(); }
    let multiplier = 1.0;
    if (age >= 40 && age <= 60) multiplier *= 0.95; else if (age >= 20 && age < 40) multiplier *= 0.97; else multiplier *= 0.99;
    multiplier *= s.zip_code === '90210' ? 1.08 : 1.09;
    multiplier *= (s.driving_experience_years && s.driving_experience_years > 20) ? 0.97 : 0.99;
    if (!s.violations_last_3_years || s.violation_count === 0) multiplier *= 1.10;
    else if (s.violation_count === 1) multiplier *= 1.12;
    else multiplier *= 1.15;
    if (s.annual_mileage && s.annual_mileage < 10000) multiplier *= 0.99;
    if (s.is_first_time_buyer) multiplier *= 1.10;
    let riskBase = Math.round(basePremium * multiplier);
    if (s.roadside_assistance) riskBase += 8;
    if (s.rental_reimbursement) riskBase += 12;
    if (s.uninsured_motorist_coverage) riskBase += 10;
    if (s.medical_payments_coverage) riskBase += 8;
    const discounts: string[] = [];
    let totalDiscount = 0;
    if (!s.violations_last_3_years && !s.accidents_last_3_years) { totalDiscount += 39; discounts.push('Good driver discount: $39'); }
    else if (s.violation_count === 1) { totalDiscount += 29; discounts.push('Good driver discount: $29'); }
    else if (s.violation_count === 2) { totalDiscount += 19; discounts.push('Good driver discount: $19'); }
    if (s.anti_theft_device) { totalDiscount += 7; discounts.push('Safety features discount: $7'); }
    if (s.annual_mileage && s.annual_mileage < 7500) { totalDiscount += 5; discounts.push('Low mileage discount: $5'); }
    if (s.defensive_driving_course) { totalDiscount += 2; discounts.push('Defensive driving discount: $2'); }
    if (s.good_student_eligible) { totalDiscount += 3; discounts.push('Good student discount: $3'); }
    if (s.aaa_member) { totalDiscount += 5; discounts.push('AAA membership discount: $5'); }
    const finalAuto = Math.max(riskBase - totalDiscount, 50);
    let homeStandalone = 0, bundledAuto = finalAuto, bundledHome = 0;
    if (s.bundle_interested && s.home_value) {
      homeStandalone = Math.round(s.home_value * 0.00024) + 37;
      bundledAuto = Math.round(finalAuto * 0.85);
      bundledHome = Math.round(homeStandalone * 0.85);
      if (s.home_security_system) { bundledHome -= 4; discounts.push('Home safety discount: $4'); }
    }
    await patchState({ quote_amount: finalAuto, bundled_auto_quote: bundledAuto, bundled_home_quote: bundledHome, discounts_applied: discounts, total_discount_amount: totalDiscount });
    return { success: true, auto_premium_standalone: finalAuto, home_premium_standalone: homeStandalone, bundled_auto_premium: bundledAuto, bundled_home_premium: bundledHome, bundled_total: bundledAuto + bundledHome, standalone_total: finalAuto + homeStandalone, monthly_savings: (finalAuto + homeStandalone) - (bundledAuto + bundledHome), discounts_applied: discounts, total_discount_amount: totalDiscount };
  }

  if (toolName === 'calculateInsuranceQuote') {
    const p = args as any;
    const vehicle = { year: p.vehicle_year, make: p.vehicle_make, model: p.vehicle_model, trim: p.vehicle_trim, estimated_value: p.estimated_vehicle_value };
    const driver = { age: p.driver_age, zip_code: p.zip_code, driving_experience_years: p.driving_experience_years, violation_count: p.violation_count, accident_count: p.accident_count, annual_mileage: p.annual_mileage, is_first_time_buyer: p.is_first_time_buyer || false };
    const coverage = { liability_level: p.liability_level, deductible: parseInt(p.deductible) as 500 | 1000 | 2000, comprehensive: p.comprehensive, collision: p.collision, roadside_assistance: p.roadside_assistance, rental_reimbursement: p.rental_reimbursement, uninsured_motorist_coverage: p.uninsured_motorist_coverage || false, medical_payments_coverage: p.medical_payments_coverage || false };
    const discounts = { anti_theft_device: p.anti_theft_device, defensive_driving_course: p.defensive_driving_course, good_student_eligible: p.good_student_eligible, aaa_member: p.aaa_member, low_mileage: p.annual_mileage < 7500, clean_driving_record: p.clean_driving_record, violation_count: p.violation_count };
    let result: any;
    if (p.include_home_bundle && p.home_value) {
      const home = { home_value: p.home_value, year_built: p.home_year_built || 2000, square_footage: p.home_square_footage || 2000, has_security_system: p.home_has_security_system || false, has_mortgage: p.home_has_mortgage || false, roof_age: p.home_roof_age || 10 };
      result = calculateBundledQuote(vehicle, driver, coverage, discounts, home);
      await patchState({ quote_amount: result.auto_premium, bundled_auto_quote: result.bundled_auto_premium, bundled_home_quote: result.bundled_home_premium, discounts_applied: result.discounts_applied.map((d: any) => `${d.name}: $${d.amount}`), total_discount_amount: result.total_discount_amount });
    } else {
      result = calculateAutoInsurancePremium(vehicle, driver, coverage, discounts);
      await patchState({ quote_amount: result.auto_premium, discounts_applied: result.discounts_applied.map((d: any) => `${d.name}: $${d.amount}`), total_discount_amount: result.total_discount_amount });
    }
    return { success: true, calculation_method: 'advanced_actuarial', ...result };
  }

  if (toolName === 'sendEmail') {
    const { to_email, subject, body } = args as { to_email: string; subject: string; body: string };
    const message = `Thank you for applying for Through SU Insurance.\nHere are the details:\n\n${body}`;
    try {
      return await callToolAPI('send_email', { to_email, subject, body, message });
    } catch {
      return { success: true, message: `Email sent to ${to_email}` };
    }
  }

  if (toolName === 'confirmPayment') {
    const { confirmation } = args as { confirmation: boolean };
    if (confirmation) { await patchState({ payment_completed: true }); return { success: true, message: 'Payment confirmed successfully' }; }
    return { success: false, message: 'Payment not confirmed' };
  }

  if (toolName === 'generatePolicy') {
    const policy_id = `SU-AUTO-${Date.now().toString().slice(-8)}`;
    const random_code = Math.random().toString(36).substring(2, 11).toUpperCase();
    const policy_link = `suinsurance.com/policy/${random_code}`;
    await patchState({ policy_id, policy_link, application_status: 'completed' });
    return { success: true, policy_id, policy_link, message: 'Policy documents generated successfully' };
  }

  if (toolName === 'ragSearch') {
    const { query, top_k } = args as { query: string; top_k?: number | null };
    const k = top_k && top_k > 0 && top_k <= 10 ? top_k : 5;
    const data = aaaRag as any;
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const results: any[] = [];
    for (const article of (data.articles || [])) {
      const text = extractText({ title: article.title, content: article.content, keywords: article.keywords });
      const s = scoreText(text, terms);
      if (s > 0) results.push({ article_id: String(article.id || ''), article_title: String(article.title || ''), score: s, excerpt: makeExcerpt(text, query), payload: article });
    }
    for (const faq of (data.faqs || [])) {
      const text = extractText({ question: faq.question, answer: faq.answer });
      const s = scoreText(text, terms);
      if (s > 0) results.push({ article_id: 'faq', article_title: faq.question || 'FAQ', score: s, excerpt: makeExcerpt(text, query), payload: faq });
    }
    results.sort((a, b) => b.score - a.score);
    return { query, total_matches: results.length, results: results.slice(0, k) };
  }

  if (toolName === 'createZendeskTicket') {
    if (state.zendesk_ticket_created) {
      return { success: true, skipped: true, message: 'Ticket already created for this session.' };
    }
    await patchState({ zendesk_ticket_created: true });
    const { subject, transcript, customer_data, application_status } = args as any;
    const stateSnapshot = customer_data ?? state;
    const descriptionParts = [`**Application Status:** ${application_status}`];
    if (transcript) descriptionParts.push(`**Transcript:**\n${transcript}`);
    if (stateSnapshot) descriptionParts.push(`**Application State:**\n${JSON.stringify(stateSnapshot, null, 2)}`);
    try {
      return await callToolAPI('tickets', { subject, description: descriptionParts.join('\n\n') });
    } catch {
      return { success: true, ticket_id: `ZD-AAA-${Date.now().toString().slice(-8)}`, message: `Zendesk ticket created: ${subject}` };
    }
  }

  return { success: false, error: `Unknown AAA tool: ${toolName}` };
}

// ── US Health Insurance tools ─────────────────────────────────────────────────

import healthRag from '@/app/agentConfigs/US_health_insurance/RAG.json';

async function healthTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
  const state = await readState();

  if (toolName === 'getRenewalState') {
    return state;
  }

  if (toolName === 'updateRenewalState') {
    const { field_name, field_value } = args as { field_name: string; field_value: unknown };
    await patchState({ [field_name]: field_value });
    return { success: true, message: `Updated ${field_name} successfully` };
  }

  if (toolName === 'requestDocument') {
    const { document_type, email } = args as { document_type: string; email: string };
    await patchState({ income_document_sent: true });
    return { success: true, message: `Document request for ${document_type} sent to ${email}` };
  }

  if (toolName === 'confirmDocumentReceived') {
    const { document_type } = args as { document_type: string };
    await patchState({ income_document_received: true });
    return { success: true, message: `${document_type} received successfully` };
  }

  if (toolName === 'sendEmail') {
    const { to_email, subject, body } = args as { to_email: string; subject: string; body: string };
    try {
      return await callToolAPI('send_email', { to_email, subject, body });
    } catch {
      return { success: true, message: `Email sent to ${to_email}` };
    }
  }

  if (toolName === 'confirmPolicyDocumentsReceived') {
    const { confirmed } = args as { confirmed: boolean };
    if (confirmed) {
      await patchState({ policy_documents_confirmed: true, renewal_status: 'completed' });
      return { success: true, message: 'Policy documents receipt confirmed' };
    }
    return { success: false, message: 'Documents not confirmed' };
  }

  if (toolName === 'generatePolicyLink') {
    const { carrier_name, plan_name } = args as { carrier_name: string; plan_name: string };
    const random_code = Math.random().toString(36).substring(2, 15).toLowerCase();
    const policy_link = `suinsurance.com/${carrier_name.toLowerCase()}/${random_code}`;
    await patchState({ policy_link, enrollment_complete: true, policy_documents_sent: true });
    return { success: true, policy_link, carrier_name, plan_name, message: 'Policy documents link generated successfully' };
  }

  if (toolName === 'ragSearch') {
    const { query, top_k, filters } = args as { query: string; top_k?: number | null; filters?: { article_id: string | null; category: string | null; section_id: string | null } | null };
    const k = top_k && top_k > 0 && top_k <= 10 ? top_k : 5;
    const data = healthRag as any;
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const results: any[] = [];
    for (const article of (data.articles || [])) {
      if (filters?.article_id && String(article.article_id) !== String(filters.article_id)) continue;
      if (filters?.category && String(article.category).toLowerCase() !== String(filters.category).toLowerCase()) continue;
      const articleText = extractText({ title: article.title, summary: article.summary, category: article.category, subcategories: article.subcategories });
      const s = scoreText(articleText, terms);
      if (s > 0) results.push({ article_id: String(article.article_id), article_title: String(article.title || ''), category: article.category, score: s, excerpt: makeExcerpt(articleText, query), payload: { article_overview: { title: article.title, summary: article.summary } } });
      for (const section of (article.sections || [])) {
        if (filters?.section_id && String(section.section_id) !== String(filters.section_id)) continue;
        const sText = extractText({ title: section.title, content: section.content, keywords: section.keywords });
        const ss = scoreText(sText, terms);
        if (ss > 0) results.push({ article_id: String(article.article_id), article_title: String(article.title || ''), section_id: String(section.section_id || ''), section_title: String(section.title || ''), score: ss, excerpt: makeExcerpt(sText, query), payload: { section } });
      }
    }
    for (const cq of (data.common_queries || [])) {
      const text = extractText(cq);
      const s = scoreText(text, terms);
      if (s > 0) results.push({ article_id: 'common_queries', article_title: 'Common Queries', score: s, excerpt: makeExcerpt(text, query), payload: { common_query: cq } });
    }
    for (const g of (data.glossary || [])) {
      const text = extractText(g);
      const s = scoreText(text, terms);
      if (s > 0) results.push({ article_id: 'glossary', article_title: 'Glossary', score: s, excerpt: makeExcerpt(text, query), payload: { glossary_item: g } });
    }
    results.sort((a, b) => b.score - a.score);
    return { query, total_matches: results.length, results: results.slice(0, k) };
  }

  if (toolName === 'createZendeskTicket') {
    if (state.zendesk_ticket_created) {
      return { success: true, skipped: true, message: 'Ticket already created for this session.' };
    }
    await patchState({ zendesk_ticket_created: true });
    const { subject, transcript, renewal_data, renewal_status } = args as any;
    const descriptionParts = [`**Renewal Status:** ${renewal_status}`];
    if (transcript) descriptionParts.push(`**Call Transcript:**\n${transcript}`);
    if (renewal_data) descriptionParts.push(`**Renewal Information:**\n${JSON.stringify(renewal_data, null, 2)}`);
    try {
      return await callToolAPI('tickets', { subject, description: descriptionParts.join('\n\n') });
    } catch {
      return { success: true, ticket_id: `ZD-HEALTH-${Date.now().toString().slice(-8)}`, message: `Zendesk ticket created: ${subject}` };
    }
  }

  return { success: false, error: `Unknown health insurance tool: ${toolName}` };
}

// ── Kotak Insurance tools ─────────────────────────────────────────────────────

import kotakRag from '@/app/agentConfigs/kotakInsurance/RAG.json';

const KOTAK_PINCODE_DB: Record<string, { city: string; state: string }> = {
  '700016': { city: 'Kolkata', state: 'West Bengal' },
  '134117': { city: 'Panchkula', state: 'Haryana' },
  '560068': { city: 'Bangalore', state: 'Karnataka' },
  '400101': { city: 'Mumbai', state: 'Maharashtra' },
  '500032': { city: 'Hyderabad', state: 'Telangana' },
};

const AADHAAR_DB: Record<string, { address: string; dob: string; name: string }> = {
  '806012121818': { address: '101/23, Street 1501, Park Street, Kolkata - 700016', dob: '18/05/1994', name: 'Arkadeep Joardar' },
  '761275436789': { address: 'Plot No 15, Sector 20, Panchkula, Haryana 134117', dob: '27/06/1987', name: 'Vishal Sharma' },
  '889876567788': { address: '109, Tower 8, Reed, Salarpuria Serenity, Bomanahalli, Bangalore - 560068', dob: '13/02/1992', name: 'Bharat Sethi' },
  '999889891222': { address: '211, Alpine, Salarpuria Greenage, Bandra, Mumbai - 400101', dob: '13/01/1998', name: 'Jay Iyer' },
  '769879791223': { address: '157, Salarpuria Meadows, Gachibowli, Hyderabad - 500032', dob: '19/08/1989', name: 'Pruthvi Vikas' },
};

async function kotakTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
  const state = await readState();

  if (toolName === 'getApplicationState') {
    return state;
  }

  if (toolName === 'updateApplicationState') {
    const { field_name, field_value } = args as { field_name: string; field_value: unknown };
    await patchState({ [field_name]: field_value });
    return { success: true, message: `Updated ${field_name} successfully` };
  }

  if (toolName === 'verifyPAN') {
    const { pan_number } = args as { pan_number: string };
    const isValid = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(pan_number);
    if (isValid) await patchState({ pan_number });
    return {
      valid: isValid,
      name: isValid ? (state.full_name as string | undefined) ?? 'Unknown' : undefined,
      message: isValid ? 'PAN verified successfully against CKYC records' : 'PAN card number appears to be invalid or not found in CKYC records',
    };
  }

  if (toolName === 'lookupPincode') {
    const { pincode } = args as { pincode: string };
    const data = KOTAK_PINCODE_DB[pincode];
    if (!data) return { success: false, message: 'Pincode not found in our records. Please verify and provide the correct pincode.' };
    await patchState({ pincode, city: data.city, state: data.state });
    return { success: true, city: data.city, state: data.state, pincode };
  }

  if (toolName === 'sendAadhaarOTP') {
    const { aadhaar_number } = args as { aadhaar_number: string };
    const normalized = aadhaar_number.replace(/\s/g, '');
    await patchState({ aadhaar_number: normalized });
    return { success: true, otp_reference_id: `AAD_${Date.now()}`, message: 'OTP sent to registered mobile number' };
  }

  if (toolName === 'verifyAadhaarOTP') {
    const { otp_code } = args as { otp_reference_id: string; otp_code: string };
    const isValid = /^\d{6}$/.test(otp_code);
    if (!isValid) return { success: false, message: 'Invalid OTP. Please try again.' };
    const aadhaarNumber = (state.aadhaar_number as string | undefined)?.replace(/\s/g, '') ?? '';
    const info = AADHAAR_DB[aadhaarNumber];
    if (!info) return { success: false, message: 'Aadhaar number not found in our records. Please verify the Aadhaar number.' };
    await patchState({ aadhaar_address: info.address, aadhaar_dob: info.dob });
    return { success: true, address: info.address, dob: info.dob, name: info.name };
  }

  if (toolName === 'sendGeneralOTP') {
    const { mobileNumber } = args as { mobileNumber: string };
    try {
      return await callToolAPI('send_otp', { mobileNumber });
    } catch {
      return { success: true, otp_reference_id: `OTP_${Date.now()}`, message: 'OTP sent to mobile number' };
    }
  }

  if (toolName === 'verifyGeneralOTP') {
    const { mobile_number, otp_code } = args as { mobile_number: string; otp_code: string };
    try {
      const result = await callToolAPI('verify_otp', { mobile_number, otp_code }) as any;
      if (result.success) await patchState({ application_everified: true });
      return result;
    } catch {
      const isValid = /^\d{6}$/.test(otp_code);
      if (isValid) { await patchState({ application_everified: true }); return { success: true, message: 'OTP verified successfully' }; }
      return { success: false, message: 'Invalid OTP. Please try again.' };
    }
  }

  if (toolName === 'sendWhatsAppMessage') {
    return { success: true, message_id: `WA_${Date.now()}`, message: 'WhatsApp message sent successfully' };
  }

  if (toolName === 'receiveWhatsAppDocument') {
    const { document_type } = args as { document_type: string };
    const documents: string[] = Array.isArray(state.documents_received) ? [...(state.documents_received as string[])] : [];
    if (!documents.includes(document_type)) documents.push(document_type);
    await patchState({ documents_received: documents, all_documents_received: documents.length === 4 });
    return { success: true, document_type, total_received: documents.length, remaining: 4 - documents.length, message: `${document_type} proof received. ${4 - documents.length} documents remaining.` };
  }

  if (toolName === 'sendEmail') {
    const { to_email, subject, body } = args as { to_email: string; subject: string; body: string };
    const message = `Thank you for applying for Kotak e-Invest Plus ULIP.\nHere are the details:\n\n${body}`;
    try {
      return await callToolAPI('send_email', { to_email, subject, body, message });
    } catch {
      return { success: true, message: `Email sent to ${to_email}` };
    }
  }

  if (toolName === 'confirmPayment') {
    const { confirmation } = args as { confirmation: boolean };
    if (confirmation) { await patchState({ payment_completed: true }); return { success: true, message: 'Payment confirmed successfully' }; }
    return { success: false, message: 'Payment not confirmed' };
  }

  if (toolName === 'receiveEmailDocument') {
    const { all_uploaded } = args as { all_uploaded: boolean };
    if (all_uploaded) {
      const allDocs = ['identity', 'address', 'income', 'age'];
      await patchState({ documents_received: allDocs, all_documents_received: true });
      return { success: true, total_received: 4, all_documents_received: true, message: 'All 4 documents confirmed received via email.' };
    }
    return { success: false, message: 'Document upload not confirmed.' };
  }

  if (toolName === 'generatePolicy') {
    const policy_id = Math.floor(100000000 + Math.random() * 900000000).toString();
    const random_code = Math.random().toString(36).substring(2, 11).toUpperCase();
    const policy_link = `sfsr.in/policy/${random_code}`;
    await patchState({ policy_id, policy_link });
    return { success: true, policy_id, policy_link, message: 'Policy documents generated successfully' };
  }

  if (toolName === 'ragSearch') {
    const { query, top_k, filters } = args as { query: string; top_k?: number | null; filters?: { article_id: string | null; category: string | null; section_id: string | null } | null };
    const k = top_k && top_k > 0 && top_k <= 10 ? top_k : 5;
    const data = kotakRag as any;
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const results: any[] = [];
    for (const article of (data.articles || [])) {
      if (filters?.article_id && String(article.article_id) !== String(filters.article_id)) continue;
      if (filters?.category && String(article.category).toLowerCase() !== String(filters.category).toLowerCase()) continue;
      const articleText = extractText({ title: article.title, summary: article.summary, category: article.category, subcategories: article.subcategories });
      const s = scoreText(articleText, terms);
      if (s > 0) results.push({ article_id: String(article.article_id), article_title: String(article.title || ''), category: article.category, score: s, excerpt: makeExcerpt(articleText, query), payload: { article_overview: { title: article.title, summary: article.summary } } });
      for (const section of (article.sections || [])) {
        if (filters?.section_id && String(section.section_id) !== String(filters.section_id)) continue;
        const sText = extractText({ title: section.title, content: section.content, keywords: section.keywords });
        const ss = scoreText(sText, terms);
        if (ss > 0) results.push({ article_id: String(article.article_id), article_title: String(article.title || ''), section_id: String(section.section_id || ''), section_title: String(section.title || ''), score: ss, excerpt: makeExcerpt(sText, query), payload: { section } });
      }
    }
    for (const cq of (data.common_queries || [])) {
      const text = extractText(cq); const s = scoreText(text, terms);
      if (s > 0) results.push({ article_id: 'common_queries', article_title: 'Common Queries', score: s, excerpt: makeExcerpt(text, query), payload: { common_query: cq } });
    }
    for (const g of (data.glossary || [])) {
      const text = extractText(g); const s = scoreText(text, terms);
      if (s > 0) results.push({ article_id: 'glossary', article_title: 'Glossary', score: s, excerpt: makeExcerpt(text, query), payload: { glossary_item: g } });
    }
    results.sort((a, b) => b.score - a.score);
    return { query, total_matches: results.length, results: results.slice(0, k) };
  }

  if (toolName === 'createZendeskTicket') {
    if (state.zendesk_ticket_created) {
      return { success: true, skipped: true, message: 'Ticket already created for this session.' };
    }
    await patchState({ zendesk_ticket_created: true });
    const { subject, transcript, customer_data, application_status } = args as any;
    const descriptionParts = [`**Application Status:** ${application_status}`];
    if (transcript) descriptionParts.push(`**Transcript:**\n${transcript}`);
    if (customer_data) descriptionParts.push(`**Customer Data:**\n${JSON.stringify(customer_data, null, 2)}`);
    try {
      return await callToolAPI('tickets', { subject, description: descriptionParts.join('\n\n') });
    } catch {
      return { success: true, ticket_id: `ZD-KOTAK-${Date.now().toString().slice(-8)}`, message: `Zendesk ticket created: ${subject}` };
    }
  }

  return { success: false, error: `Unknown Kotak tool: ${toolName}` };
}

// ── Tool schemas (OpenAI function calling format) ─────────────────────────────
// Used by GET /api/tools?agentKey=... so phone-mode session creation can fetch
// the correct schemas and pass them to the OpenAI Realtime session — keeping
// tool definitions in one place instead of duplicated in session/route.ts.

const LIC_TOOL_SCHEMAS = [
  {
    type: 'function',
    name: 'updateLeadState',
    description: 'Updates the lead qualification state with collected information. Use this to save user-provided data immediately as it is collected during the conversation. For array fields like competing_lenders, pass the value as a JSON array string (e.g., \'["HDFC","SBI"]\') — it will be parsed automatically.',
    parameters: {
      type: 'object',
      properties: {
        field_name: { type: 'string', description: 'Name of the field to update (e.g., property_stage, employment_type, pan_number, competing_lenders)' },
        field_value: {
          oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
          description: 'Value to store. For array fields (competing_lenders), pass a JSON array string like \'["HDFC","SBI"]\'',
        },
      },
      required: ['field_name', 'field_value'],
    },
  },
  {
    type: 'function',
    name: 'getLeadState',
    description: 'Retrieves the current lead qualification state. Use this to check what information has been collected so far, including pre-collected lead info like first_name, last_name, phone_number, property_location, and area_office.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'validatePAN',
    description: 'Validates the format of an Indian PAN (Permanent Account Number). PAN format: 5 uppercase letters, 4 digits, 1 uppercase letter (e.g., AAAPA1111A).',
    parameters: {
      type: 'object',
      properties: { pan_number: { type: 'string', description: 'PAN number to validate' } },
      required: ['pan_number'],
    },
  },
  {
    type: 'function',
    name: 'lookupPincode',
    description: 'Looks up city and state information for a given Indian PIN code (6 digits).',
    parameters: {
      type: 'object',
      properties: { pincode: { type: 'string', description: '6-digit Indian PIN code' } },
      required: ['pincode'],
    },
  },
  {
    type: 'function',
    name: 'calculateLeadScore',
    description: 'Calculates the lead qualification score across 5 parameters (Intent, Eligibility, Loan Amount, Decision Authority, LICHFL Preference). Call this at end of call or when enough data is collected. No parameters needed — it reads from state automatically.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'syncToLeadSquared',
    description: 'Syncs the full qualification data, transcript, lead score, and category to LeadSquared CRM. Call this after scoring is complete at end of call.',
    parameters: {
      type: 'object',
      properties: {
        lead_category: { type: 'string', enum: ['HOT', 'WARM', 'COLD', 'PENDING', 'URGENT'], description: 'Lead category after scoring' },
        call_disposition: { type: 'string', description: 'How the call ended: completed, callback_requested, not_interested, dropped, abusive' },
      },
      required: ['lead_category', 'call_disposition'],
    },
  },
  {
    type: 'function',
    name: 'ragSearch',
    description: 'Searches the LICHFL home loan knowledge base for answers to customer questions. Use when the lead asks about documents, eligibility, EMI, rates, tenure, tax benefits, etc.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'User query text to search for' },
        top_k: { type: 'number', description: 'Number of results to return, default 5' },
      },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'createZendeskTicket',
    description: 'Creates a Zendesk ticket with the lead qualification snapshot. Call at the end of every call (completed, abandoned, or callback requested).',
    parameters: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Ticket subject line including lead name and category' },
        transcript: { type: 'string', description: 'Conversation transcript or summary' },
        lead_category: { type: 'string', enum: ['HOT', 'WARM', 'COLD', 'PENDING', 'URGENT'], description: 'Lead category' },
        call_disposition: { type: 'string', description: 'How the call ended' },
      },
      required: ['lead_category', 'call_disposition'],
    },
  },
  {
    type: 'function',
    name: 'sendEmail',
    description: 'Sends an email to the lead (callback confirmation or loan information).',
    parameters: {
      type: 'object',
      properties: {
        to_email: { type: 'string', description: 'Email address' },
        subject: { type: 'string', description: 'Email subject line' },
        body: { type: 'string', description: 'Email body content' },
      },
      required: ['to_email', 'subject', 'body'],
    },
  },
];

const AGENT_TOOL_SCHEMAS: Record<string, unknown[]> = {
  licSales: LIC_TOOL_SCHEMAS,
};

// ── Route handler ─────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const agentKey = searchParams.get('agentKey') ?? '';
  const schemas = AGENT_TOOL_SCHEMAS[agentKey];
  if (!schemas) {
    return NextResponse.json({ error: `No tool schemas registered for agentKey: ${agentKey}` }, { status: 404 });
  }
  return NextResponse.json({ tools: schemas });
}

export async function POST(req: NextRequest) {
  try {
    const { agentKey, toolName, args = {} } = await req.json() as { agentKey: string; toolName: string; args: Record<string, unknown> };

    let result: unknown;
    if (agentKey === 'licSales') {
      result = await licTool(toolName, args);
    } else if (agentKey === 'aaaInsurance') {
      result = await aaaTool(toolName, args);
    } else if (agentKey === 'usHealthInsurance') {
      result = await healthTool(toolName, args);
    } else if (agentKey === 'kotakInsurance') {
      result = await kotakTool(toolName, args);
    } else {
      return NextResponse.json({ success: false, error: `Unknown agentKey: ${agentKey}` }, { status: 400 });
    }

    return NextResponse.json(result);
  } catch (err: any) {
    console.error('[/api/tools] Error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
