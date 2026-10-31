import hashlib, json, sys, tarfile
from pathlib import Path

RESEARCH = Path('/Users/vaiditya/dev/unmask-research')
LABELS = RESEARCH / 'fixtures/labels/triage-labels.dev.v2.1.json'
LABELS_SHA = 'fd6ac97b52277bc6185a081f57c256e0ecfba98526518421059f177d920d16da'
RULES = RESEARCH / 'fixtures/labels/SCORING_RULES.v19.txt'
RULES_SHA = 'd03ac96459fea2adcf64d281b52894e43e57f1e3d99483fb2b658288d4b7454f'
SELECTED = ['V1', 'V4', 'V5', 'V6', 'V7']
CATEGORIES = {'review-concern', 'possible-transformation', 'unknown'}

def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def fail(message):
    raise SystemExit('SCORER STRUCTURE ERROR: ' + message)

def member_bytes(tarball, path):
    with tarfile.open(tarball, 'r:gz') as archive:
        for member in archive.getmembers():
            name = member.name.split('/', 1)[1] if '/' in member.name else member.name
            if name == path and member.isfile():
                return archive.extractfile(member).read()
    fail('path not found in variant tarball: ' + path)

def planted_positions(label, manifest_item):
    span = label['ground_truth_span']
    if span['variant_length'] == 0:
        return 'source', set(), True
    data = member_bytes(manifest_item['variant_tarball'], label['path'])
    start = span['variant_offset']
    chunk = data[start:start + span['variant_length']]
    positions = {start + i for i, b in enumerate(chunk) if b not in b' \t\r\n'}
    return 'artifact', positions, not positions

def quote_range(evidence, quote):
    excerpt = evidence.get('excerpt')
    excerpt_range = evidence.get('excerptRange')
    if not isinstance(excerpt, str) or not isinstance(excerpt_range, list) or len(excerpt_range) != 2:
        fail('evidence entry lacks excerpt/excerptRange: ' + str(evidence.get('id')))
    raw = excerpt.encode('utf-8')
    needle = quote.encode('utf-8')
    if not needle or raw.count(needle) != 1:
        return None
    offset = raw.find(needle)
    return excerpt_range[0] + offset, excerpt_range[0] + offset + len(needle)

def paired_ok(hypothesis, groups, evidence_by_id):
    cited = [c.get('evidenceId') for c in hypothesis.get('citations', [])]
    sides = {evidence_by_id[i]['side'] for i in cited if i in evidence_by_id}
    if not {'artifact', 'source'} <= sides:
        return False
    return any(g.get('paired') is True and set(cited) <= set(g.get('evidenceIds', [])) for g in groups)

def credited_labels(hypothesis, labels, evidence_by_id):
    hits = set()
    for citation in hypothesis.get('citations', []):
        evidence = evidence_by_id.get(citation.get('evidenceId'))
        if evidence is None or not isinstance(citation.get('quote'), str):
            continue
        located = quote_range(evidence, citation['quote'])
        if located is None:
            continue
        for key, info in labels.items():
            if evidence['side'] == info['side'] and evidence['path'] == info['path'] and any(located[0] <= p < located[1] for p in info['positions']):
                hits.add(key)
    return hits

def b1_category(info, report, evidence_by_id):
    linked = []
    for item in report.get('cues', []) + report.get('policy', {}).get('findings', []):
        linked.extend(item.get('evidenceIds') or [])
    for evidence_id in linked:
        evidence = evidence_by_id.get(evidence_id)
        if evidence and evidence['side'] == info['side'] and evidence['path'] == info['path']:
            start, end = evidence['range']
            if any(start <= p < end for p in info['positions']):
                return 'review-concern'
    for group in (report.get('model') or {}).get('evidenceGroups', []):
        if group.get('paired') is not True:
            continue
        for evidence_id in group.get('evidenceIds', []):
            evidence = evidence_by_id.get(evidence_id)
            if evidence and evidence['side'] == info['side'] and evidence['path'] == info['path']:
                start, end = evidence['range']
                if any(start <= p < end for p in info['positions']):
                    return 'possible-transformation'
    return 'unknown'

