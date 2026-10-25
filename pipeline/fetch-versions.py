"""Fetch the ASAR member of public ZIPs, validate CRC, and deduplicate renderer files."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import plistlib
import struct
import ssl
import time
import urllib.request
import zipfile
import zlib

from paths import DATA
PREFIX = 'https://persistent.oaistatic.com/codex-app-prod/'


def request(url, **kwargs):
    if not url.startswith(PREFIX):
        raise ValueError('Unexpected archive source')
    kwargs['headers'] = {'User-Agent': 'curl/8.7.1', **kwargs.get('headers', {})}
    return urllib.request.urlopen(urllib.request.Request(url, **kwargs), timeout=90,
                                  context=ssl.create_default_context(cafile='/etc/ssl/cert.pem'))


class RemoteZip(io.RawIOBase):
    def __init__(self, url):
        self.url, self.position, self.bytes_received = url, 0, 0
        with request(url, method='HEAD') as response:
            self.length = int(response.headers['Content-Length'])
            self.modified = response.headers.get('Last-Modified')
        self.cache_start = max(0, self.length - 1024 * 1024)
        self.cache = self.range(self.cache_start, self.length - 1).read()
        self.bytes_received += len(self.cache)

    def range(self, start, end):
        response = request(self.url, headers={'Range': f'bytes={start}-{end}'})
        if response.status != 206 or response.headers.get('Content-Range') != f'bytes {start}-{end}/{self.length}':
            response.close()
            raise ValueError('Server did not honor the bounded range request')
        return response

    def seek(self, offset, whence=0):
        self.position = offset if whence == 0 else self.position + offset if whence == 1 else self.length + offset
        return self.position

    def tell(self):
        return self.position

    def read(self, size=-1):
        size = self.length - self.position if size < 0 else min(size, self.length - self.position)
        if size <= 0:
            return b''
        if self.cache_start <= self.position and self.position + size <= self.cache_start + len(self.cache):
            start = self.position - self.cache_start
            data = self.cache[start:start + size]
        else:
            with self.range(self.position, self.position + size - 1) as response:
                data = response.read()
            self.bytes_received += len(data)
        self.position += len(data)
        return data

    def extract_member(self, member, target):
        self.seek(member.header_offset)
        header = self.read(30)
        if header[:4] != b'PK\x03\x04':
            raise ValueError('Invalid member header')
        filename_length, extra_length = struct.unpack_from('<HH', header, 26)
        start = member.header_offset + 30 + filename_length + extra_length
        decoder = zlib.decompressobj(-15) if member.compress_type == zipfile.ZIP_DEFLATED else None
        if member.compress_type not in (zipfile.ZIP_DEFLATED, zipfile.ZIP_STORED):
            raise ValueError('Unsupported ZIP compression')
        size, crc, sha = 0, 0, hashlib.sha256()
        with self.range(start, start + member.compress_size - 1) as response, target.open('wb') as output:
            while chunk := response.read(1024 * 1024):
                self.bytes_received += len(chunk)
                data = decoder.decompress(chunk) if decoder else chunk
                output.write(data)
                size += len(data)
                crc = zlib.crc32(data, crc)
                sha.update(data)
            if decoder:
                data = decoder.flush()
                output.write(data)
                size += len(data)
                crc = zlib.crc32(data, crc)
                sha.update(data)
        if size != member.file_size or crc != member.CRC:
            raise ValueError('ZIP member size or CRC mismatch')
        return sha.hexdigest()


def extract_asar(archive, destination):
    inventory = []
    assets = DATA / 'assets'
    destination.mkdir(parents=True, exist_ok=True)
    with archive.open('rb') as source:
        _, header_size, _, json_size = struct.unpack('<4I', source.read(16))
        header = json.loads(source.read(json_size))

        def walk(node, prefix=''):
            for name, item in node.get('files', {}).items():
                path = f'{prefix}/{name}'.lstrip('/')
                if 'files' in item:
                    yield from walk(item, path)
                else:
                    yield path, item

        for relative, item in walk(header):
            if not (relative.startswith('webview/') or relative in ('package.json', '.vite/build/preload.js')):
                continue
            if '..' in PurePosixPath(relative).parts or relative.startswith('/') or 'link' in item or item.get('unpacked'):
                raise ValueError(f'Unsupported renderer entry: {relative}')
            source.seek(8 + header_size + int(item['offset']))
            data = source.read(item['size'])
            if len(data) != item['size']:
                raise ValueError(f'Truncated ASAR member: {relative}')
            digest = hashlib.sha256(data).hexdigest()
            blob = assets / digest
            if not blob.exists():
                temporary = assets / f'{digest}.{destination.name}.tmp'
                temporary.write_bytes(data)
                try:
                    os.link(temporary, blob)
                except FileExistsError:
                    pass
                temporary.unlink()
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists():
                os.link(blob, target)
            inventory.append({'path': relative, 'size': len(data), 'sha256': digest})
    if not (destination / 'webview/index.html').exists():
        raise ValueError('No packaged webview entry point')
    (destination / 'inventory.json').write_text(json.dumps(inventory, separators=(',', ':')))
    return inventory


def find_asar(archive):
    candidates = [x for x in archive.infolist() if x.filename.endswith('.app/Contents/Resources/app.asar') and len(PurePosixPath(x.filename).parts) == 4]
    if len(candidates) != 1:
        raise ValueError(f'Expected one app.asar, found {len(candidates)}')
    return candidates[0]


def engine_version(remote, archive, app_prefix, stage):
    """The bundled Codex CLI version, which the frontend expects from its host; None when the package has none."""
    try:
        member = archive.getinfo(app_prefix + '/Contents/Resources/codex-cli/codex-package.json')
    except KeyError:
        return None
    target = stage / 'codex-package.json'
    remote.extract_member(member, target)
    return json.loads(target.read_text())['version']


def fetch(item):
    version = item['version']
    output = DATA / 'renderers' / version
    receipt = output / 'receipt.json'
    stage = DATA / 'staging' / version
    if receipt.exists():
        result = json.loads(receipt.read_text())
        if 'engineVersion' not in result:
            # Receipts from before engine versions were recorded: read only the ZIP index and that small file.
            stage.mkdir(parents=True, exist_ok=True)
            remote = RemoteZip(item['archiveUrl'])
            with zipfile.ZipFile(remote) as archive:
                result['engineVersion'] = engine_version(remote, archive, find_asar(archive).filename.split('/')[0], stage)
            receipt.write_text(json.dumps(result, indent=2) + '\n')
        return result
    stage.mkdir(parents=True, exist_ok=True)
    print(f'FETCH {version}', flush=True)
    remote = RemoteZip(item['archiveUrl'])
    with zipfile.ZipFile(remote) as archive:
        asar = find_asar(archive)
        app_prefix = asar.filename.split('/')[0]
        metadata = archive.getinfo(app_prefix + '/Contents/Info.plist')
        remote.extract_member(metadata, stage / 'Info.plist')
        info = plistlib.loads((stage / 'Info.plist').read_bytes())
        if info.get('CFBundleIdentifier') != 'com.openai.codex' or info.get('CFBundleShortVersionString') != version:
            raise ValueError('Bundle identity/version mismatch')
        engine = engine_version(remote, archive, app_prefix, stage)
        asar_path = stage / 'app.asar'
        digest = remote.extract_member(asar, asar_path)
    inventory = extract_asar(asar_path, output)
    result = {**item, 'status': 'extracted', 'build': info.get('CFBundleVersion'), 'archiveBytes': remote.length,
              'archiveModified': remote.modified, 'archivedAt': parsedate_to_datetime(remote.modified).isoformat() if remote.modified else item.get('indexedAt'),
              'asarSha256': digest, 'asarBytes': asar.file_size, 'asarZipCrc32': f'{asar.CRC:08x}',
              'bytesDownloaded': remote.bytes_received, 'extractedFiles': len(inventory),
              'extractedBytes': sum(x['size'] for x in inventory), 'engineVersion': engine, 'capturedAt': datetime.now(timezone.utc).isoformat()}
    result.pop('error', None)
    receipt.write_text(json.dumps(result, indent=2) + '\n')
    # Extraction is verified; keep the source URL and member hash instead of 170 full app copies.
    asar_path.unlink()
    print(f'OK {version} build={result["build"]} files={len(inventory)} downloaded={remote.bytes_received // 1048576}MiB', flush=True)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--versions', nargs='*')
    parser.add_argument('--workers', type=int, default=3)
    args = parser.parse_args()
    catalog = json.loads((DATA / 'catalog.json').read_text())
    selected = [x for x in catalog if not args.versions or x['version'] in args.versions]
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(fetch, x): x for x in selected}
        for future in as_completed(futures):
            item = futures[future]
            try:
                result = future.result()
            except Exception as error:
                result = {**item, 'status': 'unavailable', 'error': f'{type(error).__name__}: {error}'}
                print(f'FAIL {item["version"]}: {result["error"]}', flush=True)
            catalog = [result if x['version'] == item['version'] else x for x in catalog]
            temporary = DATA / 'catalog.tmp.json'
            temporary.write_text(json.dumps(catalog, indent=2) + '\n')
            temporary.replace(DATA / 'catalog.json')
