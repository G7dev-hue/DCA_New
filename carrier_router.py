"""Carrier routing and shared extraction for the New Plan PDF pipeline.

Architecture:
    raw portal JSON -> detect carrier -> carriers/<carrier>.py -> canonical plan dict
    -> shared overrides/finalization -> new_plan.py renderer

Carrier modules own carrier-specific parsing and business rules. This module owns
only routing, shared helpers, the common normalized extraction contract, and
shared UI/output cleanup.
"""

import json
import re
import requests
from datetime import datetime, timedelta, timezone

OLLAMA_URL = "http://localhost:11434/api/generate"
OLLAMA_MODEL = "llama3.2"
OLLAMA_TIMEOUT = 60
USE_CLAUDE_FALLBACK = False
CLAUDE_MODEL = "claude-sonnet-4-20250514"

_LLM_DEFAULT_ANSWERS = {
    "molars_only_sealants": "—",
    "posterior_composite_downgrade": "—",
    "porcelain_posterior_downgrade": "—",
    "d2950_same_day_crown": "—",
    "ortho_payment_frequency": "—",
    "ortho_age_limit": "—",
}

_LLM_QUESTIONS_PROMPT = r"""
You are a dental insurance benefits analyst. Read the plan provisions below
and answer each question. Respond ONLY with a valid JSON object — no explanation,
no markdown fences, just raw JSON.

Use "Yes" / "No" for boolean questions, a short string for free-text, "—" if not present.

Questions:
1. "molars_only_sealants"           — For D1351 Sealants, are they limited to permanent molars only?
2. "posterior_composite_downgrade"  — Does the plan downgrade posterior composite fillings to amalgam?
3. "porcelain_posterior_downgrade"  — Does the plan downgrade porcelain/veneer crowns on posterior teeth to full cast?
4. "d2950_same_day_crown"           — Does the plan allow D2950 (build-up) same day as a crown? Answer Yes/No/Not stated.
5. "ortho_payment_frequency"        — What is the orthodontic payment frequency? (e.g. "End of quarter")
6. "ortho_age_limit"                — Maximum age for orthodontic coverage for a child/adolescent?

PLAN DATA:
{context}

Respond with ONLY a JSON object.
"""

_CARRIER_PRE_AUTH = {
    'metlife': 'Recommended-300',
    'cigna': 'Recommended-300',
    'delta': 'Recommended-300',
}

RELATION_MAP = {
    'child': 'Dependent', 'dependent': 'Dependent', 'self': 'Self',
    'subscriber': 'Self', 'spouse': 'Spouse', 'employee': 'Self', 'other': 'Other',
}

# Editable/operator-owned fields for New Plan. Denticon is mandatory and its
# office/provider fields are authoritative, so they are intentionally NOT
# exposed as manual overrides. Only plan-identification/operator fields remain
# editable. Carrier modules may append a field only if it is not Denticon-owned.
COMMON_EDITABLE_FIELDS = (
    {'key': 'insName', 'data_key': 'ins_name', 'label': 'Insurance Name', 'section': 'Plan Overrides', 'source': 'operator'},
    {'key': 'feeSchedule', 'data_key': 'fee_schedule', 'label': 'Fee Schedule', 'section': 'Plan Overrides', 'source': 'operator'},
    {'key': 'relationship', 'data_key': 'relationship', 'label': 'Relation to Subscriber', 'section': 'Plan Overrides', 'source': 'operator'},
    {'key': 'providerNetworkStatus', 'data_key': 'network_status', 'label': 'Provider Network Status', 'section': 'Plan Overrides', 'source': 'operator'},
)

_COMMON_OVERRIDE_ALIASES = {
    'ins_name': ('insName', 'insuranceName', 'ins_name'),
    'fee_schedule': ('feeSchedule', 'fee_schedule'),
    'relationship': ('relationship', 'relation'),
    'network_status': ('providerNetworkStatus', 'provider_network_status', 'networkStatus', 'network_status'),
}


def _override_value(overrides, *aliases):
    """Return the first non-empty operator override from the supplied aliases."""
    if not isinstance(overrides, dict):
        return ''
    for alias in aliases:
        value = overrides.get(alias)
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return ''

def _llm_build_context(portal_raw: dict) -> str:
    """Extract provisions + key procedure notes into a plain-text context string."""
    lines  = []
    ml     = portal_raw.get("metlife_data") or portal_raw
    procs  = (portal_raw.get("benefit_coverage") or {}).get("procedures", [])

    provisions = ml.get("provisions", [])
    if provisions:
        lines.append("=== PLAN PROVISIONS ===")
        for p in provisions:
            r = p.get("rule", "").strip()
            v = p.get("value", "").strip()
            if r and v:
                lines.append(f"  [{r}]: {v}")

    interesting = {"D1351","D2331","D2332","D2740","D2950",
                   "D0120","D0150","D0140","D1110","D4910","D8080","D8090"}
    proc_lines = []
    for p in procs:
        code = p.get("procedure_code","").upper()
        if code in interesting:
            proc_lines.append(
                f"  {code}: freq='{p.get('frequency_limit','')}' "
                f"desc='{p.get('description','')}'"
            )
    if proc_lines:
        lines.append("\n=== KEY PROCEDURE NOTES ===")
        lines.extend(proc_lines)

    return "\n".join(lines)

def _llm_call_ollama(prompt: str):
    payload = {
        "model": OLLAMA_MODEL, "prompt": prompt,
        "stream": False, "format": "json",
        "options": {"temperature": 0.0, "num_predict": 512},
    }
    try:
        resp = requests.post(OLLAMA_URL, json=payload, timeout=OLLAMA_TIMEOUT)
        resp.raise_for_status()
        raw = resp.json().get("response", "")
        raw = re.sub(r"```json|```", "", raw).strip()
        return json.loads(raw)
    except requests.exceptions.ConnectionError:
        print("[LLM] ⚠ Ollama not reachable")
        return None
    except Exception as e:
        print(f"[LLM] ⚠ Ollama error: {e}")
        return None

def _llm_normalize(raw: dict) -> dict:
    result = dict(_LLM_DEFAULT_ANSWERS)
    for k in _LLM_DEFAULT_ANSWERS:
        v = raw.get(k)
        if v is not None:
            result[k] = str(v).strip()
    for k in ["molars_only_sealants","posterior_composite_downgrade",
              "porcelain_posterior_downgrade"]:
        v = result[k].lower()
        if v in ("true","1","yes"): result[k] = "Yes"
        elif v in ("false","0","no"): result[k] = "No"
    return result

def _interpret_provisions(portal_raw: dict) -> dict:
    """
    Call LLM to answer interpretive questions from plan provisions.
    Returns a flat dict. Never raises — falls back to defaults on error.
    """
    context = _llm_build_context(portal_raw)
    if not context.strip():
        return dict(_LLM_DEFAULT_ANSWERS)

    prompt = _LLM_QUESTIONS_PROMPT.format(context=context)

    raw = _llm_call_ollama(prompt)

    if raw is None:
        print("[LLM] ⚠ All LLM calls failed — using defaults")
        return dict(_LLM_DEFAULT_ANSWERS)

    answers = _llm_normalize(raw)
    print("[LLM] ✓", json.dumps(answers, indent=2))
    return answers

