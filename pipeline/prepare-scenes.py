"""Prepare source-rendered main screens for the multi-version timeline player.

Only successful capture ledger entries are included. Semantic identities drive
matching; capture metadata and runtime-generated DOM ids never drive deduplication.
"""
from __future__ import annotations

import argparse
import base64
import copy
import hashlib
import json
import math
import re
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from paths import DATA, PIPELINE, REVISION_SOURCES
GROUPS = {"layout", "chrome", "navigation", "hero", "composer", "announcement", "cards"}
HERO = re.compile(r"^(let[’']s build|what should we (?:work on|build)\?|what can i help(?: you)?(?: with)?\??)$", re.I)
# Ordered, so prepared data serializes identically on every run.
VISUAL_FIELDS = ("kind", "x", "y", "w", "h", "opacity", "background", "backgroundImage", "borders", "radius", "shadow", "filter", "backdropFilter", "mixBlendMode", "html", "text", "color", "fontSize", "fontFamily", "fontWeight", "lineHeight", "letterSpacing", "textAlign", "textIndent", "whiteSpace", "direction", "src", "alt", "objectFit", "objectPosition")


def digest(value):
    if not isinstance(value, (str, bytes)):
        value = json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(value.encode() if isinstance(value, str) else value).hexdigest()


def clean(value):
    return re.sub(r"\s+", " ", value or "").strip()


def slug(value):
    text = re.sub(r"[^a-z0-9]+", "-", clean(value).lower()).strip("-")
    return text[:52] + ("-" + digest(value)[:8] if len(text) > 52 else "") or digest(value)[:12]


def classes(element, ancestors=True):
    source = element.get("source", {})
    nodes = [source, *source.get("ancestors", [])] if ancestors else [source]
    return " ".join(node.get("class") or "" for node in nodes)


def normalized_label(element):
    label = clean(element.get("semantic", {}).get("controlLabel") or element.get("hint"))
    return re.sub(r"\s*[⌘⇧⌥⌃].*$", "", label).strip()


def contains(outer, inner, tolerance=2):
    return outer["x"] <= inner["x"] + tolerance and outer["y"] <= inner["y"] + tolerance and outer["x"] + outer["w"] >= inner["x"] + inner["w"] - tolerance and outer["y"] + outer["h"] >= inner["y"] + inner["h"] - tolerance


def center(element):
    return element["x"] + element["w"] / 2, element["y"] + element["h"] / 2


def near_score(a, b, viewport):
    ax, ay = center(a); bx, by = center(b)
    distance = math.hypot((ax - bx) / viewport["width"], (ay - by) / viewport["height"])
    shape = abs(math.log(max(a["w"], 1) / max(b["w"], 1))) + abs(math.log(max(a["h"], 1) / max(b["h"], 1)))
    return distance + shape * 0.16


def anchors_for(elements, viewport):
    boxes = [e for e in elements if e["kind"] == "box"]
    hero = next((e for e in elements if e["kind"] == "text" and HERO.match(clean(e.get("text")))), None)
    placeholder = max((e for e in elements if e["kind"] == "placeholder"), key=lambda e: e["w"], default=None)
    composer = None
    if placeholder:
        candidates = [e for e in boxes if contains(e, placeholder) and e["h"] >= 40 and e["h"] < viewport["height"] * 0.45 and e["w"] < viewport["width"] * 0.9]
        if candidates:
            # The outer editable surface owns its border/shadow; a nested opaque
            # fill is a separate primitive in the earliest packages.
            composer = min(candidates, key=lambda e: (abs(e["w"] - placeholder["w"] - 24) + abs(e["h"] - 100) * 0.3))
            outer = [e for e in candidates if contains(e, composer, 0) and e['w'] - composer['w'] <= 4 and e['h'] - composer['h'] <= 4]
            composer = max(outer, key=lambda e: e['w'] * e['h'], default=composer)
    card_hints = {normalized_label(e) for e in elements if e["kind"] in {"img", "svg"} and len(normalized_label(e)) > 12}
    cards = [e for e in boxes if normalized_label(e) in card_hints and e["w"] > 100 and e["h"] > 40 and e.get('source', {}).get('tag', '').lower() == 'button']
    cards.sort(key=lambda e: (round(e["y"] / 20), e["x"]))
    banners = [e for e in boxes if e.get("source", {}).get("tag", "").lower() == "aside" and e["w"] > viewport["width"] * 0.3 and 35 < e["h"] < viewport["height"] * 0.3]
    banner = max(banners, key=lambda e: e["w"] * e["h"], default=None)
    project = next((e for e in elements if e["kind"] == "text" and clean(e.get("text")).lower() in {"choose project", "select your project", "work in a project"}), None)
    project_bar = None
    if project:
        candidates = [e for e in boxes if contains(e, project) and e["w"] > viewport["width"] * 0.4 and 25 < e["h"] < 120 and e is not composer]
        project_bar = min(candidates, key=lambda e: e["w"] * e["h"], default=None)
    return {"hero":hero, "placeholder":placeholder, "composer":composer, "cards":cards, "banner":banner, "project_bar":project_bar}


