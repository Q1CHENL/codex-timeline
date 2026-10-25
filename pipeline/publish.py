"""Copy the timeline page to dist/ once its captures are current and clean and verify.cjs passed on it."""
import hashlib
import json

from paths import DATA, DIST, REVISION_SOURCES

CAPTURES = {'dark': ('captures', 'capture-results.json'), 'light': ('captures-light', 'capture-results-light.json')}


def read(name):
    return json.loads((DATA / name).read_text())


states = read('timeline-catalog.json')
fixtures = read('model-fixtures.json')
html = (DATA / 'preview.html').read_bytes()
common_source = ''.join(path.read_text() for path in REVISION_SOURCES)

# Every capture is current and rendered without errors or unhandled requests.
for theme, (directory, ledger_name) in CAPTURES.items():
    ledger = read(ledger_name)
    for row in states:
        capture = ledger[row['captureId']]
        host = (DATA / 'renderers' / row['version'] / 'host.mjs').read_text()
        label = (theme, row['captureId'])
        assert capture['status'] == 'captured', (*label, 'not captured')
        fixture = json.dumps(fixtures[row['captureId']], ensure_ascii=False, separators=(',', ':'))
        assert capture['revision'] == hashlib.sha256((common_source + fixture + host + theme).encode()).hexdigest(), (*label, 'outdated capture')
        assert not (capture['errors'] or capture['failed'] or capture['unhandledHttpRequests'] or capture['unhandledMcpRequests']), (*label, 'render problems')
        assert not read(f'{directory}/{row["captureId"]}.json')['diagnostics']['warnings'], (*label, 'extraction warnings')

# verify/verify.cjs passed against this exact page.
verification = read('verification.json')
assert verification['htmlSha256'] == hashlib.sha256(html).hexdigest(), 'run verify/verify.cjs on this build'
assert not (verification['errors'] or verification['external'] or verification['failures'])

DIST.mkdir(exist_ok=True)
target = DIST / 'codex-timeline.html'
temporary = target.with_name(target.name + '.tmp')
temporary.write_bytes(html)
temporary.replace(target)
print(json.dumps({'output': str(target), 'bytes': len(html), 'timelineStates': len(states), 'scenesChecked': verification['scenesChecked']}))
