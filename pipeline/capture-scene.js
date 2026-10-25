async () => {
  await document.fonts.ready;
  const width = innerWidth, height = innerHeight;
  const version = window.__lab?.number || window.__historyVersion?.version || window.__historyVersion || 'unknown';
  const elements = [], warnings = [], resources = new Map();
  const styles = new WeakMap(), rectangles = new WeakMap(), contexts = new WeakMap(), clips = new WeakMap();
  const parentOf = el => el.parentElement || el.getRootNode()?.host || null;
  const parents = el => { const result = []; for (let p = el; p; p = parentOf(p)) result.push(p); return result; };
  const style = el => { if (!styles.has(el)) styles.set(el, getComputedStyle(el)); return styles.get(el); };
  const rect = el => {
    if (!rectangles.has(el)) { const r = el.getBoundingClientRect(); rectangles.set(el, {x:r.x, y:r.y, w:r.width, h:r.height}); }
    return rectangles.get(el);
  };
  const clean = text => String(text || '').trim().replace(/\s+/g, ' ');
  const colorVisible = color => color && color !== 'transparent' && !/^rgba\([^)]*,\s*0(?:\.0+)?\)$/.test(color) && !/\/\s*0(?:%|\.0+)?\s*\)$/.test(color);
  const radii = s => [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius];
  const border = s => ['Top', 'Right', 'Bottom', 'Left'].map(side => ({width:parseFloat(s[`border${side}Width`]) || 0, style:s[`border${side}Style`], color:s[`border${side}Color`]}));
  const intersects = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  const viewport = {x:0, y:0, w:width, h:height};
  const ownAttributes = el => {
    const out = {};
    for (const name of ['data-testid', 'data-test', 'data-slot', 'data-part', 'data-action', 'data-view', 'data-selected', 'data-state', 'data-orientation']) {
      if (el.hasAttribute(name)) out[name] = el.getAttribute(name);
    }
    return out;
  };
  const describe = el => ({tag:el.tagName, class:el.getAttribute('class'), role:el.getAttribute('role'), id:el.id || null,
    ariaLabel:el.getAttribute('aria-label'), title:el.getAttribute('title'), data:ownAttributes(el)});
  const isClippedAway = s => /^inset\(\s*50%(?:\s|\))/.test(s.clipPath) || /^rect\(\s*0(?:px)?[ ,]+0(?:px)?[ ,]+0(?:px)?[ ,]+0(?:px)?\s*\)$/.test(s.clip);
  const hasOverflowClip = value => /^(hidden|clip|auto|scroll)$/.test(value);
  const formsPositioningContext = (el, fixed) => {
    const s = style(el);
    if (s.display === 'contents') return false;
    return (!fixed && s.position !== 'static') || s.transform !== 'none' || s.perspective !== 'none' ||
      s.filter !== 'none' || s.backdropFilter !== 'none' ||
      [s.translate, s.rotate, s.scale].some(value => value && value !== 'none') ||
      /(^|\s)(layout|paint|strict|content)(\s|$)/.test(s.contain) ||
      /(^|,|\s)(transform|perspective|filter|backdrop-filter)(,|\s|$)/.test(s.willChange) || s.contentVisibility === 'auto';
  };
  const escapedOverflowAncestors = el => {
    const escaped = new Set();
    for (const positioned of parents(el)) {
      const position = style(positioned).position;
      if (position !== 'absolute' && position !== 'fixed') continue;
      // Chromium's offsetParent resolves transformed and contained fixed-position
      // containing blocks as well as ordinary absolute-position containing blocks.
      // A null fixed offsetParent means the viewport. SVG roots lack offsetParent,
      // so use CSS positioning contexts only for that uncommon case.
      const containingBlock = 'offsetParent' in positioned ? positioned.offsetParent :
        parents(positioned).slice(1).find(p => formsPositioningContext(p, position === 'fixed'));
      for (let p = parentOf(positioned); p && p !== containingBlock; p = parentOf(p)) escaped.add(p);
    }
    return escaped;
  };
  const clipFor = el => {
    if (clips.has(el)) return clips.get(el);
    const bounds = {...viewport}, ancestors = [];
    const escaped = escapedOverflowAncestors(el);
    for (const p of parents(el).slice(1)) {
      const s = style(p), r = rect(p);
      if (s.display === 'contents') continue;
      const paint = /(^|\s)(paint|strict|content)(\s|$)/.test(s.contain);
      const clipX = (!escaped.has(p) && hasOverflowClip(s.overflowX)) || paint;
      const clipY = (!escaped.has(p) && hasOverflowClip(s.overflowY)) || paint;
      if (!clipX && !clipY && s.clipPath === 'none') continue;
      // Overflow clips at the padding box. Keep its rounded outline as well as
      // the rectangular intersection; consumers can apply both without moving glyphs.
      const left = parseFloat(s.borderLeftWidth) || 0, top = parseFloat(s.borderTopWidth) || 0;
      const right = parseFloat(s.borderRightWidth) || 0, bottom = parseFloat(s.borderBottomWidth) || 0;
      const cr = {x:r.x + left, y:r.y + top, w:Math.max(0, r.w - left - right), h:Math.max(0, r.h - top - bottom)};
      ancestors.push({...cr, radius:radii(s), borderInsets:[top, right, bottom, left], clipX, clipY, clipPath:s.clipPath, source:describe(p)});
      if (clipX) { const edge = Math.min(bounds.x + bounds.w, cr.x + cr.w); bounds.x = Math.max(bounds.x, cr.x); bounds.w = Math.max(0, edge - bounds.x); }
      if (clipY) { const edge = Math.min(bounds.y + bounds.h, cr.y + cr.h); bounds.y = Math.max(bounds.y, cr.y); bounds.h = Math.max(0, edge - bounds.y); }
    }
    const result = {rect:bounds, ancestors};
    clips.set(el, result);
    return result;
  };
  const visible = (el, r = rect(el)) => {
    if (r.w <= 0 || r.h <= 0 || !intersects(r, viewport)) return false;
    if (style(el).visibility !== 'visible') return false;
    for (const p of parents(el)) {
      const s = style(p);
      if (s.display === 'none' || Number(s.opacity) === 0 || isClippedAway(s) || s.contentVisibility === 'hidden') return false;
      // Accessibility announcement regions often have real text but a one-pixel
      // offscreen box. Do not drop aria-hidden SVG icons, which are still painted.
      if ((p.hasAttribute('aria-live') || /^(status|log|alert)$/.test(p.getAttribute('role') || '')) &&
          rect(p).w <= 1 && rect(p).h <= 1) return false;
    }
    const c = clipFor(el).rect;
    return c.w > 0 && c.h > 0 && intersects(r, c);
  };
  const opacity = el => parents(el).reduce((value, p) => value * Number(style(p).opacity), 1);
  const label = el => {
    const labelledBy = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
      .map(id => el.getRootNode().getElementById?.(id) || document.getElementById(id)).filter(Boolean).map(node => clean(node.textContent)).join(' ');
    return clean(el.getAttribute('aria-label') || labelledBy || el.getAttribute('title') || el.innerText || el.textContent).slice(0, 160);
  };
  const context = el => {
    if (contexts.has(el)) return contexts.get(el);
    const chain = parents(el), control = chain.find(p => p.matches('button,a,[role="button"],[role="menuitem"],[role="menuitemradio"],[role="combobox"],input,textarea'));
    const landmarks = chain.filter(p => p.matches('main,aside,nav,header,footer,form,[role="main"],[role="navigation"],[role="complementary"],[role="banner"],[role="contentinfo"],[role="search"],[role="toolbar"],[role="dialog"]'))
      .map(p => ({tag:p.tagName.toLowerCase(), role:p.getAttribute('role'), label:clean(p.getAttribute('aria-label')), id:p.id || null}));
    const components = [...new Set(chain.flatMap(p => (p.getAttribute('class') || '').split(/\s+/).map(c => /^_([^_]+)_[a-zA-Z0-9]+_\d+/.exec(c)?.[1]).filter(Boolean)))];
    const ancestorClasses = chain.map(p => p.getAttribute('class') || '').join(' ');
    let region = 'surface';
    if (/composer|chat-input|prompt-input/i.test(components.join(' ') + ' ' + ancestorClasses)) region = 'composer';
    else if (/sidebar-navigation|app-shell-left-panel|\bSidebar[A-Z_]|\bsidebar-/i.test(ancestorClasses)) region = 'sidebar';
    else if (chain.some(p => p.matches('nav,[role="navigation"]'))) region = 'navigation';
    else if (chain.some(p => p.matches('main,[role="main"]'))) region = 'main';
    else if (/Titlebar|TitleBar|WindowControls|AppHeader/.test(components.join(' ')) || chain.some(p => p.matches('header,[role="banner"]'))) region = 'chrome';
    else if (chain.some(p => p.matches('aside,[role="complementary"]'))) region = 'sidebar';
    const result = {
      hint:control ? label(control) : clean(el.getAttribute('aria-label') || el.getAttribute('title')),
      source:{...describe(el), ancestors:chain.slice(1, 9).map(describe)},
      semantic:{region, controlLabel:control ? label(control) : null, controlRole:control ? control.getAttribute('role') || control.tagName.toLowerCase() : null,
        controlAttributes:control ? ownAttributes(control) : {}, landmarks, components},
      clip:clipFor(el)
    };
    contexts.set(el, result);
    return result;
  };
  const copyStyles = (original, clone) => {
    if (!clone || original.nodeType !== Node.ELEMENT_NODE) return;
    const s = style(original);
    for (const property of s) if (!property.startsWith('--')) clone.style.setProperty(property, s.getPropertyValue(property));
    for (let i = 0; i < original.children.length; i++) copyStyles(original.children[i], clone.children[i]);
    clone.removeAttribute('class');
    for (const attr of [...clone.attributes]) if (/^on/i.test(attr.name)) clone.removeAttribute(attr.name);
  };
  // A surface can round itself with its own clip-path instead of border-radius
  // (the October app shell does); ancestor clips are recorded by clipFor.
  const paint = s => ({background:s.backgroundColor, backgroundImage:s.backgroundImage, borders:border(s), radius:radii(s), shadow:s.boxShadow,
    filter:s.filter, backdropFilter:s.backdropFilter, mixBlendMode:s.mixBlendMode, clipPath:s.clipPath});
  const hasPaint = s => colorVisible(s.backgroundColor) || s.backgroundImage !== 'none' || s.boxShadow !== 'none' || border(s).some(b => b.width > 0 && b.style !== 'none' && colorVisible(b.color));
  const add = (el, item) => elements.push({...context(el), ...item});
  const embeddedResource = async url => {
    if (!url) return '';
    if (resources.has(url)) return resources.get(url);
    const result = (async () => {
      try {
        const resolved = new URL(url, location.href);
        if (resolved.protocol === 'data:') return url;
        if (resolved.origin !== location.origin && resolved.protocol !== 'blob:') throw new Error('external resource');
        const response = await fetch(resolved.href);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        return await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob); });
      } catch (error) { warnings.push({kind:'resource-not-embedded', url, reason:String(error)}); return url; }
    })();
    resources.set(url, result);
    return result;
  };
  const wrapper = document.createElement('div');
  wrapper.style.cssText = `position:fixed;left:${width + 1024}px;top:${height + 1024}px;width:${width}px;height:${height}px;pointer-events:none;visibility:hidden;z-index:-2147483648`;
  const all = [];
  const visit = root => { for (const el of root.children) { all.push(el); if (el.shadowRoot) visit(el.shadowRoot); visit(el); } };
  visit(document.body);
  const ignoredTag = /^(script|style|title|template|noscript|link|meta|head|option)$/;
  document.body.append(wrapper);
  try {
    for (const el of all) {
      const tag = el.tagName.toLowerCase(), r = rect(el), s = style(el);
      if (ignoredTag.test(tag) || parents(el).slice(1).some(p => p.tagName.toLowerCase() === 'svg') || !visible(el, r)) continue;
      if (tag === 'svg') {
        const clone = el.cloneNode(true); copyStyles(el, clone);
        // Sprite references inside this document must travel with their icon.
        const referenced = new Set();
        for (const use of [...clone.querySelectorAll('use')]) {
          const href = use.getAttribute('href') || use.getAttribute('xlink:href') || '';
          const id = href.startsWith('#') ? href.slice(1) : null;
          const target = id && ![...el.querySelectorAll('[id]')].some(node => node.id === id) && document.getElementById(id);
          if (target && !referenced.has(id)) {
            referenced.add(id);
            const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs'), content = target.cloneNode(true);
            copyStyles(target, content); defs.append(content); clone.prepend(defs);
          }
        }
        const nodes = [clone, ...clone.querySelectorAll('*')];
        const prefix = `history-${String(version).replace(/[^a-zA-Z0-9_-]/g, '-')}-${elements.length}-`;
        const idMap = new Map(nodes.filter(node => node.id).map(node => [node.id, prefix + node.id]));
        for (const node of nodes) {
          if (idMap.has(node.id)) node.id = idMap.get(node.id);
          for (const attr of [...node.attributes]) {
            let value = attr.value.replace(/url\(["']?[^)]*?#([^"')]+)["']?\)/g, (whole, id) => idMap.has(id) ? `url(#${idMap.get(id)})` : whole);
            if ((attr.name === 'href' || attr.name === 'xlink:href') && idMap.has(value.slice(1))) value = '#' + idMap.get(value.slice(1));
            node.setAttribute(attr.name, value);
          }
          if (node.tagName.toLowerCase() === 'image') {
            const attr = node.hasAttribute('href') ? 'href' : 'xlink:href';
            if (node.getAttribute(attr)) node.setAttribute(attr, await embeddedResource(node.getAttribute(attr)));
          }
        }
        // Keep pure reflections/rotations used by navigation arrows. Their
        // measured bounds already include position, so remove translation.
        let transform = 'none';
        if (s.transform !== 'none') {
          const m = new DOMMatrix(s.transform);
          if (m.is2D && Math.abs(Math.hypot(m.a, m.b) - 1) < 0.001 && Math.abs(Math.hypot(m.c, m.d) - 1) < 0.001) transform = `matrix(${m.a},${m.b},${m.c},${m.d},0,0)`;
          else warnings.push({kind:'non-unit-svg-transform', transform:s.transform, hint:context(el).hint});
        }
        Object.assign(clone.style, {width:'100%', height:'100%', margin:'0', position:'static', transform, transformOrigin:'center', opacity:'1'});
        add(el, {kind:'svg', ...r, opacity:opacity(el), html:clone.outerHTML,
          svgSignature:[...el.querySelectorAll('path')].map(path => path.getAttribute('d')).join('|')});
        continue;
      }
      if (hasPaint(s)) add(el, {kind:'box', ...r, opacity:opacity(el), ...paint(s)});
      for (const pseudo of ['::before', '::after']) {
        const p = getComputedStyle(el, pseudo);
        if (!['""', "''"].includes(p.content) || p.display === 'none' || p.visibility !== 'visible' || Number(p.opacity) === 0 || !hasPaint(p)) continue;
        let pr = {...r};
        if (p.position === 'absolute' || p.position === 'fixed') {
          const base = p.position === 'fixed' ? viewport : {...r, x:r.x + (parseFloat(s.borderLeftWidth) || 0), y:r.y + (parseFloat(s.borderTopWidth) || 0),
            w:r.w - (parseFloat(s.borderLeftWidth) || 0) - (parseFloat(s.borderRightWidth) || 0), h:r.h - (parseFloat(s.borderTopWidth) || 0) - (parseFloat(s.borderBottomWidth) || 0)};
          const pw = parseFloat(p.width), ph = parseFloat(p.height);
          const addWidth = p.boxSizing === 'border-box' ? 0 : (parseFloat(p.paddingLeft) || 0) + (parseFloat(p.paddingRight) || 0) + (parseFloat(p.borderLeftWidth) || 0) + (parseFloat(p.borderRightWidth) || 0);
          const addHeight = p.boxSizing === 'border-box' ? 0 : (parseFloat(p.paddingTop) || 0) + (parseFloat(p.paddingBottom) || 0) + (parseFloat(p.borderTopWidth) || 0) + (parseFloat(p.borderBottomWidth) || 0);
          pr.w = Number.isFinite(pw) ? pw + addWidth : base.w; pr.h = Number.isFinite(ph) ? ph + addHeight : base.h;
          pr.x = base.x + (p.left !== 'auto' ? parseFloat(p.left) || 0 : p.right !== 'auto' ? base.w - (parseFloat(p.right) || 0) - pr.w : 0) + (parseFloat(p.marginLeft) || 0);
          pr.y = base.y + (p.top !== 'auto' ? parseFloat(p.top) || 0 : p.bottom !== 'auto' ? base.h - (parseFloat(p.bottom) || 0) - pr.h : 0) + (parseFloat(p.marginTop) || 0);
        } else if (!el.matches('button[data-selected]')) {
          warnings.push({kind:'unmeasured-pseudo', pseudo, hint:context(el).hint}); continue;
        }
        if (p.transform !== 'none') {
          const m = new DOMMatrix(p.transform);
          if (m.is2D && m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1) { pr.x += m.e; pr.y += m.f; }
          else { warnings.push({kind:'unmeasured-pseudo-transform', pseudo, hint:context(el).hint}); continue; }
        }
        if (visible(el, pr)) add(el, {kind:'box', ...pr, opacity:opacity(el) * Number(p.opacity), ...paint(p), source:{...context(el).source, pseudo}});
      }
      if (tag === 'img') {
        const clone = el.cloneNode(false); copyStyles(el, clone);
        const originalSrc = el.currentSrc || el.src, src = await embeddedResource(originalSrc);
        clone.removeAttribute('srcset'); clone.removeAttribute('sizes'); clone.removeAttribute('loading'); clone.removeAttribute('id'); clone.src = src;
        Object.assign(clone.style, {width:'100%', height:'100%', margin:'0', position:'static', transform:'none', opacity:'1', border:'0', background:'transparent', boxShadow:'none'});
        add(el, {kind:'img', ...r, opacity:opacity(el), src, originalSrc, alt:el.alt, html:clone.outerHTML, objectFit:s.objectFit, objectPosition:s.objectPosition});
        if (!el.complete || !el.naturalWidth) warnings.push({kind:'image-not-loaded', src:originalSrc});
        continue;
      }
      for (const node of [...el.childNodes]) {
        if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim() || tag === 'textarea') continue;
        const range = document.createRange(); range.selectNodeContents(node);
        const b = range.getBoundingClientRect(), rt = {x:b.x, y:b.y, w:b.width, h:b.height};
        if (rt.w < 2 || rt.h < 2 || !visible(el, rt)) continue;
        const leaf = el.childNodes.length === 1;
        let fragments = [{text:node.textContent, rect:rt}];
        if (!leaf && range.getClientRects().length > 1) {
          // A text node following an inline skill chip can occupy the end of
          // one line and the start of the next. A bounding box loses that first
          // line's indentation, so preserve each painted line separately.
          fragments = [];
          const characters = new Intl.Segmenter(undefined, {granularity:'grapheme'}).segment(node.textContent);
          for (const character of characters) {
            const probe = document.createRange(); probe.setStart(node, character.index); probe.setEnd(node, character.index + character.segment.length);
            const cr = probe.getBoundingClientRect();
            if (cr.width < 0.01 || cr.height < 0.01) continue;
            let fragment = fragments.at(-1);
            if (!fragment || Math.abs(fragment.rect.y - cr.y) > 0.5) {
              fragment = {text:'', rect:{x:cr.x, y:cr.y, w:cr.width, h:cr.height}}; fragments.push(fragment);
            }
            fragment.text += character.segment;
            const left = Math.min(fragment.rect.x, cr.x), right = Math.max(fragment.rect.x + fragment.rect.w, cr.x + cr.width);
            fragment.rect.x = left; fragment.rect.w = right - left; fragment.rect.h = Math.max(fragment.rect.h, cr.height);
          }
        }
        for (let lineIndex = 0; lineIndex < fragments.length; lineIndex++) {
          const fragment = fragments[lineIndex], glyphRect = fragment.rect;
          if (!fragment.text.trim() || !visible(el, glyphRect)) continue;
          const clone = leaf ? el.cloneNode(true) : document.createElement('span');
          if (!leaf) clone.textContent = fragment.text;
          copyStyles(el, clone); clone.removeAttribute('id');
          const target = leaf ? r : glyphRect;
          Object.assign(clone.style, {position:'absolute', left:'0', top:'0', right:'auto', bottom:'auto', width:`${target.w}px`, height:`${target.h}px`, minWidth:'0', maxWidth:'none', minHeight:'0', maxHeight:'none', margin:'0', boxSizing:'border-box', transform:'none', opacity:'1', background:'transparent', borderColor:'transparent', boxShadow:'none', animation:'none', transition:'none'});
          if (!leaf) Object.assign(clone.style, {padding:'0', border:'0', display:'block', whiteSpace:'pre', overflow:'visible', textOverflow:'clip'});
          wrapper.append(clone);
          // Measure an actual range in the cloned line box, preserving its glyph baseline.
          const cloneRange = document.createRange(); cloneRange.selectNodeContents(clone);
          const cr = cloneRange.getBoundingClientRect(), wr = wrapper.getBoundingClientRect();
          const x = glyphRect.x - (cr.x - wr.x), y = glyphRect.y - (cr.y - wr.y);
          clone.style.position = 'static'; clone.style.width = '100%'; clone.style.height = '100%';
          add(el, {kind:'text', x, y, w:target.w, h:target.h, opacity:opacity(el), text:clean(fragment.text), html:clone.outerHTML,
            color:s.color, fontSize:parseFloat(s.fontSize), fontFamily:s.fontFamily, fontWeight:s.fontWeight, lineHeight:s.lineHeight,
            textAlign:s.textAlign, direction:s.direction, glyphRect,
            source:{...context(el).source, textNodeIndex:[...el.childNodes].indexOf(node), lineIndex}});
          clone.remove();
        }
      }
      if (el.matches('textarea[placeholder],input[placeholder]') && !el.value && el.matches(':placeholder-shown')) {
        const p = getComputedStyle(el, '::placeholder');
        if (colorVisible(p.color) && p.visibility === 'visible' && Number(p.opacity) > 0) {
          const left = (parseFloat(s.borderLeftWidth) || 0) + (parseFloat(s.paddingLeft) || 0), right = (parseFloat(s.borderRightWidth) || 0) + (parseFloat(s.paddingRight) || 0);
          const top = (parseFloat(s.borderTopWidth) || 0) + (parseFloat(s.paddingTop) || 0), bottom = (parseFloat(s.borderBottomWidth) || 0) + (parseFloat(s.paddingBottom) || 0);
          const pr = {x:r.x + left, y:r.y + top, w:Math.max(0, r.w - left - right), h:Math.max(0, r.h - top - bottom)};
          const lineHeight = parseFloat(p.lineHeight) || parseFloat(p.fontSize) * 1.2;
          if (tag === 'input') { pr.y += Math.max(0, (pr.h - lineHeight) / 2); pr.h = Math.min(pr.h, lineHeight); }
          add(el, {kind:'placeholder', ...pr, opacity:opacity(el) * Number(p.opacity), hint:'composer-placeholder', text:el.placeholder,
            color:p.color, fontSize:parseFloat(p.fontSize), fontFamily:p.fontFamily, fontWeight:p.fontWeight, lineHeight:p.lineHeight,
            letterSpacing:p.letterSpacing, textAlign:s.textAlign, textIndent:s.textIndent, whiteSpace:tag === 'textarea' ? 'pre-wrap' : 'pre', direction:s.direction,
            source:{...context(el).source, pseudo:'::placeholder'}});
        }
      } else if (el.matches('[data-placeholder]')) {
        let pseudo = '::before', p = getComputedStyle(el, pseudo);
        if (p.content === 'none' || p.content === 'normal') { pseudo = '::after'; p = getComputedStyle(el, pseudo); }
        if (!['none', 'normal', '""', "''"].includes(p.content) && p.display !== 'none' && p.visibility === 'visible' && Number(p.opacity) > 0 && colorVisible(p.color)) {
          add(el, {kind:'placeholder', ...r, opacity:opacity(el) * Number(p.opacity), hint:'composer-placeholder', text:el.dataset.placeholder,
            color:p.color, fontSize:parseFloat(p.fontSize), fontFamily:p.fontFamily, fontWeight:p.fontWeight, lineHeight:p.lineHeight,
            letterSpacing:p.letterSpacing, textAlign:p.textAlign, direction:p.direction, source:{...context(el).source, pseudo}});
        }
      }
    }
  } finally { wrapper.remove(); }
  const fontFaces = [];
  const readRules = (rules, base) => { for (const rule of rules) { if (rule.type === CSSRule.FONT_FACE_RULE) fontFaces.push({css:rule.cssText, base}); else if (rule.cssRules) readRules(rule.cssRules, base); } };
  for (const sheet of document.styleSheets) try { readRules(sheet.cssRules, sheet.href || location.href); } catch (error) { warnings.push({kind:'unreadable-stylesheet', href:sheet.href, reason:String(error)}); }
  const visibleInputs = all.filter(el => el.matches('textarea,input,[contenteditable]') && visible(el));
  const diagnostics = {
    schemaVersion:2, shadowHosts:all.filter(el => el.shadowRoot).map(el => el.tagName),
    inputs:visibleInputs.map(el => el.outerHTML.slice(0, 2000)),
    top:all.filter(el => el.tagName.toLowerCase() === 'svg' && rect(el).y < 50 && visible(el)).map(el => ({rect:rect(el), html:el.outerHTML.slice(0, 250), parents:parents(el).slice(0, 8).map(p => ({...describe(p), rect:rect(p), display:style(p).display, opacity:style(p).opacity, overflow:style(p).overflow}))})),
    placeholder:elements.filter(el => el.kind === 'placeholder').map(el => ({rect:{x:el.x, y:el.y, w:el.w, h:el.h}, text:el.text, source:el.source})),
    warnings,
    clipping:{elementsWithAncestorClips:elements.filter(el => el.clip.ancestors.length).length, nonRectangular:elements.flatMap(el => el.clip.ancestors.filter(clip => clip.clipPath !== 'none').map(clip => clip.clipPath)).filter((path, i, allPaths) => allPaths.indexOf(path) === i)}
  };
  return {version, viewport:{width, height}, background:style(document.body).backgroundColor, elements, fontFaces, bodyText:document.body.innerText, diagnostics};
}
