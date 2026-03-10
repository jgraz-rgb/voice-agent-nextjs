export interface VehicleInfo {
  year: string;
  make: string;
  model: string;
  trim: string;
  estimated_value: number;
}

export interface DriverProfile {
  age: number;
  zip_code: string;
  driving_experience_years: number;
  violation_count: number;
  accident_count: number;
  annual_mileage: number;
}

export interface CoverageSelections {
  liability_level: '15/30/5' | '25/50/25' | '50/100/50' | '100/300/100' | '250/500/100';
  deductible: 500 | 1000 | 2000;
  comprehensive: boolean;
  collision: boolean;
  roadside_assistance: boolean;
  rental_reimbursement: boolean;
}

export interface DiscountFlags {
  anti_theft_device: boolean;
  defensive_driving_course: boolean;
  good_student_eligible: boolean;
  aaa_member: boolean;
  low_mileage: boolean;
  clean_driving_record: boolean;
  violation_count: number;
}

export interface HomeInfo {
  home_value: number;
  year_built: number;
  square_footage: number;
  has_security_system: boolean;
  has_mortgage: boolean;
  roof_age: number;
}

export interface QuoteResult {
  auto_premium: number;
  home_premium_standalone?: number;
  bundled_auto_premium?: number;
  bundled_home_premium?: number;
  total_monthly: number;
  bundle_monthly_savings?: number;
  discounts_applied: DiscountDetail[];
  total_discount_amount: number;
  breakdown: PremiumBreakdown;
}

export interface DiscountDetail {
  name: string;
  amount: number;
  description: string;
}

export interface PremiumBreakdown {
  base_liability: number;
  collision: number;
  comprehensive: number;
  uninsured_motorist: number;
  risk_adjusted_subtotal: number;
  optional_coverages: number;
  total_before_discounts: number;
  total_discounts: number;
  final_premium: number;
}

const BASE_RATES = {
  liability: {
    '15/30/5': 35,
    '25/50/25': 42,
    '50/100/50': 48,
    '100/300/100': 50,
    '250/500/100': 58,
  },
  uninsured_motorist: 10,
  roadside_assistance: 8,
  rental_reimbursement: 12,
};

const DEDUCTIBLE_IMPACT = {
  500: { collision_base: 52, comprehensive_base: 28 },
  1000: { collision_base: 45, comprehensive_base: 25 },
  2000: { collision_base: 38, comprehensive_base: 22 },
};

const VEHICLE_VALUE_MULTIPLIERS: Record<string, number> = {
  'under_15000': 0.85,
  '15000_25000': 0.95,
  '25001_35000': 1.0,
  '35001_50000': 1.15,
  'over_50000': 1.30,
};

function getVehicleValueMultiplier(value: number): number {
  if (value < 15000) return VEHICLE_VALUE_MULTIPLIERS['under_15000'];
  if (value <= 25000) return VEHICLE_VALUE_MULTIPLIERS['15000_25000'];
  if (value <= 35000) return VEHICLE_VALUE_MULTIPLIERS['25001_35000'];
  if (value <= 50000) return VEHICLE_VALUE_MULTIPLIERS['35001_50000'];
  return VEHICLE_VALUE_MULTIPLIERS['over_50000'];
}

const RISK_MULTIPLIERS = {
  age: {
    under_20: 1.25,
    '20_24': 1.15,
    '25_29': 1.05,
    '30_49': 0.95,
    '50_64': 0.92,
    '65_plus': 0.97,
  },
  zip_code: {
    '90210': 1.08,
    default: 1.09,
  },
  driving_experience: {
    under_3: 1.10,
    '3_5': 1.05,
    '6_10': 1.00,
    '11_20': 0.98,
    over_20: 0.95,
  },
  mileage: {
    under_5000: 0.90,
    '5000_7500': 0.95,
    '7501_10000': 0.98,
    '10001_15000': 1.00,
    over_15000: 1.05,
  },
};

function getAgeMultiplier(age: number): number {
  if (age < 20) return RISK_MULTIPLIERS.age.under_20;
  if (age <= 24) return RISK_MULTIPLIERS.age['20_24'];
  if (age <= 29) return RISK_MULTIPLIERS.age['25_29'];
  if (age <= 49) return RISK_MULTIPLIERS.age['30_49'];
  if (age <= 64) return RISK_MULTIPLIERS.age['50_64'];
  return RISK_MULTIPLIERS.age['65_plus'];
}