def semantic_key(element, anchors, viewport):
    kind, text = element["kind"], clean(element.get("text"))
    own, ancestry, label = classes(element, False), classes(element), normalized_label(element)
    low = label.lower()
    components = re.findall(r"_([^_\s]+)_[A-Za-z0-9]+_\d+", own)
    width, height = element["w"], element["h"]
    if kind == "text" and HERO.match(text): return "hero-heading", "hero"
    if element is anchors["placeholder"]: return "composer-placeholder", "composer"
    if kind in {"svg", "img"} and not label and anchors["hero"]:
        hx, hy = center(anchors["hero"]); ex, ey = center(element)
        if 28 <= width <= 100 and 28 <= height <= 100 and abs(ex - hx) < max(width, 60) and 0 < hy - ey < 160:
            return "hero-icon", "hero"
    if kind == "text" and text == "Codex": return "brand", "navigation"
    if low.startswith("switch mode"):
        return ("brand" if width > height * 1.6 else "mode-chevron"), "navigation"
    if kind == "box":
        if "PageSurfaceLayout" in components: return "app-background", "layout"
        if "PageSurface" in components: return "page-frame", "layout"
        if "MainContentSurface" in components or re.search(r"(?:^|\s)main-surface(?:\s|$)", own): return "main-background", "layout"
        if "sidebar-navigation" in own or "app-shell-left-panel" in own: return "sidebar-background", "layout"
        if "MainContentTopFade" in components or ("bg-gradient-to-b" in own and height <= 32 and width > viewport["width"] * 0.4): return "top-fade", "layout"
        if element is anchors["composer"] or "ComposerLayoutBody" in components: return "composer-background", "composer"
        if element is anchors["project_bar"]: return "project-background", "composer"
        if anchors["composer"] and contains(anchors["composer"], element) and width > anchors["composer"]["w"] * 0.8 and height > anchors["composer"]["h"] * 0.6:
            return "composer-surface", "composer"
        if anchors["composer"] and contains(element, anchors["composer"]) and height < viewport['height'] * 0.5:
            return "composer-surround", "composer"
    for index, card in enumerate(anchors["cards"]):
        if contains(card, element) and (normalized_label(card) == label or element is card):
            prefix = f"card-{index + 1}"
            if element is card: return prefix + "-background", "cards"
            if kind in {"img", "svg"}: return prefix + "-icon", "cards"
            if kind == "text": return prefix + "-text-" + slug(text), "cards"
    if text == "Explore more": return "cards-explore", "cards"
    banner = anchors["banner"]
    if banner and contains(banner, element):
        if element is banner: return "announcement-base", "announcement"
        if kind == "box" and not label and width > banner["w"] * 0.8: return "announcement-surface", "announcement"
        if kind == "svg" and not label: return "announcement-icon", "announcement"
        if low.startswith("dismiss"): return "announcement-dismiss-" + kind, "announcement"
        if label: return "announcement-" + slug(label) + "-" + kind, "announcement"
        if kind == "text":
            return ("announcement-description" if len(text) > 60 else "announcement-heading"), "announcement"
    # Toolbar controls can use composer-sized shared buttons, so recognize their
    # meaning before consulting generic ancestor classes or region metadata.
    aliases = {"toggle terminal":"toggle-bottom-panel", "toggle bottom panel":"toggle-bottom-panel", "toggle diff panel":"toggle-side-panel", "toggle side panel":"toggle-side-panel", "hide sidebar":"toggle-sidebar", "show sidebar":"toggle-sidebar", "back":"back", "forward":"forward"}
    if low in aliases: return "chrome-" + aliases[low] + "-" + kind, "chrome"
    if kind == "text" and text in {"New thread", "New chat", "New task"} and element["y"] < viewport["height"] * 0.065:
        return "chrome-title", "chrome"
    composer_context = bool(re.search(r"composer-footer|Composer|ProseMirror|composer-surface|_multilineSurface", ancestry)) or (anchors["composer"] and contains(anchors["composer"], element))
    chevron = kind == "svg" and (("icon-2xs" in own and "placeholder" in own) or "Select effort" in label or ("chevron" in own.lower()))
    if low in {"choose project", "select your project", "work in a project"}:
        return "project-picker-" + ("chevron" if chevron else kind), "composer"
    if low == "add files and more": return "add-files-" + kind, "composer"
    if low in {"default permission", "default permissions", "ask for approval", "change permissions", "full access"} or low.startswith("codex automatically runs"):
        return "permissions-" + ("chevron" if chevron else kind), "composer"
    if low == "send" or re.search(r"(?:^|\s)size-token-button-composer(?:\s|$)", ancestry):
        return "send-" + kind, "composer"
    if composer_context:
        if kind == "text" and (text == anchors.get("model_label") or text == "Custom" or re.match(r"^(?:GPT-|gpt-|o[134]-|Auto$)", text)): return "model-label", "composer"
        if kind == "text" and text in {"None", "Minimal", "Light", "Low", "Medium", "High", "Extra High", "Max", "Ultra", "Persistent"}: return "effort-label", "composer"
        if kind == "svg" and ((anchors.get("model_label") and label.startswith(anchors["model_label"] + " ")) or re.match(r"^(?:GPT-|gpt-|o[134]-|Custom)", label)): return "model-chevron", "composer"
        if kind == "svg" and ("Select effort" in label or label in {"None", "Minimal", "Light", "Low", "Medium", "High", "Extra High", "Max", "Ultra"}): return "effort-chevron", "composer"
        if low == "local": return "execution-mode-" + ("chevron" if chevron else kind), "composer"
        if low == "create git repository": return "create-repository-" + kind, "composer"
    region = element.get("semantic", {}).get("region", "")
    nav_labels = {"home", "new chat", "new thread", "new task", "search", "scheduled", "automations", "plugins", "skills", "explore", "project", "projects", "recents", "settings", "open profile menu", "open help menu"}
    nav = region in {"sidebar", "navigation"} or low in nav_labels or text.lower() in nav_labels or "w-token-sidebar" in ancestry
    if nav:
        name = low or text.lower()
        if name == "open profile menu" and kind == "svg": name = "settings"
        if name in {"new thread", "new chat", "new task"}: name = "new-chat"
        if name: return "navigation-" + slug(name) + "-" + kind, "navigation"
    group = "composer" if composer_context else "navigation" if nav else "chrome" if region == "chrome" else "layout" if kind == "box" and (width <= 2 or height <= 2) else "hero"
    if kind == "placeholder": return "placeholder-" + slug(text), group
    if kind == "text": return group + "-text-" + slug(text), group
    if label: return group + "-control-" + slug(label) + "-" + kind, group
    if kind == "svg": return group + "-icon-" + digest(element.get("svgSignature") or element.get("html", ""))[:12], group
    if kind == "img": return group + "-image-" + digest(element.get("src", ""))[:12], group
    if width <= 2 or height <= 2:
        return "divider-" + ("vertical" if width <= 2 else "horizontal") + "-" + ("sidebar" if element["x"] < viewport["width"] * 0.35 else "main"), "layout"
    if components: return "surface-" + slug(components[0]), group
    return None, group


