"""Assemble the standalone timeline player from verified scene records.

player.html holds the markup and three slots: player.css, the compressed
scene payload and player.js. The payload keeps only what the player
reads; prepared-data.json and the published evidence files keep the full record.
"""
import sys
from pathlib import Path
import base64
import gzip
import json
import re

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'pipeline'))
from paths import DATA, PLAYER
SLOTS = ('PLAYER_CSS', 'SCENE_DATA', 'PLAYER_JS')
TIMELINE_FIELDS = ('version', 'captureId', 'kind', 'date', 'archivedAt', 'sceneIndices', 'models')
# Image parts render from their captured `html`; these fields duplicate it.
UNRENDERED_PART_FIELDS = frozenset({'src', 'alt', 'objectFit', 'objectPosition'})


def validate(data):
    total = len(data['versions'])
    if data['coverage'].get('total') != total or data['coverage'].get('captured') != total:
        raise ValueError('combined coverage must verify both themes for every version')
    if data.get('timelineCoverage', {}).get('captured') != len(data.get('timeline', [])) or not data.get('timeline'):
        raise ValueError('complete model rollout states are required')
    for theme, value in data['themes'].items():
        if value['coverage'].get('captured') != total or value['coverage'].get('unavailable') != 0:
            raise ValueError(f'{theme}: incomplete theme coverage')
        for version in data['timeline']:
            index = version.get('sceneIndices', {}).get(theme)
            if not isinstance(index, int) or not 0 <= index < len(value['scenes']):
                raise ValueError(f"{theme}/{version['version']}: invalid scene index")
        for scene in value['scenes']:
            for part in scene['parts']:
                if part['kind'] in ('img', 'svg', 'text') and part.get('html') is None:
                    raise ValueError(f"{theme}/{part['key']}: {part['kind']} part has no captured markup")
    for version in data['timeline']:
        if not version.get('archivedAt'):
            raise ValueError(f"{version['version']}: missing archive timestamp")


def player_payload(data):
    """Project prepared data onto the player's contract (see the typedefs in player.js).

    Captured markup repeats heavily across scenes (one sidebar icon set can be
    ~58 KB and appear in dozens of scenes), beyond gzip's 32 KB window.
    prepare-scenes.py stores each distinct string once, with its style
    attributes numbered into shared `styles` and `declarations`, and parts refer
    to it by index; here it becomes `assets`.
    """
    def project(part):
        return {key: item for key, item in part.items() if key not in UNRENDERED_PART_FIELDS}

    # State parts are [look, x, y, z]: prepare-scenes.py stores each distinct look
    # once, since the same tooltip or menu recurs in many layouts, shifted.
    looks = [project(look) for look in data['looks']]
    # Every state goes in one table, referred to by index, its parts as columns:
    # alike values sit together, which gzip's 32 KB window compresses far better
    # than parts interleaved with the controls they belong to.
    states = {'counts': [], 'hide': [], 'look': [], 'x': [], 'y': [], 'z': []}

    def state(change):
        if not change:
            return None
        for column, value in zip(('look', 'x', 'y', 'z'), zip(*change['parts'])):
            states[column].extend(value)
        states['counts'].append(len(change['parts']))
        states['hide'].append(change['hide'])
        return len(states['counts']) - 1

    def editor(value):
        return value and {'rect': value['rect'], 'text': project(value['text']), 'typed': state(value['typed'])}

    def submenus(items):
        return [{'rect': item['rect'], 'by': item['by'], 'panel': item['panel'], 'state': state(item['state']), 'submenus': submenus(item['submenus'])} for item in items]

    def control(value):
        projected = {**value, 'hover': state(value['hover'])}
        if value.get('open'):
            projected['open'] = {'panel': value['open']['panel'], 'state': state(value['open']), 'submenus': submenus(value['open']['submenus'])}
        return projected

    def layout(value):
        return {'state': state(value['state']), 'controls': [control(item) for item in value['controls']], 'editor': editor(value['editor'])}

    themes = {}
    for theme, value in data['themes'].items():
        scenes = []
        for scene in value['scenes']:
            projected = {'background': scene['background'], 'parts': [project(part) for part in scene['parts']]}
            # Recorded layouts, with their hover, open, toggle and typing states (capture-states.cjs).
            if scene.get('layouts'):
                projected['layouts'] = [layout(value) for value in scene['layouts']]
            scenes.append(projected)
        themes[theme] = {'scenes': scenes}
    return {
        'versionCount': len(data['versions']),
        'timeline': [{field: row[field] for field in TIMELINE_FIELDS} for row in data['timeline']],
        'themes': themes,
        'states': states,
        'looks': looks,
        'assets': data['markup'],
        'styles': data['styles'],
        'declarations': data['declarations'],
    }


def build(root=DATA):
    root = Path(root)
    data = json.loads((root / 'prepared-data.json').read_text())
    target = root / 'preview.html'
    if set(data.get('themes', {})) != {'dark', 'light'} or data.get('coverage', {}).get('unavailable') != 0:
        return {'built':False, 'reason':'Complete dual-theme data is not ready; the existing preview is unchanged.'}
    validate(data)
    projected = player_payload(data)
    payload = json.dumps(projected, ensure_ascii=False, separators=(',', ':')).encode()
    encoded = base64.b64encode(gzip.compress(payload, compresslevel=9, mtime=0)).decode()
    template = (PLAYER / 'player.html').read_text()
    for slot in SLOTS:
        if template.count(f'__{slot}__') != 1:
            raise ValueError(f'player template must contain exactly one __{slot}__ slot')
    script = (PLAYER / 'player.js').read_text()
    if '</script' in script.lower():
        raise ValueError('player.js cannot be inlined: it contains a closing script tag')
    content = {
        'PLAYER_CSS': (PLAYER / 'player.css').read_text().rstrip('\n'),
        'SCENE_DATA': encoded,
        'PLAYER_JS': script.rstrip('\n'),
    }
    # One pass, so inserted content is never scanned for slot names.
    page = re.sub(r'__(' + '|'.join(SLOTS) + r')__', lambda match: content[match.group(1)], template)
    temporary = target.with_suffix('.tmp.html')
    temporary.write_text(page)
    temporary.replace(target)
    return {'built':True, 'file':str(target), 'bytes':len(page.encode()), 'payloadBytes':len(payload), 'assets':len(projected['assets']),
        'versions':len(data['versions']), 'scenes':{theme:len(value['scenes']) for theme, value in data['themes'].items()}, 'coverage':data['coverage']}


if __name__ == '__main__':
    print(json.dumps(build()))
