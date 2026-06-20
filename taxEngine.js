/**
 * TaxEngine.js — Tax Year 2026 (1 Jul 2025 – 30 Jun 2026)
 * Translated from TaxEngine.kt — Income Tax Ordinance 2001 / Finance Act 2025
 */

const TAX_YEAR = "2026";
const SURCHARGE_THRESHOLD = 10_000_000;
const SURCHARGE_RATE = 0.09;
const POD_BANK_RATE = 0.20;
const POD_NSS_RATE = 0.15;
const POD_FINAL_LIMIT = 5_000_000;
const DIVIDEND_RATE = 0.15;

function roundToLong(v) { return Math.round(v); }
function fmt(v) { return Number(v).toLocaleString("en-US"); }

/** Derived properties from ReturnData (mirrors Kotlin computed vals) */
function deriveData(d) {
  d.businessGrossProfitCalc = d.businessRevenue - d.businessCostOfSales;
  d.businessNetIncome = Math.max(0,
    d.businessRevenue - d.businessCostOfSales -
    d.businessAdminExpenses - d.businessFinanceCharges -
    d.businessOtherIndirectExp - d.businessDepreciation -
    d.businessInitialAllowance - d.businessPrecommencement - d.businessOtherDeductions
  );
  d.propertyNetIncome = Math.max(0,
    d.rentReceived - d.propertyTax - d.propertyInsurance -
    d.propertyMaintenance - d.propertyInterestOnLoan - d.propertyOtherDeductions
  );
  d.totalAssets = d.assetProperty + d.assetVehicles + d.assetBankBalances +
                  d.assetCash + d.assetInvestments + d.assetBusiness + d.assetOther;
  d.closingNetAssets = d.totalAssets - d.liabilities;
  return d;
}

function salariedSlabTax(taxable) {
  const t = taxable;
  if (taxable <= 600_000)    return 0;
  if (taxable <= 1_200_000)  return roundToLong(0.01 * (t - 600_000));
  if (taxable <= 2_200_000)  return roundToLong(6_000 + 0.11 * (t - 1_200_000));
  if (taxable <= 3_200_000)  return roundToLong(116_000 + 0.23 * (t - 2_200_000));
  if (taxable <= 4_100_000)  return roundToLong(346_000 + 0.30 * (t - 3_200_000));
  return roundToLong(616_000 + 0.35 * (t - 4_100_000));
}

function nonSalariedSlabTax(taxable) {
  const t = taxable;
  if (taxable <= 600_000)    return 0;
  if (taxable <= 1_200_000)  return roundToLong(0.15 * (t - 600_000));
  if (taxable <= 2_400_000)  return roundToLong(90_000 + 0.20 * (t - 1_200_000));
  if (taxable <= 3_600_000)  return roundToLong(330_000 + 0.25 * (t - 2_400_000));
  if (taxable <= 6_000_000)  return roundToLong(630_000 + 0.30 * (t - 3_600_000));
  return roundToLong(1_350_000 + 0.35 * (t - 6_000_000));
}

function propertyCapitalGainRate(holdingYears, propertyType) {
  if (propertyType === "Open Plot") {
    if (holdingYears < 1) return 0.15;
    if (holdingYears < 2) return 0.125;
    if (holdingYears < 3) return 0.10;
    if (holdingYears < 4) return 0.075;
    if (holdingYears < 5) return 0.05;
    if (holdingYears < 6) return 0.025;
    return 0.0;
  } else {
    if (holdingYears < 1) return 0.15;
    if (holdingYears < 2) return 0.125;
    if (holdingYears < 3) return 0.10;
    if (holdingYears < 4) return 0.075;
    if (holdingYears < 5) return 0.05;
    return 0.0;
  }
}