function getExperienceMultiplier(years: number): number {
  if (years < 3) return RISK_MULTIPLIERS.driving_experience.under_3;
  if (years <= 5) return RISK_MULTIPLIERS.driving_experience['3_5'];
  if (years <= 10) return RISK_MULTIPLIERS.driving_experience['6_10'];
  if (years <= 20) return RISK_MULTIPLIERS.driving_experience['11_20'];
  return RISK_MULTIPLIERS.driving_experience.over_20;
}

function getMileageMultiplier(mileage: number): number {
  if (mileage < 5000) return RISK_MULTIPLIERS.mileage.under_5000;
  if (mileage <= 7500) return RISK_MULTIPLIERS.mileage['5000_7500'];
  if (mileage <= 10000) return RISK_MULTIPLIERS.mileage['7501_10000'];
  if (mileage <= 15000) return RISK_MULTIPLIERS.mileage['10001_15000'];
  return RISK_MULTIPLIERS.mileage.over_15000;
}

function getZipCodeMultiplier(zip_code: string): number {
  return RISK_MULTIPLIERS.zip_code[zip_code as keyof typeof RISK_MULTIPLIERS.zip_code] || RISK_MULTIPLIERS.zip_code.default;
}

export function calculateAutoInsurancePremium(
  vehicle: VehicleInfo,
  driver: DriverProfile,
  coverage: CoverageSelections,
  discounts: DiscountFlags
): QuoteResult {
  const baseLiability = BASE_RATES.liability[coverage.liability_level];
  const uninsuredMotorist = BASE_RATES.uninsured_motorist;
  
  const deductibleRates = DEDUCTIBLE_IMPACT[coverage.deductible];
  const vehicleValueMult = getVehicleValueMultiplier(vehicle.estimated_value);
  
  let collisionCost = coverage.collision ? Math.round(deductibleRates.collision_base * vehicleValueMult) : 0;
  let comprehensiveCost = coverage.comprehensive ? Math.round(deductibleRates.comprehensive_base * vehicleValueMult) : 0;
  
  const baseTotal = baseLiability + collisionCost + comprehensiveCost + uninsuredMotorist;
  
  const ageMultiplier = getAgeMultiplier(driver.age);
  const zipMultiplier = getZipCodeMultiplier(driver.zip_code);
  const experienceMultiplier = getExperienceMultiplier(driver.driving_experience_years);
  const mileageMultiplier = getMileageMultiplier(driver.annual_mileage);
  
  const violationMultiplier = driver.violation_count === 0 ? 1.0 : 
                               driver.violation_count === 1 ? 1.08 : 
                               driver.violation_count === 2 ? 1.15 : 1.22;
  
  const accidentMultiplier = driver.accident_count === 0 ? 1.0 :
                              driver.accident_count === 1 ? 1.12 :
                              driver.accident_count === 2 ? 1.25 : 1.40;
  
  const combinedMultiplier = ageMultiplier * zipMultiplier * experienceMultiplier * 
                              mileageMultiplier * violationMultiplier * accidentMultiplier;
  
  const riskAdjustedBase = Math.round(baseTotal * combinedMultiplier);
  
  let optionalCoverages = 0;
  if (coverage.roadside_assistance) optionalCoverages += BASE_RATES.roadside_assistance;
  if (coverage.rental_reimbursement) optionalCoverages += BASE_RATES.rental_reimbursement;
  
  const totalBeforeDiscounts = riskAdjustedBase + optionalCoverages;
  
  const discountDetails: DiscountDetail[] = [];
  let totalDiscounts = 0;
  
  if (discounts.clean_driving_record) {
    let gdDiscount = 0;
    if (driver.violation_count === 0 && driver.accident_count === 0) {
      gdDiscount = 39;
    } else if (driver.violation_count === 1 && driver.accident_count === 0) {
      gdDiscount = 29;
    } else if (driver.violation_count === 2 && driver.accident_count === 0) {
      gdDiscount = 19;
    }
    
    if (gdDiscount > 0) {
      discountDetails.push({
        name: 'Good Driver Discount',
        amount: gdDiscount,
        description: 'For maintaining a clean driving record',
      });
      totalDiscounts += gdDiscount;
    }
  }
  
  if (discounts.anti_theft_device) {
    const safetyDiscount = 7;
    discountDetails.push({
      name: 'Safety Features Discount',
      amount: safetyDiscount,
      description: 'Anti-theft devices and security systems',
    });
    totalDiscounts += safetyDiscount;
  }
  
  if (discounts.low_mileage && driver.annual_mileage < 7500) {
    const lowMileageDiscount = 5;
    discountDetails.push({
      name: 'Low Mileage Discount',
      amount: lowMileageDiscount,
      description: 'Driving less than 7,500 miles annually',
    });
    totalDiscounts += lowMileageDiscount;
  }
  
  if (discounts.defensive_driving_course) {
    const defensiveDiscount = 2;
    discountDetails.push({
      name: 'Defensive Driving Discount',
      amount: defensiveDiscount,
      description: 'Completed approved defensive driving course',
    });
    totalDiscounts += defensiveDiscount;
  }
  
  if (discounts.good_student_eligible && driver.age >= 16 && driver.age <= 25) {
    const studentDiscount = 3;
    discountDetails.push({
      name: 'Good Student Discount',
      amount: studentDiscount,
      description: 'For students maintaining a 3.0 GPA or higher',
    });
    totalDiscounts += studentDiscount;
  }
  
  if (discounts.aaa_member) {
    const aaaDiscount = 5;
    discountDetails.push({
      name: 'AAA Member Discount',
      amount: aaaDiscount,
      description: 'AAA membership benefit',
    });
    totalDiscounts += aaaDiscount;
  }
  
  const finalPremium = Math.max(totalBeforeDiscounts - totalDiscounts, 50);
  
  const breakdown: PremiumBreakdown = {
    base_liability: baseLiability,
    collision: collisionCost,
    comprehensive: comprehensiveCost,
    uninsured_motorist: uninsuredMotorist,
    risk_adjusted_subtotal: riskAdjustedBase,
    optional_coverages: optionalCoverages,
    total_before_discounts: totalBeforeDiscounts,
    total_discounts: totalDiscounts,
    final_premium: finalPremium,
  };
  
  return {
    auto_premium: finalPremium,
    total_monthly: finalPremium,
    discounts_applied: discountDetails,
    total_discount_amount: totalDiscounts,
    breakdown,
  };
}

