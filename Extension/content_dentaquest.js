/**
 * DentaQuest / Sun Life content script
 * ------------------------------------
 * Popup-driven build for the existing insurance-auditor extension.
 *
 * Existing popup contract:
 *   - receives { command: "START_CRAWL" }
 *   - saves the completed result in audit_context.dentaquest_data
 *   - the existing popup Download button exports audit_context
 *
 * No background worker, service worker, popup change, or external library.
 * Register as a normal content script for providers.dentaquest.com with
 * run_at: "document_start".
 */

(function dentaQuestContentScriptBootstrap() {
  "use strict";

  function createMainWorldExtractor(testMode) {
    "use strict";

    const VERSION = "2.0.0-popup";
    const SOURCE = "content_dentaquest";
    const MISSING = "Not found in DentaQuest response";
    const NOT_STATED = "Not stated in plan response";
    const NOT_APPLICABLE = "Not Applicable";
    let capturedAuthorization = "";

    const ENDPOINT_PATTERNS = [
      ["profile", /\/users\/my-profile(?:\?|$)/i],
      ["memberInfo", /\/member-info(?:\?|$)/i],
      ["planInfo", /\/plan-info(?:\?|$)/i],
      ["clinicalHistory", /\/clinical-history(?:\?|$)/i],
      ["enrollmentHistory", /\/enrollment-history(?:\?|$)/i],
      ["memberEligibility", /\/eligibility\/member-eligibility(?:\?|$)/i],
      ["familyInfo", /\/family-info(?:\?|$)/i],
      ["planBenefitSummary", /\/plan-benefit-summary(?:\?|$)/i],
      ["maximumDeductible", /\/maximum-deductible(?:\?|$)/i],
      ["coordinationOfBenefits", /\/coordination-of-benefits(?:\?|$)/i]
    ];

    const CORE_ENDPOINTS = [
      "memberInfo",
      "planInfo",
      "enrollmentHistory",
      "memberEligibility",
      "familyInfo",
      "planBenefitSummary",
      "maximumDeductible"
    ];

    const PROCEDURE_GROUPS = {
      EXAMS: [
        ["Perio Consult (D0180)", "D0180"],
        ["Periodic Exam (D0120)", "D0120"],
        ["Limited Exam (D0140)", "D0140"],
        ["Comprehensive Exam (D0150)", "D0150"]
      ],
      DIAGNOSTIC: [
        ["Full Mouth Xray (D0210)", "D0210"],
        ["PA (D0220)", "D0220"],
        ["PA Addtn (D0230)", "D0230"],
        ["Intraoral - Occlusal Image (D0240)", "D0240"],
        ["Bitewings (D0274)", "D0274"],
        ["Panoramic Xray (D0330)", "D0330"]
      ],
      PREVENTATIVE: [
        ["Space Maintainer (D1510)", "D1510"],
        ["Prophylaxis (D1110)", "D1110"],
        ["Prophylaxis Child (D1120)", "D1120"],
        ["Fluoride (D1206)", "D1206"],
        ["Sealants (D1351)", "D1351"]
      ],
      "BASIC RESTORATIVE": [
        ["Amalgam (D2140)", "D2140"],
        ["Composite Filling (D2331)", "D2331"],
        ["Restorative Onlay/Inlay (D2620)", "D2620"]
      ],
      "MAJOR RESTORATIVE": [
        ["Porcelain Crown (D2740)", "D2740"],
        ["Build up (D2950)", "D2950"],
        ["D2991", "D2991"]
      ],
      ENDODONTICS: [
        ["Retreatment of previous root canal therapy - premolar (D3347)", "D3347"],
        ["Endo (D3310)", "D3310"],
        ["Root Canal (D3330)", "D3330"]
      ],
      PERIODONTICS: [
        ["Osseous Surgery (D4260)", "D4260"],
        ["Scaling & Root Planning (D4341)", "D4341"],
        ["Full Mouth Debridement (D4355)", "D4355"],
        ["Arestin (D4381)", "D4381"],
        ["Perio Maintenance (D4910)", "D4910"]
      ],
      "REMOVABLE PROSTHO": [
        ["Over Denture Complete (D5860)", "D5860"],
        ["Dentures (D5110)", "D5110"],
        ["Reline maxillary partial denture (direct) (D5740)", "D5740"],
        ["Surgical stent (D5982)", "D5982"]
      ],
      IMPLANT: [
        ["Implant (D6194)", "D6194"],
        ["Implant Body (D6010)", "D6010"],
        ["Implant Abutment (D6056)", "D6056"],
        ["Implant Crown (D6065)", "D6065"]
      ],
      "FIXED PROSTHO": [
        ["Pontic - porcelain/ceramic (D6245)", "D6245"]
      ],
      "ORAL SURGERY": [
        ["Nerve dissection (D7259)", "D7259"],
        ["Simple Extraction (D7140)", "D7140"],
        ["Impacted Extraction (D7240)", "D7240"]
      ],
      ORTHODONTICS: [
        ["Ortho (D8010)", "D8010"],
        ["Ortho (D8080)", "D8080"],
        ["Ortho (D8090)", "D8090"]
      ],
      ADJUNCTIVE: [
        ["Office visit for observation (D9430)", "D9430"],
        ["Palliative (D9110)", "D9110"],
        ["Gen Anesthesia (D9222)", "D9222"],
        ["sedation/analgesia (D9239)", "D9239"],
        ["Consult (D9310)", "D9310"],
        ["Occlusal Guard (D9944)", "D9944"]
      ]
    };

    function classifyEndpoint(url) {
      const text = String(url || "");
      for (const [key, pattern] of ENDPOINT_PATTERNS) {
        if (pattern.test(text)) return key;
      }
      return null;
    }

    function safeUrl(url) {
      try {
        return new URL(String(url), typeof location !== "undefined" ? location.href : "https://providers.dentaquest.com/");
      } catch (_) {
        return null;
      }
    }

    function isObject(value) {
      return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    function clean(value) {
      if (value === null || value === undefined) return "";
      return String(value).replace(/\s+/g, " ").trim();
    }

    function present(value) {
      return value !== null && value !== undefined && clean(value) !== "";
    }

    function firstPresent(...values) {
      for (const value of values) {
        if (present(value)) return value;
      }
      return null;
    }

    function titleCaseName(value) {
      const text = clean(value);
      if (!text) return MISSING;
      if (/[a-z]/.test(text)) return text;
      return text.toLowerCase().replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
    }

    function fullName(first, last, fallback) {
      const joined = [clean(first), clean(last)].filter(Boolean).join(" ");
      return titleCaseName(joined || fallback);
    }

    function parseNumber(value) {
      if (value === null || value === undefined || value === "") return null;
      const number = Number(String(value).replace(/[$,%\s,]/g, ""));
      return Number.isFinite(number) ? number : null;
    }

    function money(value) {
      const number = parseNumber(value);
      if (number === null) return MISSING;
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      }).format(number);
    }

    function percentage(value) {
      const number = parseNumber(value);
      return number === null ? MISSING : `${number}%`;
    }

    function subtractMoney(total, used) {
      const totalNumber = parseNumber(total);
      const usedNumber = parseNumber(used);
      if (totalNumber === null || usedNumber === null) return MISSING;
      return money(Math.max(0, totalNumber - usedNumber));
    }

    function normalizeDate(value) {
      const text = clean(value);
      if (!text) return MISSING;
      if (/^9999-12-31/.test(text)) return "No termination date (active)";
      return text;
    }

    function monthFromPlanYear(planYear) {
      const text = clean(planYear);
      const match = text.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/);
      if (!match) return MISSING;
      const monthIndex = Number(match[1]) - 1;
      if (monthIndex < 0 || monthIndex > 11) return MISSING;
      return new Intl.DateTimeFormat("en-US", { month: "long" }).format(new Date(2000, monthIndex, 1));
    }

    function getBenefitItems(planBenefitSummary) {
      if (Array.isArray(planBenefitSummary)) return planBenefitSummary;
      if (isObject(planBenefitSummary) && Array.isArray(planBenefitSummary.benefitSummaryItems)) {
        return planBenefitSummary.benefitSummaryItems;
      }
      return [];
    }

    function indexProcedures(items) {
      const map = new Map();
      for (const item of items) {
        const code = clean(item && item.procedureCode).toUpperCase();
        if (code && !map.has(code)) map.set(code, item);
      }
      return map;
    }

    function getMemberProfileGuid(urls) {
      for (const url of Object.values(urls || {})) {
        const match = String(url || "").match(/\/member-detail\/([0-9a-f-]{36})\//i);
        if (match) return match[1];
      }
      const pageMatch = typeof location !== "undefined"
        ? location.pathname.match(/\/member-details\/([0-9a-f-]{36})/i)
        : null;
      return pageMatch ? pageMatch[1] : null;
    }

    function getIsInNetwork(urls) {
      for (const key of ["planBenefitSummary", "maximumDeductible"]) {
        const parsed = safeUrl(urls && urls[key]);
        if (parsed && parsed.searchParams.has("isInNetwork")) {
          return parsed.searchParams.get("isInNetwork") === "true";
        }
      }
      return null;
    }

    function findFamilyMember(familyInfo, memberInfo, memberEligibility, memberProfileGuid) {
      const family = Array.isArray(familyInfo) ? familyInfo : [];
      if (memberProfileGuid) {
        const exact = family.find((person) => clean(person && person.id).toLowerCase() === memberProfileGuid.toLowerCase());
        if (exact) return exact;
      }
      const patientName = clean(firstPresent(
        memberEligibility && memberEligibility.memberName,
        [memberInfo && memberInfo.firstName, memberInfo && memberInfo.lastName].filter(Boolean).join(" ")
      )).toLowerCase();
      const patientDob = clean(firstPresent(
        memberEligibility && memberEligibility.memberDateOfBirth,
        memberInfo && memberInfo.dateOfBirth
      ));
      return family.find((person) => {
        const sameName = patientName && clean(person && person.name).toLowerCase() === patientName;
        const sameDob = patientDob && clean(person && person.dateOfBirth) === patientDob;
        return sameName || (sameDob && patientName === clean(person && person.name).toLowerCase());
      }) || null;
    }

    function findSubscriber(familyInfo) {
      const family = Array.isArray(familyInfo) ? familyInfo : [];
      return family.find((person) => /subscriber/i.test(clean(person && person.relationship))) || null;
    }

    function findMaximum(maximumDeductible, pattern) {
      const rows = Array.isArray(maximumDeductible) ? maximumDeductible : [];
      return rows.find((row) => pattern.test(clean(row && row.benefitName))) || null;
    }

    function compactUnique(values) {
      return [...new Set(values.map(clean).filter(Boolean))];
    }

    function extractCodesFromFrequency(frequencyText) {
      const text = clean(frequencyText).toUpperCase();
      return compactUnique(text.match(/D\d{4}/g) || []);
    }

    function sharesFrequency(procedureMap, baseCode, comparedCodes) {
      const item = procedureMap.get(baseCode);
      if (!item) return `${MISSING}: ${baseCode}`;
      const included = new Set(extractCodesFromFrequency(item.frequencyPeriodDescription));
      const shared = comparedCodes.every((code) => included.has(code));
      return shared
        ? `Yes — ${clean(item.frequencyPeriodDescription)}`
        : `No explicit shared frequency found — ${clean(item.frequencyPeriodDescription) || NOT_STATED}`;
    }

    function procedureHistory(clinicalHistory, code) {
      const history = Array.isArray(clinicalHistory) ? clinicalHistory : [];
      return history
        .filter((entry) => clean(entry && entry.procedureCode).toUpperCase() === code)
        .sort((a, b) => clean(b.dateOfService).localeCompare(clean(a.dateOfService)))
        .map((entry) => ({
          "Date of Service": normalizeDate(entry.dateOfService),
          "Procedure Code": clean(entry.procedureCode) || code,
          "Procedure Description": clean(entry.procedureDescription) || MISSING,
          "Part of Mouth": clean(entry.partOfMouth) || MISSING,
          "Tooth": clean(entry.toothCode) || MISSING,
          "Arch": clean(entry.archCode) || MISSING,
          "Quadrant": clean(entry.quadCode) || MISSING,
          "Surface": clean(entry.surface) || MISSING,
          "Place of Treatment": clean(entry.placeOfTreatment) || MISSING
        }));
    }

    function coverageStatus(item, inNetwork) {
      if (!item) return MISSING;
      const selected = parseNumber(inNetwork === false ? item.outNetworkCoinsurance : item.inNetworkCoinsurance);
      const fallback = parseNumber(item.coinsurance);
      const percent = selected === null ? fallback : selected;
      if (percent === 0) return "Not covered (0% benefit)";
      if (percent !== null) return "Covered";
      return "Benefit record found";
    }

    function buildProcedureRecord(code, procedureMap, clinicalHistory, inNetwork) {
      const item = procedureMap.get(code);
      if (!item) {
        return {
          "Status": MISSING,
          "Procedure Code": code,
          "Coverage Percentage": MISSING,
          "In-Network Coverage": MISSING,
          "Out-of-Network Coverage": MISSING,
          "Frequency": MISSING,
          "Age Limit": MISSING,
          "Deductible Applies": MISSING,
          "Waiting Period (Standard)": MISSING,
          "Waiting Period (Late Entrant)": MISSING,
          "Teeth/Area Covered": MISSING,
          "Narrative/Limitations": MISSING,
          "Review Required": MISSING,
          "Documentation Required": MISSING,
          "Maximum Applies": MISSING,
          "Copay": MISSING,
          "Service History Count": 0,
          "Service History": []
        };
      }

      const history = procedureHistory(clinicalHistory, code);
      const selectedCoverage = inNetwork === false
        ? firstPresent(item.outNetworkCoinsurance, item.coinsurance)
        : firstPresent(item.inNetworkCoinsurance, item.coinsurance);

      return {
        "Status": coverageStatus(item, inNetwork),
        "Procedure Code": code,
        "Procedure Class": clean(item.procedureClass) || MISSING,
        "Procedure Description": clean(item.procedureDescription) || MISSING,
        "Coverage Percentage": percentage(selectedCoverage),
        "In-Network Coverage": percentage(item.inNetworkCoinsurance),
        "Out-of-Network Coverage": percentage(item.outNetworkCoinsurance),
        "Frequency": clean(item.frequencyPeriodDescription) || NOT_STATED,
        "Age Limit": clean(item.ageRange) || NOT_STATED,
        "Deductible Applies": clean(item.deductibleApplies) || NOT_STATED,
        "Waiting Period (Standard)": `${parseNumber(item.waitingPeriodDays) ?? 0} day(s)`,
        "Waiting Period (Late Entrant)": `${parseNumber(item.waitingPeriodDaysLate) ?? 0} day(s)`,
        "Waiting Period Satisfied Date": normalizeDate(item.waitingPeriodSatisfiedDate),
        "Teeth/Area Covered": clean(item.teethCovered) || NOT_STATED,
        "Narrative/Limitations": clean(item.narrative) || NOT_STATED,
        "Review Required": clean(item.reviewRequired) || NOT_STATED,
        "Documentation Required": clean(item.documentationRequired) || NOT_STATED,
        "Maximum Applies": clean(item.maxApplies) || NOT_STATED,
        "Out-of-Pocket Maximum Applies": clean(item.outOfPocketMaxApplies) || NOT_STATED,
        "Copay": money(firstPresent(
          inNetwork === false ? item.outNetworkCopayAmount : item.inNetworkCopayAmount,
          item.copayAmount
        )),
        "Copay Age Range": clean(item.copayAgeRange) || NOT_STATED,
        "Medical Conditions": clean(item.medicalConditions) || NOT_STATED,
        "Service History Count": history.length,
        "Last Service Date": history.length ? history[0]["Date of Service"] : "No matching history found",
        "Service History": history
      };
    }

    function hasDeductibleForClasses(items, classPatterns) {
      const relevant = items.filter((item) => classPatterns.some((pattern) => pattern.test(clean(item.procedureClass))));
      if (!relevant.length) return MISSING;
      const applies = relevant.some((item) => !/^(not applicable|no|none)$/i.test(clean(item.deductibleApplies)));
      const evidence = compactUnique(relevant.map((item) => item.deductibleApplies));
      return `${applies ? "Yes" : "No"} — ${evidence.join("; ") || NOT_STATED}`;
    }

    function waitingPeriodSummary(items, enrollmentHistory, memberInfo) {
      const enrollment = Array.isArray(enrollmentHistory) ? enrollmentHistory[0] : null;
      const isTimely = firstPresent(
        enrollment && enrollment.timelyLateOverrides && enrollment.timelyLateOverrides.isTimely,
        enrollment && enrollment.timelyLateDefault && enrollment.timelyLateDefault.isSubscriberTimely,
        memberInfo && memberInfo.isTimely
      );
      const timely = isTimely === null ? null : Boolean(isTimely);

      const standardMax = Math.max(0, ...items.map((item) => parseNumber(item.waitingPeriodDays) || 0));
      const lateMax = Math.max(0, ...items.map((item) => parseNumber(item.waitingPeriodDaysLate) || 0));
      const currentMax = timely === false ? lateMax : standardMax;
      const currentClasses = compactUnique(items
        .filter((item) => (timely === false
          ? (parseNumber(item.waitingPeriodDaysLate) || 0)
          : (parseNumber(item.waitingPeriodDays) || 0)) > 0)
        .map((item) => item.procedureClass));
      const lateClasses = compactUnique(items
        .filter((item) => (parseNumber(item.waitingPeriodDaysLate) || 0) > 0)
        .map((item) => item.procedureClass));

      return {
        "Is there a Waiting Period": currentMax > 0 ? "Yes" : "No",
        "Period": `${currentMax} day(s)${lateMax > currentMax ? `; late entrant maximum ${lateMax} day(s)` : ""}`,
        "Applies to": currentClasses.length ? currentClasses.join(", ") : "No classes for the current timely-member rule",
        "Member Timely Status": timely === null ? MISSING : (timely ? "Timely" : "Late entrant"),
        "Late Entrant Waiting Period Applies To": lateClasses.length ? lateClasses.join(", ") : "None found"
      };
    }

    function majorPrepOrSeat(items) {
      const majorClass = /(crowns|bridges|dentures|implants|inlays|onlays|prosthetic)/i;
      const relevant = items.filter((item) => majorClass.test(clean(item.procedureClass)));
      const evidence = relevant.filter((item) => /\b(prep(?:aration)?|seat(?:ed|ing)?|insertion)\b/i.test(
        `${clean(item.narrative)} ${clean(item.frequencyPeriodDescription)} ${clean(item.documentationRequired)}`
      ));
      if (!evidence.length) return NOT_STATED;
      return evidence.map((item) => `${item.procedureCode}: ${clean(item.narrative) || clean(item.frequencyPeriodDescription)}`).join(" | ");
    }

    function posteriorCompositeDowngrade(items) {
      const evidence = items.filter((item) =>
        /^D239[1-4]$/i.test(clean(item.procedureCode)) &&
        /(alternate benefit|downgrade|amalgam)/i.test(clean(item.narrative))
      );
      if (!evidence.length) return "No explicit posterior-composite downgrade language found";
      return `Yes — ${evidence.map((item) => `${item.procedureCode}: ${clean(item.narrative)}`).join(" | ")}`;
    }

    function porcelainCrownDowngrade(items, procedureMap) {
      const d2740 = procedureMap.get("D2740");
      const d2740Evidence = d2740 && /(alternate benefit|downgrade|posterior)/i.test(clean(d2740.narrative));
      const planEvidence = items.filter((item) =>
        /crowns/i.test(clean(item.procedureClass)) &&
        /(porcelain|ceramic)/i.test(`${clean(item.procedureDescription)} ${clean(item.procedureCode)}`) &&
        /(alternate benefit|posterior teeth.*excluded|downgrade)/i.test(clean(item.narrative))
      );
      if (d2740Evidence) return `Yes — D2740: ${clean(d2740.narrative)}`;
      if (planEvidence.length) {
        return `Yes at plan level — explicit posterior alternate-benefit language appears on ${planEvidence.map((item) => item.procedureCode).join(", ")}; D2740 itself has no explicit narrative`;
      }
      return "No explicit porcelain-crown downgrade language found";
    }

    function buildupSameDay(procedureMap) {
      const buildup = procedureMap.get("D2950");
      if (!buildup) return `${MISSING}: D2950`;
      const text = `${clean(buildup.narrative)} ${clean(buildup.frequencyPeriodDescription)} ${clean(buildup.documentationRequired)}`;
      if (/same\s+(day|date)/i.test(text)) return `Yes — ${text}`;
      if (/different\s+(day|date)|not\s+same\s+(day|date)/i.test(text)) return `No — ${text}`;
      return NOT_STATED;
    }

    function sealantRestriction(procedureMap) {
      const item = procedureMap.get("D1351");
      if (!item) return `${MISSING}: D1351`;
      const teeth = clean(item.teethCovered);
      const permanentMolars = /permanent\s+molars/i.test(teeth);
      const unrestored = /un[- ]?restored|unrestored/i.test(`${teeth} ${clean(item.narrative)}`);
      if (permanentMolars && unrestored) return "Yes — permanent un-restored molars only";
      if (permanentMolars) return "Permanent molars only; an un-restored-tooth restriction is not stated";
      return `No explicit permanent-molar-only restriction — ${teeth || NOT_STATED}`;
    }

    function d4341Quadrants(procedureMap) {
      const item = procedureMap.get("D4341");
      if (!item) return `${MISSING}: D4341`;
      const quadrants = compactUnique(clean(item.teethCovered).match(/\b(?:UL|UR|LL|LR)\b/g) || []);
      if (quadrants.length) {
        return `${quadrants.length} quadrant(s) listed (${quadrants.join(", ")}); no per-day quadrant limit is stated`;
      }
      return NOT_STATED;
    }

    function orthoAgeLimit(procedureMap) {
      const ages = ["D8010", "D8080", "D8090"]
        .map((code) => procedureMap.get(code))
        .filter(Boolean)
        .map((item) => clean(item.ageRange));
      if (!ages.length) return MISSING;
      const numbers = ages.flatMap((age) => [...age.matchAll(/\d+/g)].map((match) => Number(match[0])));
      return numbers.length ? `${Math.max(...numbers)} years` : compactUnique(ages).join("; ");
    }

    function orthoPaymentFrequency(items, clinicalHistory) {
      const explicit = items.filter((item) =>
        /orthodontics/i.test(clean(item.procedureClass)) &&
        /(monthly|quarterly|installment|payment)/i.test(`${clean(item.narrative)} ${clean(item.frequencyPeriodDescription)}`)
      );
      if (explicit.length) {
        return explicit.map((item) => `${item.procedureCode}: ${clean(item.narrative) || clean(item.frequencyPeriodDescription)}`).join(" | ");
      }

      const historyDates = (Array.isArray(clinicalHistory) ? clinicalHistory : [])
        .filter((entry) => /^(D8\d{3}|D8570)$/i.test(clean(entry.procedureCode)))
        .map((entry) => clean(entry.dateOfService))
        .filter(Boolean)
        .sort();
      if (historyDates.length >= 3) {
        return `Not provided by the plan; observed orthodontic claim dates include ${historyDates.join(", ")} (claim cadence is not a payment-frequency guarantee)`;
      }
      return MISSING;
    }

    function deriveInsuranceName(memberEligibility, enrollmentHistory, familyInfo) {
      const enrollment = Array.isArray(enrollmentHistory) ? enrollmentHistory[0] : null;
      const family = Array.isArray(familyInfo) ? familyInfo[0] : null;
      const source = clean(firstPresent(
        memberEligibility && memberEligibility.memberPlanName,
        enrollment && enrollment.planName,
        family && family.planName
      ));
      if (/sun\s*life/i.test(source)) return "Sun Life";
      return source || MISSING;
    }

    function missingToothClause(planInfo) {
      const value = clean(planInfo && planInfo.missingTeeth);
      if (!value) return MISSING;
      if (/not covered|excluded|applies|yes/i.test(value)) return `Yes — ${value}`;
      if (/not applicable|does not apply|no/i.test(value)) return `No — ${value}`;
      return value;
    }

    function getDomFallbackValue(domFallback, key) {
      return clean(domFallback && domFallback[key]) || MISSING;
    }

    function deduplicateObjects(arr) {
      if (!Array.isArray(arr)) return arr;
      const seen = new Set();
      return arr.filter(item => {
        const stringified = JSON.stringify(item);
        if (seen.has(stringified)) return false;
        seen.add(stringified);
        return true;
      });
    }

    function buildExtraction(rawInput, urlsInput, domFallbackInput) {
      const raw = rawInput || {};
      const urls = urlsInput || {};
      const domFallback = domFallbackInput || {};

      const memberInfo = isObject(raw.memberInfo) ? raw.memberInfo : {};
      const planInfo = isObject(raw.planInfo) ? raw.planInfo : {};
      const memberEligibility = isObject(raw.memberEligibility) ? raw.memberEligibility : {};
      const familyInfo = deduplicateObjects(Array.isArray(raw.familyInfo) ? raw.familyInfo : []);
      const enrollmentHistory = Array.isArray(raw.enrollmentHistory) ? raw.enrollmentHistory : [];
      const clinicalHistory = Array.isArray(raw.clinicalHistory) ? raw.clinicalHistory : [];
      const maximumDeductible = deduplicateObjects(Array.isArray(raw.maximumDeductible) ? raw.maximumDeductible : []);
      const coordinationOfBenefits = deduplicateObjects(Array.isArray(raw.coordinationOfBenefits) ? raw.coordinationOfBenefits : []);
      const items = getBenefitItems(raw.planBenefitSummary);
      const procedureMap = indexProcedures(items);
      const memberProfileGuid = getMemberProfileGuid(urls);
      const patientFamily = findFamilyMember(familyInfo, memberInfo, memberEligibility, memberProfileGuid);
      const subscriber = findSubscriber(familyInfo);
      const enrollment = enrollmentHistory[0] || {};
      const isInNetwork = getIsInNetwork(urls);

      const annualMaximum = findMaximum(maximumDeductible, /individual\s+annual\s+maximum/i);
      const individualDeductible = findMaximum(maximumDeductible, /individual\s+deductible/i);
      const familyDeductible = findMaximum(maximumDeductible, /family\s+deductible/i);
      const orthoDeductible = findMaximum(maximumDeductible, /orthodont.*deductible/i);
      const orthoMaximum = findMaximum(maximumDeductible, /orthodont.*(?:lifetime\s+)?maximum/i);
      const waiting = waitingPeriodSummary(items, enrollmentHistory, memberInfo);

      const patientName = fullName(
        memberInfo.firstName,
        memberInfo.lastName,
        firstPresent(memberEligibility.memberName, patientFamily && patientFamily.name)
      );

      const relation = clean(firstPresent(patientFamily && patientFamily.relationship, domFallback.relationToSubscriber)) || MISSING;
      const subscriberName = titleCaseName(firstPresent(subscriber && subscriber.name, domFallback.subscriberName));
      const planNetworkName = clean(firstPresent(
        memberEligibility.memberPlanName,
        enrollment.planName,
        patientFamily && patientFamily.planName,
        planInfo.networkName
      )) || MISSING;

      const providerNetworkStatus = isInNetwork === true
        ? `In Network${present(memberEligibility.networkName) ? ` — ${clean(memberEligibility.networkName)}` : ""}`
        : isInNetwork === false
          ? `Out of Network${present(memberEligibility.networkName) ? ` — ${clean(memberEligibility.networkName)}` : ""}`
          : (present(memberEligibility.networkName) ? `Network found — ${clean(memberEligibility.networkName)}; in/out status not explicit` : MISSING);

      const feeSchedule = clean(firstPresent(
        memberEligibility.feeScheduleId,
        planInfo.feeScheduleId,
        domFallback.feeSchedule
      )) || "Not provided (feeScheduleId is blank)";

      const orthoItems = items.filter((item) => /orthodontics/i.test(clean(item.procedureClass)));
      const allOrthoDeductibleNotApplicable = orthoItems.length > 0 && orthoItems.every((item) => /not applicable/i.test(clean(item.deductibleApplies)));

      const output = {
        "Extraction Metadata": {
          "Extractor": SOURCE,
          "Version": VERSION,
          "Extracted At": new Date().toISOString(),
          "Portal": typeof location !== "undefined" ? location.origin : "https://providers.dentaquest.com",
          "Member Profile GUID": memberProfileGuid || MISSING,
          "Network Context": isInNetwork === true ? "In Network" : isInNetwork === false ? "Out of Network" : MISSING,
          "Captured Endpoints": Object.keys(raw).filter((key) => raw[key] !== undefined),
          "Missing Core Endpoints": CORE_ENDPOINTS.filter((key) => raw[key] === undefined)
        },

        "Patient/Subscriber Information": {
          "Patient Name": patientName,
          "Date of Birth of the Patient": normalizeDate(firstPresent(
            memberInfo.dateOfBirth,
            memberEligibility.memberDateOfBirth,
            patientFamily && patientFamily.dateOfBirth
          )),
          "Member ID": clean(firstPresent(memberInfo.memberId, memberEligibility.memberId, planInfo.memberId)) || MISSING,
          "Relation to Subscriber": relation,
          "Subscriber Name": subscriberName,
          "Subscriber DOB": normalizeDate(firstPresent(subscriber && subscriber.dateOfBirth, domFallback.subscriberDateOfBirth)),
          "SSN": getDomFallbackValue(domFallback, "ssn"),
          "Family Members": deduplicateObjects(familyInfo)
        },

        "Insurance Information": {
          "Insurance Name": deriveInsuranceName(memberEligibility, enrollmentHistory, familyInfo),
          "Plan/Network Name": planNetworkName,
          "Product": clean(firstPresent(memberEligibility.productNew, planInfo.productNew, enrollment.productNew)) || MISSING,
          "Product Category": clean(firstPresent(memberEligibility.productCategory, planInfo.productCategory, enrollment.productCategory)) || MISSING,
          "Group Name": clean(firstPresent(
            planInfo.parsedParentGroupName,
            memberEligibility.parsedParentGroupName,
            enrollment.parsedParentGroupName,
            planInfo.productRelatedGroupName
          )) || MISSING,
          "Group Number": clean(firstPresent(
            planInfo.parsedParentGroupNumber,
            memberEligibility.parsedParentGroupNumber,
            enrollment.parsedParentGroupNumber,
            planInfo.productRelatedGroupNumber
          )) || MISSING,
          "Subgroup Name": clean(firstPresent(planInfo.parsedSubGroupName, memberEligibility.parsedSubGroupName, enrollment.parsedSubGroupName)) || MISSING,
          "Subgroup Number": clean(firstPresent(planInfo.parsedSubGroupNumber, memberEligibility.parsedSubGroupNumber, enrollment.parsedSubGroupNumber)) || MISSING,
          "Fee Schedule": feeSchedule,
          "Insurance Address": getDomFallbackValue(domFallback, "insuranceAddress"),
          "Insurance Phone": getDomFallbackValue(domFallback, "insurancePhone"),
          "Provider Network Status": providerNetworkStatus,
          "Network Contract": clean(firstPresent(
            memberEligibility.networkContractNew,
            planInfo.networkContractNew,
            planInfo.networkContract
          )) || MISSING,
          "Network Contract Owner": clean(firstPresent(
            memberEligibility.networkContractOwnerNew,
            planInfo.networkContractOwnerNew,
            planInfo.contractOwner
          )) || MISSING,
          "Patient Eff Date": normalizeDate(firstPresent(
            patientFamily && patientFamily.effectiveDate,
            enrollment.effectiveDate
          )),
          "Patient Term Date": normalizeDate(firstPresent(
            patientFamily && patientFamily.terminationDate,
            enrollment.terminationDate
          )),
          "Starting Month of Plan Year": monthFromPlanYear(planInfo.planYear),
          "Plan Year": clean(planInfo.planYear) || MISSING,
          "Payor ID": getDomFallbackValue(domFallback, "payorId")
        },

        "Eligibility Notes": {
          "Member Eligibility Status": clean(memberEligibility.memberEligibilityStatus) || clean(patientFamily && patientFamily.status) || MISSING,
          "Eligibility Status Last Updated": normalizeDate(memberEligibility.memberEligibilityStatusLastUpdated),
          "Date of Service": normalizeDate(firstPresent(memberEligibility.dateOfService, enrollment.effectiveDate)),
          "Coverage Level": clean(firstPresent(memberEligibility.memberCoverageLevel, memberEligibility.memberCoverageType)) || MISSING,
          "Provider/Practitioner": titleCaseName(memberEligibility.practitionerName),
          "Service Location": clean(memberEligibility.locationAddress) || MISSING,
          "Member Timely Status": waiting["Member Timely Status"],
          "Missing Tooth Information": clean(planInfo.missingTeeth) || MISSING,
          "Coordination of Benefits": coordinationOfBenefits.length ? coordinationOfBenefits : "No coordination-of-benefits records returned",
          "Coordination of Benefits Records": deduplicateObjects(coordinationOfBenefits),
          "Notes": compactUnique([
            present(memberEligibility.memberEligibilityStatus) ? `Eligibility is ${clean(memberEligibility.memberEligibilityStatus)}.` : "",
            present(memberEligibility.productNew) ? `Product is ${clean(memberEligibility.productNew)} (${clean(memberEligibility.productCategory) || "category not stated"}).` : "",
            present(memberEligibility.networkName) ? `Network is ${clean(memberEligibility.networkName)}.` : "",
            waiting["Is there a Waiting Period"] === "No" ? "No current-member waiting period was found." : `Current waiting period: ${waiting.Period}.`,
            clean(planInfo.missingTeeth) ? `Missing tooth field: ${clean(planInfo.missingTeeth)}.` : ""
          ]).join(" ") || MISSING
        },

        "Coverage and Maximums": {
          "Yearly Maximum": annualMaximum ? money(annualMaximum.benefitAmount) : MISSING,
          "Remaining": annualMaximum ? subtractMoney(annualMaximum.benefitAmount, annualMaximum.benefitApplied) : MISSING,
          "Individual Deductible Paid to Date": individualDeductible ? money(individualDeductible.benefitApplied) : MISSING,
          "Individual Deductible Remaining": individualDeductible ? subtractMoney(individualDeductible.benefitAmount, individualDeductible.benefitApplied) : MISSING,
          "Family Deductible Paid to Date": familyDeductible ? money(familyDeductible.benefitApplied) : MISSING,
          "Family Deductible Remaining": familyDeductible ? subtractMoney(familyDeductible.benefitAmount, familyDeductible.benefitApplied) : MISSING,
          "Deductible Applies to Preventive": hasDeductibleForClasses(items, [
            /preventive\/diagnostic/i,
            /routine cleanings/i,
            /fluoride/i,
            /sealants/i,
            /space maintainers/i
          ]),
          "Deductible Applies to Diagnostic": hasDeductibleForClasses(items, [
            /oral exams/i,
            /xray/i
          ]),
          "Is there a Waiting Period": waiting["Is there a Waiting Period"],
          "Period": waiting.Period,
          "Applies to": waiting["Applies to"],
          "Are Major Services Paid on Prep": majorPrepOrSeat(items),
          "Or Seat": majorPrepOrSeat(items),
          "Does Missing Tooth Clause Apply?": missingToothClause(planInfo),
          "Dependent Age Limit": getDomFallbackValue(domFallback, "dependentAgeLimit"),
          "Orthodontic Deductible": orthoDeductible
            ? money(orthoDeductible.benefitAmount)
            : allOrthoDeductibleNotApplicable ? NOT_APPLICABLE : MISSING,
          "Orthodontic Deductible Paid to Date": orthoDeductible
            ? money(orthoDeductible.benefitApplied)
            : allOrthoDeductibleNotApplicable ? NOT_APPLICABLE : MISSING,
          "Orthodontic Maximum": orthoMaximum ? money(orthoMaximum.benefitAmount) : MISSING,
          "Orthodontic Maximum Paid to Date": orthoMaximum ? money(orthoMaximum.benefitApplied) : MISSING,
          "All Maximums and Deductibles": deduplicateObjects(maximumDeductible)
        },

        "General Benefit Categories": {
          "All Clinical History": allClinicalHistory
        }
      };

      for (const [category, definitions] of Object.entries(PROCEDURE_GROUPS)) {
        const categoryOutput = {};
        for (const [label, code] of definitions) {
          categoryOutput[label] = buildProcedureRecord(code, procedureMap, clinicalHistory, isInNetwork);
        }
        output["General Benefit Categories"][category] = categoryOutput;
      }

      output["General Benefit Categories"].EXAMS["Do D0120,D0150 Share a frequency with D0140?"] =
        sharesFrequency(procedureMap, "D0120", ["D0120", "D0150", "D0140"]);

      output["General Benefit Categories"].PREVENTATIVE["Permanent Un-restored Molars only?"] =
        sealantRestriction(procedureMap);

      output["General Benefit Categories"]["BASIC RESTORATIVE"]["Posterior composites downgraded to amalgam?"] =
        posteriorCompositeDowngrade(items);

      output["General Benefit Categories"]["MAJOR RESTORATIVE"]["Porcelain crowns downgraded on posterior teeth"] =
        porcelainCrownDowngrade(items, procedureMap);

      output["General Benefit Categories"]["MAJOR RESTORATIVE"]["Can D2950 be done same day as crown?"] =
        buildupSameDay(procedureMap);

      output["General Benefit Categories"].PERIODONTICS["Number of quads for the code D4341"] =
        d4341Quadrants(procedureMap);

      output["General Benefit Categories"].PERIODONTICS["Do D4910 and D1110 share a frequency?"] =
        sharesFrequency(procedureMap, "D4910", ["D4910", "D1110"]);

      output["General Benefit Categories"].ORTHODONTICS["Payment Frequency"] =
        orthoPaymentFrequency(items, clinicalHistory);

      output["General Benefit Categories"].ORTHODONTICS["Ortho Age Limit"] =
        orthoAgeLimit(procedureMap);

      return output;
    }

    function findJsonTokens(value, depth, results) {
      if (depth > 8 || value === null || value === undefined) return;
      if (typeof value === "string") {
        const text = value.trim();
        if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(text)) results.push(text);
        if ((text.startsWith("{") || text.startsWith("[")) && text.length < 2_000_000) {
          try { findJsonTokens(JSON.parse(text), depth + 1, results); } catch (_) { /* ignore */ }
        }
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((item) => findJsonTokens(item, depth + 1, results));
        return;
      }
      if (isObject(value)) {
        for (const [key, nested] of Object.entries(value)) {
          if (/^(accessToken|access_token|idToken|id_token|token)$/i.test(key)) {
            if (typeof nested === "string") results.push(nested);
            else if (isObject(nested)) {
              for (const candidate of Object.values(nested)) {
                if (typeof candidate === "string") results.push(candidate);
              }
            }
          }
          findJsonTokens(nested, depth + 1, results);
        }
      }
    }

    function discoverSessionToken() {
      const candidates = [];
      if (capturedAuthorization) candidates.push(capturedAuthorization.replace(/^Bearer\s+/i, ""));
      for (const storage of [typeof localStorage !== "undefined" ? localStorage : null, typeof sessionStorage !== "undefined" ? sessionStorage : null]) {
        if (!storage) continue;
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index);
          if (!key) continue;
          const value = storage.getItem(key);
          if (value) findJsonTokens(value, 0, candidates);
        }
      }
      const cleaned = compactUnique(candidates.map((token) => token.replace(/^Bearer\s+/i, "")));
      const jwt = cleaned.find((token) => /^eyJ.+\..+\..+$/.test(token));
      return jwt || cleaned[0] || null;
    }

    function readDomLabelValue(labelPatterns) {
      if (typeof document === "undefined" || !document.body) return "";
      const selectors = "dt, th, td, label, span, div, p, strong, b";
      const nodes = [...document.body.querySelectorAll(selectors)];
      for (const node of nodes) {
        const label = clean(node.textContent);
        if (!label || label.length > 120) continue;
        if (!labelPatterns.some((pattern) => pattern.test(label))) continue;

        const ariaControls = node.getAttribute && node.getAttribute("aria-controls");
        if (ariaControls) {
          const controlled = document.getElementById(ariaControls);
          if (controlled && clean(controlled.textContent)) return clean(controlled.textContent);
        }

        const sibling = node.nextElementSibling;
        if (sibling && clean(sibling.textContent) && clean(sibling.textContent) !== label) {
          return clean(sibling.textContent);
        }

        const parent = node.parentElement;
        if (parent) {
          const children = [...parent.children].filter((child) => child !== node);
          const candidate = children.map((child) => clean(child.textContent)).find((text) => text && text !== label);
          if (candidate) return candidate;
        }
      }

      const text = document.body.innerText || "";
      for (const pattern of labelPatterns) {
        const source = pattern.source.replace(/^\^|\$$/g, "");
        const match = text.match(new RegExp(`(?:${source})\\s*[:\\n]\\s*([^\\n]{1,120})`, "i"));
        if (match) return clean(match[1]);
      }
      return "";
    }

    function collectDomFallback() {
      return {
        ssn: readDomLabelValue([/^SSN$/i, /social security number/i]),
        subscriberName: readDomLabelValue([/^subscriber name$/i]),
        subscriberDateOfBirth: readDomLabelValue([/subscriber.*date of birth/i, /subscriber.*DOB/i]),
        relationToSubscriber: readDomLabelValue([/relation(?:ship)? to subscriber/i]),
        insuranceAddress: readDomLabelValue([/insurance address/i, /payer address/i, /payor address/i]),
        insurancePhone: readDomLabelValue([/insurance phone/i, /payer phone/i, /payor phone/i]),
        payorId: readDomLabelValue([/payor id/i, /payer id/i]),
        feeSchedule: readDomLabelValue([/fee schedule/i]),
        dependentAgeLimit: readDomLabelValue([/dependent age limit/i, /dependent.*age/i])
      };
    }

    const coreApi = {
      VERSION,
      SOURCE,
      MISSING,
      classifyEndpoint,
      buildExtraction,
      collectDomFallback,
      discoverSessionToken
    };

    if (testMode) return coreApi;
    if (typeof window === "undefined" || typeof document === "undefined") return coreApi;
    if (!/^(providers\.)?dentaquest\.com$/i.test(location.hostname)) return coreApi;
    if (window.__DENTAQUEST_EXTRACTOR__ && window.__DENTAQUEST_EXTRACTOR__.version === VERSION) {
      return window.__DENTAQUEST_EXTRACTOR__;
    }

    document.documentElement.setAttribute("data-dentaquest-extractor-main-ready", VERSION);

    const state = {
      data: Object.create(null),
      urls: Object.create(null),
      capturedAt: Object.create(null),
      errors: [],
      panel: null,
      statusNode: null,
      lastOutput: null,
      recovering: false,
      observedApiUrls: new Set()
    };

    function updateStatus() {
      if (!state.statusNode) return;
      const capturedCore = CORE_ENDPOINTS.filter((key) => state.data[key] !== undefined).length;
      const all = Object.keys(state.data).length;
      const missing = CORE_ENDPOINTS.filter((key) => state.data[key] === undefined);
      state.statusNode.textContent = missing.length
        ? `Captured ${capturedCore}/${CORE_ENDPOINTS.length} core APIs (${all} total). ${missing.join(", ")} pending.`
        : `Ready: all ${CORE_ENDPOINTS.length} core APIs captured (${all} total).`;
      state.statusNode.setAttribute("data-ready", missing.length ? "false" : "true");
    }

    function capture(url, data) {
      const key = classifyEndpoint(url);
      if (!key) return;
      state.observedApiUrls.add(String(url));
      state.data[key] = data;
      state.urls[key] = String(url);
      state.capturedAt[key] = new Date().toISOString();
      updateStatus();
    }

    async function captureFetchResponse(url, response) {
      const key = classifyEndpoint(url);
      if (!key || !response) return;
      try {
        const clone = response.clone();
        const contentType = clone.headers.get("content-type") || "";
        if (!/json/i.test(contentType)) return;
        const data = await clone.json();
        capture(url, data);
      } catch (error) {
        state.errors.push(`Fetch capture failed for ${key}: ${error.message}`);
      }
    }

    function installFetchHook() {
      if (typeof window.fetch !== "function" || window.fetch.__dentaquestWrapped) return;
      const originalFetch = window.fetch;
      const wrapped = async function dentaQuestFetchWrapper(input, init) {
        const url = typeof input === "string" ? input : input && input.url;
        const response = await originalFetch.apply(this, arguments);
        if (classifyEndpoint(url)) void captureFetchResponse(url, response);
        return response;
      };
      Object.defineProperty(wrapped, "__dentaquestWrapped", { value: true });
      Object.defineProperty(wrapped, "__dentaquestOriginal", { value: originalFetch });
      window.fetch = wrapped;
    }

    function installXhrHook() {
      if (typeof XMLHttpRequest === "undefined" || XMLHttpRequest.prototype.open.__dentaquestWrapped) return;
      const originalOpen = XMLHttpRequest.prototype.open;
      const originalSend = XMLHttpRequest.prototype.send;

      function wrappedOpen(method, url) {
        this.__dentaquestUrl = String(url || "");
        this.__dentaquestMethod = String(method || "GET");
        return originalOpen.apply(this, arguments);
      }
      Object.defineProperty(wrappedOpen, "__dentaquestWrapped", { value: true });

      function wrappedSend() {
        if (classifyEndpoint(this.__dentaquestUrl)) {
          this.addEventListener("loadend", () => {
            try {
              if (this.status < 200 || this.status >= 300) return;
              let data;
              if (this.responseType === "json") {
                data = this.response;
              } else {
                const text = this.responseText;
                data = JSON.parse(text);
              }
              capture(this.__dentaquestUrl, data);
            } catch (error) {
              state.errors.push(`XHR capture failed for ${this.__dentaquestUrl}: ${error.message}`);
            }
          }, { once: true });
        }
        return originalSend.apply(this, arguments);
      }

      XMLHttpRequest.prototype.open = wrappedOpen;
      XMLHttpRequest.prototype.send = wrappedSend;
    }

    function getPerformanceApiUrls() {
      const found = new Set(state.observedApiUrls);
      try {
        for (const entry of performance.getEntriesByType("resource")) {
          if (classifyEndpoint(entry.name)) found.add(entry.name);
        }
      } catch (_) { /* ignore */ }
      return [...found];
    }

    function makeHeaders(token, taxId) {
      const headers = {
        "Accept": "application/json, text/plain, */*",
        "Authorization": /^Bearer\s/i.test(token) ? token : `Bearer ${token}`,
        "x-traceability-id": typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(16).slice(2)}`
      };
      if (taxId) headers["x-tax-id-number"] = taxId;
      return headers;
    }

    async function fetchJsonAuthenticated(url, token, taxId) {
      const response = await (window.fetch.__dentaquestOriginal || window.fetch)(url, {
        method: "GET",
        credentials: "include",
        headers: makeHeaders(token, taxId),
        cache: "no-store"
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const data = await response.json();
      capture(url, data);
      return data;
    }

    async function recoverExistingResponses() {
      if (state.recovering) return;
      state.recovering = true;
      updateStatus();
      try {
        const token = discoverSessionToken();
        if (!token) throw new Error("No current access token was found in page storage. Reload the member-details page with run_at=document_start and world=MAIN.");

        let taxId = clean(state.data.profile && state.data.profile.userBusiness && state.data.profile.userBusiness.taxIdNumber);
        if (!taxId) {
          try {
            const profileUrl = `${location.origin}/api/user-management/api/provider-portal/v1/users/my-profile?includeUserData=false`;
            const profile = await fetchJsonAuthenticated(profileUrl, token, "");
            taxId = clean(profile && profile.userBusiness && profile.userBusiness.taxIdNumber);
          } catch (error) {
            state.errors.push(`Profile recovery failed: ${error.message}`);
          }
        }

        const urls = getPerformanceApiUrls().filter((url) => classifyEndpoint(url) !== "profile");
        for (const url of urls) {
          const key = classifyEndpoint(url);
          if (!key || state.data[key] !== undefined) continue;
          try {
            await fetchJsonAuthenticated(url, token, taxId);
          } catch (error) {
            state.errors.push(`Recovery failed for ${key}: ${error.message}`);
          }
        }
      } catch (error) {
        state.errors.push(error.message);
      } finally {
        state.recovering = false;
        updateStatus();
      }
    }

    function buildCurrentOutput() {
      const output = buildExtraction(state.data, state.urls, collectDomFallback());
      output["Extraction Metadata"]["Capture Times"] = { ...state.capturedAt };
      output["Extraction Metadata"]["Capture Errors"] = [...state.errors];
      state.lastOutput = output;
      return output;
    }

    function publishOutput(output) {
      const message = {
        source: SOURCE,
        type: "DENTAQUEST_EXTRACTION_READY",
        version: VERSION,
        payload: output
      };
      window.postMessage(message, location.origin);
      try {
        document.dispatchEvent(new CustomEvent("dentaquest:extracted", { detail: output }));
      } catch (_) { /* Firefox may reject cross-compartment objects */ }

      let dataNode = document.getElementById("dentaquest-extracted-json");
      if (!dataNode) {
        dataNode = document.createElement("script");
        dataNode.id = "dentaquest-extracted-json";
        dataNode.type = "application/json";
        (document.head || document.documentElement).appendChild(dataNode);
      }
      dataNode.textContent = JSON.stringify(output);
    }

    async function extract(options) {
      const settings = { recover: true, publish: true, ...options };
      const missingBefore = CORE_ENDPOINTS.filter((key) => state.data[key] === undefined);
      if (settings.recover && missingBefore.length) await recoverExistingResponses();
      const output = buildCurrentOutput();
      if (settings.publish) publishOutput(output);
      return output;
    }

    async function copyOutput() {
      const output = await extract({ recover: true, publish: true });
      const text = JSON.stringify(output, null, 2);
      try {
        await navigator.clipboard.writeText(text);
        setPanelMessage("Copied complete DentaQuest JSON to clipboard.", false);
      } catch (_) {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
        setPanelMessage("Copied complete DentaQuest JSON to clipboard.", false);
      }
    }

    async function downloadOutput() {
      const output = await extract({ recover: true, publish: true });
      const patient = clean(output["Patient/Subscriber Information"]["Patient Name"]).replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") || "member";
      const date = new Date().toISOString().slice(0, 10);
      const blob = new Blob([JSON.stringify(output, null, 2)], { type: "application/json" });
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = `dentaquest_${patient}_${date}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
      setPanelMessage("Downloaded complete DentaQuest JSON.", false);
    }

    function setPanelMessage(message, isError) {
      if (!state.panel || !state.panel.shadowRoot) return;
      const node = state.panel.shadowRoot.getElementById("message");
      if (!node) return;
      node.textContent = message;
      node.setAttribute("data-error", isError ? "true" : "false");
    }

    function createPanel() {
      if (!document.body || document.getElementById("dentaquest-extractor-panel")) return;
      const host = document.createElement("div");
      host.id = "dentaquest-extractor-panel";
      host.style.all = "initial";
      host.style.position = "fixed";
      host.style.right = "14px";
      host.style.bottom = "14px";
      host.style.zIndex = "2147483647";
      const shadow = host.attachShadow({ mode: "open" });
      shadow.innerHTML = `
        <style>
          :host { all: initial; }
          .panel {
            width: 318px;
            box-sizing: border-box;
            font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            color: #17202a;
            background: #ffffff;
            border: 1px solid #ccd6dd;
            border-radius: 12px;
            box-shadow: 0 10px 30px rgba(0, 0, 0, .22);
            padding: 12px;
          }
          .header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
          .title { font-size: 14px; line-height: 1.25; font-weight: 750; }
          .badge { font-size: 10px; padding: 2px 6px; border-radius: 999px; background: #e8f4fd; }
          #status { margin-top: 7px; font-size: 11px; line-height: 1.35; color: #566573; }
          #status[data-ready="true"] { color: #166534; font-weight: 650; }
          .buttons { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px; }
          button {
            appearance: none;
            border: 1px solid #9aa7b2;
            border-radius: 8px;
            background: #f7f9fa;
            color: #17202a;
            padding: 8px 9px;
            font: 650 11px/1.2 ui-sans-serif, system-ui, sans-serif;
            cursor: pointer;
          }
          button:hover { background: #edf2f5; }
          button.primary { background: #0f6cbd; color: white; border-color: #0f6cbd; }
          button.primary:hover { background: #0b5ca3; }
          #message { min-height: 14px; margin-top: 8px; font-size: 10px; line-height: 1.3; color: #166534; }
          #message[data-error="true"] { color: #b42318; }
          .hint { margin-top: 4px; font-size: 9px; color: #7b8794; }
        </style>
        <div class="panel">
          <div class="header">
            <div class="title">DentaQuest Benefit Extractor</div>
            <div class="badge">No background worker</div>
          </div>
          <div id="status">Waiting for member APIs…</div>
          <div class="buttons">
            <button id="copy" class="primary" type="button">Extract + Copy JSON</button>
            <button id="download" type="button">Download JSON</button>
            <button id="recover" type="button">Recover API Data</button>
            <button id="hide" type="button">Hide</button>
          </div>
          <div id="message"></div>
          <div class="hint">Open a member-details page. If APIs were missed, click Recover or reload once.</div>
        </div>`;
      document.body.appendChild(host);
      state.panel = host;
      state.statusNode = shadow.getElementById("status");
      shadow.getElementById("copy").addEventListener("click", () => {
        copyOutput().catch((error) => setPanelMessage(error.message, true));
      });
      shadow.getElementById("download").addEventListener("click", () => {
        downloadOutput().catch((error) => setPanelMessage(error.message, true));
      });
      shadow.getElementById("recover").addEventListener("click", () => {
        recoverExistingResponses()
          .then(() => setPanelMessage("Recovery attempt completed. Check capture status.", false))
          .catch((error) => setPanelMessage(error.message, true));
      });
      shadow.getElementById("hide").addEventListener("click", () => host.remove());
      updateStatus();
    }

    installFetchHook();
    installXhrHook();

    // The existing extension popup is the only UI. Keep a durable registry of
    // API URLs so the crawl can refetch authenticated responses on demand.
    try {
      for (const entry of performance.getEntriesByType("resource")) {
        if (classifyEndpoint(entry.name)) state.observedApiUrls.add(entry.name);
      }
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (classifyEndpoint(entry.name)) state.observedApiUrls.add(entry.name);
        }
      });
      observer.observe({ type: "resource", buffered: true });
      state.performanceObserver = observer;
    } catch (_) { /* optional */ }

    const publicApi = {
      version: VERSION,
      state,
      extract,
      copy: copyOutput,
      download: downloadOutput,
      recover: recoverExistingResponses,
      getRaw: () => ({ ...state.data }),
      getLastOutput: () => state.lastOutput,
      buildExtraction,
      capture,
      setAuthorization: (value) => {
        const text = clean(value);
        if (text) capturedAuthorization = text;
      }
    };
    window.__DENTAQUEST_EXTRACTOR__ = publicApi;
    return publicApi;
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = createMainWorldExtractor(true);
    return;
  }

  if (typeof document === "undefined") return;
  if (!/^(providers\.)?dentaquest\.com$/i.test(location.hostname)) return;
  if (window.top !== window) return;

  const BRIDGE_CHANNEL = "insurance-auditor-dentaquest-v2";

  function installOptionalMainWorldCaptureBridge() {
    try {
      const bridge = function dentaQuestMainWorldBridge(channel) {
        if (window.__insuranceAuditorDentaQuestBridgeV2) return;
        window.__insuranceAuditorDentaQuestBridgeV2 = true;
        const endpointPattern = /\/(?:member-info|plan-info|clinical-history|enrollment-history|family-info|plan-benefit-summary|maximum-deductible|coordination-of-benefits)(?:\?|$)|\/eligibility\/member-eligibility(?:\?|$)|\/users\/my-profile(?:\?|$)/i;
        const isTarget = value => endpointPattern.test(String(value || ""));
        const emit = payload => window.postMessage({ source: channel, ...payload }, "*");

        const nativeFetch = window.fetch && window.fetch.bind(window);
        if (nativeFetch && !window.fetch.__insuranceAuditorDqWrapped) {
          const wrappedFetch = async function(input, init) {
            const request = input instanceof Request ? input : null;
            const url = request?.url || String(input || "");
            let authorization = "";
            try { authorization = new Headers(init?.headers || request?.headers || {}).get("authorization") || ""; } catch (_) {}
            const response = await nativeFetch(input, init);
            if (isTarget(url)) {
              try {
                const data = await response.clone().json();
                emit({ type: "capture", url, data, authorization });
              } catch (_) {
                if (authorization) emit({ type: "authorization", authorization });
              }
            }
            return response;
          };
          Object.defineProperty(wrappedFetch, "__insuranceAuditorDqWrapped", { value: true });
          window.fetch = wrappedFetch;
        }

        const nativeOpen = XMLHttpRequest.prototype.open;
        const nativeSetHeader = XMLHttpRequest.prototype.setRequestHeader;
        const nativeSend = XMLHttpRequest.prototype.send;
        if (!nativeOpen.__insuranceAuditorDqWrapped) {
          XMLHttpRequest.prototype.open = function(method, url) {
            this.__insuranceAuditorDq = { url: String(url || ""), headers: {} };
            return nativeOpen.apply(this, arguments);
          };
          XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
            if (this.__insuranceAuditorDq) this.__insuranceAuditorDq.headers[String(name).toLowerCase()] = String(value);
            return nativeSetHeader.apply(this, arguments);
          };
          XMLHttpRequest.prototype.send = function() {
            const meta = this.__insuranceAuditorDq;
            if (meta && isTarget(meta.url)) {
              this.addEventListener("loadend", () => {
                if (this.status < 200 || this.status >= 300) return;
                const authorization = meta.headers.authorization || "";
                try {
                  const data = this.responseType === "json" ? this.response : JSON.parse(this.responseText);
                  emit({ type: "capture", url: meta.url, data, authorization });
                } catch (_) {
                  if (authorization) emit({ type: "authorization", authorization });
                }
              }, { once: true });
            }
            return nativeSend.apply(this, arguments);
          };
          Object.defineProperty(XMLHttpRequest.prototype.open, "__insuranceAuditorDqWrapped", { value: true });
        }
      };
      const script = document.createElement("script");
      script.textContent = `;(${bridge.toString()})(${JSON.stringify(BRIDGE_CHANNEL)});`;
      (document.documentElement || document.head).appendChild(script);
      script.remove();
    } catch (error) {
      console.warn("DentaQuest: MAIN-world bridge unavailable; recovery mode will be used.", error);
    }
  }

  function lockPage() {
    if (document.getElementById("_dentaquest_crawl_overlay")) return;
    const overlay = document.createElement("div");
    overlay.id = "_dentaquest_crawl_overlay";
    Object.assign(overlay.style, { position:"fixed", inset:"0", zIndex:"2147483647", background:"rgba(0,0,0,.22)", display:"flex", alignItems:"center", justifyContent:"center", cursor:"not-allowed", pointerEvents:"all", userSelect:"none" });
    overlay.innerHTML = `<div style="background:#fff;border-radius:12px;padding:28px 36px;max-width:520px;box-shadow:0 4px 32px rgba(0,0,0,.2);text-align:center;font-family:sans-serif;"><div style="font-size:22px;font-weight:700;color:#276299;margin-bottom:8px;">DentaQuest Crawl Running...</div><div id="_dentaquest_crawl_status" style="font-size:14px;line-height:1.45;color:#555;">Reading member, plan, maximum, deductible, and procedure benefits.<br>Please do not navigate until the crawl finishes.</div></div>`;
    for (const name of ["click","mousedown","mouseup","touchstart","touchend","keydown","keyup","scroll","wheel"]) overlay.addEventListener(name, event => event.stopImmediatePropagation(), true);
    (document.body || document.documentElement).appendChild(overlay);
    if (document.body) document.body.style.overflow = "hidden";
  }

  function setStatus(message, isError = false) {
    const node = document.getElementById("_dentaquest_crawl_status");
    if (!node) return;
    node.textContent = message;
    node.style.color = isError ? "#b42318" : "#555";
  }

  function unlockPage(delay = 0) {
    setTimeout(() => {
      document.getElementById("_dentaquest_crawl_overlay")?.remove();
      if (document.body) document.body.style.overflow = "";
    }, delay);
  }

  const storageGet = key => new Promise((resolve, reject) => chrome.storage.local.get(key, result => chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(result)));
  const storageSet = value => new Promise((resolve, reject) => chrome.storage.local.set(value, () => chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve()));

  async function clearPreviousData() {
    const stored = await storageGet("audit_context");
    const context = stored.audit_context || {};
    if (Object.prototype.hasOwnProperty.call(context, "dentaquest_data")) {
      delete context.dentaquest_data;
      await storageSet({ audit_context: context });
    }
  }

  installOptionalMainWorldCaptureBridge();
  const extractor = createMainWorldExtractor(false);

  window.addEventListener("message", event => {
    if (event.source !== window || event.data?.source !== BRIDGE_CHANNEL) return;
    if (event.data.authorization) extractor.setAuthorization(event.data.authorization);
    if (event.data.type === "capture") extractor.capture(event.data.url, event.data.data);
  });

  function autoDownloadJSON(data) {
    try {
        const json  = JSON.stringify(data, null, 2);
        const blob  = new Blob([json], { type: 'application/json' });
        const url   = URL.createObjectURL(blob);
        const nameText = data?.["Patient/Subscriber Information"]?.["Patient Name"] || 'patient';
        const name  = nameText.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '');
        const date  = new Date().toISOString().slice(0, 10);
        const fname = `dentaquest_${name}_${date}.json`;
        const a     = document.createElement('a');
        a.href      = url;
        a.download  = fname;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1500);
        console.log('DentaQuest: Auto-downloaded →', fname);
    } catch (e) {
        console.error('DentaQuest: Auto-download failed', e);
    }
  }

  let activeRun = null;
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request?.command !== "START_CRAWL") return;
    if (activeRun) {
      sendResponse({ status: "[!] DentaQuest crawl is already running." });
      return;
    }

    const run = { id: `${Date.now()}-${Math.random().toString(16).slice(2)}` };
    activeRun = run;
    lockPage();
    setStatus("Recovering authenticated DentaQuest API responses...");

    (async () => {
      await clearPreviousData();
      const output = await extractor.extract({ recover: true, publish: false });
      const metadata = output?.["Extraction Metadata"] || {};
      const captured = Array.isArray(metadata["Captured Endpoints"]) ? metadata["Captured Endpoints"] : [];
      const missing = Array.isArray(metadata["Missing Core Endpoints"]) ? metadata["Missing Core Endpoints"] : [];
      if (!captured.length) throw new Error("No member APIs were found. Open the DentaQuest member details/benefits page, wait for it to load, and click Crawl again.");
      if (!output?.["Patient/Subscriber Information"] || !output?.["General Benefit Categories"]) throw new Error("DentaQuest data was found, but the normalized output could not be built.");

      autoDownloadJSON(output);

      const stored = await storageGet("audit_context");
      const context = stored.audit_context || {};
      context.dentaquest_data = output;
      await storageSet({ audit_context: context });
      
      // Clear after download
      await clearPreviousData();

      setStatus(missing.length ? `Saved with ${captured.length} endpoints. Missing: ${missing.join(", ")}. JSON downloaded automatically.` : `Crawl complete. ${captured.length} endpoints saved. JSON downloaded automatically.`);
      unlockPage(2200);
      return { status: missing.length ? `[+] DentaQuest saved with warnings. Missing: ${missing.join(", ")}. JSON downloaded.` : `[+] DentaQuest crawl complete. JSON downloaded.` };
    })().then(sendResponse).catch(error => {
      console.error("DentaQuest crawl error:", error);
      setStatus(`Crawl failed: ${error.message}`, true);
      unlockPage(4200);
      sendResponse({ status: `[!] DentaQuest crawl error: ${error.message}` });
    }).finally(() => { if (activeRun === run) activeRun = null; });

    return true;
  });
})();
