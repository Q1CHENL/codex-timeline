"""Identify each packaged Cap'n Web implementation and generate its local host.

Only host.mjs is written. Original bundles and package inventories are untouched.
The import aliases are derived from code structure, never from a version table.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re

from paths import DATA, PIPELINE
IDENT = r'[A-Za-z_$][A-Za-z0-9_$]*'
PEER_CLOSED = 'Peer closed MessagePort connection.'


def class_expression(source, start):
    """Copy the observed self-contained MessagePort class without reformatting."""
    begin = source.index('class', start)
    position = source.index('{', begin)
    depth, quote = 0, None
    while position < len(source):
        character = source[position]
        if quote:
            if character == '\\':
                position += 2
                continue
            if character == quote:
                quote = None
        elif character in ('"', "'", '`'):
            quote = character
        elif character == '{':
            depth += 1
        elif character == '}':
            depth -= 1
            if depth == 0:
                end = position + 1
                expression = source[begin:end]
                if '${' in expression or '/*' in expression or '//' in expression:
                    raise ValueError('Unexpected syntax in MessagePort transport class')
                return begin, end
        position += 1
    raise ValueError('Unterminated MessagePort transport class')


def exported_names(source):
    """Vite's production modules end with a named export list."""
    start = source.rfind('export{')
    if start < 0:
        start = source.rfind('export {')
    if start < 0:
        return {}
    end = source.find('}', start)
    if end < 0:
        raise ValueError('Unterminated export list')
    names = {}
    for item in source[source.find('{', start) + 1:end].split(','):
        pair = re.fullmatch(rf'\s*({IDENT})(?:\s+as\s+({IDENT}))?\s*', item)
        if pair:
            names[pair[1]] = pair[2] or pair[1]
    return names


def exported_alias(local, exports, source):
    """Resolve Vite's final identity alias, with no evaluated bundle code."""
    frontier, visited = [local], set()
    matches = set()
    while frontier:
        current = frontier.pop()
        if current in visited:
            continue
        visited.add(current)
        if current in exports:
            matches.add(exports[current])
        pattern = rf'(?<![\w$.])({IDENT})\s*=\s*{re.escape(current)}(?=[,;}}])'
        frontier.extend(match[1] for match in re.finditer(pattern, source))
    if len(matches) > 1:
        raise ValueError(f'Ambiguous exports for {local}: {sorted(matches)}')
    return next(iter(matches), None)


