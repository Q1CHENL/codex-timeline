"""Add versions published since the catalog was last updated to data/catalog.json.

Versions come from the official update feed and from the history of Homebrew's
casks, which also records releases the feed has already dropped. A version is
added only when an official package can be downloaded; when its arm64 package
is gone, the same release's x64 package is used.
"""
import json
import ssl
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

from paths import DATA

APPCAST = 'https://persistent.oaistatic.com/codex-app-prod/appcast.xml'
PACKAGES = 'https://persistent.oaistatic.com/codex-app-prod/'
SPARKLE = {'sparkle': 'http://www.andymatuschak.org/xml-namespaces/sparkle'}
CASKS = {'chatgpt': 'ChatGPT', 'codex-app': 'Codex'}
# python.org builds on macOS ship without system certificates; use the system bundle as fetch-versions.py does.
TLS = ssl.create_default_context(cafile='/etc/ssl/cert.pem')
# The package host rejects Python's default user agent.
HEADERS = {'User-Agent': 'curl/8.7.1'}


def get(url):
    request = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(request, timeout=30, context=TLS) as response:
        return response.read()


def exists(url):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, method='HEAD', headers=HEADERS), timeout=30, context=TLS) as response:
            return response.status == 200
    except urllib.error.HTTPError:
        return False


def iso(moment):
    return moment.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def from_appcast():
    for item in ET.fromstring(get(APPCAST)).iter('item'):
        yield {'version': item.find('sparkle:shortVersionString', SPARKLE).text, 'brand': 'ChatGPT',
               'indexedAt': iso(parsedate_to_datetime(item.find('pubDate').text)),
               'source': {'kind': 'official-appcast', 'url': APPCAST}}


def from_homebrew(since):
    for cask, brand in CASKS.items():
        url = f'https://api.github.com/repos/Homebrew/homebrew-cask/commits?path=Casks/c/{cask}.rb&since={iso(since)}&per_page=100'
        for commit in json.loads(get(url)):
            words = commit['commit']['message'].split()
            # Version bumps are titled "<cask> <version>".
            if len(words) >= 2 and words[0] == cask and words[1][:1].isdigit():
                yield {'version': words[1], 'brand': brand, 'indexedAt': commit['commit']['committer']['date'],
                       'source': {'kind': 'homebrew-commit', 'url': commit['html_url'], 'sha': commit['sha']}}


def main():
    path = DATA / 'catalog.json'
    catalog = json.loads(path.read_text())
    known = {row['version'] for row in catalog}
    latest = max(datetime.fromisoformat(row['indexedAt'].replace('Z', '+00:00')) for row in catalog)
    found = {}
    for record in [*from_appcast(), *from_homebrew(latest - timedelta(days=1))]:
        if record['version'] in known:
            continue
        entry = found.setdefault(record['version'], {'version': record['version'], 'brand': record['brand'], 'indexedAt': record['indexedAt'], 'sources': []})
        entry['indexedAt'] = min(entry['indexedAt'], record['indexedAt'])
        if record['source'] not in entry['sources']:
            entry['sources'].append(record['source'])
    added, missing = [], []
    for entry in sorted(found.values(), key=lambda row: row['indexedAt']):
        stem = f"{PACKAGES}{entry['brand']}-darwin-{{}}-{entry['version']}.zip"
        if exists(stem.format('arm64')):
            entry.update(archiveUrl=stem.format('arm64'), status='indexed')
        elif exists(stem.format('x64')):
            entry.update(archiveUrl=stem.format('x64'), status='indexed', architecture='x64', originalArm64Url=stem.format('arm64'),
                         archiveFallbackReason='The arm64 archive returns 404; the same release official x64 archive is available.')
        else:
            missing.append(entry['version'])
            continue
        catalog.append(entry)
        added.append(entry['version'])
    temporary = DATA / 'catalog.tmp.json'
    temporary.write_text(json.dumps(catalog, indent=2) + '\n')
    temporary.replace(path)
    print(json.dumps({'added': added, 'noDownloadablePackage': missing, 'versions': len(catalog)}))


if __name__ == '__main__':
    main()