def _rule_based_interp(portal_raw: dict, procs_map: dict) -> dict:
    """
    Parse note-row answers deterministically from provisions + procedure data.
    Returns a partial dict; '—' means "couldn't determine, let LLM try".
    """
    ml         = portal_raw.get('metlife_data') or portal_raw
    provisions = ml.get('provisions', []) if isinstance(ml, dict) else []
    bc_procs   = (portal_raw.get('benefit_coverage') or {}).get('procedures', [])

    proc_by_code = {p.get('procedure_code','').upper(): p for p in bc_procs}

    answers = dict(_LLM_DEFAULT_ANSWERS)

    # ── 1. Molars only for sealants (D1351) — SEE FIX #2 below ───────────────
    # (Moved to _rule_based_molars_only which is called from _extract)

    # ── 2. Posterior composite / porcelain downgrade — SEE FIX #4 below ──────
    # (Moved to dedicated parsers called from _extract)

    for p in provisions:
        rule  = str(p.get('rule',  '')).lower()
        value = str(p.get('value', '')).lower()

        # ── 3. D4910 + D1110 share frequency ──────────────────────────────────
        if 'cleaning' in rule or 'periodontal maintenance' in rule:
            if 'combines' in value or 'combined' in value:
                answers['d4910_d1110_share_freq'] = 'Yes'
            elif 'does not combine' in value or 'separate' in value:
                answers['d4910_d1110_share_freq'] = 'No'

        # ── 4. Ortho payment frequency ────────────────────────────────────────
        if 'ortho payment' in rule or 'payment method' in rule:
            v = p.get('value', '').strip()
            if v:
                answers['ortho_payment_frequency'] = v

        # ── 5. Ortho age limit ────────────────────────────────────────────────
        if 'maximum age for orthodontic' in rule or ('ortho' in rule and 'age' in rule):
            m = re.search(r'child\s*:\s*(\d+)', value, re.IGNORECASE)
            if m:
                answers['ortho_age_limit'] = m.group(1)

    # ── 6. D0120/D0150 share with D0140 ──────────────────────────────────────
    freqs = {
        c: proc_by_code.get(c, {}).get('frequency_limit', '')
        for c in ('D0120', 'D0150', 'D0140')
    }
    if all(freqs.values()) and len(set(
        re.sub(r'\s+', ' ', f).upper() for f in freqs.values()
    )) == 1:
        answers['d0120_d0150_share_d0140'] = 'Yes'

    return answers

def _rule_molars_only_sealants(procs_map: dict) -> str:
    """Resolve the permanent-molars question only from explicit website text."""
    p = procs_map.get('D1351')
    if not p:
        return ''

    freq_upper = str(p.get('frequency_limit', '')).upper().strip()
    if not freq_upper:
        return ''

    has_permanent = 'PERMANENT' in freq_upper
    has_molar = 'MOLAR' in freq_upper
    has_non_molar = any(
        word in freq_upper
        for word in ('PREMOLAR', 'BICUSPID', 'PRIMARY', 'ALL TEETH', 'ANY TOOTH')
    )

    if has_permanent and has_molar and not has_non_molar:
        return 'Yes'
    if has_non_molar:
        return 'No'
    return ''

def _rule_d2950_same_day_crown(procs_map: dict) -> str:
    """
    Return 'Yes' if D2740 exists in the plan AND is not marked as 'Not Covered'.
    Return 'No' if D2740 is explicitly not covered.
    Return '—' if D2740 is absent.
    """
    p = procs_map.get('D2740')
    if not p:
        return '—'

    freq_upper  = str(p.get('frequency_limit', '')).upper()
    level_upper = str(p.get('benefit_level',   '')).upper()

    if 'NOT COVERED' in freq_upper or level_upper in ('N/A', 'NOT COVERED', '0%', '0'):
        return 'No'

    # D2740 is present and covered → build-up same day is allowed
    return 'Yes'

def _rule_alternate_benefit_downgrades(provisions: list) -> dict:
    """
    Scan every provision whose rule contains 'alternate benefit' (case-insensitive).
    Parse the value text for the two canonical sentences:

      "amalgam filling for composite fillings performed on molar teeth: Yes/No"
      "full cast restoration for porcelain or veneer materials on molar teeth: Yes/No"
      "full cast restoration for porcelain or veneer crowns on bicuspid teeth: Yes/No"

    A downgrade applies ('Yes') when EITHER molars OR bicuspids sentence is 'Yes'.
    Returns dict with keys:
        'posterior_composite_downgrade'  → 'Yes' | 'No' | '—'
        'porcelain_posterior_downgrade'  → 'Yes' | 'No' | '—'
    """
    composite_answer  = '—'
    porcelain_answer  = '—'

    for p in provisions:
        rule  = str(p.get('rule',  '')).lower()
        value = str(p.get('value', ''))

        if 'alternate benefit' not in rule and 'alternate benefits' not in rule:
            continue

        # ── Composite → amalgam on molars ────────────────────────────────────
        # Sentence: "...amalgam filling for composite fillings performed on molar teeth: Yes/No"
        m = re.search(
            r'amalgam\s+filling\s+for\s+composite\s+fillings\s+performed\s+on\s+molar\s+teeth\s*:\s*(yes|no)',
            value,
            re.IGNORECASE,
        )
        if m:
            composite_answer = 'Yes' if m.group(1).lower() == 'yes' else 'No'

        # ── Porcelain/veneer → full cast on molars ────────────────────────────
        # Sentence: "...full cast restoration for porcelain or veneer materials on molar teeth: Yes/No"
        m_molar = re.search(
            r'full\s+cast\s+restoration\s+for\s+porcelain\s+or\s+veneer\s+(?:materials|crowns)\s+on\s+molar\s+teeth\s*:\s*(yes|no)',
            value,
            re.IGNORECASE,
        )
        # Sentence: "...full cast restoration for porcelain or veneer crowns on bicuspid teeth: Yes/No"
        m_bicuspid = re.search(
            r'full\s+cast\s+restoration\s+for\s+porcelain\s+or\s+veneer\s+(?:materials|crowns)\s+on\s+bicuspid\s+teeth\s*:\s*(yes|no)',
            value,
            re.IGNORECASE,
        )

        molar_yes    = m_molar    and m_molar.group(1).lower()    == 'yes'
        bicuspid_yes = m_bicuspid and m_bicuspid.group(1).lower() == 'yes'

        # If either molar or bicuspid sentence was found, resolve the answer
        if m_molar or m_bicuspid:
            porcelain_answer = 'Yes' if (molar_yes or bicuspid_yes) else 'No'

    return {
        'posterior_composite_downgrade': composite_answer,
        'porcelain_posterior_downgrade': porcelain_answer,
    }

