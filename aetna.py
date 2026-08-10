"""
new_plan.py
-----------
Generates an "Insurance Plan Breakdown – (New Plan)" PDF from the
MetLife, Cigna, or Aetna Portal JSON and the Denticon JSON.

Includes:
  - LLM-based provision interpretation (Ollama, Claude fallback)
  - Bug fixes: waiting period, applies_to, pre_auth

Usage:
    from new_plan import generate_new_plan_pdf
    pdf_bytes = generate_new_plan_pdf(portal_raw: dict, denticon_raw: dict)
"""

import io
import re
import json
import requests
from xml.sax.saxutils import escape
from datetime import datetime, timedelta, timezone

from reportlab.pdfgen import canvas
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.lib.pagesizes import letter
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.utils import simpleSplit
from reportlab.platypus import Paragraph, Table, TableStyle

# ─── Page geometry ─────────────────────────────────────────────────────────────
W, H     = letter          # 612 × 792 pt
MARGIN   = 36
CW       = W - 2 * MARGIN  # 540 pt content width
FOOTER_Y = 22

# ─── Colour palette ────────────────────────────────────────────────────────────
TEAL        = colors.HexColor('#0d6e8a')
TEAL_DARK   = colors.HexColor('#094e65')
TEAL_LIGHT  = colors.HexColor('#e6f4f9')
GOLD        = colors.HexColor('#c8a800')
GOLD_BG     = colors.HexColor('#fffce6')
GOLD_TXT    = colors.HexColor('#7a6000')
WHITE       = colors.white
GREY        = colors.HexColor('#6b7280')
GREY_LIGHT  = colors.HexColor('#f4f9fb')
DARK        = colors.HexColor('#1a2030')
BORDER      = colors.HexColor('#9ab8c8')
AMBER       = colors.HexColor('#92400e')


# ═══════════════════════════════════════════════════════════════════════════════
#  LLM PROVISION INTERPRETER  (formerly interpret_provisions.py)
# ═══════════════════════════════════════════════════════════════════════════════

OLLAMA_URL          = "http://localhost:11434/api/generate"
OLLAMA_MODEL        = "llama3.2"
OLLAMA_TIMEOUT      = 60
USE_CLAUDE_FALLBACK = False
CLAUDE_MODEL        = "claude-sonnet-4-20250514"

_LLM_DEFAULT_ANSWERS = {
    "molars_only_sealants":          "—",
    "posterior_composite_downgrade": "—",
    "porcelain_posterior_downgrade": "—",
    "d2950_same_day_crown":          "—",
    "ortho_payment_frequency":       "—",
    "ortho_age_limit":               "—",
}

_LLM_QUESTIONS_PROMPT = """
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


# ═══════════════════════════════════════════════════════════════════════════════
#  RULE-BASED DETERMINISTIC INTERPRETER
# ═══════════════════════════════════════════════════════════════════════════════

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


# ═══════════════════════════════════════════════════════════════════════════════
#  FIX #2 — Molars-only sealants: purely frequency-string based
# ═══════════════════════════════════════════════════════════════════════════════

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


# ═══════════════════════════════════════════════════════════════════════════════
#  FIX #3 — D2950 same day as crown: check D2740 coverage
# ═══════════════════════════════════════════════════════════════════════════════

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


# ═══════════════════════════════════════════════════════════════════════════════
#  FIX #4 — Alternate-benefit downgrade rules: parse provision sentences
# ═══════════════════════════════════════════════════════════════════════════════

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


# ═══════════════════════════════════════════════════════════════════════════════
#  BUG-FIXED HELPERS  (waiting period, applies_to, pre_auth)
# ═══════════════════════════════════════════════════════════════════════════════

_CARRIER_PRE_AUTH = {
    'metlife': 'Recommended-300',
    'cigna':   'Recommended-300',
    'delta':   'Recommended-300',
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


# ═══════════════════════════════════════════════════════════════════════════════
#  UTILITIES
# ═══════════════════════════════════════════════════════════════════════════════

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


def _extract_metlife_ortho_age_limit(provisions):
    """Return only the numeric MetLife child/student orthodontic age limit."""
    candidates = []
    for p in provisions or []:
        rule = str(p.get('rule', '')).lower()
        if 'orthodont' not in rule or 'age' not in rule:
            continue
        value = str(p.get('value', ''))
        # Prefer Child/Student values and ignore employee/spouse no-age-limit text.
        for m in re.finditer(r'(?:child|student)\s*:?\s*(\d+)', value, re.IGNORECASE):
            candidates.append(int(m.group(1)))
        if not candidates:
            candidates.extend(int(x) for x in re.findall(r'\b(\d{1,3})\b', value))
    if not candidates:
        return ''
    # Child/student provisions can expose two limits; business rule keeps the greater one.
    return str(max(candidates))


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


def _cigna_molars_only_sealants(procs):
    """Resolve D1351 only when Cigna explicitly proves a tooth restriction.

    A patient-age exclusion or an overall not-covered response does not answer
    whether the plan is limited to permanent molars. When the website does not
    prove either direction, the PDF question is intentionally left blank.
    """
    p = (procs or {}).get('D1351') or {}
    groups = (
        p.get('_cigna_context_groups')
        or ((p.get('api_details') or {}).get('context_groups') or [])
    )

    molars = {'1', '2', '3', '14', '15', '16', '17', '18', '19', '30', '31', '32'}
    covered_molar = False
    covered_non_molar = False
    tested_non_molar = False

    for group in groups:
        outcome = group.get('outcome') or {}
        group_covered = outcome.get('covered') is True
        for context in group.get('contexts') or []:
            tooth = str(context.get('tooth') or '').upper().strip()
            if not tooth or tooth == 'N/A':
                continue
            if tooth in molars:
                if group_covered:
                    covered_molar = True
            else:
                tested_non_molar = True
                if group_covered:
                    covered_non_molar = True

    if covered_non_molar:
        return 'No'
    if covered_molar and tested_non_molar:
        return 'Yes'
    return ''


def _cigna_same_frequency(procs, *codes):
    """Return Yes only when every requested Cigna procedure has the same real limit."""
    values = []
    for code in codes:
        value = str((procs.get(code) or {}).get('frequency_limit') or '').strip()
        if not value or value.upper() in (
            'N/A', 'NA', 'NOT APPLICABLE', 'NO FREQUENCY',
            'NOT COVERED', 'NC', '-', '—',
        ):
            return '-'
        values.append(re.sub(r'\s+', ' ', value).upper())
    return 'Yes' if len(set(values)) == 1 else 'No'


def _cigna_frequency_is_unavailable(value):
    """True when a covered Cigna code has no usable frequency limit."""
    normalized = re.sub(r'\s+', ' ', str(value or '')).strip().upper()
    return normalized in (
        '', '-', '—', 'N/A', 'NA', 'NONE',
        'NOT APPLICABLE', 'NOT AVAILABLE',
    )


def _cigna_sync_bidirectional_pair(procs, code_a, code_b):
    """Make paired Cigna codes share the best resolved covered benefit.

    Cigna can return one age-specific prophylaxis code as covered and the other
    as not covered for the current patient. The business PDF treats D1110 and
    D1120 as a bidirectional pair, so whichever code has the resolved covered
    plan benefit becomes the display source for both rows.
    """
    candidates = []
    for code in (code_a, code_b):
        proc = (procs or {}).get(code) or {}
        if proc.get('_cigna_covered') is True:
            candidates.append((code, proc))

    if not candidates:
        return

    def score(item):
        _, proc = item
        return (
            1 if not _cigna_frequency_is_unavailable(proc.get('frequency_limit')) else 0,
            1 if str(proc.get('benefit_level') or '').strip() else 0,
            1 if str(proc.get('deductible') or '').strip() else 0,
            1 if str(proc.get('late_date_of_service') or '').strip() else 0,
        )

    source_code, source = max(candidates, key=score)
    copied_fields = (
        'frequency_limit', 'benefit_level', 'deductible', 'age_limit',
        'late_date_of_service', 'number_of_quads', '_cigna_covered',
        '_cigna_lookup_resolved', '_cigna_class_code',
    )

    for code in (code_a, code_b):
        target = (procs or {}).setdefault(code, {'procedure_code': code})
        target_description = target.get('description')
        for field in copied_fields:
            target[field] = source.get(field, '')
        target['_cigna_bidirectional_source'] = source_code
        if target_description:
            target['description'] = target_description


def _cigna_resolve_ortho_age(procs, portal_ortho_age=''):
    """Return blank for uncovered ortho; otherwise explicit age or 99."""
    ortho_codes = ('D8010', 'D8080', 'D8090')
    covered = [
        (procs or {}).get(code) or {}
        for code in ortho_codes
        if ((procs or {}).get(code) or {}).get('_cigna_covered') is True
    ]
    if not covered:
        return ''

    for proc in covered:
        raw_age = str(proc.get('age_limit') or '').strip()
        if raw_age.lower() in ('', '-', '—', 'n/a', 'na', 'none'):
            continue
        match = re.search(
            r'(?:exclude|excluded)\s+after\s+age\s*(\d+)|'
            r'under\s*(\d+)|'
            r'(\d+)\s*[-–]\s*(\d+)|'
            r'\b(\d+)\b',
            raw_age,
            re.IGNORECASE,
        )
        if match:
            values = [group for group in match.groups() if group]
            if values:
                return values[-1]

    portal_age = str(portal_ortho_age or '').strip()
    if portal_age.lower() not in ('', '-', '—', 'n/a', 'na', 'none', '0'):
        return portal_age

    # Business fallback: a covered orthodontic benefit with no age limit means 99.
    return '99'


def _cigna_has_alternate_benefit_phrase(proc):
    """True when Cigna explicitly says an alternate benefit may apply."""
    if not proc:
        return False
    if proc.get('_cigna_alternate_benefit') is True:
        return True
    api_details = proc.get('api_details') or {}
    text = ' '.join(
        str(value or '')
        for value in (
            proc.get('benefit_status'),
            proc.get('frequency_limit'),
            proc.get('description'),
            proc.get('notes'),
            api_details.get('validation_message'),
            api_details.get('notes'),
        )
    )
    return bool(re.search(r'alternate\s+benefits?\s+may\s+apply', text, re.IGNORECASE))


def _format_history_dates(value):
    """Return all history dates as wrapped PDF text instead of only latest."""
    values = []
    if isinstance(value, list):
        candidates = value
    elif value in (None, ''):
        candidates = []
    else:
        candidates = [value]

    for item in candidates:
        if isinstance(item, dict):
            raw = item.get('date') or item.get('serviceDate') or item.get('service_date') or ''
        else:
            raw = str(item or '')
        raw = raw.strip()
        if not raw:
            continue
        if 'no history' in raw.lower():
            return 'NH'
        m1 = re.search(r'(\d{4})-(\d{2})-(\d{2})', raw)
        m2 = re.search(r'(\d{2})/(\d{2})/(\d{2})$', raw)
        m3 = re.search(r'(\d{2})/(\d{2})/(\d{4})$', raw)
        if m1:
            normalized = f"{m1.group(2)}/{m1.group(3)}/{m1.group(1)}"
        elif m2:
            normalized = f"{m2.group(1)}/{m2.group(2)}/20{m2.group(3)}"
        elif m3:
            normalized = raw
        else:
            normalized = raw
        if normalized not in values:
            values.append(normalized)
    return '\n'.join(values)


# ═══════════════════════════════════════════════════════════════════════════════
#  FIX #1 — Family Deductible logic
# ═══════════════════════════════════════════════════════════════════════════════

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


def _aetna_network_label(value):
    """Return a readable ClaimConnect network/fee-schedule label."""
    raw = clean(value)
    if not raw or raw.upper() in ('N/A', 'NA', 'NONE'):
        return ''
    return re.sub(r'\s*,\s*', ', ', raw)


# ═══════════════════════════════════════════════════════════════════════════════
#  DATA EXTRACTION
# ═══════════════════════════════════════════════════════════════════════════════

RELATION_MAP = {
    'child':      'Dependent',
    'dependent':  'Dependent',
    'self':       'Self',
    'subscriber': 'Self',
    'spouse':     'Spouse',
    'employee':   'Self',
    'other':      'Other',
}


def _is_aetna_portal(raw):
    """Recognize the ClaimConnect/Aetna payload without affecting other carriers."""
    if not isinstance(raw, dict):
        return False

    source = str(raw.get('source') or '').lower()
    payer = raw.get('payer') if isinstance(raw.get('payer'), dict) else {}
    coverage = (
        raw.get('coverage_details')
        if isinstance(raw.get('coverage_details'), dict)
        else {}
    )
    payer_name = ' '.join(
        str(value or '')
        for value in (
            payer.get('name'),
            coverage.get('payer'),
        )
    ).lower()

    return (
        'aetna' in payer_name
        or (
            'claimconnect' in source
            and isinstance(raw.get('service_level_benefits'), list)
            and isinstance(raw.get('co_insurance'), list)
            and isinstance(raw.get('maximums'), list)
        )
    )


def _aetna_plan_pct(value):
    """Convert ClaimConnect's patient/plan split into the plan-paid percentage."""
    values = re.findall(r'(\d+(?:\.\d+)?)\s*%', str(value or ''))
    if not values:
        return ''
    paid = values[1] if len(values) > 1 else values[0]
    try:
        return f'{float(paid):g}%'
    except ValueError:
        return f'{paid}%'


def _aetna_money_value(value):
    match = re.search(r'([\d,]+(?:\.\d+)?)', str(value or ''))
    if not match:
        return None
    try:
        return float(match.group(1).replace(',', ''))
    except ValueError:
        return None


def _aetna_money_used(total, remaining):
    """Return total minus remaining, preserving unknown values as blank."""
    total_value = _aetna_money_value(total)
    remaining_value = _aetna_money_value(remaining)
    if total_value is None or remaining_value is None:
        return ''
    return f'{max(0.0, total_value - remaining_value):,.2f}'


def _aetna_financial_record(records, type_hint='', coverage=''):
    """Select an Aetna maximum/deductible row by type and coverage."""
    candidates = [item for item in (records or []) if isinstance(item, dict)]
    if type_hint:
        candidates = [
            item for item in candidates
            if type_hint.lower() in str(item.get('type') or '').lower()
        ]
    if coverage:
        candidates = [
            item for item in candidates
            if coverage.lower() in str(item.get('coverage') or '').lower()
        ]
    return candidates[0] if candidates else {}


def _aetna_procedure_covered(item):
    """Resolve Aetna coverage only from the explicit ClaimConnect row."""
    if not isinstance(item, dict):
        return None
    text = ' '.join(
        str(item.get(key) or '')
        for key in ('message', 'frequency', 'percentage_copay')
    )
    if re.search(r'\bnot\s+covered\b', text, re.IGNORECASE):
        return False
    if _aetna_plan_pct(item.get('percentage_copay')):
        return True
    return None


def _aetna_age_limit(value):
    raw = clean(value)
    if raw.upper() in ('', 'N/A', 'NA', 'NONE'):
        return ''
    match = re.search(r'(?:maximum\s+age|under)\s*:?\s*(\d+)', raw, re.IGNORECASE)
    return match.group(1) if match else raw