# Room between consecutive parts' z, so an interaction state can paint new parts between a
# screen's own, and a state within a state between those. The largest z, 60_999 * Z_SPACING,
# stays under the player's hit layer (2_147_483_000).
Z_SPACING = 30_000


def z_for(key, element, order):
    # CSS z-index accepts integers only. Reserve a full range for each visual
    # layer, retaining DOM order inside it and placing large surrounds below fills.
    base = re.sub(r'~\d+$', '', key)
    levels = {'app-background':-10, 'main-background':-5, 'sidebar-background':-5,
        'page-frame':2, 'top-fade':6, 'composer-surround':8, 'project-background':9,
        'announcement-base':10, 'announcement-surface':11, 'composer-background':12,
        'composer-surface':13}
    if base in levels: level = levels[base]
    elif key.startswith('divider-'): level = 7
    elif re.match(r'card-\d+-background', key): level = 10
    elif element['kind'] == 'box':
        # Icon-only controls may have no label in older packages. Their painted
        # backgrounds still sit above composer fills and below control glyphs.
        is_control = bool(element.get('semantic', {}).get('controlRole')) or element.get('source', {}).get('tag', '').upper() in {'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'A'}
        level = 20 if is_control or normalized_label(element) else 8
    else: level = 60 if key.startswith('chrome-') else 50
    return (level * 1000 + order) * Z_SPACING


def radius_value(value, size):
    first = str(value).split()[0]
    try: return float(first[:-1]) * size / 100 if first.endswith("%") else float(first.removesuffix("px"))
    except ValueError: return 0


def apply_clipping(part, element):
    clip = element.get("clip")
    if not clip: return
    bounds = clip.get("rect")
    if not bounds: return
    x, y, w, h = (part[k] for k in ("x", "y", "w", "h"))
    insets = [max(0, bounds["y"] - y), max(0, x + w - bounds["x"] - bounds["w"]), max(0, y + h - bounds["y"] - bounds["h"]), max(0, bounds["x"] - x)]
    inherited = [0.0] * 4
    for ancestor in clip.get("ancestors", []):
        if not ancestor.get("clipX") or not ancestor.get("clipY"): continue
        ax, ay, aw, ah = (ancestor[k] for k in ("x", "y", "w", "h"))
        edges = [abs(x - ax) < 2, abs(y - ay) < 2, abs(x + w - ax - aw) < 2, abs(y + h - ay - ah) < 2]
        corners = [(edges[0] and edges[1]), (edges[2] and edges[1]), (edges[2] and edges[3]), (edges[0] and edges[3])]
        for index, touch in enumerate(corners):
            if touch: inherited[index] = max(inherited[index], radius_value(ancestor.get("radius", [0] * 4)[index], min(aw, ah)))
    if part["kind"] == "box" and any(inherited):
        original = part.get("radius", ["0px"] * 4)
        part["radius"] = [f"{max(radius_value(original[i], min(w,h)), inherited[i]):g}px" for i in range(4)]
    if any(v > 0.01 for v in insets):
        part["clipCSS"] = "inset(" + " ".join(f"{v:.3f}px" for v in insets) + (" round " + " ".join(f"{v:g}px" for v in inherited) if any(inherited) else "") + ")"
    # A box's own clip-path is relative to its border box, which is the part's box.
    own = element.get("clipPath", "none")
    if own != "none":
        if "clipCSS" in part:
            raise ValueError(f"{part.get('key')}: own clip-path {own} combined with an ancestor clip is not supported")
        part["clipCSS"] = own


def blockify(markup):
    """capture-scene.js measures a text clone's glyph offset while it is absolutely
    positioned, which lays an inline clone out as a block. Keep that display, so the
    player does not place the glyphs on a line box with a different strut."""
    root = re.match(r'<[^>]*>', markup)
    if not root: return markup
    tag = re.sub(r'([;"]\s*)display:\s*inline(?:-(block|flex|grid|table))?(?=\s*[;"])', lambda m: f"{m[1]}display: {m[2] if m[2] and m[2] != 'block' else 'block'}", root[0], count=1)
    return tag + markup[root.end():]


def normalize_html(markup, prefix):
    # A CSS mask id belongs to one primitive. Rebase both its declaration and
    # references so identical captures hash equally and multiple icons coexist.
    ids = re.findall(r'\bid="([^"]+)"', markup)
    mapping = {value:prefix + str(i) for i, value in enumerate(dict.fromkeys(ids))}
    for original in sorted(mapping, key=len, reverse=True):
        markup = markup.replace('id="' + original + '"', 'id="' + mapping[original] + '"')
        markup = markup.replace('#' + original, '#' + mapping[original])
    markup = re.sub(r'\s+(?:aria-[\w-]+|data-[\w-]+|tabindex|role|contenteditable|spellcheck|draggable)="[^"]*"', '', markup)
    return markup


def build_parts(scene, previous):
    viewport = scene['viewport']; elements = scene['elements']; anchors = anchors_for(elements, viewport)
    anchors["model_label"] = scene.get("renderedModel", {}).get("visibleLabel")
    available = defaultdict(list)
    for part in previous: available[re.sub(r"~\d+$", '', part['key'])].append(part)
    assigned = set(); parts = []; next_fallback = 1
    for order, element in enumerate(elements):
        base, group = semantic_key(element, anchors, viewport)
        assert group in GROUPS
        if base is None:
            candidates = [part for part in previous if part['key'].startswith('surface-auto-') and part['key'] not in assigned and part['group'] == group and part['kind'] == element['kind']]
            match = min(candidates, key=lambda p: near_score(element, p, viewport), default=None)
            if match and near_score(element, match, viewport) < 0.18: base = match['key']
            else:
                while f'surface-auto-{group}-{next_fallback}' in assigned or any(part['key'] == f'surface-auto-{group}-{next_fallback}' for part in previous): next_fallback += 1
                base = f'surface-auto-{group}-{next_fallback}'; next_fallback += 1
        candidates = [part for part in available.get(base, []) if part['key'] not in assigned]
        if candidates: key = min(candidates, key=lambda p: near_score(element, p, viewport))['key']
        else:
            key = base; index = 2
            while key in assigned: key = f'{base}~{index}'; index += 1
        assigned.add(key)
        part = {field:copy.deepcopy(element[field]) for field in VISUAL_FIELDS if field in element}
        for field in ('x', 'y', 'w', 'h', 'opacity'):
            if field in part: part[field] = round(part[field], 3)
        part.update(key=key, group=group, z=z_for(key, element, order))
        apply_clipping(part, element)
        if part['kind'] == 'text': part['html'] = blockify(part['html'])
        if 'html' in part: part['html'] = normalize_html(part['html'], 'history-' + digest(key)[:12] + '-')
        parts.append(part)
    return parts


def fingerprint(scene):
    parts = []
    for part in scene['parts']:
        visual = {key:value for key, value in part.items() if key not in {'key', 'group'}}
        if 'html' in visual: visual['html'] = normalize_html(visual['html'], 'icon-')
        parts.append(visual)
    return digest({"background":scene['background'], "viewport":scene['viewport'], "parts":parts})


def timestamp(entry):
    value = entry.get('archivedAt') or entry.get('archiveAt') or entry.get('indexedAt')
    return datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(timezone.utc) if value else datetime.max.replace(tzinfo=timezone.utc)


THEME_INPUTS = {
    'dark': ('captures', 'capture-results.json'),
    'light': ('captures-light', 'capture-results-light.json'),
}
STATE_LEDGERS = {'dark': 'state-results.json', 'light': 'state-results-light.json'}
OVERLAY_ROLES = {'tooltip', 'dialog', 'menu', 'listbox'}


def recorded_states(root, theme, capture_id, capture_revision):
    """A capture's hover, open, toggle and typing states from capture-states.cjs, when current."""
    ledger_path = root / STATE_LEDGERS[theme]
    record = (json.loads(ledger_path.read_text()) if ledger_path.is_file() else {}).get(capture_id, {})
    revision = digest(capture_revision + (PIPELINE / 'capture-states.cjs').read_text())
    path = root / 'states' / theme / (capture_id + '.json')
    if record.get('status') != 'recorded' or record.get('revision') != revision or not path.is_file(): return None
    return json.loads(path.read_text())


def interaction(source, parts, states):
    """The scene's layouts, each with its controls and composer. Every state is a delta
    over the screen it applies to (the scene, or a toggled layout): the parts it adds
    or restyles, and the screen's parts it hides."""
    base = source['elements']
    def resolve(encoded, against):
        """A recorded element list; numbers index the list it was recorded against."""
        if any(isinstance(entry, int) and entry >= len(against) for entry in encoded): return None
        return [against[entry] if isinstance(entry, int) else entry for entry in encoded]
    def state_parts(encoded, reference, against):
        """The state's parts, in paint order."""
        if (elements := resolve(encoded, against)) is None: return None
        state = build_parts({**source, 'elements':elements}, reference)
        # Tooltips, flyouts, menus and dialogs render in the app's top layer, above everything
        # on the page: in a layer the state mounted on the body, or under an overlay role.
        overlay = lambda element: element.get('layer') == 'overlay' or bool(OVERLAY_ROLES & {node.get('role') for node in [element.get('source', {}), *element.get('source', {}).get('ancestors', [])]})
        return [part for _, _, part in sorted(((overlay(element), part['z'], part) for part, element in zip(state, elements)), key=lambda item: item[:2])]
    def delta(encoded, reference, against, extract_text=False):
        if (painted := state_parts(encoded, reference, against)) is None: return None
        by_key = {part['key']: part for part in reference}
        look = lambda part: {key:value for key, value in part.items() if key != 'z'}
        # Parts that look the same keep their place in the screen when they still paint in
        # its order; the others are redrawn, slotted between their kept neighbours.
        kept, last = set(), None
        for part in painted:
            known = by_key.get(part['key'])
            if known and look(part) == look(known) and (last is None or known['z'] > last):
                kept.add(part['key']); last = known['z']
        # A kept part too close above the last to fit the run between them is redrawn too.
        run, below = [], None
        for part in painted:
            above = by_key[part['key']]['z'] if part['key'] in kept else None
            if above is not None and below is not None and above - below <= len(run):
                kept.discard(part['key']); above = None
            if above is None: run.append(part); continue
            step = Z_SPACING if below is None else (above - below) // (len(run) + 1)
            for index, item in enumerate(run): item['z'] = above - (len(run) - index) * step
            run, below = [], above
        for index, item in enumerate(run): item['z'] = (below or 0) + (index + 1) * Z_SPACING
        changed = [part for part in painted if part['key'] not in kept]
        text = None
        if extract_text:
            # capture-states.cjs types a single "x"; its text part gives the typography for real input.
            text = next((part for part in changed if part['kind'] == 'text' and part.get('text') == 'x'), None)
            if text: changed.remove(text)
        hidden = {part['key'] for part in changed if part['key'] in by_key} | (by_key.keys() - {part['key'] for part in painted})
        result = {'parts':changed, 'hide':sorted(hidden)} if changed or hidden else None
        return (result, text) if extract_text else result
    def applied(reference, change):
        hidden = set(change['hide'])
        return [part for part in reference if part['key'] not in hidden] + change['parts']
    def editor(recorded, reference, against):
        if not recorded: return None
        typed, text = delta(recorded['typed'], reference, against, extract_text=True) or (None, None)
        return {'rect':recorded['rect'], 'text':text, 'typed':typed} if typed and text else None
    def transplant(encoded, layout_elements):
        """A state recorded in the first layout, applied to another where its control looks
        the same and sits in the same place: the elements it removed and added there, at
        the same neighbours in this layout's element order."""
        # As capture-states.cjs compares elements: their look, without DOM identity at any depth.
        def identityless(value):
            if isinstance(value, dict): return {k: identityless(v) for k, v in value.items() if k != 'source'}
            return [identityless(v) for v in value] if isinstance(value, list) else value
        signature = lambda element: re.sub(r'\b(id=\\"|url\(#|href=\\"#)[^"\\)]*', r'\1', json.dumps(identityless(element), sort_keys=True))
        here = {}
        for position, element in enumerate(layout_elements): here.setdefault(signature(element), []).append(position)
        mapped, taken = {}, set()
        for position, element in enumerate(base):
            match = next((candidate for candidate in here.get(signature(element), []) if candidate not in taken), None)
            if match is not None: mapped[position] = match; taken.add(match)
        kept = {entry for entry in encoded if isinstance(entry, int)}
        removed = {mapped[position] for position in mapped if position not in kept}
        added, after = defaultdict(list), -1
        for entry in encoded:
            if isinstance(entry, int):
                if entry in mapped: after = mapped[entry]
            else: added[after].append(entry)
        result = list(added[-1])
        for position, element in enumerate(layout_elements):
            if position not in removed: result.append(element)
            result.extend(added[position])
        return result
    def submenus(opened, screen, elements):
        # Items in an open menu that open another: hovering one shows both, over the screen.
        return [{'label':item['label'], 'rect':item['rect'], 'by':item['by'], 'panel':item['panel'], 'state':state, 'submenus':submenus(item, screen, elements)}
                for item in opened.get('submenus', []) if (state := delta(item['state'], screen, elements))]
    layouts = []
    for index, recorded in enumerate(states['layouts']):
        # Layout 0 is the scene itself; the others are toggled from it, alone or combined.
        # Layouts are recorded against the scene, the states within them against the layout.
        elements = resolve(recorded['state'], base) if index else base
        if elements is None: raise ValueError(f"{source.get('captureId')}: layout {index} refers past the scene's elements")
        state = delta(recorded['state'], parts, base) if index else None
        screen = applied(parts, state) if state else parts
        controls = []
        for control in recorded['controls']:
            if 'reuse' in control:
                # Recorded in the first layout: apply its states to this one.
                original = states['layouts'][0]['controls'][control['reuse']]
                control = {**control, **{key: original[key] for key in ('hover', 'open') if original.get(key)}}
                if control.get('hover'): control['hover'] = transplant(control['hover'], elements)
                moved = lambda items: [{**item, 'state': transplant(item['state'], elements), 'submenus': moved(item.get('submenus', []))} for item in items]
                if control.get('open'): control['open'] = {**control['open'], 'state': transplant(control['open']['state'], elements), 'submenus': moved(control['open'].get('submenus', []))}
            hover = control.get('hover') and delta(control['hover'], screen, elements)
            opened = control.get('open') and delta(control['open']['state'], screen, elements)
            toggle = control.get('toggle')
            if hover or opened or toggle is not None:
                controls.append({'label':control['label'], 'rect':control['rect'], 'hover':hover or None,
                                 **({'open':{**opened, 'panel':control['open']['panel'], 'submenus':submenus(control['open'], screen, elements)}} if opened else {}),
                                 **({'toggle':toggle} if toggle is not None else {})})
        layouts.append({'state':state, 'controls':controls, 'editor':editor(recorded.get('editor'), screen, elements)})
    return {'layouts':layouts}


def capture_inputs(root, catalog):
    """Read ledgers once; absent or older unlabelled captures are never ready."""
    inputs = {}
    fixtures = json.loads((root / 'model-fixtures.json').read_text())
    common_source = ''.join(path.read_text() for path in REVISION_SOURCES)
    for theme, (directory, ledger_name) in THEME_INPUTS.items():
        ledger_path = root / ledger_name
        ledger = json.loads(ledger_path.read_text()) if ledger_path.is_file() else {}
        ready, missing = {}, []
        for entry in catalog:
            version = entry['version']; capture_id = entry['captureId']; record = ledger.get(capture_id, {})
            path = root / directory / (capture_id + '.json'); image = path.with_suffix('.png')
            fixture = json.dumps(fixtures[capture_id], ensure_ascii=False, separators=(',', ':'))
            revision = digest(common_source + fixture + (root / 'renderers' / version / 'host.mjs').read_text() + theme)
            if record.get('status') != 'captured': reason = record.get('status', 'pending')
            elif record.get('theme') != theme or record.get('fixture', {}).get('theme') != theme: reason = 'theme-unverified'
            elif record.get('revision') != revision: reason = 'stale-fixture'
            elif not record.get('renderedModel', {}).get('visibleLabel') or not record.get('renderedModel', {}).get('visibleEffort') or record.get('fixture', {}).get('model') != fixtures[capture_id]: reason = 'model-unverified'
            elif record.get('captureId') != capture_id: reason = 'capture-id-mismatch'
            elif str(record.get('version')) != version: reason = 'version-mismatch'
            elif not path.is_file() or not image.is_file(): reason = 'capture-files-missing'
            else:
                ready[capture_id] = {'record':record, 'path':path, 'image':image}
                continue
            missing.append({'version':version, 'captureId':capture_id, 'reason':reason})
        inputs[theme] = {'ready':ready, 'missing':missing}
    return inputs


def assemble(catalog, inputs, root=DATA, limit_versions=None, model_policy=None):
    timeline = [{"version":entry['version'], "captureId":entry['captureId'], "kind":entry['kind'], "modelEvent":entry['modelEvent'], "packageArchivedAt":entry['packageArchivedAt'], "datePrecision":entry.get('datePrecision', 'timestamp'), "date":timestamp(entry).date().isoformat(), "archivedAt":timestamp(entry).isoformat(), "build":entry.get('build'),
        "sceneIndices":dict.fromkeys(THEME_INPUTS), "models":{}, "confidence":"Original frontend · Historical feature flags unverified",
        "dateSource":entry['dateSource'],
        "archiveUrl":entry['archiveUrl'], "status":"pending"} for entry in catalog]
    themes = {}
    for theme in THEME_INPUTS:
        scenes, fingerprints, previous, warnings = [], {}, [], []
        captured = 0; captured_releases = 0
        for row in timeline:
            version = row['version']; capture_id = row['captureId']; item = inputs[theme]['ready'].get(capture_id)
            if item is None or (limit_versions and capture_id not in limit_versions): continue
            source = json.loads(item['path'].read_text())
            if str(source.get('version')) != version: raise ValueError(f'{theme}/{version}: capture version does not match')
            if source.get('captureId') != capture_id: raise ValueError(f'{theme}/{capture_id}: capture ID does not match')
            if source.get('theme', theme) != theme: raise ValueError(f'{theme}/{version}: capture theme does not match')
            row['models'][theme] = source['renderedModel']
            parts = build_parts(source, previous)
            if len({part['key'] for part in parts}) != len(parts): raise ValueError(f'{theme}/{version}: duplicate part identities')
            if any(not isinstance(part['z'], int) for part in parts): raise ValueError(f'{theme}/{version}: CSS layer must be an integer')
            scene = {"background":source['background'], "viewport":source['viewport'], "parts":parts}
            key = fingerprint(scene)
            if key not in fingerprints:
                fingerprints[key] = len(scenes)
                scene['image'] = 'data:image/png;base64,' + base64.b64encode(item['image'].read_bytes()).decode()
                scene['fingerprint'] = key
                scenes.append(scene)
            scene = scenes[fingerprints[key]]
            if 'layouts' not in scene and (states := recorded_states(root, theme, capture_id, item['record']['revision'])):
                scene.update(interaction(source, scene['parts'], states))
            row['sceneIndices'][theme] = fingerprints[key]
            captured += 1; captured_releases += row['kind'] == 'release'; previous = parts
            capture_warnings = source.get('diagnostics', {}).get('warnings', [])
            if capture_warnings: warnings.append({"version":version, "captureWarnings":capture_warnings})
        release_count = sum(row['kind'] == 'release' for row in timeline)
        themes[theme] = {"scenes":scenes, "coverage":{"total":release_count, "captured":captured_releases, "unavailable":release_count - captured_releases, "uniqueScenes":len(scenes)},
            "timelineCoverage":{"total":len(timeline), "captured":captured, "unavailable":len(timeline) - captured, "uniqueScenes":len(scenes)},
            "diagnostics":{"captureWarnings":warnings}}
    captured_both = 0
    for row in timeline:
        if all(index is not None for index in row['sceneIndices'].values()):
            row['status'] = 'captured'; captured_both += 1
            records = [inputs[theme]['ready'][row['captureId']]['record'] for theme in THEME_INPUTS]
            layouts = [record.get('fixture', {}).get('navigationLayout') for record in records]
            if len(set(layouts)) != 1: raise ValueError(f"{row['version']}: themes have different navigation fixtures")
            sizes = [themes[theme]['scenes'][row['sceneIndices'][theme]]['viewport'] for theme in THEME_INPUTS]
            if any(size != sizes[0] for size in sizes): raise ValueError(f"{row['version']}: themes use different viewports")
            if layouts[0]: row['confidence'] = 'Original frontend · Navigation matched to October reference'
        else:
            row['confidence'] = 'Both themes awaiting verification'
    versions = [row for row in timeline if row['kind'] == 'release']
    release_captured = sum(row['status'] == 'captured' for row in versions)
    policy_sources = {}
    for event in (model_policy or {}).get("events", []):
        for evidence in event.get("evidence", []):
            if evidence.get("url"):
                policy_sources[evidence["url"]] = {"title":evidence.get("title") or evidence.get("section") or "Official model history", "url":evidence["url"]}
    return {"versions":versions, "timeline":timeline, "themes":themes,
        "coverage":{"total":len(versions), "captured":release_captured, "unavailable":len(versions) - release_captured},
        "timelineCoverage":{"total":len(timeline), "captured":captured_both, "unavailable":len(timeline) - captured_both},
        "sources":[{"title":"Official app packages and update feed", "url":"https://persistent.oaistatic.com/codex-app-prod/appcast.xml"}, {"title":"Codex public version history", "url":"https://github.com/Homebrew/homebrew-cask/commits/main/Casks/c/codex-app.rb"}, {"title":"Later desktop package history", "url":"https://github.com/Homebrew/homebrew-cask/commits/main/Casks/c/chatgpt.rb"}, *policy_sources.values()],
        "notes":[*((model_policy or {}).get(key) for key in ("policy", "dateConvention", "effortPolicy") if (model_policy or {}).get(key)), "App releases use official archive timestamps. Independently dated model changes use documented UTC dates; day precision does not imply a known rollout time. All transitions begin at or after their dated boundary.", "Each theme is rendered by the original frontend using the same sample data. Historical server-side flags cannot be established from packages alone.", "Both themes use the package's native appearance and sidebar defaults; the original fonts are not embedded, so text uses system fonts.", "The sample uses empty preferences and no dismissed announcements; historical voice capabilities and account entitlements are unverified.", "All discovered versions are retained. Identical content, geometry, and styles share a scene within each theme."]}


def share_markup(data):
    """Markup and state parts repeat across scenes and layouts. Store each markup
    string once in data['markup'] (a part's html is its index there), its style
    attributes as numbers into data['styles'], and each state part's look
    (everything but its position) once in data['looks']: a state part is
    [look, x, y, z]."""
    indices = {}
    def walk(value):
        if isinstance(value, dict):
            if isinstance(value.get('html'), str): value['html'] = indices.setdefault(value['html'], len(indices))
            for item in value.values(): walk(item)
        elif isinstance(value, list):
            for item in value: walk(item)
    walk(data['themes'])
    # A style attribute is a full computed style (~300 declarations, mostly shared): store
    # each as indices into data['declarations'], numbered in data['styles'].
    styles, declarations = {}, {}
    def numbered(match):
        if match[1] not in styles: styles[match[1]] = (len(styles), [declarations.setdefault(item, len(declarations)) for item in match[1].split('; ')])
        return f' style="{styles[match[1]][0]}"'
    markup = list(indices)
    data['markup'] = [re.sub(r' style="([^"]*)"', numbered, item) for item in markup]
    data['styles'] = [items for _, items in styles.values()]; data['declarations'] = list(declarations)
    # The player's expansion (markup() in player.js) must give back every string exactly.
    expand = lambda item: re.sub(r' style="(\d+)"', lambda match: ' style="' + '; '.join(data['declarations'][i] for i in data['styles'][int(match[1])]) + '"', item)
    assert all(expand(compact) == original for compact, original in zip(data['markup'], markup))
    looks = {}
    def place(change):
        if not change: return
        change['parts'] = [[looks.setdefault(json.dumps({k: v for k, v in part.items() if k not in ('x', 'y', 'z')}, sort_keys=True), len(looks)), part['x'], part['y'], part['z']] for part in change['parts']]
    for theme in data['themes'].values():
        for scene in theme['scenes']:
            for layout in scene.get('layouts', []):
                place(layout['state'])
                def nested(items):
                    for item in items: place(item['state']); nested(item['submenus'])
                for control in layout['controls']:
                    place(control['hover']); place(control.get('open'))
                    nested((control.get('open') or {}).get('submenus', []))
                if layout['editor']: place(layout['editor']['typed'])
    data['looks'] = [json.loads(look) for look in looks]


def prepare(limit_versions=None, dry_run=False, root=DATA):
    root = Path(root)
    if limit_versions and not dry_run: raise ValueError('--versions requires --dry-run; a partial dataset cannot replace the verified build')
    catalog = json.loads((root / 'timeline-catalog.json').read_text()); catalog.sort(key=timestamp)
    if len({entry['captureId'] for entry in catalog}) != len(catalog): raise ValueError('timeline contains duplicate capture IDs')
    inputs = capture_inputs(root, catalog)
    both_ready = set.intersection(*(set(inputs[theme]['ready']) for theme in THEME_INPUTS))
    readiness = {'total':len(catalog), 'captured':len(both_ready), 'unavailable':len(catalog) - len(both_ready)}
    if readiness['unavailable'] and not dry_run:
        return {'published':False, 'reason':'Both verified themes are required for every timeline state; existing prepared data is unchanged.',
            'coverage':readiness, 'themes':{theme:{'captured':len(value['ready']), 'unavailable':len(value['missing']), 'missingSample':value['missing'][:12]} for theme, value in inputs.items()}}
    model_policy = json.loads((root / 'model-rollout-policy.json').read_text())
    data = assemble(catalog, inputs, root, limit_versions, model_policy)
    summary = {'published':False, 'coverage':data['coverage'], 'timelineCoverage':data['timelineCoverage'], 'themes':{theme:value['coverage'] for theme, value in data['themes'].items()},
        'parts':{theme:sum(len(scene['parts']) for scene in value['scenes']) for theme, value in data['themes'].items()}}
    if dry_run:
        return {**summary, 'dryRun':True, 'readiness':readiness}
    if data['timelineCoverage']['unavailable']: raise ValueError('a published dataset must contain both themes for every timeline state')
    share_markup(data)
    data_temp = root / 'prepared-data.tmp.json'
    data_temp.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')))
    data_temp.replace(root / 'prepared-data.json')
    return {**summary, 'published':True, 'bytes':(root / 'prepared-data.json').stat().st_size}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dry-run', action='store_true', help='Validate available captures without replacing prepared data.')
    parser.add_argument('--versions', nargs='*', help='With --dry-run, assemble only these capture IDs while retaining the full timeline metadata.')
    args = parser.parse_args()
    print(json.dumps(prepare(set(args.versions) if args.versions else None, dry_run=args.dry_run), ensure_ascii=False))