def score(run_path):
    assert sha(LABELS) == LABELS_SHA and sha(RULES) == RULES_SHA, 'frozen inputs changed'
    run = json.loads(Path(run_path).read_text())
    manifest = {f['id']: f for f in json.loads((RESEARCH / 'fixtures/MANIFEST.json').read_text())['fixtures']}
    labels_doc = json.loads(LABELS.read_text())
    reports = {r['id']: r for r in run['results']}
    out = {'run': str(run_path), 'scorer_sha256': sha(__file__), 'labels_sha256': LABELS_SHA, 'rules_sha256': RULES_SHA, 'fixtures': {}, 'unscorable': [], 'notes': ['BENIGN-5/6 duplicate V7 spans and are counted once as V7 labels', 'Axios reference XHR samples and V8 are outside this pre-registered run']}
    totals = {}
    for fixture in SELECTED:
        entry = reports.get(fixture)
        labels = {}
        for label in labels_doc['planted_hunks']:
            if label['fixture_id'] != fixture or not label.get('in_scope', True):
                continue
            side, positions, unscorable = planted_positions(label, manifest[fixture])
            if unscorable:
                out['unscorable'].append(label['hunk_id'])
            labels[label['hunk_id']] = {'side': side, 'path': label['path'], 'positions': positions, 'expected': label['expected_category'], 'alternatives': label.get('acceptable_alternatives', [])}
        report = json.loads(Path(entry['report']).read_text()) if entry and entry.get('report') and Path(entry['report']).exists() else None
        model = (report or {}).get('model') or {}
        evidence_by_id = {e['id']: e for e in (report or {}).get('evidence', [])}
        tier = None
        log = model.get('attemptLog') or []
        if log:
            tier = str(log[-1].get('modelId')) + '/' + str((log[-1].get('generationConfig') or {}).get('thinkingConfig', {}).get('thinkingLevel'))
        predictions = {key: set() for key in labels}
        for hypothesis in model.get('hypotheses') or []:
            category = hypothesis.get('category')
            if category not in CATEGORIES:
                fail('unknown category ' + repr(category))
            if category == 'possible-transformation' and not paired_ok(hypothesis, model.get('evidenceGroups') or [], evidence_by_id):
                category = 'unknown'
            for key in credited_labels(hypothesis, labels, evidence_by_id):
                predictions[key].add(category)
        rows = {}
        for key, info in labels.items():
            found = predictions[key]
            model_cat = None if not found else (next(iter(found)) if len(found) == 1 else 'unknown')
            b1 = b1_category(info, report or {}, evidence_by_id) if report else 'unknown'
            rows[key] = {'expected': info['expected'], 'model': model_cat or 'miss', 'b1': b1, 'localized': model_cat is not None, 'model_hit': model_cat == 'review-concern' and info['expected'] == 'review-concern', 'b1_hit': b1 == 'review-concern' and info['expected'] == 'review-concern', 'model_false_alarm': info['expected'] != 'review-concern' and model_cat == 'review-concern', 'b1_false_alarm': info['expected'] != 'review-concern' and b1 == 'review-concern'}
        out['fixtures'][fixture] = {'model_status': model.get('status'), 'producing_tier': tier, 'promptHash': model.get('promptHash'), 'configHash': model.get('configHash'), 'labels': rows}
        bucket = totals.setdefault(tier or 'no-model-output', {'risk_positive': 0, 'model_hits': 0, 'b1_hits': 0, 'all_labels': 0, 'model_localized': 0, 'benign': 0, 'model_false_alarms': 0, 'b1_false_alarms': 0})
        for row in rows.values():
            bucket['all_labels'] += 1
            bucket['model_localized'] += row['localized']
            if row['expected'] == 'review-concern':
                bucket['risk_positive'] += 1
                bucket['model_hits'] += row['model_hit']
                bucket['b1_hits'] += row['b1_hit']
            else:
                bucket['benign'] += 1
                bucket['model_false_alarms'] += row['model_false_alarm']
                bucket['b1_false_alarms'] += row['b1_false_alarm']
    for bucket in totals.values():
        bucket['risk_positive_recall_delta_model_minus_b1'] = bucket['model_hits'] - bucket['b1_hits']
        bucket['false_alarm_delta_model_minus_b1'] = bucket['model_false_alarms'] - bucket['b1_false_alarms']
    out['per_tier_totals_never_pooled'] = totals
    return out

if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('usage: python3 -I score_model_gate.py <RUN.json>')
    print(json.dumps(score(sys.argv[1]), indent=2))