def _aetna_history(value, covered):
    """Extract paid service dates; a covered row without a paid date is NH."""
    if covered is not True:
        return ''
    raw = clean(value)
    dates = re.findall(
        r'(?:last\s+paid\s+date\s*:\s*)?(\d{2}/\d{2}/(?:\d{2}|\d{4}))',
        raw,
        re.IGNORECASE,
    )
    if dates:
        return '\n'.join(dict.fromkeys(dates))
    if raw.upper() in ('', 'N/A', 'NA', 'NONE') or 'remaining' in raw.lower():
        return 'NH'
    if 'no history' in raw.lower():
        return 'NH'
    return raw


def _aetna_dependent_age(remarks):
    """Return the greater child/student dependent-age limit from Aetna remarks.

    ClaimConnect may return two limits in one sentence, for example
    ``CHLD TO 19 OR 25 IF FT STUDENT``.  The business PDF keeps the greater
    supported age so the child/student continuation limit is not lost.
    """
    text = ' '.join(str(value or '') for value in (remarks or []))
    candidates = []

    # Read every age from clauses that explicitly discuss a child, dependent,
    # or student.  Restrict to one/two-digit values so plan years are ignored.
    for clause in re.split(r'[,;]', text):
        if not re.search(r'\b(?:CHLD|CHILD(?:REN)?|DEPENDENT|STUDENT)\b', clause, re.IGNORECASE):
            continue
        for value in re.findall(r'(?<!\d)(\d{1,2})(?!\d)', clause):
            age = int(value)
            if 0 < age < 99:
                candidates.append(age)

    # Fallback for uncommon formatting where the relevant text is not cleanly
    # comma/semicolon separated.
    if not candidates:
        for pattern in (
            r'\bCHLD\s+TO\s+(\d{1,2})',
            r'\bCHILD(?:REN)?\s+(?:TO|THROUGH|UNTIL)\s+(\d{1,2})',
            r'\bDEPENDENT\s+AGE\s+(?:LIMIT\s*)?:?\s*(\d{1,2})',
            r'\b(?:FT\s+)?STUDENT(?:\s+TO|\s+THROUGH|\s+UNTIL|\s+AGE)?\s*:?[ ]*(\d{1,2})',
            r'\b(\d{1,2})\s+IF\s+(?:FT|FULL[- ]?TIME)\s+STUDENT',
        ):
            candidates.extend(
                int(match)
                for match in re.findall(pattern, text, re.IGNORECASE)
                if 0 < int(match) < 99
            )

    return str(max(candidates)) if candidates else ''


def _aetna_missing_tooth(remarks):
    text = ' '.join(str(value or '') for value in (remarks or [])).lower()
    if 'missing tooth clause does not apply' in text:
        return 'No'
    if 'missing tooth clause applies' in text:
        return 'Yes'
    return '-'


def _aetna_waiting_period(remarks):
    text = ' '.join(str(value or '') for value in (remarks or []))
    lower = text.lower()
    if 'no waiting period' in lower:
        return 'No', '0', '-'
    months = re.findall(r'(\d+)\s*months?', lower)
    if not months or 'waiting' not in lower:
        return 'No', '0', ''
    categories = []
    for needle, label in (
        ('prevent', 'Preventive'),
        ('diagnostic', 'Diagnostic'),
        ('basic', 'Basic'),
        ('major', 'Major'),
        ('ortho', 'Orthodontic'),
    ):
        if needle in lower:
            categories.append(label)
    return 'Yes', months[-1], ' & '.join(categories) or '-'


def _aetna_shared_codes(proc):
    """Return only ADA codes explicitly listed in an Aetna share-frequency field."""
    return {
        token.upper()
        for token in re.findall(
            r'D\d{4}',
            str((proc or {}).get('_aetna_shares_frequency_with') or ''),
            re.IGNORECASE,
        )
    }


def _aetna_share_question(procs, source_codes, target_codes):
    """Answer an Aetna sharing question from ``shares_frequency_with`` only.

    The relationship is accepted in either direction because ClaimConnect may
    list the companion code on only one of the returned rows.  Equal frequency
    text by itself is intentionally not treated as proof of a shared counter.
    """
    sources = tuple(str(code).upper() for code in source_codes)
    targets = tuple(str(code).upper() for code in target_codes)

    source_rows = [((procs or {}).get(code) or {}) for code in sources]
    target_rows = [((procs or {}).get(code) or {}) for code in targets]

    # Preserve the prior unknown result when required rows are absent or not
    # covered; otherwise decide Yes/No exclusively from the explicit column.
    if not source_rows or not target_rows:
        return '-'
    if any(row.get('_aetna_covered') is not True for row in source_rows + target_rows):
        return '-'

    target_set = set(targets)
    source_set = set(sources)
    if any(_aetna_shared_codes(row) & target_set for row in source_rows):
        return 'Yes'
    if any(_aetna_shared_codes(row) & source_set for row in target_rows):
        return 'Yes'
    return 'No'


def _aetna_has_alternate_benefit(proc):
    text = ' '.join(
        str((proc or {}).get(key) or '')
        for key in (
            'frequency_limit', 'description', '_aetna_message',
            '_aetna_shares_frequency_with',
        )
    )
    return bool(re.search(r'alternate\s+benefits?\s+may\s+apply', text, re.IGNORECASE))


def _normalize_aetna_portal(raw):
    """Translate the ClaimConnect payload into the existing Portal contract."""
    patient = raw.get('patient') if isinstance(raw.get('patient'), dict) else {}
    selected = (
        raw.get('selected_member')
        if isinstance(raw.get('selected_member'), dict)
        else {}
    )
    patient_info = (
        raw.get('patient_information')
        if isinstance(raw.get('patient_information'), dict)
        else {}
    )
    subscriber = (
        raw.get('subscriber')
        if isinstance(raw.get('subscriber'), dict)
        else {}
    )
    payer = raw.get('payer') if isinstance(raw.get('payer'), dict) else {}
    coverage = (
        raw.get('coverage_details')
        if isinstance(raw.get('coverage_details'), dict)
        else {}
    )
    dates = raw.get('dates') if isinstance(raw.get('dates'), dict) else {}
    remarks = raw.get('plan_level_remarks') or []
    maximums = raw.get('maximums') or []
    deductibles = raw.get('deductibles') or []

    patient_name = (
        selected.get('name')
        or patient_info.get('name')
        or patient.get('name')
        or ''
    )
    patient_dob = (
        selected.get('date_of_birth')
        or patient_info.get('date_of_birth')
        or patient.get('date_of_birth')
        or ''
    )
    relationship = (
        selected.get('relationship')
        or patient_info.get('relationship')
        or patient.get('relationship')
        or ''
    )
    if not relationship:
        for member in raw.get('eligibility_members') or []:
            if not isinstance(member, dict):
                continue
            if clean(member.get('name')).lower() == clean(patient_name).lower():
                relationship = member.get('relationship') or ''
                break
    if not relationship and clean(patient_name).lower() == clean(subscriber.get('name')).lower():
        relationship = 'Self'

    member_id = (
        patient.get('member_id_or_ssn')
        or patient_info.get('member_id_or_ssn')
        or subscriber.get('member_id_or_ssn')
        or ''
    )

    subscriber_name = subscriber.get('name') or ''
    subscriber_dob = ''
    if subscriber_name and clean(subscriber_name).lower() == clean(patient_name).lower():
        subscriber_dob = patient_dob
    else:
        for member in raw.get('eligibility_members') or []:
            if not isinstance(member, dict):
                continue
            if (
                clean(member.get('name')).lower() == clean(subscriber_name).lower()
                or str(member.get('relationship') or '').lower() in ('self', 'subscriber')
            ):
                subscriber_dob = member.get('date_of_birth') or ''
                if subscriber_dob:
                    break

    annual = _aetna_financial_record(maximums, 'dental', 'individual')
    ortho_max = _aetna_financial_record(maximums, 'ortho', 'individual')
    individual_ded = _aetna_financial_record(deductibles, '', 'individual')
    family_ded = _aetna_financial_record(deductibles, '', 'family')
    ortho_ded = _aetna_financial_record(deductibles, 'ortho', 'individual')

    has_positive_deductible = any(
        (_aetna_money_value(item.get('amount')) or 0) > 0
        for item in deductibles
        if isinstance(item, dict)
    )

    normalized_procs = []
    for item in raw.get('service_level_benefits') or []:
        if not isinstance(item, dict):
            continue
        code = str(item.get('procedure_code') or '').upper().strip()
        if not code:
            continue
        covered = _aetna_procedure_covered(item)
        frequency = clean(item.get('frequency'))
        normalized_frequency = frequency.upper()
        if re.search(r'\b999\s+CALENDAR\s+YEARS?\b', frequency, re.IGNORECASE):
            frequency = 'NO FREQUENCY'
        elif covered is True and normalized_frequency in (
            '', '-', '—', 'N/A', 'NA', 'NONE',
            'NOT APPLICABLE', 'NOT AVAILABLE',
        ):
            # A covered Aetna service without an applicable portal limit is
            # still covered; the PDF should say "No Frequency", not N/A.
            frequency = 'NO FREQUENCY'
        if covered is False:
            frequency = 'NOT COVERED'
        normalized_procs.append({
            'procedure_code': code,
            'description': '',
            'frequency_limit': frequency,
            'benefit_level': (
                _aetna_plan_pct(item.get('percentage_copay'))
                if covered is True else
                'N/A' if covered is False else ''
            ),
            'deductible': 'NO' if not has_positive_deductible and covered is True else '',
            'age_limit': _aetna_age_limit(item.get('age_limit')),
            'late_date_of_service': _aetna_history(item.get('history'), covered),
            'number_of_quads': '',
            '_aetna_covered': covered,
            '_aetna_shares_frequency_with': item.get('shares_frequency_with') or '',
            '_aetna_message': item.get('message') or '',
        })

    category_map = {
        'preventative': 'PREVENTIVE',
        'preventive': 'PREVENTIVE',
        'basic': 'RESTORATIVE',
        'major': 'PROSTHODONTICS',
        'ortho': 'ORTHODONTICS',
    }
    covered_services = []
    for item in raw.get('co_insurance') or []:
        if not isinstance(item, dict):
            continue
        raw_type = clean(item.get('type')).lower()
        category = next(
            (mapped for hint, mapped in category_map.items() if hint in raw_type),
            clean(item.get('type')),
        )
        paid = _aetna_plan_pct(item.get('percentage'))
        if category and paid:
            covered_services.append({
                'category': category,
                'services': '',
                'in_network': paid,
                'out_of_network': '',
            })

    normalized = {
        '_skip_llm': True,
        '_source_insurer': 'aetna',
        'carrier_information': {'name': payer.get('name') or 'Aetna Dental Plans'},
        'subscriber_info': {
            'name': subscriber_name,
            # The shared extractor falls back to the patient's DOB when this
            # value is blank. For a dependent, preserve an unavailable
            # subscriber DOB explicitly instead of copying the child's DOB.
            'dob': subscriber_dob or ('-' if relationship.lower() not in ('self', 'subscriber') else patient_dob),
            'relation': relationship,
        },
        'metlife_data': {
            'patient': {
                'name': patient_name,
                'dob': patient_dob,
                'relationship': relationship,
            },
            'plan_details': {
                'start_date': dates.get('eligibility_begin') or '',
                'end_date': '',
                'subscriber_id': member_id,
                'employer_group': coverage.get('group_name') or payer.get('group_name') or '',
                'group_number': coverage.get('group_number') or payer.get('group#') or '',
                'network': payer.get('plan_type') or payer.get('description') or '',
                'plan_type': payer.get('plan_type') or '',
            },
            'financials': {
                'annual_max': {
                    'total': annual.get('amount') or '',
                    'used': _aetna_money_used(annual.get('amount'), annual.get('remaining')),
                    'remaining': annual.get('remaining') or '',
                },
                'deductible_ind': {
                    'total': individual_ded.get('amount') or '',
                    'used': _aetna_money_used(
                        individual_ded.get('amount'), individual_ded.get('remaining')
                    ),
                    'remaining': individual_ded.get('remaining') or '',
                },
                'deductible_fam': {
                    'total': family_ded.get('amount') or '',
                    'used': _aetna_money_used(
                        family_ded.get('amount'), family_ded.get('remaining')
                    ),
                    'remaining': family_ded.get('remaining') or '',
                },
                'ortho_lifetime': {
                    'total': ortho_max.get('amount') or '',
                    'used': _aetna_money_used(
                        ortho_max.get('amount'), ortho_max.get('remaining')
                    ),
                    'remaining': ortho_max.get('remaining') or '',
                },
            },
            'provider_info': {
                'provider_name': '',
                'provider_network_status': (
                    coverage.get('network_type') or payer.get('network_type') or ''
                ),
            },
            'covered_services': covered_services,
            'provisions': [],
        },
        'benefit_coverage': {'procedures': normalized_procs},
    }
    normalized['_aetna_meta'] = {
        'remarks': remarks,
        'plan_begin': dates.get('plan_begin') or '',
        'network_type': _aetna_network_label(
            coverage.get('network_type') or payer.get('network_type') or ''
        ),
        'annual_max_present': bool(annual),
        'individual_deductible_present': bool(individual_ded),
        'family_deductible_present': bool(family_ded),
        'has_positive_deductible': has_positive_deductible,
        'ortho_max_present': bool(ortho_max),
        'ortho_ded_total': ortho_ded.get('amount') or '',
        'ortho_ded_used': _aetna_money_used(
            ortho_ded.get('amount'), ortho_ded.get('remaining')
        ),
        'dependent_age': _aetna_dependent_age(remarks),
    }
    return normalized


