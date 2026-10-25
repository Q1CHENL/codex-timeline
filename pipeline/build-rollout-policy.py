"""Resolve the display policy from official rollout and public catalog evidence."""
from pathlib import Path
import hashlib
import json

from paths import DATA
research = json.loads((DATA / 'model-rollout-research.json').read_text())
history = json.loads((DATA / 'engine-model-catalog-history.json').read_text())
by_model = {row['id']: row for row in research['events']}
# A release announcement establishes availability, not every account's default.
# Later catalogs provide a stronger selection signal than the stale UI fallback.
selection = [
    ('gpt-5.2-codex', '2026-02-02', 'medium', 'ebbbee70'),
    ('gpt-5.3-codex', '2026-02-05', 'medium', 'd45ffd58'),
    ('gpt-5.4', '2026-03-05', 'medium', '316cf0e9'),
    ('gpt-5.5', '2026-04-23', 'medium', 'c10f95dd'),
    ('gpt-5.6-sol', '2026-07-09', 'low', '3380969a'),
    ('gpt-6-astra', '2026-09-04', 'low', 'a97cf1b7'),
    ('gpt-6.1-sol', '2026-09-29', 'low', 'b1e72963'),
]
events = []
for model, day, effort, prefix in selection:
    release = by_model[model]
    catalog = next(row for row in history if row['sha'].startswith(prefix))
    first = catalog['firstVisibleByPriority']
    assert first['slug'] == model and first['default_reasoning_level'] == effort
    evidence = list(release['sources']) + [{
        'url': catalog['url'], 'title': 'Public Codex model catalog',
        'sourceCommit': catalog['sha'], 'sourceCommittedAt': catalog['committedAt'],
        'sha256': catalog['sha256'], 'selection': first,
        'scope': 'Public source catalog; not an archived per-account service response',
    }]
    same_day_catalog = catalog['committedAt'][:10] <= day
    events.append({
        'id': model, 'effectiveAt': day + 'T00:00:00Z', 'datePrecision': 'day',
        'model': model, 'displayName': first['display_name'], 'reasoningEffort': effort,
        'basis': 'catalog-supported-reconstruction' if same_day_catalog else 'official-release-representative',
        # The model picker offers the catalog's visible models, each with its own reasoning levels.
        'catalogModels': [{'model': row['slug'], 'displayName': row['display_name'], 'description': row['description'],
                           'defaultReasoningEffort': row['default_reasoning_level'], 'reasoningEfforts': row['supported_reasoning_levels']}
                          for row in sorted(catalog['models'], key=lambda row: row['priority']) if row['visibility'] == 'list'],
        'historicalServiceDefaultVerified': False,
        'selectionRationale': ('Default-priority visible model in the public catalog; its application to the desktop rollout day is reconstructed.' if same_day_catalog else 'Contemporary representative from the official Codex availability date. A later catalog corroborates the model and effort, not this default-switch date.'),
        'accessScope': 'Eligible paid ChatGPT account; Astra September 4 availability was limited to specified paid plans.' if model == 'gpt-6-astra' else 'Eligible Codex users; availability may vary by account.',
        'evidence': evidence,
    })
policy = {
    'schemaVersion': 2,
    'policy': 'Reconstruct a contemporary Codex model selection from official availability dates and public catalog default priority. Use representative selections where desktop defaults cannot be verified. Historical server defaults are not claimed.',
    'dateConvention': 'Official rollout days are placed at midnight UTC for display. This is not a measured activation timestamp, nor the public source commit or CLI publication time.',
    'effortPolicy': 'Use the selected model catalog reasoning default (Medium through GPT-5.5, Low for GPT-5.6 Sol, GPT-6 Astra and GPT-6.1 Sol). Earlier availability-date use of later catalog effort is representative.',
    'events': events,
    'otherAvailableModels': [row for row in research['events'] if row['id'] == 'gpt-6-sol'],
    'selectionNotes': [
        'GPT-6 Sol was released September 22, but inspected catalogs prioritize Astra above Sol; it is not inserted as an assumed default switch.',
        'A desktop package may bundle an older catalog after a newer model rollout. The date-based reconstruction does not regress solely because that fallback catalog regressed.',
        'model/list metadata supplies the reconstructed selection to the original frontend. The isolated host fixture uses synthetic account data and a documented auth adapter per capture; it does not establish historical authentication or entitlement.',
    ],
    'evidenceFiles': ['model-rollout-research.json', 'engine-model-evidence.json', 'engine-model-catalog-history.json', 'engine-model-catalog-evidence.json'],
}
(DATA / 'model-rollout-policy.json').write_text(json.dumps(policy, indent=2, ensure_ascii=False) + '\n')
print(json.dumps({'events': [(row['effectiveAt'][:10], row['model'], row['reasoningEffort'], row['basis']) for row in events]}))
