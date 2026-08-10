"""MetLife integration for the New Plan PDF pipeline."""

import re
from datetime import date, datetime

import carrier_router as cr

CARRIER_KEY = 'metlife'
PRESERVE_FAMILY_DED_ON_RELATIONSHIP_OVERRIDE = False


def matches(raw):
    if not isinstance(raw, dict):
        return False
    if isinstance(raw.get('metlife_data'), dict):
        return True
    carrier = raw.get('carrier_information') or raw.get('carrier_info') or {}
    provider = raw.get('provider_info') or {}
    names = []
    if isinstance(carrier, dict):
        names.append(carrier.get('name'))
    if isinstance(provider, dict):
        names.append(provider.get('provider_name'))
    return 'metlife' in ' '.join(str(x or '') for x in names).lower()


def _extract_metlife_ortho_age_limit(provisions):
    """Return the numeric child/student orthodontic age limit only.

    Use a real ``age`` word match so a rule such as ``Orthodontic Coverage``
    cannot qualify merely because the word ``coverage`` contains the letters
    ``age``. This also prevents the initial-placement percentage from being
    mistaken for an age limit.
    """
    candidates = []
    for p in provisions or []:
        rule = str(p.get('rule', '')).lower()
        if 'orthodont' not in rule or not re.search(r'\bage\b', rule):
            continue
        value = str(p.get('value', ''))
        explicit = [
            int(m.group(1))
            for m in re.finditer(
                r'(?:child|student)\s*:?\s*(\d+)',
                value,
                re.IGNORECASE,
            )
        ]
        if explicit:
            candidates.extend(explicit)
            continue

        # Fallback only inside a genuine orthodontic-age provision.
        candidates.extend(int(x) for x in re.findall(r'\b(\d{1,3})\b', value))
    return str(max(candidates)) if candidates else ''


def _metlife_missing_tooth_clause(provisions):
    """Resolve the ordinary MetLife missing-tooth clause, not congenital text.

    MetLife can put two answers in one provision: one for ordinary teeth lost
    before the effective date and another for congenital teeth. The PDF's
    ``Does Missing Tooth Clause Apply?`` field is controlled by the first one.
    """
    for item in provisions or []:
        if 'missing tooth' not in str(item.get('rule', '')).lower():
            continue
        value = str(item.get('value', ''))
        match = re.search(
            r'benefits\s+available\s+for\s+teeth\s+lost\s+prior\s+to\s+'
            r'effective\s+date\s*:\s*(yes|no)',
            value,
            re.IGNORECASE,
        )
        if match:
            # Benefits available = no restrictive missing-tooth clause.
            return 'No' if match.group(1).lower() == 'yes' else 'Yes'
    return '—'




def _patient_age_from_dob(value):
    raw = str(value or '').strip()
    for fmt in ('%m/%d/%Y', '%Y-%m-%d', '%m-%d-%Y'):
        try:
            dob = datetime.strptime(raw, fmt).date()
            today = date.today()
            return today.year - dob.year - ((today.month, today.day) < (dob.month, dob.day))
        except ValueError:
            pass
    return None


def _resolve_age_specific_frequencies(data):
    """Resolve MetLife dual child/adult frequency sentences for this patient.

    Example portal text:
      ``2 PER 1 CALENDAR YEAR(S) FOR PARTICIPANT TO AGE 19 ...,
      1 PER 1 CALENDAR YEAR(S) FOR ADULTS``

    The shared PDF formatter intentionally remains carrier-blind, so the
    MetLife adapter converts only these explicit dual-rate sentences to the
    frequency that applies to the current patient's age.
    """
    age = _patient_age_from_dob(data.get('patient_dob'))
    if age is None:
        return data

    procs = data.get('procs') or {}
    pattern = re.compile(
        r'\b(\d+)\s+(?:PER|EVERY)\s+(\d+)\s+'
        r'(?:CALENDAR\s+)?YEAR(?:S|\(S\))?\s+FOR\s+'
        r'PARTICIPANT\s+TO\s+AGE\s+(\d+).*?'
        r'\b(\d+)\s+(?:PER|EVERY)\s+(\d+)\s+'
        r'(?:CALENDAR\s+)?YEAR(?:S|\(S\))?\s+FOR\s+ADULTS',
        re.IGNORECASE,
    )

    for code, proc in list(procs.items()):
        if not isinstance(proc, dict):
            continue
        raw = str(proc.get('frequency_limit') or '')
        match = pattern.search(raw)
        if not match:
            continue

        child_count, child_years, cutoff, adult_count, adult_years = map(int, match.groups())
        if age <= cutoff:
            count, years = child_count, child_years
        else:
            count, years = adult_count, adult_years

        updated = dict(proc)
        noun = 'TIME' if count == 1 else 'TIMES'
        unit = 'YEAR' if years == 1 else 'YEARS'
        updated['_metlife_original_frequency_limit'] = raw
        updated['frequency_limit'] = f'{count} {noun} IN {years} CALENDAR {unit}'
        procs[code] = updated

    data['procs'] = procs
    return data