def _apply_aetna_output_rules(data, normalized):
    """Apply only Aetna-specific meanings after the shared extraction path."""
    meta = normalized.get('_aetna_meta') or {}
    remarks = meta.get('remarks') or []
    waiting_value, waiting_months, waiting_applies = _aetna_waiting_period(remarks)

    has_any_deductible = bool(
        meta.get('individual_deductible_present')
        or meta.get('family_deductible_present')
        or meta.get('has_positive_deductible')
    )

    if has_any_deductible:
        individual_ded = data.get('indiv_ded') or '-'
        individual_paid = data.get('indiv_ded_paid') or '-'
        family_ded = (
            data.get('family_ded')
            if meta.get('family_deductible_present')
            else _triple_individual_deductible(individual_ded)
        )
        family_paid = (
            data.get('family_ded_paid')
            if meta.get('family_deductible_present') else '-'
        )
        ded_prev = ded_diag = '-'
    else:
        individual_ded = individual_paid = '0.00'
        family_ded = family_paid = '0.00'
        ded_prev = ded_diag = 'No'

    plan_begin_month = _effective_date_month(meta.get('plan_begin'))
    data.update({
        'source_insurer': 'aetna',
        # These are modal-editable defaults. They reflect the selected
        # in-network Aetna portal context until an operator overrides them.
        'ins_name': '(IN) Aetna',
        'ins_address': 'PO Box 14094, Lexington, KY 40512',
        'ins_phone': '8004517715',
        'payor_id': '60054',
        'fee_schedule': meta.get('network_type') or '-',
        'network_status': 'IN',
        'ssn': data.get('member_id') or '-',
        'elig_notes': 'ins: aetna, benefits verified online',
        'plan_type': _display_plan_type(data.get('plan_type')),
        'term_date': '-',
        'plan_year_start': plan_begin_month or _effective_date_month(data.get('eff_date')) or '-',
        'yearly_max': data.get('yearly_max') if meta.get('annual_max_present') else '0.00',
        'yearly_rem': data.get('yearly_rem') if meta.get('annual_max_present') else '0.00',
        'indiv_ded': individual_ded,
        'indiv_ded_paid': individual_paid,
        'family_ded': family_ded,
        'family_ded_paid': family_paid,
        'ded_prev': ded_prev,
        'ded_diag': ded_diag,
        'waiting_period': waiting_value,
        'waiting_period_mo': waiting_months,
        'applies_to': waiting_applies,
        'major_on_prep': 'No',
        'or_seat': 'Yes',
        'missing_tooth': _aetna_missing_tooth(remarks),
        'pre_auth': '350',
        'dep_age_limit': meta.get('dependent_age') or 'NAL',
        'ortho_ded': _dollar(meta.get('ortho_ded_total'), default='0.00'),
        'ortho_ded_paid': _dollar(meta.get('ortho_ded_used'), default='0.00'),
        'ortho_max': data.get('ortho_max') if meta.get('ortho_max_present') else '0.00',
        'ortho_max_paid': data.get('ortho_max_paid') if meta.get('ortho_max_present') else '0.00',
        'ortho_payment_frequency': '-',
        'd4341_number_of_quads': '-',
    })

    procs = data.get('procs') or {}
    data['d0120_d0150_share_d0140'] = _aetna_share_question(
        procs,
        source_codes=('D0120', 'D0150'),
        target_codes=('D0140',),
    )
    data['d4910_d1110_share_freq'] = _aetna_share_question(
        procs,
        source_codes=('D4910',),
        target_codes=('D1110',),
    )

    # Aetna business rule: keep the permanent-molars question blank.  Do not
    # infer it from tooth ranges, age limits, or frequency wording.
    data['molars_only_sealants'] = ''

    # Posterior composite/amalgam answer is Yes when either D2140 or D2331
    # explicitly carries the alternate-benefit phrase.
    d2140 = procs.get('D2140') or {}
    d2331 = procs.get('D2331') or {}
    if d2140 or d2331:
        data['posterior_composite_downgrade'] = (
            'Yes'
            if _aetna_has_alternate_benefit(d2140) or _aetna_has_alternate_benefit(d2331)
            else 'No'
        )
    else:
        data['posterior_composite_downgrade'] = '-'

    # Posterior crown answer is controlled only by D2740's explicit
    # alternate-benefit phrase.
    d2740 = procs.get('D2740') or {}
    data['porcelain_posterior_downgrade'] = (
        'Yes' if _aetna_has_alternate_benefit(d2740) else ('No' if d2740 else '-')
    )

    d2950 = procs.get('D2950') or {}
    d2740 = procs.get('D2740') or {}
    d2950_covered = d2950.get('_aetna_covered')
    d2740_covered = d2740.get('_aetna_covered')
    if d2950_covered is False:
        data['d2950_same_day_crown'] = 'No'
    elif d2950_covered is True and d2740_covered is True:
        data['d2950_same_day_crown'] = 'Yes'
    elif d2950_covered is True and d2740_covered is False:
        data['d2950_same_day_crown'] = 'No'
    else:
        data['d2950_same_day_crown'] = '-'

    # The template historically grouped D1206 and D1208 into one fluoride
    # row. Do not claim a result for an unqueried code. Select the available
    # Aetna row and let the table label name only the code(s) actually present.
    d1206 = procs.get('D1206') or {}
    d1208 = procs.get('D1208') or {}
    fluoride = None
    if d1206.get('_aetna_covered') is True:
        fluoride = d1206
    elif d1208.get('_aetna_covered') is True:
        fluoride = d1208
    elif d1206:
        fluoride = d1206
    elif d1208:
        fluoride = d1208
    if fluoride:
        procs['_AETNA_FLUORIDE_DISPLAY'] = fluoride

    ortho_age = ''
    for code in ('D8010', 'D8080', 'D8090'):
        proc = procs.get(code) or {}
        if proc.get('_aetna_covered') is not True:
            continue
        raw_age = str(proc.get('age_limit') or '').strip()
        if raw_age.lower() in ('', '-', '—', 'n/a', 'na', 'none', '99', '999'):
            proc['age_limit'] = ''
            continue
        ortho_age = raw_age
        break
    data['ortho_age_limit_llm'] = ortho_age

    if data.get('chair_provider') in ('', '—'):
        data['chair_provider'] = '-'
    return data


def _is_cigna_portal(raw):
    """Recognize the Cigna extension payload without affecting MetLife JSON."""
    if not isinstance(raw, dict):
        return False
    source = str(raw.get('source', '')).lower()
    return (
        'cigna' in source or
        (
            isinstance(raw.get('procedures'), dict) and
            isinstance(raw.get('procedures', {}).get('results'), list) and
            isinstance(raw.get('coinsurance'), list) and
            isinstance(raw.get('summary'), dict)
        )
    )


def _cigna_plan_pct(member_pct):
    """Convert Cigna member coinsurance into the plan-paid percentage."""
    m = re.search(r'(\d+(?:\.\d+)?)\s*%', str(member_pct or ''))
    if not m:
        return ''
    paid = max(0.0, min(100.0, 100.0 - float(m.group(1))))
    return f'{paid:g}%'


def _cigna_network_value(record, *keys):
    for key in keys:
        value = record.get(key) if isinstance(record, dict) else None
        if value not in (None, '', 'N/A', 'NA'):
            return str(value).strip()
    return ''


def _cigna_network_matches(record, selected_network):
    """Match a Cigna record to plan_details.network without using OONET."""
    if not isinstance(record, dict):
        return False
    selected_network = selected_network if isinstance(selected_network, dict) else {}
    selected_name = _cigna_network_value(selected_network, 'name', 'networkName')
    selected_id = _cigna_network_value(selected_network, 'id', 'networkId')
    record_name = _cigna_network_value(record, 'networkName', 'network')
    record_id = _cigna_network_value(record, 'networkId', 'network_id')

    if selected_id:
        return record_id.lower() == selected_id.lower()
    if selected_name:
        return record_name.lower() == selected_name.lower()
    return False


def _cigna_matching_records(records, selected_network):
    """Return only records belonging to the portal-selected Cigna network."""
    valid = [record for record in (records or []) if isinstance(record, dict)]
    selected_network = selected_network if isinstance(selected_network, dict) else {}
    if _cigna_network_value(selected_network, 'name', 'networkName', 'id', 'networkId'):
        direct = [
            record for record in valid
            if _cigna_network_matches(record, selected_network)
        ]
        if direct:
            return direct
        # Some Cigna responses omit network fields on the financial records
        # after the portal has already scoped the page to the selected network.
        # Use these generic records only as a fallback, never over an exact
        # network match.
        generic = [
            record for record in valid
            if not _cigna_network_value(
                record, 'networkName', 'network', 'networkId', 'network_id'
            )
        ]
        if generic:
            return generic
        return []
    return valid


def _cigna_primary_record(records, desc_hint='', covers='', selected_network=None):
    """Choose a financial record from the portal-selected Cigna network."""
    candidates = []
    for record in _cigna_matching_records(records, selected_network):
        if desc_hint and not _cigna_financial_desc_matches(record, desc_hint):
            continue
        if covers and covers.upper() != str(record.get('covers', '')).upper():
            continue
        candidates.append(record)
    if not candidates:
        return {}
    def tier_rank(record):
        raw = record.get('tierIndex') or record.get('networkTier') or record.get('tier')
        try:
            return int(raw)
        except (TypeError, ValueError):
            return 999
    return sorted(candidates, key=tier_rank)[0]


def _cigna_class_codes(record):
    return {
        value.strip()
        for value in str(record.get('classCode') or '').split(',')
        if value.strip()
    }


def _cigna_financial_desc_matches(record, desc_hint):
    """Cigna may label plan-year accumulators as Calendar Year or Policy Year."""
    desc = str(record.get('desc') or record.get('description') or '').lower()
    hint = str(desc_hint or '').lower()
    if not hint:
        return True
    if hint in desc:
        return True
    normalized_hint = hint.replace('calendar year', '').replace('policy year', '')
    return all(
        part in desc
        for part in normalized_hint.split()
        if part not in {'individual', 'family'}
    ) and any(
        word in desc
        for word in ('calendar year', 'policy year')
    )


def _cigna_general_annual_record(records, selected_network):
    """Select the core dental maximum, excluding ortho/implant-only maxima."""
    candidates = [
        record for record in _cigna_matching_records(records, selected_network)
        if 'maximum' in str(record.get('desc', '')).lower()
        and 'lifetime' not in str(record.get('desc', '')).lower()
        and str(record.get('covers', '')).upper() == 'IND'
        and 'ortho' not in str(record.get('classDesc', '')).lower()
        and 'implant' not in str(record.get('classDesc', '')).lower()
    ]
    if not candidates:
        return {}
    dollar_candidates = [
        record for record in candidates
        if '$' in str(record.get('amount') or '')
    ]
    if dollar_candidates:
        dental_care = next(
            (
                record for record in dollar_candidates
                if 'dental care' in str(record.get('classDesc', '')).lower()
            ),
            None,
        )
        if dental_care:
            return dental_care
        candidates = dollar_candidates
    return next(
        (
            record for record in candidates
            if {'1', '2', '3'}.issubset(_cigna_class_codes(record))
        ),
        max(candidates, key=lambda record: len(_cigna_class_codes(record))),
    )


def _cigna_ortho_max_record(records, selected_network):
    return next(
        (
            record for record in _cigna_matching_records(records, selected_network)
            if 'ortho' in str(record.get('classDesc', '')).lower()
            or 'ortho' in str(record.get('desc', '')).lower()
        ),
        {},
    )


def _cigna_ortho_deductible_record(records, selected_network):
    return next(
        (
            record for record in _cigna_matching_records(records, selected_network)
            if 'ortho' in str(record.get('classDesc', '')).lower()
            or 'ortho' in str(record.get('desc', '')).lower()
        ),
        {},
    )


def _cigna_deductible_applicability(raw, selected_network):
    """
    Derive deductible service classes from selected-network records.
    content_cigna.js attaches the parent classCode/classDesc to accumulations.
    """
    supplied = (raw.get('financials') or {}).get('deductible_applicability')
    if isinstance(supplied, dict):
        return supplied

    records = _cigna_matching_records(
        (raw.get('financials') or {}).get('deductible_records'),
        selected_network,
    )
    codes = set()
    descriptions = []
    for record in records:
        codes.update(_cigna_class_codes(record))
        descriptions.append(str(record.get('classDesc') or '').lower())
    desc = ','.join(descriptions)
    return {
        'has_selected_network_deductible': bool(records),
        'class_codes': sorted(codes),
        'class_descriptions': [
            value.strip()
            for value in ','.join(
                str(record.get('classDesc') or '') for record in records
            ).split(',')
            if value.strip()
        ],
        'diagnostic': '1' in codes or 'diagnostic' in desc,
        'preventive': '1' in codes or 'preventive' in desc,
        'basic': '2' in codes or 'basic restorative' in desc,
        'major': '3' in codes or 'major restorative' in desc,
        'orthodontic': '4' in codes or 'orthodont' in desc,
        'periodontal': '6' in codes or 'periodontal' in desc,
        'implants': '9' in codes or 'implant' in desc,
    }


def _cigna_procedure_deductible(class_code, applicability):
    codes = {
        value.strip()
        for value in str(class_code or '').split(',')
        if value.strip() and value.strip().upper() not in ('N/A', 'NA')
    }
    if not codes:
        return ''
    deductible_codes = {
        str(value).strip() for value in applicability.get('class_codes', [])
    }
    if applicability.get('has_selected_network_deductible'):
        return 'YES' if bool(codes & deductible_codes) else 'NO'
    return 'NO'


def _cigna_covered_quadrant_count(api_details):
    """Count resolved covered quadrant contexts; unresolved data stays blank."""
    if str(api_details.get('coverage_scope') or '').lower() not in ('all', 'partial'):
        return ''
    quadrants = set()
    for group in api_details.get('context_groups') or []:
        if (group.get('outcome') or {}).get('covered') is not True:
            continue
        for context in group.get('contexts') or []:
            value = str(context.get('quadrant') or '').upper().strip()
            if value not in ('', 'N/A', 'NA'):
                quadrants.add(value)
    return str(len(quadrants)) if quadrants else ''


def _cigna_waiting_period_values(raw_waiting):
    if not raw_waiting:
        return 'No', '0', ''
    values = raw_waiting if isinstance(raw_waiting, list) else [raw_waiting]
    texts = []
    for value in values:
        if isinstance(value, dict):
            texts.extend(
                str(value.get(key) or '')
                for key in (
                    'summary', 'description', 'desc', 'value',
                    'waitingPeriod', 'waiting_period', 'notes',
                )
            )
        else:
            texts.append(str(value))
    text = clean(' '.join(part for part in texts if part))
    if not text:
        return 'No', '0', ''
    if re.search(r'\bno\s+waiting\b|does\s+not\s+apply|not\s+applicable', text, re.IGNORECASE):
        return 'No', '0', ''
    months = re.findall(r'(\d+)\s*month', text, re.IGNORECASE)
    categories = []
    for needle, label in (
        ('diagnostic', 'Diagnostic'),
        ('preventive', 'Preventive'),
        ('basic', 'Basic'),
        ('major', 'Major'),
        ('orthodont', 'Orthodontic'),
    ):
        if needle in text.lower():
            categories.append(label)
    return 'Yes', (months[-1] if months else ''), ' & '.join(categories)