function compute(rawD) {
  const d = deriveData({ ...rawD });
  const warnings = [];

  // Salary
  let taxableSalary = 0;
  if (d.hasSalary) {
    const gross = d.salarySimpleMode
      ? d.grossSalary
      : d.basicSalary + d.houseRentAllowance + d.medicalAllowance +
        d.conveyanceAllowance + d.otherAllowances +
        d.bonusPerformancePay + d.perquisitesAndBenefits;
    taxableSalary = Math.max(0, gross - d.exemptMedicalAllowance - d.exemptHouseRentAllowance - d.otherExemptSalary);
  }

  const businessIncome    = d.hasBusiness     ? d.businessNetIncome  : 0;
  const propertyIncome    = d.hasProperty     ? d.propertyNetIncome  : 0;
  const otherNormalIncome = d.hasOtherSources ? d.otherIncome + d.foreignIncome : 0;

  const normalIncome  = taxableSalary + businessIncome + propertyIncome + otherNormalIncome;
  const taxableIncome = Math.max(0, normalIncome - d.zakat - d.workerWelfareFund);

  const isSalariedCase = taxableIncome === 0 || taxableSalary > 0.75 * taxableIncome;
  if (!isSalariedCase) {
    warnings.push("Salary is not more than 75% of taxable income — non-salaried (higher) rates apply. Rates have been computed using non-salaried slabs.");
  }

  const normalTaxGross = isSalariedCase ? salariedSlabTax(taxableIncome) : nonSalariedSlabTax(taxableIncome);

  const teacherReduction = (d.isTeacherOrResearcher && taxableIncome > 0 && taxableSalary > 0)
    ? roundToLong(0.25 * normalTaxGross * (taxableSalary / taxableIncome))
    : 0;

  const taxAfterReduction = Math.max(0, normalTaxGross - teacherReduction);
  const surcharge = taxableIncome > SURCHARGE_THRESHOLD
    ? roundToLong(SURCHARGE_RATE * taxAfterReduction) : 0;

  const avgRate = taxableIncome > 0 ? taxAfterReduction / taxableIncome : 0;
  const eligiblePension  = Math.min(d.pensionFundContribution, roundToLong(0.20 * taxableIncome));
  const pensionCredit    = roundToLong(eligiblePension * avgRate);
  const eligibleDonation = Math.min(d.charitableDonations, roundToLong(0.30 * taxableIncome));
  const donationCredit   = roundToLong(eligibleDonation * avgRate);

  const normalTaxNet = Math.max(0, taxAfterReduction + surcharge - pensionCredit - donationCredit);

  // Final taxes
  const totalPod = d.profitOnDebtBank + d.profitOnDebtNss;
  if (totalPod > POD_FINAL_LIMIT) {
    warnings.push("Profit on debt exceeds Rs 5,000,000 — it falls outside the final tax regime u/s 7B and is taxable at normal rates. Consult a tax adviser.");
  }
  const finalTaxProfitOnDebt = d.hasOtherSources
    ? roundToLong(d.profitOnDebtBank * POD_BANK_RATE + d.profitOnDebtNss * POD_NSS_RATE) : 0;

  const finalTaxDividend = d.hasOtherSources
    ? roundToLong(d.dividend * DIVIDEND_RATE) : 0;

  const propGainRate       = propertyCapitalGainRate(d.propertyHoldingYears, d.propertyType);
  const finalTaxPropertyGain = d.hasCapitalGains ? roundToLong(d.propertyGainAmount * propGainRate) : 0;
  const finalTaxSecurities   = d.hasCapitalGains
    ? roundToLong(d.securitiesGainLessThan1Yr * 0.15 + d.securitiesGain1To2Yr * 0.125) : 0;
  const finalTaxCapitalGains = finalTaxPropertyGain + finalTaxSecurities;

  if (d.hasCapitalGains && d.securitiesGainAbove2Yr > 0) {
    warnings.push(`Securities gains held >2 years: exempt from tax (Rs ${fmt(d.securitiesGainAbove2Yr)} not included in computation).`);
  }
  if (d.hasCapitalGains && propGainRate === 0.0 && d.propertyGainAmount > 0) {
    warnings.push(`Property held ${d.propertyHoldingYears}+ years: gain is exempt from tax (Rs ${fmt(d.propertyGainAmount)} not included).`);
  }

  const totalTaxChargeable = normalTaxNet + finalTaxProfitOnDebt + finalTaxDividend + finalTaxCapitalGains;

  const totalTaxPaid = d.taxDeductedSalary + d.taxDeductedBusiness + d.taxDeductedRent +
    d.taxDeductedProfit + d.taxDeductedDividend + d.taxDeductedCapitalGains +
    d.taxPhone + d.taxElectricity + d.taxVehicle +
    d.taxPropertyPurchase + d.taxPropertySale + d.taxOtherAdjustable;

  const balance = totalTaxChargeable - totalTaxPaid;

  // Wealth reconciliation
  const closingNetAssets   = d.closingNetAssets;
  const increaseInNetAssets = closingNetAssets - d.openingNetAssets;
  const inflows = taxableIncome + d.zakat + d.workerWelfareFund +
    d.exemptMedicalAllowance + d.exemptHouseRentAllowance + d.otherExemptSalary +
    totalPod + d.dividend + d.agriculturalIncome +
    d.foreignRemittance + d.giftsInheritanceOther;
  const outflows      = d.personalExpenses + totalTaxChargeable;
  const unreconciled  = increaseInNetAssets - (inflows - outflows);
  if (unreconciled !== 0) {
    warnings.push(`Wealth statement is out of balance by Rs ${fmt(unreconciled)}. Inflows minus outflows must equal the increase in net assets.`);
  }

  return {
    taxableSalary, businessIncome, propertyIncome, otherNormalIncome,
    normalIncome, taxableIncome, isSalariedCase,
    normalTaxGross, teacherReduction, surcharge, pensionCredit, donationCredit, normalTaxNet,
    finalTaxProfitOnDebt, finalTaxDividend, finalTaxCapitalGains,
    totalTaxChargeable, totalTaxPaid, balance,
    closingNetAssets, increaseInNetAssets, inflows, outflows, unreconciled, warnings
  };
}

