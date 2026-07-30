
import re
from datetime import datetime


# ── Helpers ───────────────────────────────────────────────────────────────────

def fmt_money(raw: str) -> str:
    m = re.search(r"\$?\s*([\d,]+\.?\d*)", str(raw))
    return m.group(1).replace(",", "") if m else raw


def parse_dollars(val: str) -> float:
    try:
        return float(re.sub(r'[^\d.]', '', str(val)))
    except Exception:
        return 0.0


def calc_used(total_str: str, remaining_str: str) -> str:
    total     = parse_dollars(total_str)
    remaining = parse_dollars(remaining_str)
    used      = total - remaining
    return f"{used:.2f}" if total > 0 else "0.00"


def _parse_date_flexible(raw: str, formats: tuple):
    raw = (raw or "").strip()
    if not raw:
        return None
    for fmt in formats:
        try:
            return datetime.strptime(raw, fmt).strftime("%m/%d/%Y")
        except ValueError:
            continue
    return raw  # couldn't parse against any known format — keep as-is rather than losing it


def _format_dates(raw_dates: list, formats: tuple, max_dates: int = None) -> str:
    """
    Format ALL service dates for a single code as a comma-joined string
    (e.g. "11/13/2025, 05/06/2025, 01/02/2025") rather than capping at a
    fixed count. Multiple dates for the same code is normal, not a data
    anomaly — standard "2 per calendar year" frequency limits on
    exams/cleanings routinely produce this, and the person wants every
    on-file date visible, not just the most recent couple.
    Assumes raw_dates is already newest-first (matches every source's
    observed ordering) and dedupes identical consecutive entries.
    max_dates is kept as an optional cap for any future one-off need, but
    defaults to None (no cap) per current policy.
    """
    formatted = []
    for raw in raw_dates:
        parsed = _parse_date_flexible(raw, formats)
        if not parsed:
            continue
        if parsed not in formatted:
            formatted.append(parsed)
        if max_dates is not None and len(formatted) >= max_dates:
            break
    return ", ".join(formatted) if formatted else "NH"


def late_dos_metlife(procedures: list, code: str) -> str:
    for p in procedures:
        if p.get("procedure_code", "").upper() == code.upper():
            dos = p.get("late_date_of_service", "").strip()
            if not dos or dos == "—":
                return "NH"
            for fmt in ("%m/%d/%Y", "%m/%d/%y"):
                try:
                    return datetime.strptime(dos, fmt).strftime("%m/%d/%Y")
                except ValueError:
                    continue
            return dos
    return "NH"