def _normalize_cigna_portal(raw):
    """
    Translate Cigna's extension payload into the established Portal contract.
    No Denticon insurance/benefit values are introduced here.
    """
    summary = raw.get('summary') or {}
    patient = raw.get('patient') or {}
    plan = raw.get('plan_details') or {}
    network = plan.get('network') or {}
    financials = raw.get('financials') or {}
    notes = raw.get('notes') or {}
    results = (raw.get('procedures') or {}).get('results') or []
    frequency_by_code = {
        str(item.get('procedure_code', '')).upper().strip(): item
        for item in (raw.get('frequencies') or [])
        if item.get('procedure_code')
    }

    maximums = financials.get('maximum_records') or []
    deductibles = financials.get('deductible_records') or []
    annual = _cigna_general_annual_record(maximums, network)
    family_max = _cigna_primary_record(
        maximums, 'Family Calendar Year Maximum', 'FAM', network
    )
    individual_ded = _cigna_primary_record(
        deductibles, 'Individual Calendar Year Deductible', 'IND', network
    )
    family_ded = _cigna_primary_record(
        deductibles, 'Family Calendar Year Deductible', 'FAM', network
    )
    ortho_max = _cigna_ortho_max_record(maximums, network)
    ortho_ded = _cigna_ortho_deductible_record(deductibles, network)
    deductible_applicability = _cigna_deductible_applicability(raw, network)

    normalized_procs = []
    unresolved_codes = []
    for proc in results:
        code = str(proc.get('procedure_code', '')).upper().strip()
        if not code:
            continue
        api_details = proc.get('api_details') or {}
        validation = str(api_details.get('validation_message') or '')
        coverage_scope = str(api_details.get('coverage_scope') or '').lower()
        lookup_failed = (
            bool(api_details.get('lookup_error'))
            or 'lookup failed' in str(proc.get('benefit_status') or '').lower()
        )
        unresolved_context = (
            lookup_failed
            or
            coverage_scope == 'unresolved'
            or (
                bool(api_details.get('context_required'))
                and bool(re.search(r'invalid|missing|required', validation, re.IGNORECASE))
            )
        )
        if unresolved_context and code != 'D5860':
            unresolved_codes.append(code)
        matched_limitations = _cigna_matching_records(
            api_details.get('limitation_records'), network
        )
        matched_coinsurance = _cigna_matching_records(
            api_details.get('coinsurance_records'), network
        )
        matched_limitation = matched_limitations[0] if matched_limitations else {}
        matched_coin = matched_coinsurance[0] if matched_coinsurance else {}
        covered = proc.get('covered')
        freq = str(
            matched_limitation.get('summary')
            or proc.get('frequency_limit')
            or ''
        )
        if unresolved_context:
            # The response is not a valid coverage decision. A tooth/arch/
            # quadrant-specific request or successful API response is required
            # before showing NC.
            covered = None
            freq = ''
        elif covered is False:
            freq = 'NOT COVERED'

        limitation = matched_limitation or api_details.get('limitation') or {}
        age = (
            limitation.get('age_summary')
            or proc.get('age_limitation')
            or ''
        )
        if str(age).upper() in ('N/A', 'NA', 'NONE'):
            age = ''
        if not age:
            age = (frequency_by_code.get(code) or {}).get('age_limitation') or ''
        if str(age).upper() in ('N/A', 'NA', 'NONE'):
            age = ''
        if not age:
            max_age = str(
                limitation.get('maxAge')
                or limitation.get('maximum_age')
                or ''
            ).strip()
            if max_age not in ('', '0', '999'):
                age = f'Under {max_age}'

        history = (
            _format_history_dates((api_details.get('history_dates') or []))
            or _format_history_dates((api_details.get('service_history') or []))
            or proc.get('history_date')
            or ''
        )
        if unresolved_context:
            history = ''
        elif 'no history' in str(history).lower():
            history = 'NH'

        # Do not infer a D4341 quadrant count from Cigna context probing.
        # Cigna PDF answer is intentionally blank; MetLife is handled later.
        quadrant = '' if code == 'D4341' else _cigna_covered_quadrant_count(api_details)
        if not quadrant:
            quadrant = proc.get('quadrant') if code != 'D4341' else ''
        if str(quadrant).upper() in ('N/A', 'NA', 'NONE', ''):
            quadrant = ''
        class_code = api_details.get('class_code') or proc.get('class_code') or ''
        plan_frequency = frequency_by_code.get(code) or {}
        plan_frequency_records = _cigna_matching_records(
            plan_frequency.get('limitation_records'), network
        )
        plan_frequency_selected = (
            plan_frequency_records[0] if plan_frequency_records else {}
        )

        normalized_procs.append({
            'procedure_code': code,
            'description': proc.get('description') or '',
            'frequency_limit': freq,
            'benefit_level': (
                _cigna_plan_pct(
                    matched_coin.get('amount')
                    or proc.get('coinsurance_member_pct')
                )
                if covered is True else
                'N/A' if covered is False else ''
            ),
            'deductible': _cigna_procedure_deductible(
                class_code, deductible_applicability
            ),
            'age_limit': age,
            'late_date_of_service': history,
            'number_of_quads': quadrant,
            '_cigna_covered': covered,
            '_cigna_coverage_scope': coverage_scope,
            '_cigna_alternate_benefit': proc.get('alternate_benefit'),
            '_cigna_context_groups': api_details.get('context_groups') or [],
            '_cigna_lookup_resolved': not unresolved_context,
            '_cigna_class_code': class_code,
            '_cigna_plan_procedure': plan_frequency.get('procedure') or '',
            '_cigna_plan_frequency': (
                plan_frequency_selected.get('summary')
                or plan_frequency.get('limit')
                or ''
            ),
            '_cigna_plan_age_limit': (
                plan_frequency_selected.get('ageSummary')
                or plan_frequency.get('age_limitation')
                or ''
            ),
            '_cigna_plan_covered': plan_frequency_selected.get('covered'),
        })

    # Some Cigna high-level frequency records (for example D8080) may not be
    # repeated in procedure results. Retain them so the PDF can still show NC
    # or the available limitation without inventing a percentage.
    result_codes = {p['procedure_code'] for p in normalized_procs}
    for code, item in frequency_by_code.items():
        if code in result_codes:
            continue
        records = _cigna_matching_records(
            item.get('limitation_records'), network
        )
        selected = records[0] if records else {}
        covered = selected.get('covered')
        age = item.get('age_limitation') or ''
        if str(age).upper() in ('N/A', 'NA', 'NONE'):
            age = ''
        normalized_procs.append({
            'procedure_code': code,
            'description': item.get('procedure') or '',
            'frequency_limit': (
                'NOT COVERED' if covered is False else item.get('limit') or ''
            ),
            'benefit_level': 'N/A' if covered is False else '',
            'deductible': '',
            'age_limit': age,
            'late_date_of_service': 'NH',
            'number_of_quads': '',
            '_cigna_covered': covered,
            '_cigna_plan_procedure': item.get('procedure') or '',
            '_cigna_plan_frequency': (
                selected.get('summary') or item.get('limit') or ''
            ),
            '_cigna_plan_age_limit': (
                selected.get('ageSummary') or item.get('age_limitation') or ''
            ),
            '_cigna_plan_covered': covered,
        })

    covered_services = []
    seen_categories = set()
    cigna_category_map = {
        'diagnostic and preventive': 'PREVENTIVE',
        'basic restorative': 'RESTORATIVE',
        'major restorative': 'PROSTHODONTICS',
    }
    for item in raw.get('coinsurance') or []:
        if not _cigna_network_matches(item, network):
            continue
        raw_category = str(item.get('category', '')).strip()
        category = next(
            (
                mapped for hint, mapped in cigna_category_map.items()
                if hint in raw_category.lower()
            ),
            raw_category,
        )
        if not category or category.upper() in seen_categories:
            continue
        seen_categories.add(category.upper())
        plan_pct = _cigna_plan_pct(item.get('patient_pays'))
        category_upper = category.upper()
        canonical_category = (
            'PREVENTIVE'
            if 'DIAGNOSTIC' in category_upper or 'PREVENTIVE' in category_upper
            else 'RESTORATIVE'
            if 'BASIC' in category_upper
            else 'PROSTHODONTICS'
            if 'MAJOR' in category_upper
            else category
        )
        covered_services.append({
            'category': canonical_category,
            'services': '',
            'in_network': plan_pct,
            'out_of_network': '',
        })

    coverage = plan.get('current_coverage') or summary.get('coverage_dates') or {}
    normalized = {
        '_skip_llm': True,
        '_source_insurer': 'cigna',
        'carrier_information': {'name': 'Cigna'},
        'subscriber_info': {
            'name': plan.get('subscriber') or patient.get('name') or '',
            'dob': plan.get('subscriber_dob') or patient.get('dob') or '',
            'relation': patient.get('relationship') or '',
        },
        'metlife_data': {
            'patient': {
                'name': patient.get('name') or '',
                'dob': patient.get('dob') or '',
                'relationship': patient.get('relationship') or '',
            },
            'plan_details': {
                'start_date': coverage.get('from') or plan.get('initial_coverage_date') or '',
                # Cigna's "Present" is not an actual patient termination date.
                'end_date': _blank_present_end_date(coverage.get('to')),
                'subscriber_id': summary.get('patient_id') or '',
                'employer_group': summary.get('group_name') or plan.get('account_name') or '',
                'group_number': summary.get('group_number') or plan.get('account_number') or '',
                'network': plan.get('plan_type') or summary.get('plan_type') or '',
                'plan_type': plan.get('plan_type') or summary.get('plan_type') or '',
            },
            'financials': {
                'annual_max': {
                    'total': annual.get('amount') or '',
                    'used': annual.get('met') or '',
                    'remaining': annual.get('remaining') or '',
                },
                'deductible_ind': {
                    'total': individual_ded.get('amount') or '',
                    'used': individual_ded.get('met') or '',
                    'remaining': individual_ded.get('remaining') or '',
                },
                'deductible_fam': {
                    'total': family_ded.get('amount') or '',
                    'used': family_ded.get('met') or '',
                    'remaining': family_ded.get('remaining') or '',
                },
                'ortho_lifetime': {
                    'total': ortho_max.get('amount') or '',
                    'used': ortho_max.get('met') or '',
                    'remaining': ortho_max.get('remaining') or '',
                },
            },
            'provider_info': {
                'provider_name': '',
                'provider_network_status': '',
            },
            'covered_services': covered_services,
            'provisions': [],
        },
        'benefit_coverage': {'procedures': normalized_procs},
    }

    dependent_age = next(
        (
            str(x.get('age'))
            for x in raw.get('age_limits') or []
            if 'dependent' in str(x.get('type', '')).lower()
            and _cigna_network_matches(x, network)
        ),
        '',
    )
    ortho_age = next(
        (
            str(x.get('age'))
            for x in raw.get('age_limits') or []
            if 'ortho' in str(x.get('type', '')).lower()
            and _cigna_network_matches(x, network)
        ),
        '',
    )
    waiting = notes.get('waiting_period')
    missing_tooth = str(notes.get('missing_tooth') or '').strip()
    normalized['_cigna_meta'] = {
        'dependent_age': dependent_age,
        'ortho_age': ortho_age,
        'deductible_applicability': deductible_applicability,
        'missing_tooth': missing_tooth,
        'waiting_period': waiting,
        'family_deductible_present': bool(family_ded),
        'individual_deductible_present': bool(individual_ded),
        'annual_max_present': bool(annual),
        'ortho_max_present': bool(ortho_max),
        'ortho_ded_total': ortho_ded.get('amount') or '',
        'ortho_ded_used': ortho_ded.get('met') or '',
        'network_name': network.get('name') or '',
        'plan_renews': plan.get('plan_renews') or '',
        'unresolved_codes': sorted(set(unresolved_codes)),
        'procedure_result_count': len(results),
    }
    return normalized


def _apply_cigna_output_rules(data, normalized):
    """Apply Cigna-only meanings and mark unavailable portal values with '-'."""
    meta = normalized.get('_cigna_meta') or {}
    deductible_applicability = meta.get('deductible_applicability') or {}
    missing_raw = str(meta.get('missing_tooth') or '').strip()
    missing_text = missing_raw.lower()
    if missing_text in ('', 'n/a', 'na', 'none', '-', '—'):
        missing_tooth = '-'
    elif (
        'does not apply' in missing_text
        or 'not applicable' in missing_text
        or missing_text == 'no'
    ):
        missing_tooth = 'No'
    else:
        # An explicit date/end date or any affirmative clause value means the
        # missing-tooth clause applies.
        missing_tooth = 'Yes'

    waiting_value, waiting_months, applies_to = _cigna_waiting_period_values(
        meta.get('waiting_period')
    )

    data.update({
        'source_insurer': 'cigna',
        'ins_name': '(IN) CIGNA',
        'ins_address': 'PO BOX 188037, Chattanooga, TN 37422',
        'ins_phone': '8002446224',
        'payor_id': '62308',
        # TOTAL/P0010 is the selected Cigna network, not a fee schedule name.
        'fee_schedule': '-',
        'ssn': data.get('member_id') or '-',
        'elig_notes': 'ins: cigna, benefits verified online',
        'plan_type': _display_plan_type(data.get('plan_type')),
        'term_date': '-',
        'plan_year_start': (
            'January'
            if 'CALENDAR' in str(meta.get('plan_renews', '')).upper()
            else _effective_date_month(data.get('eff_date')) or '-'
        ),
        'family_ded': (
            data.get('family_ded', '')
            if meta.get('family_deductible_present')
            else _triple_individual_deductible(data.get('indiv_ded'))
        ),
        'family_ded_paid': (
            data.get('family_ded_paid', '')
            if meta.get('family_deductible_present')
            else data.get('indiv_ded_paid', '')
        ),
        'yearly_max': (
            data.get('yearly_max', '') if meta.get('annual_max_present') else '-'
        ),
        'yearly_rem': (
            data.get('yearly_rem', '') if meta.get('annual_max_present') else '-'
        ),
        'indiv_ded': (
            data.get('indiv_ded', '')
            if meta.get('individual_deductible_present') else '-'
        ),
        'indiv_ded_paid': (
            data.get('indiv_ded_paid', '')
            if meta.get('individual_deductible_present') else '-'
        ),
        'ortho_max': (
            data.get('ortho_max', '')
            if meta.get('ortho_max_present') else '-'
        ),
        'ortho_max_paid': (
            data.get('ortho_max_paid', '')
            if meta.get('ortho_max_present') else '-'
        ),
        'ortho_ded': _dollar(meta.get('ortho_ded_total'), default='-'),
        'ortho_ded_paid': _dollar(meta.get('ortho_ded_used'), default='-'),
        'dep_age_limit': meta.get('dependent_age') or '-',
        'waiting_period': waiting_value or 'No',
        'waiting_period_mo': waiting_months or '0',
        'applies_to': applies_to or '-',
        'missing_tooth': missing_tooth,
        'major_on_prep': '-',
        'or_seat': '-',
        'ded_prev': (
            'Yes' if deductible_applicability.get('preventive') else 'No'
        ),
        'ded_diag': (
            'Yes' if deductible_applicability.get('diagnostic') else 'No'
        ),
        'molars_only_sealants': '',
        'posterior_composite_downgrade': '-',
        'porcelain_posterior_downgrade': '-',
        'd2950_same_day_crown': '-',
        'ortho_payment_frequency': '-',
        'ortho_age_limit_llm': '',
        'd0120_d0150_share_d0140': _cigna_same_frequency(
            data.get('procs') or {}, 'D0120', 'D0150', 'D0140'
        ),
        'd4910_d1110_share_freq': _cigna_same_frequency(
            data.get('procs') or {}, 'D4910', 'D1110'
        ),
        'd4341_number_of_quads': '-',
        'pre_auth': 'Recommended-200',
    })

    procs = data.get('procs') or {}

    # Cigna's plan-level limitation endpoint is authoritative for the general
    # sealant benefit even when the current patient's age-gated procedure lookup
    # returns not covered. Match the named Topical Sealant Application benefit.
    d1351 = procs.get('D1351') or {}
    if (
        str(d1351.get('_cigna_plan_procedure') or '').strip().lower()
        == 'topical sealant application'
        and d1351.get('_cigna_plan_covered') is True
    ):
        d1351.update({
            'frequency_limit': d1351.get('_cigna_plan_frequency') or '',
            'benefit_level': (
                data.get('pct_prev')
                if str(data.get('pct_prev') or '').strip() not in ('', '-', '—')
                else '100%'
            ),
            'deductible': data.get('ded_prev') or '',
            'age_limit': d1351.get('_cigna_plan_age_limit') or '',
            'late_date_of_service': (
                d1351.get('late_date_of_service')
                if str(d1351.get('late_date_of_service') or '').strip()
                not in ('', '-', '—')
                else 'NH'
            ),
            '_cigna_covered': True,
            '_cigna_lookup_resolved': True,
        })

    # Adult and child prophylaxis are a bidirectional display pair.
    _cigna_sync_bidirectional_pair(procs, 'D1110', 'D1120')

    data['ortho_age_limit_llm'] = _cigna_resolve_ortho_age(
        procs, meta.get('ortho_age')
    )
    data['molars_only_sealants'] = _cigna_molars_only_sealants(procs)

    # Business rule: the exact Cigna alternate-benefit phrase means Yes. A
    # successfully resolved response without that phrase means No. Failed or
    # unresolved lookups remain unknown.
    for code, output_key in (
        ('D2140', 'posterior_composite_downgrade'),
        ('D2740', 'porcelain_posterior_downgrade'),
    ):
        proc = procs.get(code) or {}
        if proc.get('_cigna_covered') is None:
            data[output_key] = '-'
        else:
            data[output_key] = (
                'Yes' if _cigna_has_alternate_benefit_phrase(proc) else 'No'
            )

    # Business truth table:
    # D2950 not covered -> No; D2950 + D2740 covered -> Yes;
    # D2950 covered but D2740 not covered -> No; unresolved -> unknown.
    d2950 = procs.get('D2950') or {}
    d2740 = procs.get('D2740') or {}
    d2950_covered = d2950.get('_cigna_covered')
    d2740_covered = d2740.get('_cigna_covered')
    if d2950_covered is False:
        data['d2950_same_day_crown'] = 'No'
    elif d2950_covered is True and d2740_covered is True:
        data['d2950_same_day_crown'] = 'Yes'
    elif d2950_covered is True and d2740_covered is False:
        data['d2950_same_day_crown'] = 'No'
    else:
        data['d2950_same_day_crown'] = '-'

    # The PDF row represents either D1206 or D1208. Prefer a covered code. The
    # high-level Cigna limitation response supplies a reliable D1208 fallback
    # for older crawl files that did not include D1208 in detailed results.
    d1206 = procs.get('D1206') or {}
    d1208 = procs.get('D1208') or {}
    fluoride = None
    if d1206.get('_cigna_covered') is True:
        fluoride = d1206
    elif d1208.get('_cigna_covered') is True:
        fluoride = dict(d1208)
        if not str(fluoride.get('benefit_level') or '').strip():
            fluoride['benefit_level'] = data.get('pct_prev') or '-'
        if not str(fluoride.get('deductible') or '').strip():
            fluoride['deductible'] = data.get('ded_prev') or '-'
        if not str(fluoride.get('late_date_of_service') or '').strip():
            # Older exports only provide the D1208 limitation, not service
            # history. Display unknown rather than inventing "No History".
            fluoride['late_date_of_service'] = '-'
    elif d1206:
        fluoride = d1206
    elif d1208:
        fluoride = d1208
    if fluoride:
        procs['_CIGNA_FLUORIDE_DISPLAY'] = fluoride

    unresolved_codes = meta.get('unresolved_codes') or []
    if unresolved_codes:
        data['elig_notes'] = (
            f"WARNING: Cigna benefit crawl incomplete - {len(unresolved_codes)} "
            "procedure lookup(s) unresolved. Rerun before finalizing."
        )

    # Cigna's over-denture-complete response is intentionally represented as
    # the requested zero-percent/N/A display, even when no usable lookup row
    # is returned for this code.
    d5860 = procs.setdefault('D5860', {})
    d5860.update({'frequency_limit': 'N/A', 'benefit_level': '0%'})

    if data.get('chair_provider') in ('', '—'):
        data['chair_provider'] = '-'
    if data.get('d4341_number_of_quads') in ('', '—'):
        data['d4341_number_of_quads'] = '-'
    return data