export function calculateHomeInsurancePremium(home: HomeInfo): number {
  const baseDwellingCost = Math.round(home.home_value * 0.00024);
  
  const otherStructures = 10;
  const personalProperty = 15;
  const liabilityProtection = 8;
  const lossOfUse = 4;
  
  let adjustedCost = baseDwellingCost + otherStructures + personalProperty + liabilityProtection + lossOfUse;
  
  if (home.has_security_system) {
    adjustedCost -= 4;
  }
  
  if (home.roof_age > 20) {
    adjustedCost += 8;
  } else if (home.roof_age > 15) {
    adjustedCost += 4;
  }
  
  const homeAge = new Date().getFullYear() - home.year_built;
  if (homeAge > 50) {
    adjustedCost = Math.round(adjustedCost * 1.10);
  }
  
  return Math.max(adjustedCost, 40);
}

export function calculateBundledQuote(
  vehicle: VehicleInfo,
  driver: DriverProfile,
  coverage: CoverageSelections,
  discounts: DiscountFlags,
  home: HomeInfo
): QuoteResult {
  const autoResult = calculateAutoInsurancePremium(vehicle, driver, coverage, discounts);
  const homeStandalone = calculateHomeInsurancePremium(home);
  
  const BUNDLE_DISCOUNT_PERCENT = 0.15;
  
  const bundledAuto = Math.round(autoResult.auto_premium * (1 - BUNDLE_DISCOUNT_PERCENT));
  const bundledHome = Math.round(homeStandalone * (1 - BUNDLE_DISCOUNT_PERCENT));
  
  const bundleSavings = (autoResult.auto_premium + homeStandalone) - (bundledAuto + bundledHome);
  
  autoResult.discounts_applied.push({
    name: 'Multi-Policy Bundle Discount',
    amount: Math.round(autoResult.auto_premium * BUNDLE_DISCOUNT_PERCENT),
    description: '15% savings for bundling auto and home insurance',
  });
  
  return {
    ...autoResult,
    home_premium_standalone: homeStandalone,
    bundled_auto_premium: bundledAuto,
    bundled_home_premium: bundledHome,
    total_monthly: bundledAuto + bundledHome,
    bundle_monthly_savings: bundleSavings,
  };
}