def extract(portal_raw, denticon_raw):
    data = cr._extract_common(portal_raw, denticon_raw, carrier_name_hint='MetLife')

    ml = portal_raw.get('metlife_data') or portal_raw
    bc = portal_raw.get('benefit_coverage') or {}
    provisions = ml.get('provisions', []) if isinstance(ml, dict) else []
    svcs = ml.get('covered_services', []) if isinstance(ml, dict) else []
    ml_pln = ml.get('plan_details', {}) if isinstance(ml.get('plan_details', {}), dict) else {}

    denticon_raw = denticon_raw or {}
    dent = denticon_raw.get('denticon_data') or denticon_raw
    dent_pi = dent.get('primary_insurance', {}) if isinstance(dent, dict) and isinstance(dent.get('primary_insurance', {}), dict) else {}

    procs = data.get('procs') or {}
    rule_interp = cr._rule_based_interp(portal_raw, procs)

    explicit_4910 = str(rule_interp.get('d4910_d1110_share_freq') or '').strip()
    if explicit_4910 in ('Yes', 'No'):
        data['d4910_d1110_share_freq'] = explicit_4910
    explicit_exam = str(rule_interp.get('d0120_d0150_share_d0140') or '').strip()
    if explicit_exam in ('Yes', 'No'):
        data['d0120_d0150_share_d0140'] = explicit_exam

    member_id = (
        cr._g(dent_pi, 'sub_id', 'subscriber_id', 'subscriberId', 'member_id', 'memberId', 'ssn', default='')
        or cr._g(ml_pln, 'subscriber_id', default='')
        or '—'
    )

    carrier = portal_raw.get('carrier_information') or portal_raw.get('carrier_info') or {}
    carrier_phone = cr._g(carrier, 'phone', default='')

    data.update({
        'source_insurer': 'metlife',
        'member_id': member_id,
        'ssn': member_id,
        'ins_name': '(IN) MetLife(TX)- PO Box 981282- 79998',
        'fee_schedule': 'METLIFE PPO',
        'ins_address': 'PO Box 981282, El Paso, TX 79998',
        'ins_phone': cr._clean_phone(carrier_phone) if carrier_phone else '8776383379',
        'payor_id': cr._g(carrier, 'payer_id', default='') or '65978',
        'plan_type': 'PPO',
        'elig_notes': 'ins: metlife, benefits verified online',
        'pre_auth': 'Recommended-300',
        'd4341_number_of_quads': 'Pre-D',
        'missing_tooth': _metlife_missing_tooth_clause(provisions),
        'pct_prev': (
            cr._procedure_benefit_pct(procs, 'D1110', 'D1120', 'D1206', 'D1351')
            or cr._covered_pct_max(svcs, 'PREVENTIVE')
            or cr._covered_pct(svcs, 'PREVENTIVE')
        ),
        'pct_basic': (
            cr._procedure_benefit_pct(procs, 'D2140', 'D2331', 'D4341', 'D3310')
            or cr._covered_pct_max(svcs, 'RESTORATIVE')
            or cr._covered_pct(svcs, 'RESTORATIVE', 'DIAGNOSTIC')
        ),
        'pct_major': (
            cr._procedure_benefit_pct(procs, 'D2740', 'D5110', 'D6010')
            or cr._covered_pct_max(svcs, 'PROSTHODONTICS', 'IMPLANT')
            or cr._covered_pct(svcs, 'PROSTHODONTICS', 'IMPLANT')
        ),
        'ortho_age_limit_llm': _extract_metlife_ortho_age_limit(provisions),
    })
    return _resolve_age_specific_frequencies(data)


def finalize(data):
    # MetLife output must contain only the numeric child/student ortho age.
    raw = str(data.get('ortho_age_limit_llm') or '').strip()
    ages = [int(x) for x in re.findall(r'\b(\d{1,3})\b', raw)]
    data['ortho_age_limit_llm'] = str(max(ages)) if ages else ''
    return data


def display_name(raw):
    return 'MetLife'


def filename_patient_name(raw):
    ml = raw.get('metlife_data') or raw
    patient = ml.get('patient') if isinstance(ml, dict) and isinstance(ml.get('patient'), dict) else {}
    return str(patient.get('name') or '').strip()



def editable_fields():
    """Expose only the MetLife SSN / Subscriber ID correction field."""
    return [
        {
            'key': 'ssn',
            'data_key': 'ssn',
            'label': 'SSN / Subscriber ID',
            'section': 'MetLife',
            'source': 'denticon_or_operator',
        }
    ]


def apply_overrides(data, overrides):
    """Allow only the MetLife subscriber identifier to override Denticon.

    A manual SSN / Subscriber ID must stay synchronized with ``member_id``.
    All other Denticon-owned fields remain authoritative in the shared router.
    """
    if not isinstance(overrides, dict):
        return data
    value = cr._override_value(
        overrides,
        'ssn', 'subscriberId', 'subscriber_id', 'memberId', 'member_id'
    )
    if value:
        data['ssn'] = value
        data['member_id'] = value
    return data