def _extract(portal_raw, denticon_raw):
    """Return a flat dict of all values needed to render the PDF."""

    if _is_aetna_portal(portal_raw):
        normalized = _normalize_aetna_portal(portal_raw)
        return _apply_aetna_output_rules(
            _extract(normalized, denticon_raw),
            normalized,
        )

    if _is_cigna_portal(portal_raw):
        normalized = _normalize_cigna_portal(portal_raw)
        return _apply_cigna_output_rules(
            _extract(normalized, denticon_raw),
            normalized,
        )

    carrier = (
        portal_raw.get('carrier_information') or
        portal_raw.get('carrier_info') or {}
    )

    # All non-office PDF data comes exclusively from Portal JSON.
    ml = portal_raw.get('metlife_data') or portal_raw
    bc = portal_raw.get('benefit_coverage') or {}

    dent       = denticon_raw.get('denticon_data') or denticon_raw
    dent_hdr   = dent.get('header', {})
    dent_pt    = dent.get('patient', {})
    dent_pi    = dent.get('primary_insurance', {}) if isinstance(dent.get('primary_insurance', {}), dict) else {}

    ml_pat      = ml.get('patient', {})       if isinstance(ml.get('patient', {}),       dict) else {}
    ml_pln      = ml.get('plan_details', {})  if isinstance(ml.get('plan_details', {}),  dict) else {}
    ml_fin      = ml.get('financials', {})    if isinstance(ml.get('financials', {}),    dict) else {}
    ml_provider = ml.get('provider_info', {}) if isinstance(ml.get('provider_info', {}), dict) else {}

    svcs       = ml.get('covered_services', [])
    provisions = ml.get('provisions', [])

    basis_payment_text = clean(_extract_basis_of_payment(provisions))
    missing_tooth_text = clean(_extract_missing_tooth_text(provisions))

    if not isinstance(svcs, list):
        svcs = []

    interp = (
        dict(_LLM_DEFAULT_ANSWERS)
        if portal_raw.get('_skip_llm')
        else _interpret_provisions(portal_raw)
    )

    waiting_period, waiting_period_mo, applies_to = _parse_waiting_period(provisions, {})

    # ── Derived values ──────────────────────────────────────────────────────

    carrier_name = (
        _g(carrier,      'name',            default='') or
        _g(ml_provider,  'provider_name',   default='') or
        ('MetLife' if portal_raw.get('metlife_data') else '') or
        '—'
    )

    is_metlife = 'METLIFE' in carrier_name.upper()

    pre_auth_val = _parse_pre_auth({}, '', carrier_name)

    # Build procedure-code → details map
    procs = {}
    for p in bc.get('procedures', []):
        code = p.get('procedure_code', '').upper().strip()
        if code:
            procs[code] = p

    # Apply deterministic provision parsing before any LLM fallback. This keeps
    # explicit portal facts (for example MetLife ortho payment method and
    # cleaning/perio-maintenance shared frequency) correct even when Ollama is
    # unavailable.
    rule_interp = _rule_based_interp(portal_raw, procs)
    for key, value in rule_interp.items():
        if str(value or '').strip().lower() not in ('', '-', '—', 'n/a', 'na', 'none'):
            interp[key] = value

    def _format_name(raw):
        if not raw or raw == '—':
            return '—'
        suffixes = ['DMD', 'DDS', 'MD', 'DO', 'PHD', 'RDH']
        parts = raw.strip().split()
        parts = [p for p in parts if p.upper().rstrip('.') not in suffixes]
        cleaned = ' '.join(parts).strip()
        if ',' in cleaned:
            last, *rest = cleaned.split(',')
            first_parts = ' '.join(rest).strip().split()
            first = first_parts[0].capitalize() if first_parts else ''
            last  = last.strip().capitalize()
            return f'{first} {last}'.strip()
        return ' '.join(p.capitalize() for p in cleaned.split())

    def _same_frequency(code1, code2):
        p1 = procs.get(code1, {})
        p2 = procs.get(code2, {})
        f1 = str(p1.get('frequency_limit', '')).strip().upper()
        f2 = str(p2.get('frequency_limit', '')).strip().upper()
        if not f1 or not f2:
            return 'No'
        return 'Yes' if f1 == f2 else 'No'

    d4910_d1110_same_freq        = _same_frequency('D4910', 'D1110')
    d0120_d0140_same             = _same_frequency('D0120', 'D0140')
    d0150_d0140_same             = _same_frequency('D0150', 'D0140')
    d0120_d0150_share_with_d0140 = (
        'Yes' if (d0120_d0140_same == 'Yes' and d0150_d0140_same == 'Yes') else 'No'
    )

    # For MetLife, explicit plan provisions take precedence over coincidentally
    # equal/unequal display strings when they state that counters are combined.
    if is_metlife:
        explicit_4910 = str(rule_interp.get('d4910_d1110_share_freq') or '').strip()
        if explicit_4910 in ('Yes', 'No'):
            d4910_d1110_same_freq = explicit_4910
        explicit_exam = str(rule_interp.get('d0120_d0150_share_d0140') or '').strip()
        if explicit_exam in ('Yes', 'No'):
            d0120_d0150_share_with_d0140 = explicit_exam

    ann  = ml_fin.get('annual_max',     {})
    dind = ml_fin.get('deductible_ind', {})
    dfam = ml_fin.get('deductible_fam', {})
    orth = ml_fin.get('ortho_lifetime', {})

    if is_metlife:
        # Business rule: MetLife Member ID / SSN are the Denticon subscriber ID.
        # Do not use the masked Portal subscriber_id when Denticon has the real value.
        member_id = (
            _g(
                dent_pi,
                'sub_id', 'subscriber_id', 'subscriberId', 'member_id', 'memberId', 'ssn',
                default='',
            )
            or _g(ml_pln, 'subscriber_id', default='')
            or '—'
        )
    else:
        member_id = (
            _g(ml_pln, 'subscriber_id', default='') or
            '—'
        )

    sub_info = portal_raw.get('subscriber_info') or {}

    subscriber_name = _format_name(
        sub_info.get('name', '') or _g(ml_pat, 'name', default='')
    )

    subscriber_dob = (
        sub_info.get('dob', '') or
        _g(ml_pat, 'dob', default='') or
        '—'
    )       

    raw_rel = (
        _g(ml_pat,   'relationship',           default='') or
        _g(sub_info, 'relation', 'relationship', default='')
    )
    relationship = RELATION_MAP.get(raw_rel.strip().lower(), raw_rel or '—')

    office_name = (
        _g(dent_pt,  'home_office',  default='') or
        _g(dent_hdr, 'office_name',  default='') or
        '—'
    )

    provider_name = _format_name(
        _g(dent_pt,  'provider',      default='') or
        _g(dent_hdr, 'provider_name', default='')
    )

    # Do not assume that the hygienist is the chair provider.
    chair_provider = _format_name(
        _g(dent_pt, 'chair_provider', default='—')
    )
    provider_speciality = (
        _g(dent_hdr, 'provider_speciality', 'speciality', 'specialty', default='') or
        'Dentist'
    )
    appointment_date = datetime.now(
        timezone(timedelta(hours=5, minutes=30))
    ).strftime('%m/%d/%Y %I:%M %p')

    # Portal-only group number lookup. Support the common schema variants at
    # both plan and MetLife payload levels without falling back to Denticon.
    group_number = (
        _g(
            ml_pln,
            'group_number', 'group_num', 'group_id', 'group_no',
            'employer_group_number', 'contract_number',
            default='',
        ) or
        _g(
            ml,
            'group_number', 'group_num', 'group_id', 'group_no',
            'employer_group_number', 'contract_number',
            default='',
        ) or
        _g(
            portal_raw,
            'group_number', 'group_num', 'group_id', 'group_no',
            'employer_group_number', 'contract_number',
            default='',
        ) or
        '—'
    )

    carrier_phone = _g(carrier, 'phone', default='')

    # ── FIX #2: Molars-only sealants — deterministic from D1351 frequency ──
    molars_only = _rule_molars_only_sealants(procs)
    if molars_only == '—':
        molars_only = interp.get('molars_only_sealants', '—')

    # ── FIX #3: D2950 same day as crown — check D2740 coverage ────────────
    d2950_same_day = _rule_d2950_same_day_crown(procs)
    if d2950_same_day == '—':
        d2950_same_day = interp.get('d2950_same_day_crown', '—')

    # ── FIX #4: Alternate-benefit downgrades — parse provision sentences ───
    downgrade_answers = _rule_alternate_benefit_downgrades(provisions)
    posterior_composite = downgrade_answers['posterior_composite_downgrade']
    porcelain_posterior = downgrade_answers['porcelain_posterior_downgrade']
    # Fall back to LLM only if rule-based couldn't determine
    if posterior_composite == '—':
        posterior_composite = interp.get('posterior_composite_downgrade', '—')
    if porcelain_posterior == '—':
        porcelain_posterior = interp.get('porcelain_posterior_downgrade', '—')

    # ── FIX #1: Family deductible ──────────────────────────────────────────
    family_ded_val = _family_deductible_v2(
        fam_total_raw   = _g(dfam, 'total', default=''),
        indiv_total_raw = _g(dind, 'total', default=''),
        relationship    = relationship,
    )

    # MetLife top category percentages should represent the actual category
    # benefit, not the first number in mixed text such as "50%-80%".
    if is_metlife:
        pct_prev = (
            _procedure_benefit_pct(procs, 'D1110', 'D1120', 'D1206', 'D1351')
            or _covered_pct_max(svcs, 'PREVENTIVE')
            or _covered_pct(svcs, 'PREVENTIVE')
        )
        pct_basic = (
            _procedure_benefit_pct(procs, 'D2140', 'D2331', 'D4341', 'D3310')
            or _covered_pct_max(svcs, 'RESTORATIVE')
            or _covered_pct(svcs, 'RESTORATIVE', 'DIAGNOSTIC')
        )
        pct_major = (
            _procedure_benefit_pct(procs, 'D2740', 'D5110', 'D6010')
            or _covered_pct_max(svcs, 'PROSTHODONTICS', 'IMPLANT')
            or _covered_pct(svcs, 'PROSTHODONTICS', 'IMPLANT')
        )
        metlife_ortho_age = _extract_metlife_ortho_age_limit(provisions)
    else:
        pct_prev = _covered_pct(svcs, 'PREVENTIVE')
        pct_basic = _covered_pct(svcs, 'RESTORATIVE', 'DIAGNOSTIC')
        pct_major = _covered_pct(svcs, 'PROSTHODONTICS', 'IMPLANT')
        metlife_ortho_age = ''

    return {
        'source_insurer': 'metlife' if is_metlife else '',

        # Patient / Subscriber
        'patient_name':    _g(ml_pat, 'name'),
        'patient_dob':     _g(ml_pat, 'dob'),
        'relationship':    relationship,
        'member_id':       member_id,
        'subscriber_name': subscriber_name,
        'subscriber_dob':  subscriber_dob,
        'ssn':             member_id,

        # Office
        'office_name':         office_name,
        'provider_name':       provider_name,
        'chair_provider':      chair_provider,
        'provider_speciality': provider_speciality,
        'appointment_date':    appointment_date,

        # Insurance
        'ins_name': (
            '(IN) MetLife(TX)- PO Box 981282- 79998'
            if is_metlife else (carrier_name if carrier_name else '—')
        ),
        'group_name': (
            _g(ml_pln, 'employer_group')
        ),
        'group_number': group_number,
        'fee_schedule': (
            'METLIFE PPO'
            if is_metlife
            else _g(ml_provider, 'provider_network_status')
        ),
        'ins_address': (
            'PO Box 981282, El Paso, TX 79998'
            if is_metlife
            else (_build_insurance_address(carrier) or '—')
        ),
        'ins_phone': (
            _clean_phone(carrier_phone)
            if carrier_phone
            else ('8776383379' if is_metlife else '—')
        ),
        'network_status': (
            ''
        ),
        'eff_date':  _g(ml_pln, 'start_date'),
        'term_date': _blank_present_end_date(_g(ml_pln, 'end_date')),
        'payor_id': (
            _g(carrier, 'payer_id', default='') or
            ('65978' if is_metlife else '—')
        ),
        'plan_type': (
            'PPO'
            if is_metlife
            else _display_plan_type(
                _g(ml_pln, 'plan_type', default='')
                or _g(ml_pln, 'network', default='')
            )
        ),
        'plan_year_start': _get_plan_year_start(procs, _g(ml_pln, 'start_date')),
        'elig_notes': (
            'ins: metlife, benefits verified online'
            if (is_metlife or 'PDP' in str(_g(ml_pln, 'network')).upper())
            else '—'
        ),

        # Coverage
        'yearly_max':      _dollar(_g(ann,  'total')),
        'yearly_rem':      _dollar(_g(ann,  'remaining')),
        'indiv_ded':       _dollar(_g(dind, 'total')),
        'indiv_ded_paid':  _zero_money(_dollar(_g(dind, 'used'))),
        'family_ded':      family_ded_val,          # ← FIX #1
        'family_ded_paid': _zero_money(_dollar(_g(dfam, 'used'))),
        'ded_prev':        _deductible_applies(svcs, 'PREVENTIVE'),
        'ded_diag':        _deductible_applies(svcs, 'DIAGNOSTIC'),

        'waiting_period':    waiting_period,
        'waiting_period_mo': waiting_period_mo,
        'applies_to':        applies_to,

        'major_on_prep': _yes_no_from_basis(basis_payment_text, 'prep'),
        'or_seat':       _yes_no_from_basis(basis_payment_text, 'seat'),
        'missing_tooth': _missing_tooth_clause(missing_tooth_text),
        'pre_auth':      pre_auth_val,

        'dep_age_limit': _extract_dependent_age_limit(provisions),
        'ortho_ded':      '0.00',
        'ortho_ded_paid': '0.00',
        'ortho_max':      _dollar(_g(orth, 'total')),
        'ortho_max_paid': _dollar(_g(orth, 'used')),

        # Benefit percentages
        'pct_prev':  pct_prev,
        'pct_basic': pct_basic,
        'pct_major': pct_major,

        # Deterministic / LLM-interpreted fields
        'molars_only_sealants':          molars_only,          # FIX #2
        'posterior_composite_downgrade': posterior_composite,  # FIX #4
        'porcelain_posterior_downgrade': porcelain_posterior,  # FIX #4
        'd2950_same_day_crown':          d2950_same_day,       # FIX #3
        'd0120_d0150_share_d0140':       d0120_d0150_share_with_d0140,
        'd4910_d1110_share_freq':        d4910_d1110_same_freq,
        # Do not infer a quadrant count from procedure text.  The approved
        # operational answer for MetLife is Pre-D.
        'd4341_number_of_quads':          'Pre-D' if is_metlife else _number_of_quads_d4341(procs),
        'ortho_payment_frequency':       interp.get('ortho_payment_frequency', '—'),
        'ortho_age_limit_llm':           (
            metlife_ortho_age if is_metlife else interp.get('ortho_age_limit', '—')
        ),

        'procs': procs,
    }


