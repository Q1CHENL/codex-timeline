"""Merge archived app releases with independently dated model configuration changes."""
from datetime import datetime, timezone
from pathlib import Path
import hashlib
import json
import re

from paths import DATA


def timestamp(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(timezone.utc)


def build(root=DATA):
    catalog = json.loads((root / 'catalog.json').read_text())
    policy = json.loads((root / 'model-rollout-policy.json').read_text())
    events = sorted(policy['events'], key=lambda row: timestamp(row['effectiveAt']))
    catalog.sort(key=lambda row: timestamp(row['archivedAt']))
    if not catalog or len({row['version'] for row in catalog}) != len(catalog):
        raise ValueError('Package catalog must be nonempty with unique versions')
    if not events or timestamp(events[0]['effectiveAt']) > timestamp(catalog[0]['archivedAt']):
        raise ValueError('Model policy must cover the first archived package')
    if len({row['id'] for row in events}) != len(events):
        raise ValueError('Duplicate model event ID')
    if len({timestamp(row['effectiveAt']) for row in events}) != len(events):
        raise ValueError('Model events must have distinct effective dates')
    for event in events:
        if not re.fullmatch(r'[a-zA-Z0-9._-]+', event['id']):
            raise ValueError('Unsafe model event ID')
        if not all(event.get(key) for key in ('model', 'displayName', 'reasoningEffort', 'basis', 'evidence', 'datePrecision')):
            raise ValueError('Model event lacks evidence or configuration')
        instant = timestamp(event['effectiveAt'])
        if event['datePrecision'] == 'day' and any((instant.hour, instant.minute, instant.second, instant.microsecond)):
            raise ValueError('Day-precision events must use the explicit UTC day boundary')
    states = []
    for release in catalog:
        event = max((row for row in events if timestamp(row['effectiveAt']) <= timestamp(release['archivedAt'])), key=lambda row: timestamp(row['effectiveAt']))
        states.append({**release, 'captureId': release['version'], 'kind': 'release',
                       'packageArchivedAt': release['archivedAt'], 'dateSource': 'Official archive timestamp', 'modelEvent': event})
    for event in events:
        instant = timestamp(event['effectiveAt'])
        if not timestamp(catalog[0]['archivedAt']) < instant <= timestamp(catalog[-1]['archivedAt']):
            continue
        release = max((row for row in catalog if timestamp(row['archivedAt']) <= instant), key=lambda row: timestamp(row['archivedAt']))
        # An event simultaneous with an actual release is represented by that release.
        if timestamp(release['archivedAt']) == instant:
            continue
        states.append({**release, 'captureId': 'model-' + event['id'], 'kind': 'model',
                       'packageArchivedAt': release['archivedAt'], 'archivedAt': event['effectiveAt'],
                       'datePrecision': event['datePrecision'], 'dateSource': 'Model rollout date (UTC day)' if event['datePrecision'] == 'day' else 'Model rollout timestamp',
                       'modelEvent': event})
    states.sort(key=lambda row: (timestamp(row['archivedAt']), row['captureId']))
    fixtures = {}
    for state in states:
        event = state['modelEvent']
        fixtures[state['captureId']] = {key: event[key] for key in ('model', 'displayName', 'reasoningEffort', 'basis', 'catalogModels')}
        fixtures[state['captureId']].update(eventId=event['id'], effectiveAt=event['effectiveAt'],
            datePrecision=event['datePrecision'], historicalServiceDefaultVerified=event.get('historicalServiceDefaultVerified', False),
            evidenceSha256=hashlib.sha256(json.dumps(event['evidence'], sort_keys=True, separators=(',', ':')).encode()).hexdigest())
    # The catalog's model list belongs to each capture's fixture; timeline rows keep the rest of their event.
    rows = [{**state, 'modelEvent': {key: item for key, item in state['modelEvent'].items() if key != 'catalogModels'}} for state in states]
    for name, value in [('timeline-catalog.json', rows), ('model-fixtures.json', fixtures)]:
        temporary = root / (name + '.tmp')
        temporary.write_text(json.dumps(value, indent=2) + '\n')
        temporary.replace(root / name)
    return {'packages': len(catalog), 'timelineStates': len(states), 'modelEvents': sum(row['kind'] == 'model' for row in states)}


if __name__ == '__main__':
    print(json.dumps(build()))
