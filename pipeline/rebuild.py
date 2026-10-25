"""Run the whole pipeline: discover, fetch, capture, build, verify and publish to dist/.

Each step skips work that is already current: downloaded versions are kept,
unchanged adapters are not rewritten, and up-to-date captures are not retaken.
"""
import argparse
import socket
import subprocess
import sys
import time

from paths import REPO

PORT = 4823


def run(*command):
    print('\n$ ' + ' '.join(command), flush=True)
    subprocess.run(command, cwd=REPO, check=True)


def python(script, *args):
    run(sys.executable, script, *args)


def wait_for_server(process, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError('pipeline/server.py exited before it started listening')
        try:
            with socket.create_connection(('127.0.0.1', PORT), timeout=1):
                return
        except OSError:
            time.sleep(0.2)
    raise RuntimeError(f'pipeline/server.py did not listen on port {PORT}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--skip-fetch', action='store_true', help='Skip discovering and downloading versions; use the frontends already in data/renderers.')
    args = parser.parse_args()

    if not args.skip_fetch:
        python('pipeline/discover-versions.py')
        python('pipeline/fetch-versions.py')
    python('pipeline/generate-adapters.py')
    python('pipeline/build-rollout-policy.py')
    python('pipeline/build-model-timeline.py')

    print(f'\n$ {sys.executable} pipeline/server.py  (background, port {PORT})', flush=True)
    server = subprocess.Popen([sys.executable, 'pipeline/server.py'], cwd=REPO, stdout=subprocess.DEVNULL)
    try:
        wait_for_server(server)
        for theme in ('dark', 'light'):
            run('node', 'pipeline/capture-all.cjs', '--theme', theme)
        # Hover and typing states are recorded once per distinct screen, which prepare-scenes.py identifies.
        python('pipeline/prepare-scenes.py')
        for theme in ('dark', 'light'):
            run('node', 'pipeline/capture-states.cjs', '--theme', theme)
    finally:
        server.terminate()
        server.wait()

    python('pipeline/prepare-scenes.py')
    python('player/build-page.py')
    run('node', 'verify/verify.cjs')
    python('pipeline/publish.py')


if __name__ == '__main__':
    try:
        main()
    except (subprocess.CalledProcessError, RuntimeError) as error:
        sys.exit(f'\nrebuild failed: {error}')