def identify_bundle(path):
    source = path.read_text()
    if PEER_CLOSED not in source:
        return None
    exports = exported_names(source)
    if not exports:
        # Standalone worker bundles contain another copy, without public exports.
        return None

    marker = source.index(PEER_CLOSED)
    prefix_start = max(0, marker - 1200)
    transports = list(re.finditer(rf'({IDENT})=class(?:\s|\{{)', source[prefix_start:marker]))
    if not transports:
        raise ValueError(f'{path.name}: Cannot identify MessagePort transport')
    transport = transports[-1][1]
    transport_start = prefix_start + transports[-1].start()

    # The exported helper builds a session from precisely this transport.
    sessions = list(re.finditer(
        rf'function ({IDENT})\(({IDENT}),({IDENT}),({IDENT})\)'
        rf'\{{return new ({IDENT})\(new {re.escape(transport)}\(\2\),\3,\4\)\.getRemoteMain\(\)\}}',
        source,
    ))
    if len(sessions) != 1:
        raise ValueError(f'{path.name}: Expected one MessagePort session helper, got {len(sessions)}')
    session_export = exported_alias(sessions[0][1], exports, source)
    session_class_export = exported_alias(sessions[0][5], exports, source) if session_export is None else None

    transport_source = source[transport_start:marker + 700]
    if 'structuredClonable' in transport_source:
        protocol = 'structured'
    elif 'Received non-string message from MessagePort.' in transport_source:
        protocol = 'string'
    else:
        raise ValueError(f'{path.name}: Unrecognized RPC transport encoding')

    if session_export is None and session_class_export is None:
        # May/June ship a self-contained RPC chunk with only client exports.
        # Preserve its library prefix byte-for-byte in host.mjs, omitting the
        # client connector (which would recursively request another host port).
        connection = source.find('connect-app-host')
        if connection < 0:
            return None
        if not path.name.startswith('rpc-'):
            raise ValueError(f'{path.name}: Host RPC exists but neither session helper nor session class is exported')
        client_functions = list(re.finditer(rf'function ({IDENT})\(\)\{{', source[:connection]))
        if not client_functions:
            raise ValueError(f'{path.name}: Cannot isolate the client connector')
        client_start = client_functions[-1].start()
        client = source[client_start:connection + 100]
        if 'new MessageChannel' not in client or 'window.postMessage' not in client:
            raise ValueError(f'{path.name}: Unexpected client connector structure')
        library = source[:client_start]
        if 'import ' in library or 'export{' in library or 'connect-app-host' in library:
            raise ValueError(f'{path.name}: RPC library prefix is not self-contained')
        target = re.search(rf'({IDENT})=({IDENT})\?\2\.RpcTarget:class\{{\}}', library[:1500])
        if not target:
            raise ValueError(f'{path.name}: Cannot identify the eager RpcTarget base')
        return {
            'protocol': protocol,
            'bundle': path.name,
            'bundleSha256': hashlib.sha256(path.read_bytes()).hexdigest(),
            'sourceMode': 'unchanged-library-prefix',
            'libraryPrefixLength': client_start,
            'libraryPrefixBytes': len(library.encode()),
            'libraryPrefixSha256': hashlib.sha256(library.encode()).hexdigest(),
            'initialize': None,
            'session': sessions[0][1],
            'target': target[1],
        }

    initializers = list(re.finditer(
        rf'({IDENT})={IDENT}\(\(\(\)=>\{{{IDENT}=Symbol\([`\'\"]workers-module[`\'\"]\)', source,
    ))
    eager = re.search(rf'(?:var|let|const) {IDENT}=Symbol\([`\'\"]workers-module[`\'\"]\)', source)
    if len(initializers) == 0 and eager:
        initialize_export = None
        initialization = source[eager.start():eager.end() + 1500]
    elif len(initializers) == 1:
        initialize_export = exported_alias(initializers[0][1], exports, source)
        if initialize_export is None:
            raise ValueError(f'{path.name}: RPC initializer is not exported')
        initialization = source[initializers[0].start():initializers[0].end() + 1200]
    else:
        raise ValueError(f'{path.name}: Expected one RPC initializer, got {len(initializers)}')
    target = re.search(rf'({IDENT})=({IDENT})\?\2\.RpcTarget:class\{{\}}', initialization)
    if not target:
        raise ValueError(f'{path.name}: Cannot identify RpcTarget base')
    target_export = exported_alias(target[1], exports, source)

    if protocol == 'structured':
        if target_export is None:
            raise ValueError(f'{path.name}: Structured RPC has no exported RpcTarget')

    result = {
        'protocol': protocol,
        'bundle': path.name,
        'bundleSha256': hashlib.sha256(path.read_bytes()).hexdigest(),
        'initialize': initialize_export,
        'session': session_export,
        'target': target_export,
    }
    if session_class_export:
        begin, end = class_expression(source, transport_start)
        expression = source[begin:end]
        result.update({
            'sourceMode': 'exported-session-class',
            'sessionClass': session_class_export,
            'transportStart': begin,
            'transportEnd': end,
            'transportByteStart': len(source[:begin].encode()),
            'transportByteEnd': len(source[:end].encode()),
            'transportSha256': hashlib.sha256(expression.encode()).hexdigest(),
        })
    return result


def identify_renderer(renderer):
    assets = renderer / 'webview/assets'
    # These are the actual renderer entry/shared chunks, in all archived layouts.
    # Inspect other non-worker chunks only if the normal entry chunks fail.
    preferred = sorted({path for glob in ('app-shared*.js', 'app-initial*.js', 'rpc-*.js', 'index-*.js')
                        for path in assets.glob(glob)})
    candidates = []
    for path in preferred:
        result = identify_bundle(path)
        if result:
            candidates.append(result)
    if not candidates:
        preferred_set = set(preferred)
        for path in sorted(assets.glob('*.js')):
            if path in preferred_set or path.name.startswith('worker-') or path.stat().st_size < 35000:
                continue
            result = identify_bundle(path)
            if result:
                candidates.append(result)
    if len(candidates) > 1:
        raise ValueError(f'{renderer.name}: Multiple exported RPC implementations: {candidates}')
    return candidates[0] if candidates else {'protocol': 'none'}