def _clean_phone(phone):
    return re.sub(r'[\s\-()]', '', str(phone or ''))

def _parse_waiting_period(provisions: list, notes: dict):
    """
    Returns (waiting_period, waiting_period_months, applies_to).
    """
    for p in (provisions or []):
        rule  = str(p.get('rule',  '')).lower()
        value = str(p.get('value', ''))
        if 'waiting period' not in rule:
            continue

        v = value.lower()

        if v.count('no waiting period') >= 2:
            return 'No', '0', '—'

        if 'no waiting period' in v:
            return 'No', '0', '—'

        applies_parts, months_found = [], '—'
        for cat in ['basic', 'major', 'preventive', 'preventative', 'orthodontic']:
            m = re.search(rf'{cat}[^.;]*?(\d+)\s*month', v, re.IGNORECASE)
            if m:
                applies_parts.append(cat.title())
                months_found = m.group(1)

        if applies_parts:
            return 'Yes', months_found, ' & '.join(applies_parts)

        if 'no waiting' in v:
            return 'No', '0', '—'

    waiting_raw = str(notes.get('waiting', '')).strip().lower()
    if waiting_raw in ('no', 'n', '0', 'false'):
        return 'No', '0', '—'
    if waiting_raw in ('yes', 'y', '1', 'true'):
        return 'Yes', '—', '—'

    return 'No', '0', ''

def _parse_pre_auth(notes: dict, notes_str: str, carrier_name: str) -> str:
    carrier_lower = str(carrier_name).lower()
    for key, val in _CARRIER_PRE_AUTH.items():
        if key in carrier_lower:
            return val

    m = re.search(
        r'PRE-D\s+MANDATORY\s*(?:\(Y/N\))?\s*:?\s*([YyNn]|yes|no|\$[\d,]+|\d+)',
        notes_str,
        re.IGNORECASE,
    )
    if m:
        v = m.group(1).strip().lower()
        if v in ('y', 'yes'): return 'Yes'
        if v in ('n', 'no'):  return 'No'
        return m.group(1).strip()

    return '—'

def _g(obj, *keys, default='—'):
    if not isinstance(obj, dict):
        return default
    for k in keys:
        v = obj.get(k)
        if v not in (None, '', [], {}):
            return str(v).strip()
        norm = k.lower().replace('_','').replace(' ','').replace('-','')
        for okey, oval in obj.items():
            ck = okey.lower().replace('_','').replace(' ','').replace('-','')
            if ck == norm and oval not in (None, '', [], {}):
                return str(oval).strip()
    return default

def _dollar(raw, default='—'):
    if not raw or raw == '—':
        return default
    m = re.search(r'\$?\s*([\d,]+\.?\d*)', str(raw))
    if m:
        try:
            return f"{float(m.group(1).replace(',', '')):,.2f}"
        except ValueError:
            pass
    return default

def _parse_notes(s):
    result = {}
    if not s:
        return result
    patterns = {
        'group_number':  r'GROUP\s*#\s*:?\s*(\S+)',
        'dep_age_limit': r'DEPENDENT\s+AGE\s+LIMIT\s*:?\s*(\d+)',
        'ded_prev':      r'APPLY\s+TO\s+PREVENTATIVE\s*(?:\(Y/N\))?\s*:?\s*(\w+)',
        'waiting':       r'WAITING\s+PERIOD\s*(?:\(Y/N\))?\s*:?\s*(\w+)',
        'plan_type':     r'PPO/HMO/INDEMNITY\s*:?\s*(\w+)',
        'fee_schedule':  r'WHAT\s+FEE\s+SCHEDULE\s*:?\s*([A-Z0-9/() ]+)',
        'cal_year':      r'CALENDAR\s+YEAR\s*:?\s*(\d{4})',
        'employer':      r'EMPLOYER\s*:?\s*([A-Z ]+?)(?:\s{2,}|\n|GROUP)',
        'prev_pct':      r'PREVENTATIVE\s*%\s*:?\s*(\d+%)',
        'basic_pct':     r'BASIC\s*%\s*:?\s*(\d+%)',
        'major_pct':     r'MAJOR\s*%\s*:?\s*(\d+%)',
        'missing_tooth': r'MISSING\s+TOOTH\s+CLAUSE?\s*(?:\(Y/N\))?\s*:?\s*(\w+)',
        'pre_auth':      r'PRE-D\s+MANDATORY\s*(?:\(Y/N\))?\s*:?\s*(\w+)',
    }
    for k, pat in patterns.items():
        m = re.search(pat, s, re.IGNORECASE)
        if m:
            result[k] = m.group(1).strip()
    return result

def _covered_pct(services, *category_hints):
    # Respect caller priority (for example RESTORATIVE before DIAGNOSTIC).
    for hint in category_hints:
        for svc in services:
            cat = svc.get('category', '').upper()
            if hint not in cat:
                continue
            m = re.search(r'(\d+%)', svc.get('in_network', ''))
            if m:
                return m.group(1)
    return '—'