# ═══════════════════════════════════════════════════════════════════════════════
#  CANVAS DRAWING HELPERS
# ═══════════════════════════════════════════════════════════════════════════════

def _filled_rect(c, x, y, w, h, fill, stroke_color=None, lw=0.5):
    c.setFillColor(fill)
    if stroke_color:
        c.setStrokeColor(stroke_color)
        c.setLineWidth(lw)
        c.rect(x, H - y - h, w, h, fill=1, stroke=1)
    else:
        c.rect(x, H - y - h, w, h, fill=1, stroke=0)


def _stroke_rect(c, x, y, w, h, stroke_color=BORDER, lw=0.5):
    c.setStrokeColor(stroke_color)
    c.setLineWidth(lw)
    c.rect(x, H - y - h, w, h, fill=0, stroke=1)


def _txt(c, x, y, text, font='Helvetica', size=8, color=DARK):
    c.setFont(font, size)
    c.setFillColor(color)
    c.drawString(x, H - y, text)


def _rtxt(c, x, y, text, font='Helvetica', size=8, color=DARK):
    c.setFont(font, size)
    c.setFillColor(color)
    c.drawRightString(x, H - y, text)


def _hline(c, x1, y, x2, color=BORDER, lw=0.5):
    c.setStrokeColor(color)
    c.setLineWidth(lw)
    c.line(x1, H - y, x2, H - y)


def _sec_bar(c, x, y, w, h, label, font_size=9):
    _filled_rect(c, x, y, w, h, fill=TEAL_LIGHT, stroke_color=BORDER)
    _txt(c, x + 6, y + h - 4, label, 'Helvetica-Bold', font_size, TEAL_DARK)


def _fit_text_lines(text, font, size, max_width, max_lines=1):
    """Wrap text to a bounded width, including strings with no spaces."""
    text = clean(text)
    if not text:
        return [''], size
    if not max_width:
        return [text], size
    if stringWidth(text, font, size) <= max_width:
        return [text], size

    # Keep compact values on one line when a small font adjustment is enough.
    for fitted_size in (size - 0.5, size - 1, size - 1.5, max(6, size - 2)):
        if stringWidth(text, font, fitted_size) <= max_width:
            return [text], fitted_size

    words = text.split()
    lines, current = [], ''
    for word in words:
        candidate = f'{current} {word}'.strip()
        if stringWidth(candidate, font, size) <= max_width:
            current = candidate
            continue
        if current:
            lines.append(current)
            current = ''
        # Split an oversized token so it cannot escape the box.
        while word and stringWidth(word, font, size) > max_width:
            cut = len(word)
            while cut > 1 and stringWidth(word[:cut], font, size) > max_width:
                cut -= 1
            lines.append(word[:cut])
            word = word[cut:]
        current = word
    if current:
        lines.append(current)

    if len(lines) > max_lines:
        lines = lines[:max_lines]
        last = lines[-1]
        while last and stringWidth(last + '…', font, size) > max_width:
            last = last[:-1]
        lines[-1] = (last.rstrip() + '…') if last else '…'
    return lines or ['—'], size


def _bounded_txt(c, x, y, text, max_width, font='Helvetica', size=8,
                 color=DARK, max_lines=1, leading=None):
    lines, fitted_size = _fit_text_lines(
        text, font, size, max_width, max_lines=max_lines
    )
    leading = leading or fitted_size + 1
    for i, line in enumerate(lines):
        _txt(c, x, y + (i * leading), line, font, fitted_size, color)


def _lv(c, x, y, label, value, lsz=7, vsz=8.5, vcolor=TEAL, gap=14,
        max_width=None, max_lines=1):
    _txt(c, x, y, label, 'Helvetica', lsz, GREY)
    _bounded_txt(
        c, x, y + gap, value if value is not None else '—', max_width,
        'Helvetica-Bold', vsz, vcolor, max_lines=max_lines,
        leading=max(7, vsz + 1),
    )


def _footer(c, page_num, total_pages):
    _hline(c, MARGIN, H - FOOTER_Y + 4, W - MARGIN, color=BORDER)
    yr = datetime.now().year
    c.setFont('Helvetica', 7)
    c.setFillColor(GREY)
    c.drawString(MARGIN, FOOTER_Y, datetime.now().strftime('%m-%d-%Y'))
    c.drawCentredString(W / 2, FOOTER_Y, f'© {yr} iSpace, Inc. All Rights Reserved.')
    c.drawRightString(W - MARGIN, FOOTER_Y, f'{page_num} of {total_pages}')


# ═══════════════════════════════════════════════════════════════════════════════
#  PAGE 1
# ═══════════════════════════════════════════════════════════════════════════════

def _page1(c, d, total_pages):
    y = 0

    BAR = 34
    _filled_rect(c, 0, y, W, BAR, fill=TEAL)
    _txt(c, MARGIN,       y + 23, 'Insurance Plan Breakdown', 'Helvetica-Bold', 14, WHITE)
    _txt(c, MARGIN + 193, y + 23, '- (New Plan)', 'Helvetica', 12, colors.HexColor('#90e8a0'))
    _rtxt(c, W - MARGIN,  y + 23, 'Powered By iSpace', 'Helvetica-Oblique', 8.5, colors.HexColor('#c0e8f5'))
    y += BAR + 3

    DISC_H = 34
    _filled_rect(c, MARGIN, y, CW, DISC_H, fill=GOLD_BG, stroke_color=GOLD)
    c.setFont('Helvetica-Bold', 8)
    c.setFillColor(GOLD_TXT)
    c.drawString(MARGIN + 5, H - y - 14, 'Disclaimer:')
    disc = ('The applicability of the deductible to Diagnostic and Preventive services '
            'is recorded based on the insurance plan, while for Basic and Major services, '
            'it is set to "Yes" by default.')
    lines = simpleSplit(disc, 'Helvetica', 7.5, CW - 75)
    c.setFont('Helvetica', 7.5)
    c.setFillColor(GOLD_TXT)
    ly = H - y - 14
    for ln in lines[:2]:
        c.drawString(MARGIN + 72, ly, ln)
        ly -= 10
    y += DISC_H + 5

    HALF  = (CW - 8) / 2
    BOX_H = 140

    _filled_rect(c, MARGIN, y, HALF, BOX_H, fill=GREY_LIGHT, stroke_color=BORDER)
    _filled_rect(c, MARGIN, y, HALF, 15,    fill=TEAL)
    _txt(c, MARGIN + 5, y + 11, 'Office Information', 'Helvetica-Bold', 8.5, WHITE)
    office_value_w = HALF - 10
    _lv(c, MARGIN + 5, y + 22,  'Office Name',             d['office_name'],         max_width=office_value_w)
    _lv(c, MARGIN + 5, y + 46,  'Preferred Provider Name', d['provider_name'],       max_width=office_value_w)
    _lv(c, MARGIN + 5, y + 70,  'Chair Provider Name',     d['chair_provider'],      max_width=office_value_w)
    _lv(c, MARGIN + 5, y + 94,  'Provider Speciality',     d['provider_speciality'], max_width=office_value_w)
    _lv(c, MARGIN + 5, y + 118, 'Appointment Date',        d['appointment_date'],    max_width=office_value_w)

    px = MARGIN + HALF + 8
    _filled_rect(c, px, y, HALF, BOX_H, fill=GREY_LIGHT, stroke_color=BORDER)
    _filled_rect(c, px, y, HALF, 15,    fill=TEAL)
    _txt(c, px + 5, y + 11, 'Patient / Subscriber Information', 'Helvetica-Bold', 8.5, WHITE)

    HC = HALF / 2
    patient_value_w = HC - 10
    _lv(c, px + 5,      y + 22, 'Patient Name',           d['patient_name'],    max_width=patient_value_w)
    _lv(c, px + HC + 3, y + 22, 'Date of Birth',          d['patient_dob'],     max_width=patient_value_w)
    _lv(c, px + 5,      y + 46, 'Member ID#',             d['member_id'],       max_width=patient_value_w)
    _lv(c, px + HC + 3, y + 46, 'Relation to Subscriber', d['relationship'],    max_width=patient_value_w)
    _lv(c, px + 5,      y + 70, 'Subscriber Name',        d['subscriber_name'], max_width=patient_value_w)
    _lv(c, px + HC + 3, y + 70, 'Date of Birth',          d['subscriber_dob'],  max_width=patient_value_w)
    _lv(c, px + 5,      y + 94, 'SSN#',                   d['ssn'],             max_width=patient_value_w)
    y += BOX_H + 5

    INS_BOX_H = 175

    _filled_rect(c, MARGIN, y, CW, INS_BOX_H, fill=GREY_LIGHT, stroke_color=BORDER)
    _sec_bar(c, MARGIN, y, CW, 16, 'Insurance Information')

    T3 = CW / 3

    r1 = y + 34
    insurance_value_w = T3 - 20
    _lv(c, MARGIN + 10,          r1, 'Insurance Name', d['ins_name'],     lsz=7, vsz=9, gap=14, max_width=insurance_value_w, max_lines=2)
    _lv(c, MARGIN + T3 + 10,     r1, 'Group Name',     d['group_name'],   lsz=7, vsz=9, gap=14, max_width=insurance_value_w, max_lines=2)
    _lv(c, MARGIN + (T3*2) + 10, r1, 'Group Number',   d['group_number'], lsz=7, vsz=9, gap=14, max_width=insurance_value_w, max_lines=2)
    _hline(c, MARGIN, y + 72, W - MARGIN, lw=0.35)

    r2 = y + 92
    _lv(c, MARGIN + 10,          r2, 'Fee Schedule',      d['fee_schedule'], lsz=7, vsz=9,   gap=14, max_width=insurance_value_w, max_lines=2)
    _lv(c, MARGIN + T3 + 10,     r2, 'Insurance Address', d['ins_address'],  lsz=7, vsz=8.5, gap=14, max_width=insurance_value_w, max_lines=2)
    _lv(c, MARGIN + (T3*2) + 10, r2, 'Insurance Phone',   d['ins_phone'],    lsz=7, vsz=9,   gap=14, max_width=insurance_value_w, max_lines=2)
    _hline(c, MARGIN, y + 126, W - MARGIN, lw=0.35)

    r3 = y + 146
    _lv(c, MARGIN + 10,          r3, 'Provider Network Status', d['network_status'], lsz=7, vsz=9, gap=14, max_width=insurance_value_w)
    _lv(c, MARGIN + T3 + 10,     r3, 'Patient Eff Date',        d['eff_date'],        lsz=7, vsz=9, gap=14, max_width=insurance_value_w)
    _lv(c, MARGIN + (T3*2) + 10, r3, 'Patient Term Date',       d['term_date'],       lsz=7, vsz=9, gap=14, max_width=insurance_value_w)

    y += INS_BOX_H

    ROW_H = 44
    _filled_rect(c, MARGIN, y, CW, ROW_H, fill=GREY_LIGHT, stroke_color=BORDER)
    _hline(c, MARGIN, y + 1, W - MARGIN, color=BORDER, lw=0.3)
    _lv(c, MARGIN + 12,          y + 14, 'PPO / Indemnity / HMO Plan?', d['plan_type'],       lsz=7, vsz=9, gap=16, max_width=T3 - 24)
    _lv(c, MARGIN + T3 + 12,     y + 14, 'Starting Month of Plan Year', d['plan_year_start'], lsz=7, vsz=9, gap=16, max_width=T3 - 24)
    _lv(c, MARGIN + (T3*2) + 12, y + 14, 'Payor ID',                    d['payor_id'],         lsz=7, vsz=9, gap=16, max_width=T3 - 24)

    y += ROW_H

    EN_H = 24
    _filled_rect(c, MARGIN, y, CW, EN_H, fill=GREY_LIGHT, stroke_color=BORDER)
    _txt(c, MARGIN + 5,  y + 8, 'Eligibility Notes:', 'Helvetica',      7.5, GREY)
    _bounded_txt(c, MARGIN + 68, y + 8, d['elig_notes'], CW - 75,
                 'Helvetica-Bold', 8, TEAL, max_lines=2, leading=9)
    y += EN_H + 5

    cov_pairs = [
        ('Yearly Maximum',                     d['yearly_max'],
         'Remaining',                          d['yearly_rem']),
        ('Individual Deductible',              d['indiv_ded'],
         'Paid to Date (Ind.)',                d['indiv_ded_paid']),
        ('Family Deductible',                  d['family_ded'],
         'Paid to Date (Fam.)',                d['family_ded_paid']),
        ('Deductible Applies to Preventative', d['ded_prev'],
         'Deductible Applies to Diagnostic',   d['ded_diag']),
        ('Is there a Waiting Period',          d['waiting_period'],
         'Period',                             d['waiting_period_mo']),
        ('Applies to',                         d['applies_to'],
         '',                                   ''),
        ('Are Major Services Paid on Prep',    d['major_on_prep'],
         'Or Seat',                            d['or_seat']),
        ('Does Missing Tooth Clause Apply?',   d['missing_tooth'],
         'Pre-Authorize over',                 d['pre_auth']),
        ('Dependent Age Limit',                d['dep_age_limit'],
         '',                                   ''),
        ('Orthodontics Deductible',            d['ortho_ded'],
         'Paid to date',                       d['ortho_ded_paid']),
        ('Ortho Max',                          d['ortho_max'],
         'Paid to date',                       d['ortho_max_paid']),
    ]

    COV_H = 15 + len(cov_pairs) * 22 + 6
    _filled_rect(c, MARGIN, y, CW, COV_H, fill=GREY_LIGHT, stroke_color=BORDER)
    _sec_bar(c, MARGIN, y, CW, 15, 'Coverage')

    HALF_CW = CW / 2
    cv_y = y + 22
    for l1, v1, l2, v2 in cov_pairs:
        _lv(c, MARGIN + 5, cv_y, l1, v1, vsz=8, gap=11,
            max_width=HALF_CW - 12)
        if l2:
            _lv(c, MARGIN + HALF_CW + 5, cv_y, l2, v2, vsz=8, gap=11,
                max_width=HALF_CW - 12)
        cv_y += 22

    _footer(c, 1, total_pages)