def build_host(adapter, template, renderer):
    if adapter['protocol'] == 'none':
        return ('/* This packaged renderer has no exported Cap\'n Web session. */\n'
                'export const adapter = {protocol: "none"};\n'
                'export async function connectHost(port, lab = window.__lab) {\n'
                '  lab.rpc.push({method: "unexpected-rpc-port", version: lab.version});\n'
                '  port.close();\n'
                '  throw new Error("This renderer has no discovered Cap\'n Web host adapter");\n'
                '}\n')

    if adapter.get('sourceMode') == 'unchanged-library-prefix':
        original = (renderer / 'webview/assets' / adapter['bundle']).read_text()
        imports = (f"/* Source: {adapter['bundle']}, bytes [0, {adapter['libraryPrefixBytes']}), "
                   f"SHA-256 {adapter['libraryPrefixSha256']}. */\n"
                   + original[:adapter['libraryPrefixLength']] + '\n'
                   f"const newMessagePortRpcSession = {adapter['session']};\n"
                   f"const RpcTarget = {adapter['target']};")
        initialize = ''
    else:
        names = ([f"{adapter['sessionClass']} as RpcSession"]
                 if adapter.get('sourceMode') == 'exported-session-class'
                 else [f"{adapter['session']} as newMessagePortRpcSession"])
        if adapter['initialize']:
            names.insert(0, f"{adapter['initialize']} as initializeRpc")
        if adapter['protocol'] == 'structured':
            names.append(f"{adapter['target']} as RpcTarget")
        imports = f"import {{ {', '.join(names)} }} from '/assets/{adapter['bundle']}';"
        if adapter.get('sourceMode') == 'exported-session-class':
            original = (renderer / 'webview/assets' / adapter['bundle']).read_text()
            imports += (f"\n/* Source: {adapter['bundle']}, bytes [{adapter['transportByteStart']}, "
                        f"{adapter['transportByteEnd']}), SHA-256 {adapter['transportSha256']}. */\n"
                        + 'const MessagePortTransport = '
                        + original[adapter['transportStart']:adapter['transportEnd']] + ';\n'
                        + 'function newMessagePortRpcSession(port, main, options) {\n'
                        + '  return new RpcSession(new MessagePortTransport(port), main, options).getRemoteMain();\n'
                        + '}')
        initialize = 'initializeRpc();' if adapter['initialize'] else ''
    if adapter['protocol'] == 'structured':
        connect = ('class Host extends RpcTarget {\n'
                   '    get services() {\n'
                   '      lab.rpc.push({method: "services"});\n'
                   '      return services;\n'
                   '    }\n'
                   '  }\n'
                   '  window.__labHost = newMessagePortRpcSession(port, new Host());')
    else:
        connect = 'window.__labHost = newMessagePortRpcSession(port, {services});'
    return (template
            .replace('__IMPORTS__', imports)
            .replace('__INITIALIZE__', initialize)
            .replace('__ADAPTER__', json.dumps(adapter, ensure_ascii=False))
            .replace('__CONNECT__', connect))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=DATA / 'renderers')
    parser.add_argument('--versions', nargs='+')
    parser.add_argument('--include-unreceipted', action='store_true',
                        help='For the original two renderer fixtures only.')
    parser.add_argument('--check', action='store_true', help='Inspect exports without writing host.mjs.')
    args = parser.parse_args()
    template = (PIPELINE / 'host-template.mjs').read_text()
    results = []
    failures = 0
    for renderer in sorted(args.root.iterdir()):
        if not renderer.is_dir() or (args.versions and renderer.name not in args.versions):
            continue
        if not args.include_unreceipted and not (renderer / 'receipt.json').is_file():
            continue
        try:
            adapter = identify_renderer(renderer)
            host = build_host(adapter, template, renderer)
            if not args.check:
                destination = renderer / 'host.mjs'
                if not destination.exists() or destination.read_text() != host:
                    temporary = renderer / f'.host.mjs.{os.getpid()}.tmp'
                    temporary.write_text(host)
                    temporary.replace(destination)
            results.append({'version': renderer.name, **adapter, 'status': 'identified'})
        except (ValueError, OSError) as error:
            failures += 1
            results.append({'version': renderer.name, 'status': 'failed', 'error': str(error)})
    print(json.dumps({'results': results, 'failed': failures}, indent=2), flush=True)
    raise SystemExit(1 if failures else 0)


if __name__ == '__main__':
    main()