def _format_frequency(freq, compact=False):
    if not freq or freq == '—':
        return '—'
    f = str(freq).upper().strip()
    f = re.sub(r'\s+', ' ', f)
    if f in ('N/A', 'NA', 'NOT APPLICABLE'):
        return 'N/A'
    if 'NO LIMIT' in f:      return 'NO FREQUENCY' if compact else 'No Frequency'
    if 'NO FREQUENCY' in f:  return 'NO FREQUENCY' if compact else 'No Frequency'
    if 'NOT COVERED' in f:   return 'NC'
    if 'NOT AVAILABLE' in f: return 'NOT AVAILABLE'
    if f in ['PRE-D', 'PRE D']: return 'Pre-D'

    # ClaimConnect/Aetna phrases limits as, for example:
    #   "2 Units, for 1 Calendar Year ..."
    #   "1 Visit, per 24 Months ..."
    # Preserve the leading unit/visit count before the generic "per N"
    # parser sees only the duration and incorrectly reduces 2X1 to 1X1.
    m = re.search(
        r'\b(\d+)\s*(?:UNITS?|VISITS?|TIMES?|SERVICES?)\s*,?\s*'
        r'(?:FOR|IN|PER|EVERY)\s+(\d+)\s*'
        r'(?:CONSECUTIVE\s+|CALENDAR\s+|POLICY\s+)?'
        r'(MONTH|YEAR|DAY)S?\b',
        f,
        re.IGNORECASE,
    )
    if m:
        count = m.group(1)
        duration = m.group(2)
        unit = m.group(3).upper()
        if int(duration) != 1:
            unit += 'S'
        return f'{count}X{duration}{unit}' if compact else f'{count}X{duration} {unit.title()}'

    m = re.search(r'\b(?:EVERY|PER)\s+(\d+)\s*(?:CALENDAR\s+|POLICY\s+)?(MONTH|YEAR|DAY)S?\b', f, re.IGNORECASE)
    if m:
        duration = m.group(1)
        unit = m.group(2).upper()
        if int(duration) != 1:
            unit += 'S'
        return f'1X{duration}{unit}' if compact else f'1X{duration} {unit.title()}'
    m = re.search(r'\b(\d+)\s*X\s*(\d+)\s*(MONTH|YEAR|DAY)S?\b', f, re.IGNORECASE)
    if m:
        count = m.group(1)
        duration = m.group(2)
        unit = m.group(3).upper()
        if int(duration) != 1:
            unit += 'S'
        return f'{count}X{duration}{unit}' if compact else f'{count}X{duration} {unit.title()}'
    m = re.search(r'\b(\d+)\s*X\s*LIFETIME\b', f, re.IGNORECASE)
    if m:
        return f'{m.group(1)}XLIFETIME' if compact else f"{m.group(1)}XLifetime"
    word_counts = {
        'ONCE': '1',
        'ONE': '1',
        'TWICE': '2',
        'TWO': '2',
        'THRICE': '3',
        'THREE': '3',
        'FOUR': '4',
    }
    word_pattern = '|'.join(word_counts)
    m = re.search(
        rf'\b({word_pattern})\b\s*(?:TIME\S*)?\s*(?:IN|PER|EVERY)?\s*(\d+)?\s*(?:CONSECUTIVE\s+|CALENDAR\s+|POLICY\s+)?(MONTH|YEAR|DAY)S?',
        f,
        re.IGNORECASE
    )
    if m:
        count = word_counts[m.group(1).upper()]
        duration = m.group(2) or '1'
        unit = m.group(3).upper()
        if int(duration) != 1:
            unit += 'S'
        return f'{count}X{duration}{unit}' if compact else f'{count}X{duration} {unit.title()}'
    m = re.search(
        r'(\d+)\s*(?:TIME\S*|X)?\s*(?:IN|PER|EVERY)\s*(\d+)\s*(?:CALENDAR\s+|POLICY\s+)?(MONTH|YEAR|DAY)S?',
        f,
        re.IGNORECASE
    )
    if m:
        count    = m.group(1)
        duration = m.group(2)
        unit     = m.group(3).upper()
        if int(duration) != 1:
            unit += 'S'
        return f'{count}X{duration}{unit}' if compact else f'{count}X{duration} {unit.title()}'
    m = re.search(
        r'(\d+)\s*(?:TIME\S*|X|PER)?\s*(?:IN|PER|EVERY)?\s*(?:ONE|1)?\s*(?:CALENDAR\s+|POLICY\s+)?(MONTH|YEAR|DAY)S?',
        f,
        re.IGNORECASE
    )
    if m:
        return (
            f"{m.group(1)}X1{m.group(2).upper()}"
            if compact else f"{m.group(1)}X1 {m.group(2).title()}"
        )
    m = re.search(
        r'(\d+)\s*(?:TIME\S*|X)?\s*(?:IN|PER|EVERY)\s*(\d+)\s*(MONTH|YEAR|DAY)S?',
        f,
        re.IGNORECASE
    )
    if m:
        count = m.group(1)
        duration = m.group(2)
        unit = m.group(3).upper()
        if int(duration) != 1:
            unit += 'S'
        return f'{count}X{duration}{unit}' if compact else f'{count}X{duration} {unit.title()}'
    m = re.search(r'(\d+)\s*(?:TIME\S*|X)?\s*(?:IN|PER|EVERY)?\s*LIFETIME', f)
    if m or 'LIFETIME' in f:
        return f"{m.group(1) if m else '1'}XLIFETIME" if compact else f"{m.group(1) if m else '1'}XLifetime"
    if 'PROVIDER' in f:
        return '1XPROVIDER' if compact else '1XProvider'
    return f if compact else freq

def _format_person_name(name):
    if not name or name == '—':
        return '—'
    name = str(name).strip()
    if ',' in name:
        last, first = [x.strip() for x in name.split(',', 1)]
        return f"{first.title()} {last.title()}"
    return name.title()

def _build_insurance_address(carrier):
    if not isinstance(carrier, dict):
        return '—'
    addr1    = carrier.get('address') or ''
    city     = carrier.get('city') or ''
    state    = carrier.get('state') or ''
    zipc     = carrier.get('zip') or carrier.get('zip_code') or ''
    combined = carrier.get('city_state_zip') or carrier.get('cityStateZip') or ''
    if combined and not city:
        city_state_zip = combined.strip()
    else:
        city_state_zip = ", ".join(x for x in [city, state] if x)
        if zipc:
            city_state_zip += f" {zipc}"
    final = ", ".join(x for x in [addr1, city_state_zip] if x.strip())
    return final or '—'

def _get_plan_year_start(procs, eff_date):
    d2740 = procs.get('D2740', {})
    freq = str(d2740.get('frequency_limit', '')).upper()
    if 'CALENDAR YEAR' in freq:
        return 'January'
    try:
        return datetime.strptime(eff_date, '%m/%d/%Y').strftime('%B')
    except:
        return '—'

def _effective_date_month(value):
    """Return the plan effective-date month, without inventing a date."""
    raw = str(value or '').strip()
    for pattern in ('%m/%d/%Y', '%Y-%m-%d', '%m-%d-%Y'):
        try:
            return datetime.strptime(raw, pattern).strftime('%B')
        except ValueError:
            pass
    return ''

def _blank_present_end_date(value):
    """Display a blank term date when the plan is active / has no term date."""
    raw = str(value or '').strip()
    text = re.sub(r'\s+', ' ', raw).lower()
    if not text:
        return ''
    if text in (
        '-', '—', 'n/a', 'na', 'none', 'null',
        'present', 'current', 'active', 'ongoing', 'current plan',
        'not available', 'not applicable',
    ):
        return ''
    if re.search(r'\b(present|ongoing|active|current\s+plan)\b', text):
        return ''
    return raw

def _display_plan_type(value, default='-'):
    """Extract just PPO/HMO/INDEMNITY from plan text like 'Dental PPO'."""
    raw = clean(value)
    if not raw or raw == '—':
        return default
    upper = raw.upper()
    for label in ('PPO', 'HMO', 'INDEMNITY'):
        if re.search(rf'\b{label}\b', upper):
            return label
    return upper

def _triple_individual_deductible(value, default='-'):
    """Business fallback when a family deductible is not returned by the portal."""
    match = re.search(r'([\d,.]+)', str(value or ''))
    if not match:
        return default
    return f"{float(match.group(1).replace(',', '')) * 3:,.2f}"

def _yes_no_from_basis(text, target):
    t = re.sub(r'\s+', ' ', str(text).lower()).strip()
    if 'completion date' in t:
        return 'Yes' if target == 'seat' else 'No'
    if 'prep date' in t:
        return 'Yes' if target == 'prep' else 'No'
    return '—'

def _missing_tooth_clause(text):
    t = re.sub(r'\s+', ' ', str(text).lower()).strip()
    if 'lost prior to effective date: no' in t:  return 'Yes'
    if 'lost prior to effective date: yes' in t: return 'No'
    return '—'