def late_dos_cigna(procedures: list, code: str) -> str:
    for p in procedures:
        if p.get("procedure_code", "").upper() == code.upper():
            raw_dates = p.get("api_details", {}).get("history_dates", [])
            if raw_dates:
                return _format_dates(raw_dates, ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y"))
            # fallback for any file where api_details/history_dates is missing —
            # keep the old single-date behavior rather than losing it entirely
            dos = p.get("history_date", "").strip()
            if not dos or dos in ("N/A", "No history on file", "—", ""):
                return "NH"
            return _format_dates([dos], ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y"))
    return "NH"


def late_dos_dd_ins_scraper(benefits_search: list, code: str) -> str:
    raw_dates = []
    for entry in benefits_search:
        if entry.get("code", "").upper() == code.upper():
            for row in entry.get("rows", []):
                # The extension's row field for this was renamed from
                # "coverage_details" to "service_date" at some point; read
                # whichever is present so older scraped files still work.
                val = (row.get("service_date") or row.get("coverage_details") or "").strip()
                if not val or val in ("None", "N/A", ""):
                    continue
                # A row can contain several comma-separated dates. Extract
                # every date rather than retaining only val.split(",")[0].
                raw_dates.extend(
                    re.findall(r"\d{1,2}/\d{1,2}/\d{2,4}", val)
                )
    return _format_dates(raw_dates, ("%m/%d/%Y", "%m/%d/%y"))


def late_dos_ddri(procedures: list, code: str) -> str:
    """
    DDRI nests history per-procedure as a list of dicts, newest-first:
    {"procedure_code": "D0120", ..., "history": [{"service_date": "07/10/2025"},
    ...]}. Same code legitimately has multiple visit dates on file (e.g. an
    annual exam over several years) — return ALL of them comma-joined via
    _format_dates, same as late_dos_ddva/late_dos_ucci, not just history[0].
    """
    for p in procedures:
        if p.get("procedure_code", "").upper() == code.upper():
            raw_dates = [
                (h.get("service_date") or "").strip()
                for h in p.get("history", [])
                if (h.get("service_date") or "").strip()
            ]
            return _format_dates(raw_dates, ("%m/%d/%Y", "%m/%d/%y"))
    return "NH"


def late_dos_ddva(history: list, code: str) -> str:
    """
    DD Virginia (content_delta_dental_va.js) — flat history list, newest first,
    each entry: {"dateOfService": "06-24-2026", "code": "D1110", ...}. The same
    code can legitimately appear multiple times (e.g. two exams in one year).
    """
    raw_dates = []
    for h in history:
        if h.get("code", "").upper() == code.upper():
            raw = (h.get("dateOfService") or "").strip()
            if raw:
                raw_dates.append(raw)
    return _format_dates(raw_dates, ("%m-%d-%Y", "%m/%d/%Y", "%m/%d/%y"))


def late_dos_ucci(history: list, code: str) -> str:
    """
    UCCI scraper's service_history has one entry PER CODE, with all its
    visit dates already grouped into a "dates" list, e.g.
    {"procedure_code": "D0120", "dates": ["07/01/2026", "12/24/2025", ...]}.
    """
    for h in history:
        if h.get("procedure_code", "").upper() == code.upper():
            return _format_dates(h.get("dates") or [], ("%m/%d/%Y", "%m/%d/%y"))
    return "NH"


def _normalize_name_for_match(name: str) -> str:
    """
    Normalize a name to 'FIRST LAST' uppercase, regardless of whether
    it came in as 'LAST, FIRST' (Denticon) or 'FIRST LAST' (PDF).
    """
    name = (name or "").strip()
    if "," in name:
        last, first = name.split(",", 1)
        name = f"{first.strip()} {last.strip()}"
    return re.sub(r"\s+", " ", name).strip().upper()


def _name_match_loose(name_a: str, name_b: str) -> bool:
    """
    Compare two names ignoring middle initials/middle names — Denticon
    often omits middle initials/names that PDFs include (e.g. Denticon
    "DE LA ROSA, JULIANNA" vs PDF "JULIANNA G DE LA ROSA"). Also handles
    compound/double surnames, where one source has extra surname words
    the other doesn't (e.g. PDF "JULIANNA G DE LA ROSA AGU" vs Denticon
    "DE LA ROSA, JULIANNA" — the PDF's surname is a superset of
    Denticon's). First name must match; the surname words from the
    shorter name must all appear in the surname words of the longer
    name (in either direction, since we don't know upfront which source
    has the fuller name).
    """
    a = _normalize_name_for_match(name_a).split()
    b = _normalize_name_for_match(name_b).split()
    if not a or not b:
        return False
    if a[0] != b[0]:
        return False
    surname_a = {t for t in a[1:] if len(t) > 1}  # drop single-letter middle initials
    surname_b = {t for t in b[1:] if len(t) > 1}
    if not surname_a or not surname_b:
        return True
    return surname_a.issubset(surname_b) or surname_b.issubset(surname_a)


# Real US state postal abbreviations — used to pull the actual state out of
# Denticon's own carrier_name field for Delta Dental plans (e.g. "DD WI",
# "DD MO") instead of collapsing every Delta Dental variant to the same
# generic "DELTA DENTAL" string regardless of which state's plan it is.
_US_STATE_ABBREVS = {
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID",
    "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS",
    "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK",
    "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV",
    "WI", "WY", "DC",
}


def _extract_carrier(carrier_raw: str) -> str:
    cleaned = re.sub(r"\(IN\)\s*|\(OUT\)\s*", "", carrier_raw).strip().upper()
    if re.search(r"\bDELTA\b", cleaned):
        # Denticon's carrier_name field embeds the state differently
        # depending on how each plan was set up — sometimes in parens
        # ("DELTA DENTAL PLAN (MO) PPO"), sometimes right after "DELTA"
        # ("DELTA WI (PPO) PID 39069"), sometimes after "PPO" ("DELTA PPO
        # GA PID 94276"). Rather than assuming a fixed position, scan every
        # standalone 2-letter token against a whitelist of real state
        # postal codes and use whichever one matches first. Falls back to
        # the generic "DELTA DENTAL" only when no state code is found at
        # all (e.g. a plan whose name genuinely doesn't include one).
        for tok in re.findall(r"\b[A-Z]{2}\b", cleaned):
            if tok in _US_STATE_ABBREVS:
                return f"Delta Dental {tok}"
        return "DELTA DENTAL"
    tokens  = cleaned.split()
    meaningful = []
    for w in tokens:
        if w.isalpha() and len(w) > 3:
            meaningful.append(w)
        else:
            break
    return " ".join(meaningful) if meaningful else (tokens[0] if tokens else "")

# Codes we actually query into patient notes (the 8 output fields plus their
# CODE_ALIASES variants). Shared-frequency codes outside this set are ignored —
# no point pulling in a date for a code we never report. Module-level constant
# only — no per-patient data lives here, so it's safe outside build_patient_notes.
TRACKED_QUERY_CODES = {
    "D0120", "D0150",
    "D1110", "D1120",
    "D4910",
    "D4355",
    "D1206", "D1208",
    "D0274", "D0272", "D0273", "D0270", "D0277",
    "D0210", "D0330",
}

def _ddri_find_category(entries, category_label):
    for entry in entries:
        if entry.get("category", "").strip().lower() == category_label.strip().lower():
            return entry
    return None

def _ddri_used(entry):
    if not entry:
        return "0.00"
    used = entry.get("used", "")
    if not used or used in ("N/A", ""):
        return "0.00"
    return fmt_money(used)

def build_patient_notes(denticon_data: dict, insurance_data: dict) -> dict:
    dent = denticon_data.get("denticon_data", denticon_data)
    ins  = insurance_data

    header      = dent.get("header", {})
    plans       = dent.get("plans", [])
    plan        = plans[-1] if plans else {}
    ins_summary = header.get("insurance_summary", {})
    dent_pi     = dent.get("primary_insurance", {})

    carrier_raw = (
        ins_summary.get("provider", "") or
        dent_pi.get("carrier_name", "")
    )
    carrier = _extract_carrier(carrier_raw)

    if not carrier:
        _src = (
            ins.get("metlife_data", {}).get("source", "") or
            ins.get("benefit_coverage", {}).get("source", "") or
            ins.get("source", "") or
            ""
        )
        _m = re.search(r'^([A-Za-z]+)\s+Portal', str(_src))
        if _m:
            carrier = _m.group(1).upper()

    notes_text      = plan.get("benefits", {}).get("notes", "")
    plan_type_match = re.search(r"PPO/HMO/INDEMNITY\s*:(\w+)", notes_text)
    plan_type       = plan_type_match.group(1).strip() if plan_type_match else "PPO"

    verification_date = datetime.now().strftime("%m/%d/%Y")

    metlife_data = (
        ins.get("metlife_data") or
        (ins if "MetLife" in str(ins.get("source", "")) else None) or
        {}
    )
    cigna_data = (
        ins.get("cigna_data") or
        (ins if ins.get("source") == "Cigna Portal" else None) or
        {}
    )

    is_cigna   = bool(cigna_data)
    is_metlife = bool(metlife_data) and not is_cigna

    aetna_data = ins if ("service_level_benefits" in ins and "maximums" in ins) else {}
    is_aetna   = bool(aetna_data) and not is_metlife and not is_cigna

    dd_ins_data = ins if (ins.get("source") == "Delta Dental" and ins.get("tabs")) else {}
    is_dd_scraper   = bool(dd_ins_data) and not is_metlife and not is_cigna and not is_aetna

    dd_wi_pdf_data = ins if (ins.get("financials_by_patient") and ins.get("history_by_patient")) else {}
    is_dd_wi_pdf   = bool(dd_wi_pdf_data)

    # DDRI (Delta Dental Rhode Island) — live portal scrape, self-flagged with
    # "ddri_data": true. Must be checked BEFORE the generic PDF branch below,
    # since DDRI also happens to carry a top-level "benefit_coverage" key
    # (with a different internal shape than the Guardian/DD-PDF parser output)
    # and would otherwise be misrouted into is_pdf.
    ddri_data = ins if ins.get("ddri_data") else {}
    is_ddri   = bool(ddri_data) and not is_metlife and not is_cigna and not is_aetna and not is_dd_scraper and not is_dd_wi_pdf

    # DD Virginia (content_delta_dental_va.js) — self-identifies by having
    # both "benefitPlan" and "accumulators" top-level keys, distinct from
    # every other shape above (no "benefit_coverage", no "ddri_data" flag).
    ddva_data = ins if (ins.get("benefitPlan") and ins.get("accumulators")) else {}
    is_ddva   = bool(ddva_data) and not is_metlife and not is_cigna and not is_aetna and not is_dd_scraper and not is_dd_wi_pdf and not is_ddri

    # UCCI (content_ucci.js) — self-identifies via "source": "UCCI". No
    # per-code $ history nesting like DDRI/DDVA; a flat service_history list
    # instead (see late_dos_ucci below).
    ucci_data = ins if ins.get("source") == "UCCI" else {}
    is_ucci   = bool(ucci_data) and not is_metlife and not is_cigna and not is_aetna and not is_dd_scraper and not is_dd_wi_pdf and not is_ddri and not is_ddva

    pdf_data = ins if (ins.get("benefit_coverage") and not is_metlife and not is_cigna
                    and not is_aetna and not is_dd_wi_pdf and not is_ddri and not is_ddva and not is_ucci) else {}
    is_pdf   = bool(pdf_data)

    patient_name = (
        header.get("patient_name")                   or
        dent.get("patient", {}).get("name")          or
        metlife_data.get("patient", {}).get("name") or
        cigna_data.get("patient", {}).get("name")   or
        aetna_data.get("patient", {}).get("name")   or
        ddri_data.get("patient", {}).get("name")    or
        ddva_data.get("benefitPlan", {}).get("patientName") or
        ucci_data.get("patient_info", {}).get("patient_name") or
        dd_ins_data.get("primary_patient", {}).get("name")   or
        pdf_data.get("summary", {}).get("patient_name")     or
        "UNKNOWN"
    )

    ind_max_used = ind_ded_used = ortho_used = ""

    if is_metlife:
        fin          = metlife_data.get("financials", {})
        ind_max_used = fmt_money(fin.get("annual_max",     {}).get("used", ""))
        ind_ded_used = fmt_money(fin.get("deductible_ind", {}).get("used", ""))
        ortho_used   = fmt_money(fin.get("ortho_lifetime", {}).get("used", ""))

    elif is_cigna:
        fin          = cigna_data.get("financials", {})
        max_records  = fin.get("maximum_records", [])
        ded_records  = fin.get("deductible_records", [])
        in_network = cigna_data.get("plan_details", {}).get("network", {}).get("name", "")

        def _cigna_pick(records, desc_pattern):
            for r in records:
                is_out_of_network = (
                    r.get("networkName", "") == "OONET"
                    or r.get("networkType", "") == "OON"
                )
                is_dollar_amount = r.get("amount", "").strip().startswith("$")
                if (not is_out_of_network
                    and is_dollar_amount
                    and r.get("covers", "") == "IND"
                    and re.search(desc_pattern, r.get("desc", ""), re.IGNORECASE)):
                    return r
            return None

        max_rec   = _cigna_pick(max_records, r"calendar year maximum")
        ortho_rec = _cigna_pick(max_records, r"lifetime maximum")
        ded_rec   = _cigna_pick(ded_records, r"calendar year deductible")

        ind_max_used = fmt_money(max_rec.get("met", ""))   if max_rec   else "0.00"
        ind_ded_used = fmt_money(ded_rec.get("met", ""))   if ded_rec   else "0.00"
        ortho_used   = fmt_money(ortho_rec.get("met", "")) if ortho_rec else "0.00"

        if not carrier:
            carrier = "CIGNA"

    elif is_aetna:
        def _aetna_annual_max():
        # Type label for the annual max row varies by plan — sometimes
        # literally "Annual Maximum", sometimes "DENTAL" (combined
        # in/out-of-network legend tables). Matching the literal string
        # "DENTAL" only worked for that one format and silently returned
        # ("", "") -> used = 0.00 for every other plan. Instead: take
        # Individual-coverage rows, exclude Orthodontics (separate lifetime
        # max, never the annual max), prefer literal "Annual Maximum" when
        # present, else fall back to whatever's left (e.g. "DENTAL").
            candidates = [
                mx for mx in aetna_data.get("maximums", [])
                if mx.get("coverage", "").lower() == "individual"
                and "ortho" not in mx.get("type", "").lower()
            ]
            if not candidates:
                return "", ""
            row = next((mx for mx in candidates if mx.get("type", "").lower() == "annual maximum"), candidates[0])
            return row.get("amount", ""), row.get("remaining", "")

        def _aetna_ortho_max():
            for mx in aetna_data.get("maximums", []):
                if "ortho" in mx.get("type", "").lower() and mx.get("coverage", "").lower() == "individual":
                    return mx.get("amount", ""), mx.get("remaining", "")
            return "", ""

        def _aetna_ded(type_str: str):
            for ded in aetna_data.get("deductibles", []):
                if ded.get("type", "").lower() == type_str.lower() and ded.get("coverage", "").lower() == "individual":
                    return ded.get("amount", ""), ded.get("remaining", "")
            return "", ""

        dental_total, dental_rem = _aetna_annual_max()
        ortho_total,  ortho_rem  = _aetna_ortho_max()
        ded_total,    ded_rem    = _aetna_ded("Dental")

        ind_max_used = calc_used(dental_total, dental_rem)
        ind_ded_used = calc_used(ded_total, ded_rem)
        # Ortho lifetime max: calc_used already handles the blank-Remaining
        # case correctly — parse_dollars("") -> 0.0, so used = total - 0 =
        # total, which is exactly the "blank Remaining means fully used"
        # rule for this field. No special-casing needed.
        ortho_used = calc_used(ortho_total, ortho_rem)
        if not carrier:
            carrier = aetna_data.get("payer", {}).get("name", "AETNA").upper()
            carrier = re.sub(r"\s+DENTAL.*", "", carrier).strip()

    elif is_dd_scraper:
        overview = dd_ins_data.get("tabs", {}).get("overview", {})
        for mx in overview.get("maximums", []):
            if "calendar individual maximum" in mx.get("type", "").lower():
                ind_max_used = fmt_money(mx.get("used", ""))
                break
        for ded in overview.get("deductibles", []):
            if "calendar individual deductible" in ded.get("type", "").lower():
                ind_ded_used = fmt_money(ded.get("used", ""))
                break
        # Ortho lifetime max isn't a separate labeled "type" on this site —
        # it shows up as one of the (possibly several) "...Lifetime..."
        # maximum entries, distinguished only by "Orthodontics" appearing in
        # that entry's treatment_types list. Search for it explicitly rather
        # than assuming it's always $0 — this patient's plan happens to have
        # NO ortho maximum at all (their only lifetime max is tied to TMJ /
        # Adjunctive General Services), but other patients' plans may have one.
        ortho_used = "0.00"
        for mx in overview.get("maximums", []):
            treatment_types = [t.lower() for t in mx.get("treatment_types", [])]
            if any("ortho" in t for t in treatment_types):
                ortho_used = fmt_money(mx.get("used", ""))
                break
        if not carrier:
            carrier = "DELTA DENTAL"

    elif is_dd_wi_pdf:
        fin_by_patient = dd_wi_pdf_data.get("financials_by_patient", {})
        matched_fin = None
        for name, fin in fin_by_patient.items():
            if _name_match_loose(patient_name, name):
                matched_fin = fin
                break
        if matched_fin:
            ind_max_used = fmt_money(matched_fin.get("individual_max_used", ""))
            ind_ded_used = fmt_money(matched_fin.get("individual_deductible_used", ""))
            ortho_used   = fmt_money(matched_fin.get("ortho_max_used", ""))
        else:
            ind_max_used = ind_ded_used = ortho_used = "0.00"
        if not carrier:
            carrier = "DELTA DENTAL"

    elif is_ddri:
        maximums    = ddri_data.get("financials", {}).get("maximums", [])
        deductibles = ddri_data.get("financials", {}).get("deductibles", [])

        ind_max_used = _ddri_used(_ddri_find_category(maximums, "Annual Maximum"))
        ind_ded_used = _ddri_used(_ddri_find_category(deductibles, "Individual Deductible"))
        ortho_used   = _ddri_used(_ddri_find_category(maximums, "Maximum Lifetime Cap"))
        if not carrier:
            carrier = "DELTA DENTAL"

    elif is_ddva:
        accs = ddva_data.get("accumulators", {}).get("accumulators", [])

        def _ddva_pick(predicate, tier_pref="In Network PPO"):
            candidates = [a for a in accs if predicate(a)]
            if not candidates:
                return None
            return next((a for a in candidates if a.get("tierName") == tier_pref), candidates[0])

        max_acc = _ddva_pick(lambda a: a.get("isMaximum") and
                              "ortho" not in a.get("name", "").lower() and
                              "tmj" not in a.get("name", "").lower() and
                              "family" not in a.get("name", "").lower())
        ded_acc = _ddva_pick(lambda a: not a.get("isMaximum") and
                              "individual" in a.get("name", "").lower() and
                              "deductible" in a.get("name", "").lower())
        ortho_acc = _ddva_pick(lambda a: a.get("isMaximum") and
                                "ortho" in a.get("name", "").lower())

        ind_max_used = f"{float(max_acc.get('usedAmount', 0)):.2f}"   if max_acc   else "0.00"
        ind_ded_used = f"{float(ded_acc.get('usedAmount', 0)):.2f}"   if ded_acc   else "0.00"
        ortho_used   = f"{float(ortho_acc.get('usedAmount', 0)):.2f}" if ortho_acc else "0.00"
        if not carrier:
            carrier = "DELTA DENTAL"

    elif is_ucci:
        # UCCI scraper's financials live under ucci_data["financial_accumulators"]
        # as a flat LIST of typed blocks (type: "Deductibles" / "Maximums" /
        # "Program Dollar Ded" / "Program Dollar Max" / "Lifetime Svc Dollar
        # Max"), each with its own "entries" list of {"label", "applied", ...}.
        fin_accums = ucci_data.get("financial_accumulators", [])

        def _ucci_block(type_pattern: str):
            for block in fin_accums:
                if re.search(type_pattern, block.get("type", ""), re.IGNORECASE):
                    return block
            return None

        def _ucci_applied(block, label_pattern: str):
            if not block:
                return None
            for entry in block.get("entries", []):
                if re.search(label_pattern, entry.get("label", ""), re.IGNORECASE):
                    applied = entry.get("applied", "")
                    if applied not in (None, ""):
                        return fmt_money(applied)
            return None

        def _ucci_explicit_zero(block) -> bool:
            # The generic "Deductibles"/"Maximums" summary blocks state
            # "No deductible/maximum applied to the current benefit period"
            # in an entry's note/raw_text when the patient genuinely has
            # nothing applied yet — a CONFIRMED $0.00, distinct from the
            # bucket simply not being present at all (which should stay
            # blank, not "0.00" — see the Lifetime Svc Dollar Max/ortho
            # case below, which has no such generic fallback).
            if not block:
                return False
            for entry in block.get("entries", []):
                note = f"{entry.get('note', '')} {entry.get('raw_text', '')}"
                if re.search(r"no (deductible|maximum) applied", note, re.IGNORECASE):
                    return True
            return False

        ded_block         = _ucci_block(r"program dollar ded")
        max_block         = _ucci_block(r"program dollar max")
        ortho_block       = _ucci_block(r"lifetime svc dollar max")
        generic_ded_block = _ucci_block(r"^deductibles$")
        generic_max_block = _ucci_block(r"^maximums$")

        ind_ded_used = _ucci_applied(ded_block, r"individual")
        if ind_ded_used is None and _ucci_explicit_zero(generic_ded_block):
            ind_ded_used = "0.00"

        ind_max_used = _ucci_applied(max_block, r"individual")
        if ind_max_used is None and _ucci_explicit_zero(generic_max_block):
            ind_max_used = "0.00"

        # Ortho card simply won't exist for patients without ortho coverage
        # — that's expected, not an error, so leave blank (not "0.00") when
        # absent rather than assuming zero.
        ortho_used = _ucci_applied(ortho_block, r"orthodontic")
        if ortho_used is None:
            ortho_used = "0.00"
            
        ind_ded_used = ind_ded_used or ""
        ind_max_used = ind_max_used or ""
        ortho_used   = ortho_used or ""

        if not carrier:
            carrier = "UCCI"

    elif is_pdf:
        fin = pdf_data.get("financials", {})
        insurer = pdf_data.get("summary", {}).get("insurer", "")
        def _pdf_fin(key: str) -> str:
            block = fin.get(key, {})
            return fmt_money(block.get("used") or block.get("total", ""))
        ind_max_used = _pdf_fin("annual_max")
        ind_ded_used = _pdf_fin("individual_deductible")
        ortho_used   = _pdf_fin("ortho_lifetime")
        if not carrier:
            carrier = "DELTA DENTAL" if "delta" in insurer else "GUARDIAN" if "guardian" in insurer else "DENTAQUEST" if "dentaquest" in insurer else ""

    if is_cigna:
        procedures = cigna_data.get("procedures", {}).get("results", [])
        dos_fn     = late_dos_cigna

    elif is_aetna:
        def _aetna_own_date(svc):
            hist_str = svc.get("history", "")
            m = re.search(r"Last paid date:\s*(\d{2}/\d{2}/\d{2,4})", hist_str, re.IGNORECASE)
            if not m:
                return None
            raw = m.group(1).strip()
            for fmt in ("%m/%d/%Y", "%m/%d/%y"):
                try:
                    return datetime.strptime(raw, fmt).strftime("%m/%d/%Y")
                except ValueError:
                    continue
            return None

        def dos_fn_aetna(_, code: str) -> str:
            code = code.upper()
            svcs = aetna_data.get("service_level_benefits", [])
            target = next((s for s in svcs if s.get("procedure_code", "").upper() == code), None)
            if not target:
                return "NH"

            dates = []
            own_date = _aetna_own_date(target)
            if own_date:
                dates.append(own_date)

            # Pull in dates from any shared-frequency codes, in the order
            # listed, filtered to codes we actually track, deduped against
            # what we already have. Each code's date is computed independently
            # from its own "shares_frequency_with" text, so asymmetric sharing
            # (D0120 lists D0150, but D0150 doesn't list D0120 back) resolves
            # correctly without any shared mutable state between codes.
            shares_text = target.get("shares_frequency_with", "")
            shared_codes = re.findall(r"D\d{4}", shares_text)
            for sc in shared_codes:
                if sc == code or sc not in TRACKED_QUERY_CODES:
                    continue
                peer = next((s for s in svcs if s.get("procedure_code", "").upper() == sc), None)
                if peer:
                    peer_date = _aetna_own_date(peer)
                    if peer_date and peer_date not in dates:
                        dates.append(peer_date)

            return ", ".join(dates) if dates else "NH"

        procedures = []
        dos_fn = dos_fn_aetna

    elif is_dd_scraper:
        procedures = dd_ins_data.get("tabs", {}).get("benefits_search", [])
        dos_fn = lambda procs, code: late_dos_dd_ins_scraper(procs, code)

    elif is_dd_wi_pdf:
        hist_by_patient = dd_wi_pdf_data.get("history_by_patient", {})
        matched_hist = {}
        for name, hist in hist_by_patient.items():
            if _name_match_loose(patient_name, name):
                matched_hist = hist
                break
        def dos_fn_dd_wi(_, code: str) -> str:
            return matched_hist.get(code.upper(), "NH")
        procedures = []
        dos_fn = dos_fn_dd_wi

    elif is_ddri:
        procedures = ddri_data.get("benefit_coverage", {}).get("procedures", [])
        dos_fn = late_dos_ddri

    elif is_ddva:
        procedures = ddva_data.get("history", [])
        dos_fn = late_dos_ddva

    elif is_ucci:
        procedures = ucci_data.get("service_history", [])
        dos_fn = late_dos_ucci

    elif is_pdf:
        raw_history = pdf_data.get("history", {})
        def dos_fn_pdf(_, code: str) -> str:
            val = raw_history.get(code.upper(), "")
            if not val or val.strip() in ("Date Not Found", "NH", ""):
                return "NH"
            for fmt in ("%m/%d/%Y", "%m/%d/%y"):
                try:
                    return datetime.strptime(val.strip(), fmt).strftime("%m/%d/%Y")
                except ValueError:
                    continue
            return val.strip()
        procedures = []
        dos_fn = dos_fn_pdf

    else:
        procedures = ins.get("benefit_coverage", {}).get("procedures", [])
        dos_fn     = late_dos_metlife

    # Some carriers log the child/lower-count variant of a procedure instead
    # of the "standard" adult/full code this pipeline tracks — same clinical
    # procedure, different CDT code purely due to patient age or film count.
    # If the primary code comes back "NH", also try these known variants
    # before giving up. Applied ONCE here, at the single point where all 8
    # fields get built, so it covers every carrier branch above (current and
    # future) without needing to be duplicated inside each dos_fn.
    #
    # NOTE for DDMO: D0120 (periodic exam) and D0150 (comprehensive exam) are
    # deliberately NOT listed here as aliases of each other, and D0145 ("Oral
    # Evaluation, Patient Under Three") is not aliased to either — confirmed
    # explicitly for this carrier rather than assumed.
    CODE_ALIASES = {
        "D1110": ["D1120"],                          # Prophylaxis: Adult <-> Child
        "D0274": ["D0272", "D0273", "D0270", "D0277"],  # Bitewings: 4/3/2/1 films, vertical
        "D1206": ["D1208"],                          # Fluoride: Varnish <-> Gel/topical
        "D0210": ["D0330"],                          # Full mouth series <-> Panoramic
    }
    # MetLife-specific: the plan's own "Cleanings and Periodontal Maintenance"
    # provision states whether Prophylaxis (D1110) and Periodontal Maintenance
    # (D4910) draw from one COMBINED frequency count rather than being tracked
    # separately, e.g. "This plan combines the frequency limitation for
    # cleanings and periodontal maintenance visits. The combined limit is 2".
    # This provision is present on every MetLife plan regardless — only a
    # combined limit GREATER THAN 0 actually means they're shared; a limit of
    # 0 (seen just as often) means NOT combined despite the rule existing.
    # Only merge when the plan explicitly confirms a positive combined limit;
    # never assume sharing by default. metlife_data is {} for every other
    # carrier, so .get("provisions", []) is a safe no-op there.
    for prov in metlife_data.get("provisions", []):
        if prov.get("rule", "").strip().lower() == "cleanings and periodontal maintenance":
            m = re.search(r"combined limit is (\d+)", prov.get("value", ""), re.IGNORECASE)
            if m and int(m.group(1)) > 0:
                CODE_ALIASES.setdefault("D1110", []).append("D4910")
                CODE_ALIASES.setdefault("D4910", []).append("D1110")
            break
    if is_ucci:
        CODE_ALIASES.setdefault("D0120", []).append("D0150")
        CODE_ALIASES.setdefault("D0150", []).append("D0120")

        # D1110/D4910 frequency sharing is plan-specific for UCCI — only merge
        # when THIS plan's own benefit-details limitation text says so. Carriers
        # word it from either row ("in combination with routine cleanings" on
        # D4910, or "in combination with periodontal maintenance" on D1110), so
        # check both directions rather than assuming one canonical phrasing.
        def _ucci_limitations(code):
            for cat in ucci_data.get("benefit_categories", []):
                for p in cat.get("procedures", []):
                    if p.get("procedure_code", "").upper() == code:
                        yield p.get("limitation", "")

        shares_freq = any(
            re.search(r"in combination with routine (cleaning|prophylaxis)", lim, re.IGNORECASE)
            for lim in _ucci_limitations("D4910")
        ) or any(
            re.search(r"in combination with periodontal maintenance", lim, re.IGNORECASE)
            for lim in _ucci_limitations("D1110")
        )
        if shares_freq:
            CODE_ALIASES.setdefault("D1110", []).append("D4910")
            CODE_ALIASES.setdefault("D4910", []).append("D1110")
        
    def _dos_with_aliases(code: str) -> str:
        # Merge dates from the primary code AND every alias code together —
        # e.g. D1110 has no entries but its alias D1120 has 3, or D0274 has
        # none but its alias D0272 has 1. Each dos_fn call may itself already
        # return multiple comma-joined dates, so we split those apart,
        # combine everyone's dates into one pool, dedupe, and sort
        # newest-first by actual date. Shows ALL on-file dates — no cap —
        # applied uniformly to every carrier's dos_fn since this is the
        # single place all 8 history fields get built.
        codes_to_try = [code] + CODE_ALIASES.get(code, [])
        seen = set()
        parsed = []
        for c in codes_to_try:
            result = dos_fn(procedures, c)
            if not result or result == "NH":
                continue
            for piece in result.split(","):
                d = piece.strip()
                if not d or d in seen:
                    continue
                try:
                    dt = datetime.strptime(d, "%m/%d/%Y")
                except ValueError:
                    continue
                seen.add(d)
                parsed.append((dt, d))
        if not parsed:
            return "NH"
        parsed.sort(key=lambda x: x[0], reverse=True)
        return ", ".join(d for _, d in parsed)

    return {
        "patient_name":               patient_name,
        "appointment_date":           "",
        "verified_by":                "",
        "verification_date":          verification_date,
        "eligibility_status":         "Currently Eligible",
        "carrier":                    carrier,
        "primary_secondary":          "Primary",
        "plan_type":                  plan_type,
        "patient_assigned_to_office": "NA",
        "individual_maximum_used":    ind_max_used,
        "individual_deductible_used": ind_ded_used,
        "ortho_maximum_used":         ortho_used,
        "history": {
            "periodic_exam_d0120":  _dos_with_aliases("D0120"),
            "comp_exam_d0150":      _dos_with_aliases("D0150"),
            "prophy_d1110":         _dos_with_aliases("D1110"),
            "perio_maint_d4910":    _dos_with_aliases("D4910"),
            "fmd_d4355":            _dos_with_aliases("D4355"),
            "fluoride_d1206_d1208": _dos_with_aliases("D1206"),
            "xray_d0274":           _dos_with_aliases("D0274"),
            "xray_d0210":           _dos_with_aliases("D0210"),
        },
    }
