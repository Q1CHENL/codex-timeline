"""Serve unmodified historical renderers with a local, isolated host fixture."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from http.cookies import SimpleCookie
from pathlib import Path
from urllib.parse import urlparse, parse_qs, unquote
import json
import re

from paths import DATA, PIPELINE
MODEL_FIXTURES = json.loads((DATA / 'model-fixtures.json').read_text())
TIMELINE = {row['captureId']: row for row in json.loads((DATA / 'timeline-catalog.json').read_text())}
BOOTSTRAP_ORDERS = {
    '26.908.31457': ['authed-route-70c1c8333037.js', 'index-96d63a4fdc9c.js'],
    '26.908.31748': ['authed-route-86740a2af5a2.js', 'index-aa443e4cd409.js'],
    '26.908.40401': ['authed-route-f1a43c28d764.js', 'index-73c6e3f9ecd1.js'],
}


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        if args and str(args[1]) not in ('200', '304'):
            super().log_message(fmt, *args)

    def do_GET(self):
        parsed = urlparse(self.path)
        cookie = SimpleCookie(self.headers.get('Cookie', ''))
        query = parse_qs(parsed.query)
        version = query.get('v', [cookie.get('history-version').value if cookie.get('history-version') else ''])[0]
        capture_id = query.get('capture', [version if 'v' in query else cookie.get('history-capture').value if cookie.get('history-capture') else version])[0]
        theme = query.get('theme', [cookie.get('history-theme').value if cookie.get('history-theme') else 'dark'])[0]
        if not re.fullmatch(r'[0-9.]+', version):
            self.send_error(400, 'Version is required')
            return
        if theme not in ('dark', 'light'):
            self.send_error(400, 'Theme must be dark or light')
            return
        state = TIMELINE.get(capture_id)
        if not state or state['version'] != version or capture_id not in MODEL_FIXTURES:
            self.send_error(400, 'Capture state does not match the package')
            return
        base = DATA / 'renderers' / version
        if not (base / 'receipt.json').exists():
            self.send_error(404, 'Renderer not extracted')
            return
        receipt = json.loads((base / 'receipt.json').read_text())
        path = unquote(parsed.path)
        if path == '/__lab/bridge.js':
            content, mime = (PIPELINE / 'bridge.js').read_bytes(), 'text/javascript'
        elif path == '/__lab/host.mjs':
            adapter = base / 'host.mjs'
            if not adapter.exists():
                self.send_error(501, 'No host adapter for this version')
                return
            content, mime = adapter.read_bytes(), 'text/javascript'
        elif path in ('/', '/index.html'):
            html = (base / 'webview/index.html').read_text()
            html = re.sub(r'<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?>', '', html, flags=re.I)
            config = {'version': version, 'captureId': capture_id, 'build': receipt['build'], 'modelFixture': MODEL_FIXTURES[capture_id], 'theme': theme, 'navigationLayout': receipt['archivedAt'][:10] >= '2026-10-01'}
            # Later frontends wait for the bundled engine version before leaving their loading screen.
            if receipt.get('engineVersion'):
                config['engineVersion'] = receipt['engineVersion']
            if version in BOOTSTRAP_ORDERS:
                # These releases' primary chunks import an icon from authed-route,
                # which immediately calls an initializer exported by primary.
                # Enter through authed-route so its cyclic dependency initializes
                # first. Both packaged modules are served byte-for-byte unchanged.
                config['bootstrapOrder'] = BOOTSTRAP_ORDERS[version]
                entry = '<script type="module" crossorigin src="./assets/' + config['bootstrapOrder'][1] + '"></script>'
                ordered = '<script type="module">' + ''.join(
                    'await import(' + json.dumps('./assets/' + module) + ');'
                    for module in config['bootstrapOrder']) + '</script>'
                if html.count(entry) != 1:
                    self.send_error(500, 'Historical bootstrap entry does not match its fixture')
                    return
                html = html.replace(entry, ordered, 1)
            html = html.replace('<head>', '<head><script>window.__historyConfig=' + json.dumps(config) + '</script><script src="/__lab/bridge.js"></script>')
            content, mime = html.encode(), 'text/html; charset=utf-8'
        else:
            file = (base / 'webview' / path.lstrip('/')).resolve()
            if not file.is_relative_to((base / 'webview').resolve()) or not file.is_file():
                self.send_error(404)
                return
            content, mime = file.read_bytes(), self.guess_type(str(file))
        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(content)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Set-Cookie', f'history-version={version}; Path=/; HttpOnly; SameSite=Strict')
        self.send_header('Set-Cookie', f'history-capture={capture_id}; Path=/; HttpOnly; SameSite=Strict')
        self.send_header('Set-Cookie', f'history-theme={theme}; Path=/; HttpOnly; SameSite=Strict')
        self.send_header('Content-Security-Policy', "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:")
        self.end_headers()
        self.wfile.write(content)


if __name__ == '__main__':
    ThreadingHTTPServer.request_queue_size = 256
    print('History renderer lab: http://127.0.0.1:4823', flush=True)
    ThreadingHTTPServer(('127.0.0.1', 4823), Handler).serve_forever()