def _extract_basis_of_payment(provisions):
    for p in provisions:
        if 'basis of payment' in str(p.get('rule', '')).lower():
            return p.get('value', '')
    return ''

def _extract_missing_tooth_text(provisions):
    for p in provisions:
        if 'missing tooth' in str(p.get('rule', '')).lower():
            return p.get('value', '')
    return ''

def _extract_dependent_age_limit(provisions):
    """Read the non-orthodontic dependent age limit from Portal provisions."""
    for p in provisions or []:
        rule = str(p.get('rule', '')).lower()
        if 'maximum child age' not in rule and 'maximum age' not in rule:
            continue
        if 'orthodont' in rule:
            continue
        m = re.search(r'(?:child\s*:?\s*)?(\d+)', str(p.get('value', '')), re.IGNORECASE)
        if m:
            return m.group(1)
    return 'NAL'

def _procedure_benefit_pct(procs, *codes):
    """Return the first usable numeric benefit percentage from representative codes."""
    for code in codes:
        proc = (procs or {}).get(code) or {}
        value = str(proc.get('benefit_level') or '').strip()
        if value.upper() in ('', '-', '—', 'N/A', 'NA', 'NC', 'NOT COVERED'):
            continue
        m = re.search(r'(\d+(?:\.\d+)?)\s*%', value)
        if m:
            try:
                return f"{float(m.group(1)):g}%"
            except ValueError:
                return f"{m.group(1)}%"
    return ''

def _covered_pct_max(services, *category_hints):
    """Return the highest plan-paid percentage in the first matching category."""
    for hint in category_hints:
        for svc in services or []:
            if hint not in str(svc.get('category', '')).upper():
                continue
            values = [float(v) for v in re.findall(r'(\d+(?:\.\d+)?)\s*%', str(svc.get('in_network', '')))]
            if values:
                return f"{max(values):g}%"
    return ''

def _deductible_applies(services, *category_hints):
    """Return Yes/No from Portal covered_services.in_network text."""
    for svc in services or []:
        cat = str(svc.get('category', '')).upper()
        if not any(h in cat for h in category_hints):
            continue
        text = str(svc.get('in_network', ''))
        m = re.search(r'Deductible\s+Applies\s*:\s*(Yes|No)', text, re.IGNORECASE)
        if m:
            return m.group(1).title()
        if re.search(r'Deductible\s+Not\s+Applies', text, re.IGNORECASE):
            return 'No'
    return '—'

def _number_of_quads_d4341(procs):
    """Read D4341 quadrant count from Portal procedure data only."""
    p = procs.get('D4341', {})
    if not p:
        return '—'

    for key in (
        'number_of_quads', 'number_of_quadrants', 'quadrants',
        'quad_limit', 'quadrant_limit', 'quads_allowed',
    ):
        value = p.get(key)
        if value not in (None, '', '—'):
            m = re.search(r'\d+', str(value))
            return m.group(0) if m else str(value).strip()

    searchable = ' '.join(str(p.get(k, '')) for k in (
        'frequency_limit', 'description', 'limitations', 'notes',
    ))
    for pattern in (
        r'(\d+)\s*(?:QUADS?|QUADRANTS?)\s+ALLOWED',
        r'(?:LIMIT(?:ED)?\s+TO\s+)?(\d+)\s*(?:QUADS?|QUADRANTS?)',
        r'(?:QUADS?|QUADRANTS?)\s*[:=-]?\s*(\d+)',
    ):
        m = re.search(pattern, searchable, re.IGNORECASE)
        if m:
            return m.group(1)
    return '—'

def _format_history_dates(value):
    """Return all history dates as wrapped PDF text.

    Portal adapters may supply history as a list, a single date, or one string
    containing several dates. Preserve every distinct date in source order so
    long histories can wrap/paginate naturally instead of silently collapsing
    to only the final date.
    """
    values = []
    if isinstance(value, list):
        candidates = value
    elif value in (None, ''):
        candidates = []
    else:
        candidates = [value]

    def add_date(mm, dd, yyyy):
        year = str(yyyy)
        if len(year) == 2:
            year = '20' + year
        normalized = f'{mm}/{dd}/{year}'
        if normalized not in values:
            values.append(normalized)

    for item in candidates:
        if isinstance(item, dict):
            raw = item.get('date') or item.get('serviceDate') or item.get('service_date') or ''
        else:
            raw = str(item or '')
        raw = raw.strip()
        if not raw:
            continue
        if 'no history' in raw.lower() or raw.upper() == 'NH':
            return 'NH'

        found = False
        # Scan the entire string, not only its ending. Aetna can return several
        # "Last paid date" entries in one value; other carriers may return lists.
        token_re = re.compile(
            r'(?P<iso>\b\d{4}-\d{2}-\d{2}\b)'
            r'|(?P<us>\b\d{2}/\d{2}/(?:\d{2}|\d{4})\b)'
        )
        for match in token_re.finditer(raw):
            found = True
            token = match.group(0)
            if '-' in token:
                yyyy, mm, dd = token.split('-')
                add_date(mm, dd, yyyy)
            else:
                mm, dd, yyyy = token.split('/')
                add_date(mm, dd, yyyy)

        if not found and raw not in values:
            values.append(raw)

    return '\n'.join(values)

def _family_deductible_v2(fam_total_raw: str, indiv_total_raw: str, relationship: str) -> str:
    """
    Show exactly what the portal shows:
      1. If the plan provides a family deductible total → use it as-is (always).
      2. If blank/missing → derive as 3 × individual deductible.
    """
    # Case 1: plan has a value — just reflect it
    fam_dollar = _dollar(fam_total_raw, default='')
    if fam_dollar and fam_dollar != '—':
        return fam_dollar

    # Case 2: no family value in plan — business fallback is 3 × individual.
    m = re.search(r'([\d,.]+)', str(indiv_total_raw))
    if not m:
        return _dollar(indiv_total_raw, default='—')

    indiv_val = float(m.group(1).replace(',', ''))
    return f"{indiv_val * 3:,.2f}"

def _zero_money(val):
    if val in ['—', '', None, 'N/A']:
        return '0.00'
    return val

def clean(s):
    return re.sub(r'\s+', ' ', str(s or '')).strip()


def _format_name_for_pdf(raw):
    if not raw or raw == '—':
        return '—'
    suffixes = ['DMD', 'DDS', 'MD', 'DO', 'PHD', 'RDH']
    parts = str(raw).strip().split()
    parts = [p for p in parts if p.upper().rstrip('.') not in suffixes]
    cleaned = ' '.join(parts).strip()
    if ',' in cleaned:
        last, *rest = cleaned.split(',')
        first_parts = ' '.join(rest).strip().split()
        first = first_parts[0].capitalize() if first_parts else ''
        last = last.strip().capitalize()
        return f'{first} {last}'.strip()
    return ' '.join(p.capitalize() for p in cleaned.split())