# ═══════════════════════════════════════════════════════════════════════════════
#  PAGE 2+ — General Benefit Details table
# ═══════════════════════════════════════════════════════════════════════════════

_BENEFIT_ROWS = [
    ('EXAMS',                                        None,    'cat'),
    ('Perio Consult (D0180)',                         'D0180', 'data'),
    ('Periodic Exam (D0120)',                         'D0120', 'data'),
    ('Limited Exam (D0140)',                          'D0140', 'data'),
    ('Comprehensive Exam (D0150)',                    'D0150', 'data'),
    ('Do D0120,D0150 Share a frequency with D0140?',  None,    'note'),

    ('DIAGNOSTIC',                                    None,    'cat'),
    ('Full Mouth X-Ray (D0210)',                      'D0210', 'data'),
    ('PA (D0220)',                                    'D0220', 'data'),
    ('PA Additional (D0230)',                         'D0230', 'data'),
    ('Intraoral - Occlusal Image (D0240)',            'D0240', 'data'),
    ('Bitewings (D0274)',                             'D0274', 'data'),
    ('Panoramic X-Ray (D0330)',                       'D0330', 'data'),

    ('PREVENTIVE',                                    None,    'cat'),
    ('Space Maintainer (D1510)',                      'D1510', 'data'),
    ('Prophylaxis (D1110)',                           'D1110', 'data'),
    ('Prophylaxis Child (D1120)',                     'D1120', 'data'),
    ('Fluoride (D1206, D1208)',                       'D1206', 'data'),
    ('Sealants (D1351)',                              'D1351', 'data'),
    ('Permanent Un-restored Molars only?',             None,    'note'),

    ('BASIC RESTORATIVE',                             None,    'cat'),
    ('Amalgam (D2140)',                               'D2140', 'data'),
    ('Composite Filling (D2331)',                     'D2331', 'data'),
    ('Restorative Onlay/Inlay (D2620)',               'D2620', 'data'),
    ('Posterior composites downgraded to amalgam?',    None,    'note'),

    ('MAJOR RESTORATIVE',                             None,    'cat'),
    ('Porcelain Crown (D2740)',                       'D2740', 'data'),
    ('Porcelain crowns downgraded on posterior teeth', None,    'note'),
    ('Build up (D2950)',                              'D2950', 'data'),
    ('Can D2950 be done same day as crown?',           None,    'note'),
    ('D2991',                                         'D2991', 'data'),

    ('ENDODONTICS',                                   None,    'cat'),
    ('Retreatment of previous root canal therapy - premolar (D3347)', 'D3347', 'data'),
    ('Endo (D3310)',                                  'D3310', 'data'),
    ('Root Canal (D3330)',                            'D3330', 'data'),

    ('PERIODONTICS',                                  None,    'cat'),
    ('Osseous Surgery (D4260)',                       'D4260', 'data'),
    ('Scaling & Root Planning (D4341)',               'D4341', 'data'),
    ('Number of quads for the code D4341',             None,    'note'),
    ('Full Mouth Debridement (D4355)',                'D4355', 'data'),
    ('Arestin (D4381)',                               'D4381', 'data'),
    ('Perio Maintenance (D4910)',                     'D4910', 'data'),
    ('Do D4910 and D1110 share a frequency?',         None,    'note'),

    ('REMOVABLE PROSTHODONTICS',                      None,    'cat'),
    ('Over Denture Complete (D5860)',                 'D5860', 'data'),
    ('Dentures (D5110)',                              'D5110', 'data'),
    ('Reline maxillary partial denture (direct) (D5740)', 'D5740', 'data'),
    ('Surgical stent (D5982)',                        'D5982', 'data'),

    ('IMPLANT',                                       None,    'cat'),
    ('Implant (D6194)',                               'D6194', 'data'),
    ('Implant Body (D6010)',                          'D6010', 'data'),
    ('Implant Abutment (D6056)',                      'D6056', 'data'),
    ('Implant Crown (D6065) Y/N',                     'D6065', 'data'),

    ('FIXED PROSTHODONTICS',                          None,    'cat'),
    ('Pontic - porcelain/ceramic (D6245)',            'D6245', 'data'),

    ('ORAL SURGERY',                                  None,    'cat'),
    ('Nerve dissection (D7259)',                      'D7259', 'data'),
    ('Simple Extraction (D7140)',                     'D7140', 'data'),
    ('Impacted Extraction (D7240)',                   'D7240', 'data'),

    ('ORTHODONTICS',                                  None,    'cat'),
    ('Ortho (D8010)',                                 'D8010', 'data'),
    ('Ortho (D8080)',                                 'D8080', 'data'),
    ('Payment Frequency',                             None,    'note'),
    ('Ortho Age Limit',                               None,    'note'),
    ('Ortho (D8090)',                                 'D8090', 'data'),

    ('ADJUNCTIVE',                                    None,    'cat'),
    ('Office visit for observation (D9430)',          'D9430', 'data'),
    ('Palliative (D9110)',                            'D9110', 'data'),
    ('General Anesthesia (D9222)',                    'D9222', 'data'),
    ('Sedation/Analgesia (D9239)',                    'D9239', 'data'),
    ('Consult (D9310)',                               'D9310', 'data'),
    ('Occlusal Guard (D9944)',                        'D9944', 'data'),
]

_NOTE_DATA_MAP = {
    'Do D0120,D0150 Share a frequency with D0140?': 'd0120_d0150_share_d0140',
    'Permanent Un-restored Molars only?':           'molars_only_sealants',
    'Posterior composites downgraded to amalgam?':  'posterior_composite_downgrade',
    'Can D2950 be done same day as crown?':          'd2950_same_day_crown',
    'Porcelain crowns downgraded on posterior teeth':'porcelain_posterior_downgrade',
    'Do D4910 and D1110 share a frequency?':        'd4910_d1110_share_freq',
    'Number of quads for the code D4341':            'd4341_number_of_quads',
    'Payment Frequency':                            'ortho_payment_frequency',
    'Ortho Age Limit':                              'ortho_age_limit_llm',
}


def _table_text(value, width, align='CENTER', color=TEAL, bold=False,
                italic=False, size=7.3):
    """Create a wrapping table cell that cannot paint over adjacent columns."""
    font = (
        'Helvetica-BoldOblique' if bold and italic else
        'Helvetica-Bold' if bold else
        'Helvetica-Oblique' if italic else
        'Helvetica'
    )
    style = ParagraphStyle(
        name=f'bounded-{font}-{align}-{size}',
        fontName=font,
        fontSize=size,
        leading=size + 1.2,
        textColor=color,
        alignment={'LEFT': 0, 'CENTER': 1, 'RIGHT': 2}.get(align, 1),
        wordWrap='CJK',  # also wraps IDs/URLs/other unbroken strings
        splitLongWords=True,
        allowWidows=0,
        allowOrphans=0,
        spaceBefore=0,
        spaceAfter=0,
    )
    safe = escape(str('—' if value is None else value)).replace('\n', '<br/>')
    return Paragraph(safe, style)


def _build_benefit_table(d):
    procs  = d['procs']
    col_w  = [195, 100, 62, 53, 58, 72]

    header_row = [
        'General Benefit Details',
        'Frequency', 'Percentage', 'Deductible', 'Age Limit\nUnder', 'History',
    ]
    rows   = [header_row]
    xstyle = []
    HISTORY_CODES = {
        'D0180', 'D0120', 'D0140', 'D0150', 'D1351', 'D0274', 'D0210',
        'D0330', 'D1110', 'D1120', 'D1206', 'D1208', 'D4355', 'D4910'
    }
    ORTHO_AGE_CODES = {'D8010', 'D8080', 'D8090'}
    for label, pct in [('Preventive', d['pct_prev']),
                        ('Basic',        d['pct_basic']),
                        ('Major',        d['pct_major'])]:
        ri = len(rows)
        rows.append([label, '', pct, '', '', ''])
        xstyle += [
            ('BACKGROUND', (0, ri), (-1, ri), colors.HexColor('#f0f8fd')),
            ('FONTNAME',   (0, ri), (0,  ri), 'Helvetica-Bold'),
            ('TEXTCOLOR',  (2, ri), (2,  ri), TEAL_DARK),
        ]

    alt = True
    for label, code, rtype in _BENEFIT_ROWS:
        ri = len(rows)
        if rtype == 'cat':
            rows.append([label, '', '', '', '', ''])
            xstyle += [
                ('BACKGROUND', (0, ri), (-1, ri), colors.HexColor('#c8e8f4')),
                ('FONTNAME',   (0, ri), (-1, ri), 'Helvetica-Bold'),
                ('TEXTCOLOR',  (0, ri), (-1, ri), TEAL_DARK),
                ('FONTSIZE',   (0, ri), (-1, ri), 7.5),
                ('SPAN',       (0, ri), (-1, ri)),
            ]

        elif rtype == 'note':
            data_key = _NOTE_DATA_MAP.get(label, '')
            note_val = d.get(data_key, '—') if data_key else '—'

            rows.append([
                _table_text(label, col_w[0] - 8, 'LEFT', GREY, italic=True, size=7),
                _table_text(note_val, col_w[1] - 8, 'CENTER', TEAL_DARK, bold=True, size=7),
                '', '', '', '',
            ])
            xstyle += [
                ('BACKGROUND', (0, ri), (-1, ri), colors.HexColor('#f8fcfe')),
                ('TEXTCOLOR',  (0, ri), (0,  ri), GREY),
                ('TEXTCOLOR',  (1, ri), (1,  ri), TEAL_DARK),
                ('FONTSIZE',   (0, ri), (-1, ri), 7),
                ('FONTNAME',   (0, ri), (0,  ri), 'Helvetica-Oblique'),
                ('FONTNAME',   (1, ri), (1,  ri), 'Helvetica-Bold'),
            ]

        else:  # 'data'
            p = {}
            display_proc = None
            display_label = label
            display_code = code
            if label == 'Fluoride (D1206, D1208)':
                if d.get('source_insurer') == 'cigna':
                    display_proc = procs.get('_CIGNA_FLUORIDE_DISPLAY')
                elif d.get('source_insurer') == 'aetna':
                    display_proc = procs.get('_AETNA_FLUORIDE_DISPLAY')
                    has_d1206 = bool(procs.get('D1206'))
                    has_d1208 = bool(procs.get('D1208'))
                    if has_d1206 and not has_d1208:
                        display_label = 'Fluoride (D1206)'
                        display_code = 'D1206'
                    elif has_d1208 and not has_d1206:
                        display_label = 'Fluoride (D1208)'
                        display_code = 'D1208'
                    elif has_d1206 and has_d1208:
                        display_label = 'Fluoride (D1206, D1208)'

            if display_code and (display_code in procs or display_proc):
                p = display_proc or procs[display_code]
                freq_raw = str(p.get('frequency_limit', '')).upper()
                is_not_covered = (
                    'NOT COVERED' in freq_raw
                    or str(p.get('benefit_level', '')).upper() == 'N/A'
                )
                is_unresolved_cigna = (
                    d.get('source_insurer') == 'cigna'
                    and display_code != 'D5860'
                    and p.get('_cigna_covered') is None
                )

                blank_cigna_d1510 = (
                    d.get('source_insurer') == 'cigna'
                    and display_code == 'D1510'
                    and (p.get('_cigna_covered') is False or is_not_covered)
                )

                if blank_cigna_d1510:
                    # Cigna business rule: an explicitly not-covered D1510 row
                    # keeps its label but leaves Frequency, Percentage,
                    # Deductible, Age Limit, and History completely blank.
                    freq = pct = deductible = age = hist = ''
                elif is_unresolved_cigna:
                    freq = pct = deductible = age = '-'
                    hist = '-' if display_code in HISTORY_CODES else ''
                elif is_not_covered:
                    freq = 'NC'
                    pct  = '0%'
                    deductible = 'N/A'
                    age  = ''
                    hist = ''
                else:
                    raw_frequency = p.get('frequency_limit', '—')
                    freq = _format_frequency(
                        raw_frequency,
                        compact=(
                            d.get('source_insurer') == 'cigna'
                            and display_code != 'D1351'
                        ),
                    )
                    if (
                        d.get('source_insurer') == 'cigna'
                        and _cigna_frequency_is_unavailable(raw_frequency)
                    ):
                        freq = 'No Frequency'
                    pct  = p.get('benefit_level', '—')

                    raw_deductible = str(p.get('deductible', '')).strip().upper()
                    deductible = raw_deductible if raw_deductible in ['YES', 'NO'] else ''

                    AGE_LIMIT_CODES = {'D1206', 'D1208', 'D1351', 'D1510', 'D8010', 'D8080', 'D8090'}
                    raw_age = str(p.get('age_limit', '')).strip()
                    if display_code in AGE_LIMIT_CODES or d.get('source_insurer') == 'cigna':
                        m = re.search(r'(\d+)\s*[-–]\s*(\d+)', raw_age)
                        if m:
                            age = m.group(2)
                        else:
                            m2 = re.search(r'under\s*(\d+)', raw_age, re.IGNORECASE)
                            m3 = re.search(
                                r'(?:exclude|excluded)\s+after\s+age\s*(\d+)',
                                raw_age,
                                re.IGNORECASE,
                            )
                            age = (
                                m2.group(1) if m2 else
                                m3.group(1) if m3 else
                                raw_age
                            )
                        if (
                            d.get('source_insurer') == 'cigna'
                            and display_code in ORTHO_AGE_CODES
                            and p.get('_cigna_covered') is True
                            and str(age).strip().lower() in ('', '-', '—', 'n/a', 'na', 'none')
                        ):
                            age = str(d.get('ortho_age_limit_llm') or '').strip()
                        elif (
                            d.get('source_insurer') != 'cigna'
                            and display_code in ORTHO_AGE_CODES
                            and str(age).strip() in ('99', '999')
                        ):
                            age = ''
                    else:
                        age = ''

                    if display_code in HISTORY_CODES:
                        hist_raw = p.get('late_date_of_service', 'NH')
                        if not hist_raw:
                            hist_raw = (
                                'NH'
                            )
                        hist = _format_history_dates(hist_raw) or str(hist_raw).strip()
                        if hist == '—':
                            hist = 'NH'
                    else:
                        hist = ''

                if d.get('source_insurer') == 'cigna' and not blank_cigna_d1510:
                    if str(freq).strip() in ('', '—'):
                        freq = '-'
                    if str(pct).strip() in ('', '—'):
                        pct = '-'
                    if str(deductible).strip() in ('', '—'):
                        deductible = '-'
                    if str(age).strip() in ('', '—'):
                        age = '' if display_code in ORTHO_AGE_CODES else '-'
                    if display_code in HISTORY_CODES and str(hist).strip() in ('', '—'):
                        hist = 'NH' if display_code in HISTORY_CODES else '-'
                    elif display_code not in HISTORY_CODES:
                        hist = ''

                hist_color = DARK
            else:
                if d.get('source_insurer') == 'cigna':
                    freq = pct = deductible = age = '-'
                    hist = 'NH' if display_code in HISTORY_CODES else ''
                else:
                    freq = pct = deductible = age = hist = ''
                hist_color = GREY

            if d.get('source_insurer') == 'cigna' and display_code in ORTHO_AGE_CODES:
                proc_covered = (p.get('_cigna_covered') if display_code and display_code in procs else None)
                if proc_covered is False:
                    age = ''
                elif proc_covered is True and str(age).strip().lower() in (
                    '', '-', '—', 'n/a', 'na', 'none'
                ):
                    age = str(d.get('ortho_age_limit_llm') or '').strip()
                elif proc_covered is None:
                    age = ''

            rows.append([
                _table_text(display_label, col_w[0] - 8, 'LEFT',   DARK),
                _table_text(freq,       col_w[1] - 8, 'CENTER', TEAL),
                _table_text(pct,        col_w[2] - 8, 'CENTER', TEAL),
                _table_text(deductible, col_w[3] - 8, 'CENTER', TEAL),
                _table_text(age,        col_w[4] - 8, 'CENTER', TEAL),
                _table_text(hist,       col_w[5] - 8, 'CENTER', hist_color),
            ])
            bg = colors.HexColor('#f8fcfe') if alt else WHITE
            xstyle += [
                ('BACKGROUND', (0, ri), (-1, ri), bg),
                ('TEXTCOLOR',  (5, ri), (5,  ri), hist_color),
            ]
            alt = not alt

    base = [
        ('BACKGROUND',    (0, 0), (-1, 0),  TEAL),
        ('TEXTCOLOR',     (0, 0), (-1, 0),  WHITE),
        ('FONTNAME',      (0, 0), (-1, 0),  'Helvetica-Bold'),
        ('FONTSIZE',      (0, 0), (-1, 0),  8.5),
        ('ALIGN',         (1, 0), (-1, 0),  'CENTER'),
        ('VALIGN',        (0, 0), (-1, -1), 'MIDDLE'),
        ('FONTNAME',      (0, 1), (-1, -1), 'Helvetica'),
        ('FONTSIZE',      (0, 1), (-1, -1), 7.5),
        ('ALIGN',         (1, 1), (-1, -1), 'CENTER'),
        ('ALIGN',         (0, 1), (0, -1),  'LEFT'),
        ('TEXTCOLOR',     (1, 1), (-1, -1), TEAL),
        ('TEXTCOLOR',     (0, 1), (0, -1),  DARK),
        ('GRID',          (0, 0), (-1, -1), 0.4, BORDER),
        ('TOPPADDING',    (0, 0), (-1, -1), 4),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
        ('LEADING',       (0, 0), (-1, -1), 8),
        ('LEFTPADDING',   (0, 0), (-1, -1), 4),
        ('RIGHTPADDING',  (0, 0), (-1, -1), 3),
    ]

    tbl = Table(rows, colWidths=col_w, repeatRows=1)
    tbl.setStyle(TableStyle(base + xstyle))
    return tbl