// Default ReturnData (all zeros / false)
function defaultReturnData() {
  return {
    hasSalary: false, hasBusiness: false, hasProperty: false,
    hasCapitalGains: false, hasOtherSources: false,
    name: "", cnic: "", ntn: "",
    isTeacherOrResearcher: false, isNonResident: false,
    salarySimpleMode: true,
    grossSalary: 0, taxDeductedSalary: 0,
    basicSalary: 0, houseRentAllowance: 0, medicalAllowance: 0,
    conveyanceAllowance: 0, otherAllowances: 0, bonusPerformancePay: 0,
    perquisitesAndBenefits: 0, exemptMedicalAllowance: 0,
    exemptHouseRentAllowance: 0, otherExemptSalary: 0,
    businessType: "Sole Proprietor", businessName: "", businessNature: "Trading",
    businessRevenue: 0, businessCostOfSales: 0, businessAdminExpenses: 0,
    businessFinanceCharges: 0, businessOtherIndirectExp: 0, businessDepreciation: 0,
    businessInitialAllowance: 0, businessPrecommencement: 0, businessOtherDeductions: 0,
    taxDeductedBusiness: 0,
    rentReceived: 0, propertyTax: 0, propertyInsurance: 0,
    propertyMaintenance: 0, propertyInterestOnLoan: 0, propertyOtherDeductions: 0,
    taxDeductedRent: 0,
    propertyGainAmount: 0, propertyHoldingYears: 0,
    propertyType: "Open Plot",
    securitiesGainLessThan1Yr: 0, securitiesGain1To2Yr: 0, securitiesGainAbove2Yr: 0,
    taxDeductedCapitalGains: 0,
    profitOnDebtBank: 0, profitOnDebtNss: 0, taxDeductedProfit: 0,
    dividend: 0, taxDeductedDividend: 0,
    foreignIncome: 0, agriculturalIncome: 0, otherIncome: 0,
    zakat: 0, pensionFundContribution: 0, charitableDonations: 0, workerWelfareFund: 0,
    taxPhone: 0, taxElectricity: 0, taxVehicle: 0,
    taxPropertyPurchase: 0, taxPropertySale: 0, taxOtherAdjustable: 0,
    openingNetAssets: 0,
    assetProperty: 0, assetVehicles: 0, assetBankBalances: 0, assetCash: 0,
    assetInvestments: 0, assetBusiness: 0, assetOther: 0,
    liabilities: 0, personalExpenses: 0, foreignRemittance: 0, giftsInheritanceOther: 0
  };
}

module.exports = { compute, defaultReturnData, deriveData, fmt, TAX_YEAR };