def _extract_common(portal_raw, denticon_raw, carrier_name_hint=''):
    """Extract the canonical renderer dictionary from the normalized portal contract.

    This intentionally contains no carrier-specific constants. Carrier modules
    normalize their raw payload, call this function, then apply their own rules.
    """
    portal_raw = portal_raw or {}
    denticon_raw = denticon_raw or {}

    carrier = portal_raw.get('carrier_information') or portal_raw.get('carrier_info') or {}
    ml = portal_raw.get('metlife_data') or portal_raw
    bc = portal_raw.get('benefit_coverage') or {}

    dent = denticon_raw.get('denticon_data') or denticon_raw
    dent_hdr = dent.get('header', {}) if isinstance(dent, dict) else {}
    dent_pt = dent.get('patient', {}) if isinstance(dent, dict) else {}

    ml_pat = ml.get('patient', {}) if isinstance(ml.get('patient', {}), dict) else {}
    ml_pln = ml.get('plan_details', {}) if isinstance(ml.get('plan_details', {}), dict) else {}
    ml_fin = ml.get('financials', {}) if isinstance(ml.get('financials', {}), dict) else {}
    ml_provider = ml.get('provider_info', {}) if isinstance(ml.get('provider_info', {}), dict) else {}

    svcs = ml.get('covered_services', [])
    provisions = ml.get('provisions', [])
    if not isinstance(svcs, list):
        svcs = []

    basis_payment_text = clean(_extract_basis_of_payment(provisions))
    missing_tooth_text = clean(_extract_missing_tooth_text(provisions))

    interp = dict(_LLM_DEFAULT_ANSWERS) if portal_raw.get('_skip_llm') else _interpret_provisions(portal_raw)
    waiting_period, waiting_period_mo, applies_to = _parse_waiting_period(provisions, {})

    carrier_name = (
        carrier_name_hint
        or _g(carrier, 'name', default='')
        or _g(ml_provider, 'provider_name', default='')
        or '—'
    )

    procs = {}
    for p in bc.get('procedures', []):
        if not isinstance(p, dict):
            continue
        code = p.get('procedure_code', '').upper().strip()
        if code:
            procs[code] = p

    rule_interp = _rule_based_interp(portal_raw, procs)
    for key, value in rule_interp.items():
        if str(value or '').strip().lower() not in ('', '-', '—', 'n/a', 'na', 'none'):
            interp[key] = value

    def same_frequency(code1, code2):
        p1, p2 = procs.get(code1, {}), procs.get(code2, {})
        f1 = str(p1.get('frequency_limit', '')).strip().upper()
        f2 = str(p2.get('frequency_limit', '')).strip().upper()
        if not f1 or not f2:
            return 'No'
        return 'Yes' if f1 == f2 else 'No'

    d4910_d1110_same_freq = same_frequency('D4910', 'D1110')
    d0120_d0150_share_with_d0140 = (
        'Yes' if same_frequency('D0120', 'D0140') == 'Yes' and same_frequency('D0150', 'D0140') == 'Yes'
        else 'No'
    )

    ann = ml_fin.get('annual_max', {})
    dind = ml_fin.get('deductible_ind', {})
    dfam = ml_fin.get('deductible_fam', {})
    orth = ml_fin.get('ortho_lifetime', {})

    member_id = _g(ml_pln, 'subscriber_id', default='') or '—'
    sub_info = portal_raw.get('subscriber_info') or {}
    subscriber_name = _format_name_for_pdf(sub_info.get('name', '') or _g(ml_pat, 'name', default=''))
    subscriber_dob = sub_info.get('dob', '') or _g(ml_pat, 'dob', default='') or '—'

    raw_rel = _g(ml_pat, 'relationship', default='') or _g(sub_info, 'relation', 'relationship', default='')
    relationship = RELATION_MAP.get(raw_rel.strip().lower(), raw_rel or '—')

    office_name = _g(dent_pt, 'home_office', default='') or _g(dent_hdr, 'office_name', default='') or '—'
    provider_name = _format_name_for_pdf(_g(dent_pt, 'provider', default='') or _g(dent_hdr, 'provider_name', default=''))
    chair_provider = _format_name_for_pdf(_g(dent_pt, 'chair_provider', default='—'))
    provider_speciality = _g(dent_hdr, 'provider_speciality', 'speciality', 'specialty', default='') or 'Dentist'

    group_number = (
        _g(ml_pln, 'group_number', 'group_num', 'group_id', 'group_no', 'employer_group_number', 'contract_number', default='')
        or _g(ml, 'group_number', 'group_num', 'group_id', 'group_no', 'employer_group_number', 'contract_number', default='')
        or _g(portal_raw, 'group_number', 'group_num', 'group_id', 'group_no', 'employer_group_number', 'contract_number', default='')
        or '—'
    )

    molars_only = _rule_molars_only_sealants(procs)
    if molars_only == '—':
        molars_only = interp.get('molars_only_sealants', '—')

    d2950_same_day = _rule_d2950_same_day_crown(procs)
    if d2950_same_day == '—':
        d2950_same_day = interp.get('d2950_same_day_crown', '—')

    downgrade_answers = _rule_alternate_benefit_downgrades(provisions)
    posterior_composite = downgrade_answers['posterior_composite_downgrade']
    porcelain_posterior = downgrade_answers['porcelain_posterior_downgrade']
    if posterior_composite == '—':
        posterior_composite = interp.get('posterior_composite_downgrade', '—')
    if porcelain_posterior == '—':
        porcelain_posterior = interp.get('porcelain_posterior_downgrade', '—')

    family_ded_val = _family_deductible_v2(
        fam_total_raw=_g(dfam, 'total', default=''),
        indiv_total_raw=_g(dind, 'total', default=''),
        relationship=relationship,
    )

    return {
        'source_insurer': '',
        'patient_name': _g(ml_pat, 'name'),
        'patient_dob': _g(ml_pat, 'dob'),
        'relationship': relationship,
        'member_id': member_id,
        'subscriber_name': subscriber_name,
        'subscriber_dob': subscriber_dob,
        'ssn': member_id,
        'office_name': office_name,
        'provider_name': provider_name,
        'chair_provider': chair_provider,
        'provider_speciality': provider_speciality,
        'appointment_date': datetime.now(timezone(timedelta(hours=5, minutes=30))).strftime('%m/%d/%Y %I:%M %p'),
        'ins_name': carrier_name if carrier_name else '—',
        'group_name': _g(ml_pln, 'employer_group'),
        'group_number': group_number,
        'fee_schedule': _g(ml_provider, 'provider_network_status'),
        'ins_address': _build_insurance_address(carrier) or '—',
        'ins_phone': _clean_phone(_g(carrier, 'phone', default='')) or '—',
        'network_status': '',
        'eff_date': _g(ml_pln, 'start_date'),
        'term_date': _blank_present_end_date(_g(ml_pln, 'end_date')),
        'payor_id': _g(carrier, 'payer_id', default='') or '—',
        'plan_type': _display_plan_type(_g(ml_pln, 'plan_type', default='') or _g(ml_pln, 'network', default='')),
        'plan_year_start': _get_plan_year_start(procs, _g(ml_pln, 'start_date')),
        'elig_notes': '—',
        'yearly_max': _dollar(_g(ann, 'total')),
        'yearly_rem': _dollar(_g(ann, 'remaining')),
        'indiv_ded': _dollar(_g(dind, 'total')),
        'indiv_ded_paid': _zero_money(_dollar(_g(dind, 'used'))),
        'family_ded': family_ded_val,
        'family_ded_paid': _zero_money(_dollar(_g(dfam, 'used'))),
        'ded_prev': _deductible_applies(svcs, 'PREVENTIVE'),
        'ded_diag': _deductible_applies(svcs, 'DIAGNOSTIC'),
        'waiting_period': waiting_period,
        'waiting_period_mo': waiting_period_mo,
        'applies_to': applies_to,
        'major_on_prep': _yes_no_from_basis(basis_payment_text, 'prep'),
        'or_seat': _yes_no_from_basis(basis_payment_text, 'seat'),
        'missing_tooth': _missing_tooth_clause(missing_tooth_text),
        'pre_auth': _parse_pre_auth({}, '', carrier_name),
        'dep_age_limit': _extract_dependent_age_limit(provisions),
        'ortho_ded': '0.00',
        'ortho_ded_paid': '0.00',
        'ortho_max': _dollar(_g(orth, 'total')),
        'ortho_max_paid': _dollar(_g(orth, 'used')),
        'pct_prev': _covered_pct(svcs, 'PREVENTIVE'),
        'pct_basic': _covered_pct(svcs, 'RESTORATIVE', 'DIAGNOSTIC'),
        'pct_major': _covered_pct(svcs, 'PROSTHODONTICS', 'IMPLANT'),
        'molars_only_sealants': molars_only,
        'posterior_composite_downgrade': posterior_composite,
        'porcelain_posterior_downgrade': porcelain_posterior,
        'd2950_same_day_crown': d2950_same_day,
        'd0120_d0150_share_d0140': d0120_d0150_share_with_d0140,
        'd4910_d1110_share_freq': d4910_d1110_same_freq,
        'd4341_number_of_quads': _number_of_quads_d4341(procs),
        'ortho_payment_frequency': interp.get('ortho_payment_frequency', '—'),
        'ortho_age_limit_llm': interp.get('ortho_age_limit', '—'),
        'procs': procs,
    }