def _draw_page2_header(c, page_num, total_pages):
    _filled_rect(c, 0, 0, W, 30, fill=TEAL)
    _txt(c, MARGIN,      22, 'General Benefit Details', 'Helvetica-Bold', 11, WHITE)
    _rtxt(c, W - MARGIN, 22, 'Powered By iSpace',       'Helvetica-Oblique', 8, colors.HexColor('#c0e8f5'))
    _footer(c, page_num, total_pages)


def _page2(c, d, start_page, total_pages):
    tbl = _build_benefit_table(d)
    top_margin = 36
    bot_margin = 95
    avail_h    = H - top_margin - bot_margin

    w, h = tbl.wrapOn(c, CW, avail_h)

    if h <= avail_h:
        _draw_page2_header(c, start_page, total_pages)
        tbl.drawOn(c, MARGIN, H - top_margin - h)
    else:
        tbl.repeatRows = 1
        frags = tbl.split(CW, avail_h)
        for i, frag in enumerate(frags):
            if i > 0:
                c.showPage()
            _draw_page2_header(c, start_page + i, total_pages)
            fw, fh = frag.wrapOn(c, CW, avail_h)
            frag.drawOn(c, MARGIN, H - top_margin - fh)


# ═══════════════════════════════════════════════════════════════════════════════
#  SHARED OUTPUT DEFAULTS
# ═══════════════════════════════════════════════════════════════════════════════

_FINANCIAL_OUTPUT_KEYS = (
    'yearly_max', 'yearly_rem',
    'indiv_ded', 'indiv_ded_paid',
    'family_ded', 'family_ded_paid',
    'ortho_ded', 'ortho_ded_paid',
    'ortho_max', 'ortho_max_paid',
)


def _finalize_shared_output(data):
    """Apply carrier-independent display rules immediately before rendering."""
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

    # All carriers: an active/unknown term date is intentionally blank.
    data['term_date'] = _blank_present_end_date(data.get('term_date'))

    if str(data.get('waiting_period') or '').strip().lower() in (
        '', '-', '—', 'n/a', 'na', 'none'
    ):
        data['waiting_period'] = 'No'
        data['waiting_period_mo'] = '0'
        data['applies_to'] = ''
    elif str(data.get('waiting_period')).strip().lower() == 'no':
        data['waiting_period'] = 'No'
        if str(data.get('waiting_period_mo') or '').strip().lower() in (
            '', '-', '—', 'n/a', 'na', 'none'
        ):
            data['waiting_period_mo'] = '0'

    dep_age_raw = str(data.get('dep_age_limit') or '').strip()
    dep_age_normalized = dep_age_raw.lower()
    dep_age_number = re.search(r'\b(\d+)\b', dep_age_raw)
    if (
        dep_age_normalized in (
            '', '-', '—', 'n/a', 'na', 'none', 'null',
            'not available', 'not applicable'
        )
        or (dep_age_number and dep_age_number.group(1) in ('99', '999'))
    ):
        # Shared business rule for every carrier: no real dependent-age
        # limit (including sentinel 99/999) is displayed as NAL.
        data['dep_age_limit'] = 'NAL'

    if str(data.get('molars_only_sealants') or '').strip().lower() in (
        '-', '—', 'n/a', 'na', 'none'
    ):
        data['molars_only_sealants'] = ''

    ortho_age_raw = str(data.get('ortho_age_limit_llm') or '').strip()
    ortho_age_text = ortho_age_raw.lower()
    if data.get('source_insurer') == 'metlife':
        # MetLife output must contain only the numeric age (e.g. 26), with
        # descriptive text such as "End Of Month" removed.
        ages = [int(x) for x in re.findall(r'\b(\d{1,3})\b', ortho_age_raw)]
        data['ortho_age_limit_llm'] = str(max(ages)) if ages else ''
    elif ortho_age_text in ('-', '—', 'n/a', 'na', 'none'):
        data['ortho_age_limit_llm'] = ''
    elif data.get('source_insurer') != 'cigna' and ortho_age_text in ('99', '999'):
        data['ortho_age_limit_llm'] = ''

    data['appointment_date'] = datetime.now(
        timezone(timedelta(hours=5, minutes=30))
    ).strftime('%m/%d/%Y %I:%M %p')

    pre_auth = str(data.get('pre_auth') or '').replace('$', '')
    data['pre_auth'] = pre_auth or '-'
    return data


# ═══════════════════════════════════════════════════════════════════════════════
#  MAIN ENTRY POINT
# ═══════════════════════════════════════════════════════════════════════════════

def generate_new_plan_pdf(
    portal_raw:   dict,
    denticon_raw: dict,
    ins_override: dict = None,
) -> bytes:
    """
    Build and return PDF bytes for an Insurance Plan Breakdown.

    Parameters
    ----------
    portal_raw   : full Portal JSON (contains metlife_data, benefit_coverage …)
    denticon_raw : Denticon JSON used only for the Office Information block
    ins_override : optional dict from the UI modal:
                     'insName'      → overrides ins_name  (Insurance Name on PDF)
                     'feeSchedule'  → overrides fee_schedule
                     'relationship' → overrides Relation to Subscriber
                     'providerNetworkStatus' / 'provider_network_status'
                                    → overrides Provider Network Status (PPO/IN/OUT)
    """
    print("PDF FUNCTION STARTED")

    data = _extract(portal_raw, denticon_raw)

    # ── Apply UI modal overrides — these always win over auto-extracted values ──
    if ins_override:
        ins_name = (ins_override.get('insName') or '').strip()
        fee_sch  = (ins_override.get('feeSchedule') or '').strip()
        rel      = (ins_override.get('relationship') or '').strip()
        provider_network_status = (
            ins_override.get('providerNetworkStatus')
            or ins_override.get('provider_network_status')
            or ''
        ).strip()

        if ins_name:
            data['ins_name'] = ins_name
            print(f"[override] ins_name     → {ins_name}")

        if fee_sch:
            data['fee_schedule'] = fee_sch
            print(f"[override] fee_schedule → {fee_sch}")

        if rel:
            data['relationship'] = rel
            # Cigna must reflect only a family accumulator explicitly returned
            # by the selected network.
            if data.get('source_insurer') != 'cigna':
                data['family_ded'] = _family_deductible_v2(
                    fam_total_raw   = data.get('family_ded',  ''),
                    indiv_total_raw = data.get('indiv_ded',   ''),
                    relationship    = rel,
                )
            print(f"[override] relationship → {rel}")

        if provider_network_status:
            normalized_status = provider_network_status.upper()
            if normalized_status in ('PPO', 'IN', 'OUT'):
                data['network_status'] = normalized_status
            else:
                data['network_status'] = provider_network_status
            print(f"[override] provider network status → {data['network_status']}")

    data = _finalize_shared_output(data)

    print("FINAL DATA (after overrides):")
    for k, v in data.items():
        if k != 'procs':
            print(f"  {k}: {v}")

    buf = io.BytesIO()
    c   = canvas.Canvas(buf, pagesize=letter)

    _tbl     = _build_benefit_table(data)
    avail    = H - 72
    _, tbl_h = _tbl.wrapOn(c, CW, avail)
    extra_pages = max(1, int(tbl_h // avail) + (1 if tbl_h % avail else 0))
    total_pages = 1 + extra_pages

    _page1(c, data, total_pages)
    c.showPage()
    _page2(c, data, start_page=2, total_pages=total_pages)

    c.save()
    return buf.getvalue()


# ═══════════════════════════════════════════════════════════════════════════════
#  DOWNLOAD FILENAME HELPERS
# ═══════════════════════════════════════════════════════════════════════════════

def _safe_pdf_filename(value: str, fallback: str = 'Insurance_Plan.pdf') -> str:
    """Return a safe, basename-only ASCII PDF filename."""
    raw = str(value or '').strip().replace('\\', '/').split('/')[-1]
    if not raw:
        raw = fallback

    stem = re.sub(r'(?i)\.pdf$', '', raw).strip()
    stem = re.sub(r'[^A-Za-z0-9._-]+', '_', stem)
    stem = re.sub(r'_+', '_', stem).strip('._-')
    if not stem:
        stem = re.sub(r'(?i)\.pdf$', '', fallback).strip() or 'Insurance_Plan'
    return f'{stem[:180]}.pdf'


def _filename_patient_name(portal_raw: dict) -> str:
    """Find the patient name across raw Aetna, Cigna, MetLife and parsed payloads."""
    raw = portal_raw if isinstance(portal_raw, dict) else {}
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


def _filename_carrier_name(portal_raw: dict) -> str:
    """Resolve a concise carrier label for the download filename."""
    raw = portal_raw if isinstance(portal_raw, dict) else {}
    source = str(raw.get('source') or '').lower()
    payer = raw.get('payer') if isinstance(raw.get('payer'), dict) else {}
    carrier = raw.get('carrier_information') if isinstance(raw.get('carrier_information'), dict) else {}
    names = ' '.join(str(v or '') for v in (
        source,
        payer.get('name'),
        carrier.get('name'),
        (raw.get('coverage_details') or {}).get('payer') if isinstance(raw.get('coverage_details'), dict) else '',
    )).lower()

    if _is_aetna_portal(raw) or 'aetna' in names:
        return 'Aetna'
    if _is_cigna_portal(raw) or 'cigna' in names or isinstance(raw.get('cigna_data'), dict):
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


def build_new_plan_pdf_filename(
    portal_raw: dict,
    download_filename: str = None,
) -> str:
    """Build the browser download name, unless an optional safe override is supplied."""
    if str(download_filename or '').strip():
        return _safe_pdf_filename(download_filename)

    patient = _filename_patient_name(portal_raw)
    carrier = _filename_carrier_name(portal_raw)
    run_date = datetime.now(
        timezone(timedelta(hours=5, minutes=30))
    ).strftime('%Y-%m-%d')
    return _safe_pdf_filename(
        f'{patient}_{carrier}_Insurance_Plan_{run_date}.pdf'
    )


def generate_new_plan_pdf_with_filename(
    portal_raw: dict,
    denticon_raw: dict,
    ins_override: dict = None,
    download_filename: str = None,
):
    """Return ``(pdf_bytes, filename)`` without changing the original PDF API."""
    pdf_bytes = generate_new_plan_pdf(
        portal_raw,
        denticon_raw,
        ins_override=ins_override,
    )
    filename = build_new_plan_pdf_filename(
        portal_raw,
        download_filename=download_filename,
    )
    return pdf_bytes, filename
