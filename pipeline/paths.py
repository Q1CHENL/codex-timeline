"""Repository locations shared by the pipeline, player, verification and research scripts."""
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
PIPELINE = REPO / 'pipeline'
PLAYER = REPO / 'player'
# Evidence (committed) and downloaded renderers, captures and intermediate data (ignored).
DATA = REPO / 'data'
# The published page and its evidence files.
DIST = REPO / 'dist'

# A capture's revision hashes these files, in this order, followed by its own
# entry in data/model-fixtures.json (compact JSON), its renderer's host.mjs and
# the theme. Changing any of them makes that capture stale; adding versions does not.
REVISION_SOURCES = (PIPELINE / 'capture-scene.js', PIPELINE / 'bridge.js', PIPELINE / 'server.py')