def _carrier_modules():
    # Lazy imports avoid circular imports because carrier modules use shared
    # helpers from this middle layer.
    from carriers import aetna, cigna, metlife
    return (aetna, cigna, metlife)


def resolve_carrier(portal_raw):
    matches = [module for module in _carrier_modules() if module.matches(portal_raw or {})]
    if len(matches) > 1:
        raise ValueError('Ambiguous carrier payload: ' + ', '.join(m.__name__ for m in matches))
    return matches[0] if matches else None


def detect_carrier(portal_raw):
    module = resolve_carrier(portal_raw)
    return getattr(module, 'CARRIER_KEY', '') if module else ''


_FINANCIAL_OUTPUT_KEYS = (
    'yearly_max', 'yearly_rem',
    'indiv_ded', 'indiv_ded_paid',
    'family_ded', 'family_ded_paid',
    'ortho_ded', 'ortho_ded_paid',
    'ortho_max', 'ortho_max_paid',
)


def _apply_overrides(data, ins_override, carrier_module=None):
    """Apply operator inputs after carrier/Denticon extraction.

    Denticon-owned office/provider fields are not overrideable here. For the
    remaining editable plan/operator fields, manual input wins over carrier/default
    values.

    Carrier modules may add their own override semantics (for example MetLife
    SSN/Member ID synchronization) via ``apply_overrides``.
    """
    if not ins_override:
        return data

    # Generic plan/operator values. Keep the relationship special case because
    # changing it can affect the family-deductible fallback.
    for data_key, aliases in _COMMON_OVERRIDE_ALIASES.items():
        value = _override_value(ins_override, *aliases)
        if not value:
            continue

        if data_key == 'relationship':
            data['relationship'] = value
            preserve = bool(getattr(carrier_module, 'PRESERVE_FAMILY_DED_ON_RELATIONSHIP_OVERRIDE', False))
            if not preserve:
                data['family_ded'] = _family_deductible_v2(
                    fam_total_raw=data.get('family_ded', ''),
                    indiv_total_raw=data.get('indiv_ded', ''),
                    relationship=value,
                )
        elif data_key == 'network_status':
            normalized_status = value.upper()
            data['network_status'] = normalized_status if normalized_status in ('PPO', 'IN', 'OUT') else value
        elif data_key in ('provider_name', 'chair_provider'):
            data[data_key] = _format_name_for_pdf(value)
        else:
            data[data_key] = value

        print(f'[override] {data_key:<20} → {data.get(data_key)}')

    if carrier_module and hasattr(carrier_module, 'apply_overrides'):
        updated = carrier_module.apply_overrides(data, ins_override)
        if isinstance(updated, dict):
            data = updated
    return data

def _finalize_shared_output(data):
    """Carrier-independent display rules immediately before rendering."""
    data = data or {}

    for key in _FINANCIAL_OUTPUT_KEYS:
        value = str(data.get(key) or '').strip()
        if value.lower() in ('', '-', '—', 'n/a', 'na', 'none'):
            data[key] = '0.00'
            continue
        match = re.search(r'\$?\s*([\d,]+(?:\.\d+)?)', value)
        if match:
            try:
                data[key] = f"{float(match.group(1).replace(',', '')):,.2f}"
            except ValueError:
                data[key] = value.replace('$', '')
        else:
            data[key] = value.replace('$', '')

    phone = str(data.get('ins_phone') or '').strip()
    if phone not in ('', '-', '—'):
        digits = re.sub(r'\D', '', phone)
        data['ins_phone'] = digits or phone

    relationship = str(data.get('relationship') or '').strip()
    if relationship.lower() in ('self', 'subscriber', 'employee'):
        data['relationship'] = 'Self'

    data['term_date'] = _blank_present_end_date(data.get('term_date'))

    if str(data.get('waiting_period') or '').strip().lower() in ('', '-', '—', 'n/a', 'na', 'none'):
        data['waiting_period'] = 'No'
        data['waiting_period_mo'] = '0'
        data['applies_to'] = ''
    elif str(data.get('waiting_period')).strip().lower() == 'no':
        data['waiting_period'] = 'No'
        if str(data.get('waiting_period_mo') or '').strip().lower() in ('', '-', '—', 'n/a', 'na', 'none'):
            data['waiting_period_mo'] = '0'

    dep_age_raw = str(data.get('dep_age_limit') or '').strip()
    dep_age_number = re.search(r'\b(\d+)\b', dep_age_raw)
    if (
        dep_age_raw.lower() in ('', '-', '—', 'n/a', 'na', 'none', 'null', 'not available', 'not applicable')
        or (dep_age_number and dep_age_number.group(1) in ('99', '999'))
    ):
        data['dep_age_limit'] = 'NAL'

    if str(data.get('molars_only_sealants') or '').strip().lower() in ('-', '—', 'n/a', 'na', 'none'):
        data['molars_only_sealants'] = ''

    ortho_age_raw = str(data.get('ortho_age_limit_llm') or '').strip()
    ortho_age_text = ortho_age_raw.lower()
    preserve_sentinel = bool(data.pop('_preserve_ortho_age_sentinel', False))
    if ortho_age_text in ('-', '—', 'n/a', 'na', 'none'):
        data['ortho_age_limit_llm'] = ''
    elif not preserve_sentinel and ortho_age_text in ('99', '999'):
        data['ortho_age_limit_llm'] = ''

    data['appointment_date'] = datetime.now(timezone(timedelta(hours=5, minutes=30))).strftime('%m/%d/%Y %I:%M %p')
    pre_auth = str(data.get('pre_auth') or '').replace('$', '')
    data['pre_auth'] = pre_auth or '-'
    return data


def prepare_plan_data(portal_raw, denticon_raw, ins_override=None):
    """Route required Portal + Denticon data through the carrier integration."""
    if not isinstance(denticon_raw, dict) or not denticon_raw:
        raise ValueError('Denticon data is required for New Plan generation.')

    module = resolve_carrier(portal_raw or {})
    if module:
        data = module.extract(portal_raw or {}, denticon_raw)
    else:
        # Preserve the legacy generic normalized-portal behavior for unknown
        # carriers while still requiring the Denticon side of the New Plan input.
        data = _extract_common(portal_raw or {}, denticon_raw)

    _apply_overrides(data, ins_override, module)
    data = _finalize_shared_output(data)
    if module and hasattr(module, 'finalize'):
        data = module.finalize(data)

    if not isinstance(data.get('procs'), dict):
        data['procs'] = {}
    return data



def get_editable_fields(portal_raw=None, data=None):
    """Return form-field metadata for common and carrier-specific overrides.

    ``data`` may be the result of :func:`prepare_plan_data`; when supplied, each
    editable field also includes its current detected value. Denticon-owned
    office/provider values are deliberately excluded because Denticon is required
    and authoritative for those fields.
    """
    portal_raw = portal_raw or {}
    module = resolve_carrier(portal_raw)

    common = [dict(item) for item in COMMON_EDITABLE_FIELDS]
    carrier_specific = []
    if module and hasattr(module, 'editable_fields'):
        carrier_specific = [dict(item) for item in (module.editable_fields() or [])]

    if isinstance(data, dict):
        for item in common + carrier_specific:
            item['value'] = data.get(item.get('data_key', ''), '')

    return {
        'carrier': getattr(module, 'CARRIER_KEY', '') if module else '',
        'common': common,
        'carrier_specific': carrier_specific,
    }


def prepare_plan_form(portal_raw, denticon_raw, ins_override=None):
    """Convenience payload for a New Plan override form.

    Denticon is mandatory and remains authoritative for office/provider fields.
    The returned editable metadata contains only plan/operator overrides;
    Denticon-owned values are excluded.
    """
    if not isinstance(denticon_raw, dict) or not denticon_raw:
        raise ValueError('Denticon data is required for New Plan generation.')
    data = prepare_plan_data(portal_raw or {}, denticon_raw, ins_override)
    return {
        'data': data,
        'editable_fields': get_editable_fields(portal_raw or {}, data),
    }

def filename_patient_name(portal_raw):
    """Find the patient name across raw known/future carrier payloads."""
    raw = portal_raw if isinstance(portal_raw, dict) else {}
    module = resolve_carrier(raw)
    if module and hasattr(module, 'filename_patient_name'):
        value = module.filename_patient_name(raw)
        if value:
            return value

    candidates = []

    def add(container, *keys):
        cur = container
        for key in keys:
            if not isinstance(cur, dict):
                return
            cur = cur.get(key)
        if cur not in (None, '', [], {}):
            candidates.append(str(cur).strip())

    add(raw, 'selected_member', 'name')
    add(raw, 'patient_information', 'name')
    add(raw, 'patient', 'name')
    add(raw, 'metlife_data', 'patient', 'name')
    add(raw, 'cigna_data', 'patient', 'name')
    add(raw, 'cigna_data', 'patient_info', 'name')
    add(raw, 'dentaquest_data', 'patient', 'name')
    add(raw, 'delta_data', 'patient', 'name')
    add(raw, 'subscriber_info', 'name')

    for value in candidates:
        if value and value not in ('-', '—', 'N/A', 'NA'):
            return value
    return 'Patient'


def filename_carrier_name(portal_raw):
    """Resolve the concise legacy carrier label used in download filenames."""
    raw = portal_raw if isinstance(portal_raw, dict) else {}
    module = resolve_carrier(raw)
    if module:
        key = getattr(module, 'CARRIER_KEY', '')
        legacy_labels = {'aetna': 'Aetna', 'cigna': 'Cigna', 'metlife': 'MetLife'}
        if key in legacy_labels:
            return legacy_labels[key]
        if hasattr(module, 'display_name'):
            value = module.display_name(raw)
            if value:
                return value

    source = str(raw.get('source') or '').lower()
    payer = raw.get('payer') if isinstance(raw.get('payer'), dict) else {}
    carrier = raw.get('carrier_information') if isinstance(raw.get('carrier_information'), dict) else {}
    coverage = raw.get('coverage_details') if isinstance(raw.get('coverage_details'), dict) else {}
    names = ' '.join(str(v or '') for v in (
        source, payer.get('name'), carrier.get('name'), coverage.get('payer')
    )).lower()

    if 'aetna' in names:
        return 'Aetna'
    if 'cigna' in names or isinstance(raw.get('cigna_data'), dict):
        return 'Cigna'
    if 'metlife' in names or isinstance(raw.get('metlife_data'), dict):
        return 'MetLife'
    if 'dentaquest' in names or isinstance(raw.get('dentaquest_data'), dict):
        return 'DentaQuest'
    if 'delta' in names or isinstance(raw.get('delta_data'), dict):
        return 'Delta_Dental'
    if 'guardian' in names:
        return 'Guardian'

    explicit = payer.get('name') or carrier.get('name') or 'Insurance'
    return re.sub(r'\b(?:dental\s+plans?|insurance)\b', '', str(explicit), flags=re.I).strip() or 'Insurance'

def frequency_is_unavailable(data, value):
    module = resolve_carrier_by_key(str((data or {}).get('source_insurer') or ''))
    checker = getattr(module, 'frequency_is_unavailable', None) if module else None
    return bool(checker(value)) if checker else False


def resolve_carrier_by_key(key):
    key = str(key or '').lower().strip()
    for module in _carrier_modules():
        if getattr(module, 'CARRIER_KEY', '') == key:
            return module
    return None
