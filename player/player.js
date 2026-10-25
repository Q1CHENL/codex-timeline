// @ts-check
// Codex Timeline player. build-page.py inlines this file into player.html.

/**
 * Payload embedded by build-page.py (`player_payload`). The build only emits
 * complete data: every timeline entry has a scene in both themes.
 *
 * @typedef {'dark'|'light'} Theme
 * @typedef {'layout'|'navigation'|'hero'|'announcement'|'composer'|'chrome'|'cards'} Group
 * @typedef {{width:number,style:string,color:string}} Border
 *
 * @typedef {object} Part One positioned element of a captured home screen.
 * @property {string} key Stable identity used to pair parts across scenes.
 * @property {Group} group
 * @property {'box'|'text'|'placeholder'|'svg'|'img'} kind
 * @property {number} x
 * @property {number} y
 * @property {number} w
 * @property {number} h
 * @property {number} z
 * @property {number} opacity
 * @property {string} [clipCSS]
 * @property {number} [html] Captured markup: an index into the payload's `assets`, expanded by markup().
 * @property {string} [text]
 * @property {string} [color]
 * @property {number} [fontSize]
 * @property {string} [fontFamily]
 * @property {string} [fontWeight]
 * @property {string} [lineHeight]
 * @property {string} [letterSpacing]
 * @property {string} [textAlign]
 * @property {string} [direction]
 * @property {string} [textIndent]
 * @property {string} [whiteSpace]
 * @property {string} [background]
 * @property {string} [backgroundImage]
 * @property {string[]} [radius]
 * @property {Border[]} [borders]
 * @property {string} [shadow]
 * @property {string} [filter]
 * @property {string} [backdropFilter]
 * @property {string} [mixBlendMode]
 *
 * @typedef {{parts:Part[],hide:string[]}} Delta Parts a state adds or restyles, and parts of the screen beneath it that it hides.
 * @typedef {{rect:number[],by:'hover'|'click',panel:number[],state:number,submenus:Submenu[]}} Submenu An item of an open menu that opens more (a submenu on hover; a popover, dialog or section on click), the bounds of everything then open, that state, and what its own items open.
 * @typedef {{panel:number[],state:number,submenus:Submenu[]}} Opened The menu, popover or dialog a click opens (a state), the panel's bounds, and its submenus.
 * @typedef {{label:string,rect:number[],hover:number|null,open?:Opened,toggle?:number}} Control A control and its recorded hover state, and the menu it opens or the layout (an index into the scene's `layouts`) it toggles to.
 * @typedef {{rect:number[],text:Part,typed:number}} Editor The composer: typed text styled like `text`, and the state once it has text.
 * @typedef {{state:number|null,controls:Control[],editor:Editor|null}} Layout The scene (layout 0) or a layout its toggles lead to: the change over the scene, and the controls and composer that respond in it.
 * @typedef {{background:string,parts:Part[],layouts?:Layout[]}} Scene
 * @typedef {{model:string,visibleLabel:string}} Model
 *
 * @typedef {object} TimelineEntry An app release or a dated model change.
 * @property {string} version
 * @property {string} captureId
 * @property {'release'|'model'} kind
 * @property {string} date YYYY-MM-DD (UTC).
 * @property {string} archivedAt ISO timestamp positioning the entry on the timeline.
 * @property {Record<Theme,number>} sceneIndices
 * @property {Record<Theme,Model>} models
 *
 * @typedef {object} Payload
 * @property {number} versionCount Public app versions; the timeline also holds model changes.
 * @property {TimelineEntry[]} timeline
 * @property {Record<Theme,{scenes:Scene[]}>} themes
 * @property {{counts:number[],hide:string[][],look:number[],x:number[],y:number[],z:number[]}} states Every
 *   state, referred to by index: how many parts each has and the parts it hides, and all
 *   their parts in order, as columns (a look and its position).
 * @property {Omit<Part,'x'|'y'|'z'>[]} looks State parts without their position, stored once.
 * @property {string[]} assets Markup shared by many parts, stored once; each ` style="n"` names an entry of `styles`.
 * @property {number[][]} styles Style attributes as indices into `declarations`.
 * @property {string[]} declarations CSS declarations shared by many styles.
 *
 * @typedef {object} PartItem A rendered part interpolating from scene `a` to scene `b`.
 * @property {string} key
 * @property {Group} group
 * @property {Part|undefined} a
 * @property {Part|undefined} b
 * @property {HTMLDivElement} part
 * @property {HTMLDivElement|null} oldLayer
 * @property {HTMLDivElement|null} newLayer
 * @property {boolean} sameText
 * @property {boolean} sameMarkup
 * @property {Animation|null} animation
 * @property {Animation|null} clipAnimation
 * @property {0|1} appearanceSide
 * @property {Keyframe} [textFrom]
 * @property {Keyframe} [textTo]
 *
 * @typedef {{first:Box,last:Box}} Route
 * @typedef {{x:number,y:number,w:number,h:number}} Box
 */

(() => {
  'use strict';
  /** @param {string} id */
  const $ = id => /** @type {HTMLElement} */ (document.getElementById(id));
  const stage = $('stage'), shell = $('stage-shell');
  const slider = /** @type {HTMLInputElement} */ ($('timeline'));
  const playButton = /** @type {HTMLButtonElement} */ ($('play'));
  const previousButton = /** @type {HTMLButtonElement} */ ($('previous'));
  const nextButton = /** @type {HTMLButtonElement} */ ($('next'));
  const themeToggle = $('theme-toggle');
  const saveButton = /** @type {HTMLButtonElement} */ ($('save-image'));
  const aboutDialog = /** @type {HTMLDialogElement} */ ($('about-dialog'));
  const versionCurrent = $('version-current'), layoutCurrent = $('layout-current');
  const readout = $('version-readout'), ticksElement = $('ticks'), monthsElement = $('months');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  /** @type {Theme[]} */
  const themeNames = ['dark','light'];
  const themeStorageKey = 'codex-timeline-theme';
  /** @param {number} v */
  const clamp = v => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
  /** @param {number} v */
  const smooth = v => v * v * (3 - 2 * v);
  /** @param {number} a @param {number} b @param {number} t */
  const lerp = (a, b, t) => a + (b - a) * t;
  /** @param {unknown} v */
  const finite = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
  /** Staggered [start, end] windows within a transition, per part group. @type {Record<Group,[number,number]>} */
  const timings = {layout:[0,.7],navigation:[.02,.7],hero:[.06,.67],announcement:[.13,.94],composer:[.12,.87],chrome:[.03,.75],cards:[.1,.86]};
  /** How long one screen takes to morph into the next, in real time. */
  const MORPH_MS = 700;
  const playIcon = '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M7.25 3.65C6.5 3.21 5.55 3.75 5.55 4.62V15.38C5.55 16.25 6.5 16.79 7.25 16.35L16.45 10.97C17.19 10.54 17.19 9.46 16.45 9.03L7.25 3.65Z"/></svg>';
  const pauseIcon = '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><rect x="5" y="4" width="3" height="12" rx="1.3"/><rect x="12" y="4" width="3" height="12" rx="1.3"/></svg>';
  const DAY = 86400000, WEEK = 7*DAY;

  /** @type {Payload} */
  let data;
  /** Timeline entries for the active theme; `sceneIndex` selects its scene. @type {(TimelineEntry & {sceneIndex:number})[]} */
  let versions = [];
  /** @type {Scene[]} */
  let scenes = [];
  /** Archive time of each timeline entry, in milliseconds. @type {number[]} */
  let releaseTimes = [];
  /** Timeline position (0–1) of each entry. @type {number[]} */
  let releasePositions = [];
  /** Per entry: how many app releases are on the timeline up to and including it. @type {number[]} */
  let releaseOrdinals = [];
  /** Entries where either theme changes layout, plus the last entry. @type {number[]} */
  let anchors = [];
  let startTime = 0, endTime = 0;
  /** @type {HTMLElement[]} */
  let ticks = [];
  /** Timeline position (0–1) of each tick, ascending. @type {number[]} */
  let tickPositions = [];
  /** @type {{key:string,fromIndex:number,toIndex:number,route:Route|null,sameScene:boolean}|null} */
  let currentPair = null;
  /** @type {Theme} */
  let theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  /** @type {number|null} */
  let renderedLocal = null;
  /** @type {PartItem[]} */
  let parts = [];
  let progress = 0, selectedIndex = 0, explicitSelection = false;
  let playing = false, direction = 1, raf = 0;
  /** The entry whose screen is shown when no morph is running. */
  let shownIndex = 0;
  /**
   * A running morph between two entries' screens. `t` runs toward 1 (the
   * `toIndex` screen) or, after the selection turns back, toward 0.
   * @type {{fromIndex:number,toIndex:number,t:number,direction:1|-1,last:number}|null}
   */
  let morph = null;
  let morphRaf = 0;
  /** @type {Animation|null} */
  let backgroundAnimation = null;
  let initialized = false;

  /** @param {string} value YYYY-MM-DD or an ISO timestamp. */
  function dateText(value) {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return match ? `${match[1]}.${match[2]}.${match[3]}` : value;
  }

  // Theme

  function applyThemeAppearance() {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    themeToggle.setAttribute('aria-checked',String(theme === 'dark'));
    themeToggle.title = `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`;
  }
  function activateThemeScenes() {
    scenes = data.themes[theme].scenes;
    versions = data.timeline.map(version=>({...version,sceneIndex:version.sceneIndices[theme]}));
  }
  function updateArchiveDetails() {
    $('version-total').textContent = String(data.versionCount);
    $('layout-total').textContent = String(scenes.length);
  }
  /** @param {string} next */
  function setTheme(next) {
    if (next !== 'dark' && next !== 'light') return;
    const changed = next !== theme;
    theme = next; applyThemeAppearance();
    try { localStorage.setItem(themeStorageKey,theme); } catch {}
    if (!initialized || !changed) return;
    // Reuse the shared timeline position and playback clock; only the native scene changes.
    activateThemeScenes(); updateArchiveDetails(); endMorph(); destroyParts();
    if (explicitSelection) renderSelectedVersion(); else setProgress(progress);
    resize();
  }

  // Scene parts

  /** @param {Scene} scene */
  function background(scene) {
    const color = scene.background;
    return !color || color === 'transparent' || /^rgba\([^)]*,\s*0\)$/.test(color) ? 'Canvas' : color;
  }
  /** @param {string} title @param {string} detail */
  function showMessage(title, detail, note = '') {
    $('message-title').textContent = title;
    $('message-detail').textContent = detail;
    $('message-note').textContent = note;
    $('stage-message').hidden = false;
    stage.hidden = true;
  }
  /** @param {Part} element @returns {Keyframe} */
  function boxStyle(element) {
    const radius = element.radius || ['0px','0px','0px','0px'];
    /** @type {Keyframe} */
    const style = {
      backgroundColor:element.background || 'transparent', backgroundImage:element.backgroundImage || 'none',
      borderTopLeftRadius:radius[0], borderTopRightRadius:radius[1], borderBottomRightRadius:radius[2], borderBottomLeftRadius:radius[3],
      boxShadow:element.shadow || 'none', filter:element.filter || 'none',
      backdropFilter:element.backdropFilter || 'none', mixBlendMode:element.mixBlendMode || 'normal'
    };
    ['Top','Right','Bottom','Left'].forEach((side, index) => {
      const border = element.borders?.[index];
      const width = finite(border?.width);
      style[`border${side}Width`] = width + 'px';
      // An invisible border can retain an opaque computed currentColor.
      // Fade from transparency instead of revealing that color as width interpolates.
      style[`border${side}Color`] = width > 0 && border?.style !== 'none' && border?.style !== 'hidden' ? (border?.color || 'transparent') : 'transparent';
      style[`border${side}Style`] = border?.style || 'none';
    });
    return style;
  }
  /** Expanded markup by asset index, built the first time a part draws it. @type {Map<number,string>} */
  const markups = new Map();
  /** @param {number} index */
  function markup(index) {
    let html = markups.get(index);
    if (html === undefined) {
      const {assets, styles, declarations} = /** @type {Payload} */ (data);
      html = assets[index].replace(/ style="(\d+)"/g, (_, style) => ` style="${styles[Number(style)].map(item => declarations[item]).join('; ')}"`);
      markups.set(index, html);
    }
    return html;
  }
  /** Decoded states by index, and where each one's parts start in the columns. @type {Map<number,Delta>} */
  const decodedStates = new Map();
  /** @type {number[]} */
  let stateStarts = [];
  /** @param {number} index @returns {Delta} */
  function delta(index) {
    let found = decodedStates.get(index);
    if (!found) {
      const {states, looks} = /** @type {Payload} */ (data);
      if (!stateStarts.length) stateStarts = states.counts.reduce((starts, count) => (starts.push(starts[starts.length - 1] + count), starts), [0]);
      const parts = [];
      for (let i = stateStarts[index]; i < stateStarts[index + 1]; i++) parts.push({...looks[states.look[i]], x:states.x[i], y:states.y[i], z:states.z[i]});
      found = {parts, hide:states.hide[index]};
      decodedStates.set(index, found);
    }
    return found;
  }
  /** @param {Part} element */
  function appearance(element) {
    const layer = document.createElement('div');
    layer.className = 'appearance';
    if (element.kind === 'box') Object.assign(layer.style, boxStyle(element));
    else if (element.kind === 'placeholder') {
      layer.textContent = element.text || '';
      Object.assign(layer.style, {color:element.color || 'inherit',fontSize:finite(element.fontSize,14)+'px',fontFamily:element.fontFamily || 'inherit',fontWeight:element.fontWeight || 'inherit',lineHeight:element.lineHeight || 'normal',letterSpacing:element.letterSpacing || 'normal',textAlign:element.textAlign || 'start',direction:element.direction || 'inherit',textIndent:element.textIndent || '0px',whiteSpace:element.whiteSpace || 'pre-wrap'});
    } else layer.innerHTML = element.html === undefined ? '' : markup(element.html);
    return layer;
  }
  /** @param {Part} element @param {HTMLElement} layer @returns {Keyframe} */
  function textStyle(element, layer) {
    const child = /** @type {HTMLElement} */ (layer.firstElementChild || layer);
    /** @type {Keyframe} */
    const style = {};
    for (const name of /** @type {const} */ (['fontFamily','fontWeight','lineHeight','letterSpacing','textAlign','direction','textIndent','whiteSpace'])) {
      const value = element[name] || child.style[name];
      if (value) style[name] = value;
    }
    if (element.color) style.color = element.color;
    if (Number.isFinite(element.fontSize)) style.fontSize = element.fontSize + 'px';
    return style;
  }
  /**
   * A paused one-second animation used as a style interpolator: setting
   * `currentTime` to t × 1000 lets the browser blend colors, shadows and clips.
   * @param {Element} element @param {Keyframe} from @param {Keyframe} to
   */
  function pausedAnimation(element, from, to) {
    const animation = element.animate([from,to], {duration:1000,fill:'both'});
    animation.pause(); animation.currentTime = 0;
    return animation;
  }
  /** @param {Part|undefined} a @param {Part|undefined} b @returns {PartItem} */
  function makePart(a, b) {
    const reference = /** @type {Part} */ (b || a);
    const part = document.createElement('div');
    part.className = 'part'; part.dataset.key = reference.key;
    part.dataset.group = reference.group || 'layout';
    part.style.zIndex = String(finite(reference.z, reference.kind === 'box' ? 0 : 10));
    stage.append(part);
    const oldLayer = a ? appearance(a) : null, newLayer = b ? appearance(b) : null;
    const sameText = !!a && !!b && a.kind === b.kind && (a.kind === 'text' || a.kind === 'placeholder') && a.text === b.text;
    const sameMarkup = !!a && !!b && a.kind === b.kind && a.html !== undefined && a.html === b.html;
    /** @type {PartItem} */
    const item = {key:reference.key,group:reference.group || 'layout',a,b,part,oldLayer,newLayer,sameText,sameMarkup,animation:null,clipAnimation:null,appearanceSide:0};
    if (a && b && a.clipCSS !== b.clipCSS) item.clipAnimation = pausedAnimation(part,{clipPath:a.clipCSS || 'none'},{clipPath:b.clipCSS || 'none'});
    else if (reference.clipCSS) part.style.clipPath = reference.clipCSS;
    if (a && b && oldLayer && newLayer && a.kind === 'box' && b.kind === 'box') {
      part.append(oldLayer);
      item.animation = pausedAnimation(oldLayer, boxStyle(a), boxStyle(b));
    } else if (sameText && a && b && oldLayer && newLayer) {
      part.append(oldLayer);
      item.textFrom = textStyle(a,oldLayer); item.textTo = textStyle(b,newLayer);
      item.animation = pausedAnimation(oldLayer.firstElementChild || oldLayer, item.textFrom, item.textTo);
    } else {
      if (oldLayer) part.append(oldLayer);
      if (newLayer && !sameMarkup) part.append(newLayer);
    }
    return item;
  }
  function destroyParts() {
    renderedLocal = null; interactiveKey = null; hovered = null; opened = null; trail = []; layoutIndex = 0; stateParts = []; hiddenParts = [];
    for (const item of parts) {item.animation?.cancel();item.clipAnimation?.cancel();}
    parts = []; stage.replaceChildren(); backgroundAnimation?.cancel(); backgroundAnimation = null;
    currentPair = null;
  }
  /**
   * Captured text keeps the original box width and ellipsis. Another engine
   * (Safari) can set the same text a pixel or two wider and would ellipsize
   * it; let that drift show instead. Text the original truncated overflows by
   * far more and keeps its ellipsis. Widths are read before any write.
   * @param {(HTMLElement|null)[]} layers
   */
  function relaxEllipses(layers) {
    const texts = layers.flatMap(layer => layer ? /** @type {HTMLElement[]} */ ([...layer.querySelectorAll('[style*="text-overflow: ellipsis"]')]) : []);
    const drift = texts.map(text => text.scrollWidth - text.clientWidth);
    texts.forEach((text, index) => {
      if (drift[index] <= Math.max(2, text.clientWidth * .04)) Object.assign(text.style, {textOverflow:'clip', overflow:'visible'});
    });
  }
  /** @param {Part[]} elements @returns {Box|null} */
  function bounds(elements) {
    if (!elements.length) return null;
    const x = Math.min(...elements.map(p=>p.x)), y = Math.min(...elements.map(p=>p.y));
    return {x,y,w:Math.max(...elements.map(p=>p.x+p.w))-x,h:Math.max(...elements.map(p=>p.y+p.h))-y};
  }
  /**
   * When an announcement moves to the other side of the hero, it folds along a
   * curved route instead of sliding through the headline.
   * @param {Scene} a @param {Scene} b @returns {Route|null}
   */
  function announcementRoute(a, b) {
    const first = bounds(a.parts.filter(p=>p.group === 'announcement'));
    const last = bounds(b.parts.filter(p=>p.group === 'announcement'));
    if (!first || !last || Math.abs(first.y-last.y) < 140) return null;
    const hero = bounds([...a.parts,...b.parts].filter(p=>p.group === 'hero'));
    if (hero && (first.y + first.h/2 - (hero.y+hero.h/2)) * (last.y + last.h/2 - (hero.y+hero.h/2)) >= 0) return null;
    return {first,last};
  }
  /** Build (or reuse) the parts interpolating between two timeline entries. @param {number} fromIndex @param {number} toIndex */
  function usePair(fromIndex, toIndex) {
    const a = versions[fromIndex], b = versions[toIndex];
    const key = `${theme}:${a.sceneIndex}:${b.sceneIndex}`;
    if (currentPair?.key === key) {
      currentPair.fromIndex = fromIndex; currentPair.toIndex = toIndex;
      return;
    }
    destroyParts();
    const first = scenes[a.sceneIndex], last = scenes[b.sceneIndex];
    const oldParts = new Map(first.parts.map(p=>[p.key,p]));
    const newParts = new Map(last.parts.map(p=>[p.key,p]));
    for (const key of new Set([...oldParts.keys(),...newParts.keys()])) parts.push(makePart(oldParts.get(key),newParts.get(key)));
    // Measure each side's text at that side's box size; renderParts then sets
    // the interpolated geometry.
    for (const side of /** @type {const} */ (['a','b'])) {
      const layers = [];
      for (const item of parts) {
        const element = item[side], layer = side === 'a' ? item.oldLayer : item.newLayer;
        if (!element || !layer?.isConnected) continue;
        Object.assign(item.part.style, {width:finite(element.w)+'px', height:finite(element.h)+'px'});
        layers.push(layer);
      }
      relaxEllipses(layers);
    }
    backgroundAnimation = pausedAnimation(stage,{backgroundColor:background(first)},{backgroundColor:background(last)});
    currentPair = {key,fromIndex,toIndex,route:announcementRoute(first,last),sameScene:a.sceneIndex === b.sceneIndex};
  }
  /** @param {number} local 0 shows the `from` scene, 1 the `to` scene. */
  function renderParts(local) {
    if (renderedLocal === local || !currentPair || !backgroundAnimation) return;
    renderedLocal = local;
    backgroundAnimation.currentTime = local * 1000;
    for (const item of parts) {
      const {a,b,part,oldLayer,newLayer} = item;
      const [start,end] = timings[item.group] || [0,1];
      const t = local === 1 ? 1 : smooth(clamp((local-start)/(end-start)));
      const from = /** @type {Part} */ (a || b), to = /** @type {Part} */ (b || a);
      let x = lerp(finite(from.x),finite(to.x),t), y = lerp(finite(from.y),finite(to.y),t);
      const w = Math.max(0,lerp(finite(from.w),finite(to.w),t)), h = Math.max(0,lerp(finite(from.h),finite(to.h),t));
      let scale = 1;
      if (item.group === 'announcement' && currentPair.route) {
        const {first,last} = currentPair.route;
        const fold = smooth(clamp(t/.28)) * (1-smooth(clamp((t-.78)/.22)));
        scale = 1-.76*fold;
        const originX = lerp(first.x,last.x,t), originY = lerp(first.y,last.y,t);
        x = originX - Math.sin(Math.PI*t)*16 + (x-originX)*scale;
        y = lerp(first.y,last.y,smooth(clamp((t-.12)/.76))) + (y-originY)*scale;
      }
      if (!a && item.group !== 'layout') y += (1-t)*10;
      if (!b && item.group !== 'layout') y -= t*8;
      const opacityA = finite(a?.opacity,1), opacityB = finite(b?.opacity,1);
      const opacity = a && b ? lerp(opacityA,opacityB,t) : a ? opacityA*(1-t) : opacityB*t;
      Object.assign(part.style,{transform:`translate3d(${x}px,${y}px,0) scale(${scale})`,width:w+'px',height:h+'px',opacity:String(opacity),zIndex:String(finite((t<.5 ? from : to).z,from.kind==='box'?0:10))});
      if (item.sameText && a && b && oldLayer) {
        // Text keeps one layer so glyphs do not double up; swap to the target
        // markup only at the endpoint, where it matches the native capture.
        const side = t === 1 ? 1 : 0;
        if (item.appearanceSide !== side) {
          item.animation?.cancel();
          const replacement = appearance(side ? b : a);
          oldLayer.replaceChildren(...replacement.childNodes);
          oldLayer.style.cssText = replacement.style.cssText;
          relaxEllipses([oldLayer]);
          item.animation = pausedAnimation(oldLayer.firstElementChild || oldLayer,/** @type {Keyframe} */ (item.textFrom),/** @type {Keyframe} */ (item.textTo));
          item.appearanceSide = side;
        }
      }
      if (item.animation) item.animation.currentTime = t*1000;
      if (item.clipAnimation) item.clipAnimation.currentTime = t*1000;
      if (oldLayer && newLayer && !item.animation && !item.sameMarkup) {
        oldLayer.style.opacity = String(1-t); newLayer.style.opacity = String(t);
      }
    }
  }

  // Timeline controls

  function positionReadout() {
    const thumb = 1 + (slider.clientWidth - 2) * progress;
    readout.style.left = thumb - readout.offsetWidth / 2 + 'px';
  }
  function resize() {
    positionReadout();
    stage.style.transform = `scale(${shell.clientWidth/1200})`;
    const monthLabels = /** @type {HTMLElement[]} */ ([...monthsElement.children]), width = monthsElement.clientWidth;
    let previousRight = -Infinity;
    monthLabels.forEach((label,index) => {
      const center = finite(label.dataset.position)*width;
      const estimatedWidth = (label.textContent || '').length*6+10;
      const left = index === 0 ? center : center-estimatedWidth/2;
      const final = index === monthLabels.length-1;
      const nextIsFinal = index === monthLabels.length-2;
      const fits = index === 0 || final || (left > previousRight+14 && (!nextIsFinal || center+estimatedWidth/2 < width-52));
      label.hidden = !fits;
      if (fits) previousRight = center+estimatedWidth/2;
    });
  }
  function updateReadout() {
    syncPlaybackControls();
    const version = versions[selectedIndex];
    const date = dateText(explicitSelection ? version.date : new Date(timelineTime()).toISOString()).split('.');
    $('version-year').textContent = date[0];
    $('version-month-day').textContent = date.slice(1).join('.');
    $('version-number').textContent = `v${version.version}`;
    positionReadout();
    previousButton.disabled = selectedIndex <= 0;
    nextButton.disabled = selectedIndex >= versions.length-1;
    versionCurrent.textContent = String(releaseOrdinals[selectedIndex]);
    layoutCurrent.textContent = String(version.sceneIndex+1);
    stage.setAttribute('aria-label',`${dateText(version.date)}, Codex ${version.version} ${theme} home screen${morph ? ', transitioning' : ''}`);
  }
  function updateTimeline() {
    slider.value = String(Math.round(progress*10000));
    // Ticks rise into a peak around the thumb. The dark mark hands off
    // linearly between the two ticks either side of the thumb.
    const upper = tickPositions.findIndex(position => position >= progress);
    const lower = Math.max(0, upper - 1);
    const span = tickPositions[upper] - tickPositions[lower];
    const handoff = span > 0 ? (progress - tickPositions[lower]) / span : 1;
    ticks.forEach((tick, index) => {
      const wave = Math.exp(-Math.abs(tickPositions[index] - progress) / .027);
      const base = tick.classList.contains('major') ? 11 : 6;
      tick.style.height = lerp(base, 64, wave) + 'px';
      const emphasis = index === upper ? handoff : index === lower ? 1 - handoff : 0;
      tick.style.background = `color-mix(in srgb, var(--thumb) ${emphasis*100}%, var(--tick))`;
    });
  }
  function timelineTime() { return lerp(startTime,endTime,progress); }
  /** @param {number} time */
  function timePosition(time) { return endTime > startTime ? clamp((time-startTime)/(endTime-startTime)) : 0; }
  /** The entry the timeline clock is on: the last one archived at or before it. */
  function clockIndex() {
    let index = 0;
    while (index+1 < releasePositions.length && releasePositions[index+1] <= progress) index++;
    return index;
  }
  /** Move the continuous timeline clock. @param {number} value 0–1 */
  function setProgress(value) {
    if (!initialized) return;
    progress = clamp(Number(value)); explicitSelection = false;
    selectedIndex = clockIndex();
    present();
    updateTimeline(); updateReadout();
    slider.setAttribute('aria-valuetext',`${dateText(new Date(timelineTime()).toISOString())}, version ${versions[selectedIndex].version}`);
  }
  /** Jump to one entry's endpoint, regardless of shared timestamps. @param {number} index */
  function selectVersion(index) {
    if (!initialized) return;
    stop(); selectedIndex = Math.max(0,Math.min(versions.length-1,Math.round(finite(index))));
    explicitSelection = true;
    progress = releasePositions[selectedIndex];
    renderSelectedVersion();
  }
  function renderSelectedVersion() {
    const version = versions[selectedIndex];
    present();
    updateTimeline(); updateReadout();
    slider.setAttribute('aria-valuetext',`${dateText(version.date)}, version ${version.version}`);
  }

  // Morphs: however the selection moves (playback, scrubbing, the arrows), a
  // change of screen morphs over MORPH_MS of real time while the clock moves
  // on. A change that comes during a morph waits for it to finish, then the
  // screen morphs on to whatever is selected by then. Reduced motion, the
  // first render and a theme switch show the screen at once.

  /** Show the selected entry's screen, morphing to it when the screen changes. */
  function present() {
    const target = selectedIndex, scene = versions[target].sceneIndex;
    if (reducedMotion.matches || !currentPair) {
      endMorph(); shownIndex = target;
      usePair(target,target); renderParts(0); syncInteraction();
      return;
    }
    if (morph) {
      // Turning back runs the same morph in reverse.
      if (versions[morph.toIndex].sceneIndex === scene) { morph.toIndex = target; morph.direction = 1; }
      else if (versions[morph.fromIndex].sceneIndex === scene) { morph.fromIndex = target; morph.direction = -1; }
      else return;
      usePair(morph.fromIndex,morph.toIndex);
      return;
    }
    if (versions[shownIndex].sceneIndex === scene) {
      shownIndex = target;
      usePair(target,target); renderParts(0); syncInteraction();
      return;
    }
    startMorph(shownIndex,target);
  }
  /** @param {number} fromIndex @param {number} toIndex */
  function startMorph(fromIndex, toIndex) {
    cancelAnimationFrame(morphRaf);
    morph = {fromIndex,toIndex,t:0,direction:1,last:0};
    usePair(fromIndex,toIndex); renderParts(0); syncInteraction();
    // Time the morph from when its parts are built, so it starts from its first frame.
    morph.last = performance.now();
    morphRaf = requestAnimationFrame(stepMorph);
  }
  /** @param {number} now */
  function stepMorph(now) {
    if (!morph) return;
    morph.t = clamp(morph.t + morph.direction*Math.max(0,now-morph.last)/MORPH_MS); morph.last = now;
    renderParts(morph.t);
    const arrived = morph.direction === 1 ? morph.t === 1 : morph.t === 0;
    if (!arrived) { morphRaf = requestAnimationFrame(stepMorph); return; }
    shownIndex = morph.direction === 1 ? morph.toIndex : morph.fromIndex;
    morph = null;
    present(); updateReadout();
  }
  function endMorph() {
    cancelAnimationFrame(morphRaf);
    morph = null;
  }

  // Interaction: at rest on a screen, its controls show their recorded hover
  // state, a click opens the menu or dialog it opened in the app or toggles the
  // layout (sidebar, panels), and the composer takes real typing. Transitions
  // and playback turn it off.

  /** The pair key of the screen the hit layer was built for. @type {string|null} */
  let interactiveKey = null;
  /** @type {Control|null} */
  let hovered = null;
  /** The control whose menu is open, and the submenus open in it, outermost first. @type {Control|null} */
  let opened = null;
  /** @type {Submenu[]} */
  let trail = [];
  /** The scene's layout shown: 0 as captured, others reached through toggles. */
  let layoutIndex = 0;
  let typedText = '';
  /** Parts drawn for the current states. @type {HTMLElement[]} */
  let stateParts = [];
  /** Base parts those states hide. @type {HTMLElement[]} */
  let hiddenParts = [];
  const hitLayer = document.createElement('div');
  hitLayer.className = 'hit-layer';

  /** @param {HTMLElement} element @param {number[]} rect */
  function place(element, [x, y, w, h]) {
    Object.assign(element.style, {left:x+'px', top:y+'px', width:w+'px', height:h+'px'});
  }
  /**
   * A part at its endpoint geometry. Built like the scene's own parts, so the
   * browser layers and rasterizes its text the same way.
   * @param {Part} part
   */
  function staticPart(part) {
    const item = makePart(part, part);
    Object.assign(item.part.style, {transform:`translate3d(${finite(part.x)}px,${finite(part.y)}px,0)`, width:finite(part.w)+'px', height:finite(part.h)+'px', opacity:String(finite(part.opacity,1))});
    if (item.animation) item.animation.currentTime = 1000;
    if (item.clipAnimation) item.clipAnimation.currentTime = 1000;
    return item.part;
  }
  function interactiveScene() {
    return currentPair?.sameScene ? scenes[versions[selectedIndex].sceneIndex] : null;
  }
  /** @param {Scene} scene @returns {Layout} */
  function currentScreen(scene) {
    return scene.layouts?.[layoutIndex] ?? {state:null, controls:[], editor:null};
  }
  /** Show the layout, typed state and open or hovered state, in that order; later states win. */
  function applyStates() {
    for (const element of stateParts) element.remove();
    for (const element of hiddenParts) element.style.display = '';
    stateParts = []; hiddenParts = [];
    const scene = interactiveScene();
    if (!scene || interactiveKey === null) return;
    const screen = currentScreen(scene);
    const deltas = [screen.state, typedText && screen.editor ? screen.editor.typed : null, opened?.open ? (trail.at(-1) ?? opened.open).state : hovered?.hover ?? null].map(index => index === null ? null : delta(index));
    /** @type {Map<string,Part>} */
    const shown = new Map();
    const hidden = new Set();
    for (const delta of deltas) {
      if (!delta) continue;
      for (const key of delta.hide) { hidden.add(key); shown.delete(key); }
      for (const part of delta.parts) { shown.set(part.key, part); hidden.add(part.key); }
    }
    // display:none rather than visibility:hidden: a hidden part's compositing layer would change how overlapping text rasterizes.
    for (const item of parts) if (hidden.has(item.key)) { item.part.style.display = 'none'; hiddenParts.push(item.part); }
    stateParts = [...shown.values()].map(staticPart);
    stage.append(...stateParts);
    relaxEllipses(stateParts);
  }
  /** @param {Editor} editor */
  function editorField(editor) {
    const field = document.createElement('div'), text = editor.text, [x, y] = editor.rect;
    field.className = 'stage-editor';
    field.contentEditable = 'plaintext-only'; field.spellcheck = false;
    field.setAttribute('role', 'textbox'); field.setAttribute('aria-label', 'Try typing (nothing is sent)');
    place(field, editor.rect);
    Object.assign(field.style, {paddingLeft:finite(text.x)-x+'px', paddingTop:finite(text.y)-y+'px', fontFamily:text.fontFamily ?? 'inherit', fontSize:finite(text.fontSize,14)+'px', fontWeight:text.fontWeight ?? 'normal', lineHeight:text.lineHeight ?? 'normal', color:text.color ?? 'inherit', caretColor:text.color ?? 'auto'});
    field.textContent = typedText;
    field.addEventListener('input', () => { typedText = field.textContent ?? ''; applyStates(); });
    field.addEventListener('keydown', event => { if (event.key === 'Enter') event.preventDefault(); });
    return field;
  }
  /**
   * Open a control's menu. Like the app's menus and dialogs it is modal: a press
   * outside the panel or Escape closes it, and nothing else responds meanwhile.
   * @param {Control} control
   * @param {number[]} panelRect
   */
  function openMenu(control, panelRect) {
    if (document.activeElement instanceof HTMLElement && hitLayer.contains(document.activeElement)) document.activeElement.blur();
    opened = control; trail = []; hovered = null;
    const outside = document.createElement('div');
    outside.className = 'stage-outside';
    outside.addEventListener('pointerdown', event => { if (event.target === outside) closeMenu(); });
    hitLayer.append(outside);
    menuRegions(panelRect);
    applyStates();
  }
  /**
   * The open menu's regions: what is open counts as inside, and each item that opens more
   * (at the menu's level and in every open submenu) opens it on hover or click, as in the app.
   * Opening an item closes whatever was open below its level.
   * @param {number[]} panelRect
   */
  function menuRegions(panelRect) {
    const outside = /** @type {HTMLElement} */ (hitLayer.querySelector('.stage-outside'));
    outside.replaceChildren();
    for (const rect of [panelRect, ...trail.map(item => item.panel)]) {
      const panel = document.createElement('div');
      panel.className = 'stage-panel';
      place(panel, rect);
      outside.append(panel);
    }
    const levels = [opened?.open?.submenus ?? [], ...trail.map(item => item.submenus)];
    levels.forEach((items, depth) => {
      for (const item of items) {
        const hit = document.createElement('div');
        hit.className = 'stage-panel';
        place(hit, item.rect);
        const show = () => {
          if (trail[depth] === item && trail.length === depth + 1) return;
          trail = [...trail.slice(0, depth), item];
          menuRegions(panelRect); applyStates();
        };
        if (item.by === 'hover') hit.addEventListener('pointerenter', show);
        hit.addEventListener('click', show);
        outside.append(hit);
      }
    });
  }
  function closeMenu() {
    if (!opened) return;
    opened = null; trail = [];
    hitLayer.querySelector('.stage-outside')?.remove();
    applyStates();
  }
  /**
   * Show another of the scene's layouts. Its own controls and composer take over.
   * @param {Scene} scene @param {number} index
   */
  function toggleLayout(scene, index) {
    layoutIndex = index; hovered = null;
    buildHits(scene);
  }
  /** @param {Scene} scene */
  function buildHits(scene) {
    hitLayer.replaceChildren();
    const screen = currentScreen(scene);
    for (const control of screen.controls) {
      const hit = document.createElement('div');
      hit.className = 'hit';
      place(hit, control.rect);
      hit.addEventListener('pointerenter', () => { hovered = control; applyStates(); });
      hit.addEventListener('pointerleave', () => { if (hovered === control) { hovered = null; applyStates(); } });
      const panel = control.open?.panel, toggle = control.toggle;
      if (panel) hit.addEventListener('click', () => openMenu(control, panel));
      else if (toggle !== undefined) hit.addEventListener('click', () => toggleLayout(scene, toggle));
      hitLayer.append(hit);
    }
    if (screen.editor) hitLayer.append(editorField(screen.editor));
    applyStates();
  }
  /** Build or remove the hit layer to match whether the stage is at rest on a screen. */
  function syncInteraction() {
    const scene = initialized && !playing ? interactiveScene() : null;
    const key = scene && currentPair ? currentPair.key : null;
    if (key === interactiveKey) return;
    interactiveKey = key; hovered = null; opened = null; trail = []; layoutIndex = 0;
    if (!scene) { hitLayer.replaceChildren(); hitLayer.remove(); applyStates(); return; }
    stage.append(hitLayer);
    buildHits(scene);
  }

  // Playback

  function stop() {
    playing = false; cancelAnimationFrame(raf);
    playButton.setAttribute('aria-label','Play timeline'); playButton.title = 'Play'; playButton.innerHTML = playIcon;
    syncInteraction();
  }
  function syncPlaybackControls() {
    // The media query value can update before its asynchronous change event.
    const disabled = !initialized || anchors.length < 2 || reducedMotion.matches;
    playButton.disabled = disabled;
    if (disabled && playing) stop();
    return disabled;
  }
  function play(nextDirection = 1) {
    if (syncPlaybackControls()) return;
    if (playing && direction === nextDirection) { stop(); return; }
    stop(); direction = nextDirection;
    if (direction === 1 && progress >= .99999) setProgress(0);
    if (direction === -1 && progress <= .00001) setProgress(1);
    if (explicitSelection) setProgress(progress);
    playing = true; syncInteraction();
    playButton.setAttribute('aria-label','Pause timeline'); playButton.title = 'Pause'; playButton.innerHTML = pauseIcon;
    // About six archive days per second.
    const start = performance.now(), initial = progress, duration = Math.max(6500,(endTime-startTime)/DAY/6*1000);
    /** @param {number} now */
    function frame(now) {
      if (!playing) return;
      setProgress(initial+direction*(now-start)/duration);
      if (!playing) return;
      if ((direction === 1 && progress >= 1) || (direction === -1 && progress <= 0)) stop();
      else raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
  }

  // Setup

  function buildTimeline() {
    releaseTimes = data.timeline.map(version=>Date.parse(version.archivedAt));
    if (releaseTimes.some((time,index)=>!Number.isFinite(time) || (index > 0 && time < releaseTimes[index-1]))) throw new Error('Archive timestamps are missing or out of order');
    startTime = releaseTimes[0]; endTime = releaseTimes[releaseTimes.length-1];
    releasePositions = releaseTimes.map(timePosition);
    let releases = 0;
    releaseOrdinals = data.timeline.map(version => version.kind === 'release' ? ++releases : releases);
    // Anchors are entries whose layout changes in either theme, plus the last entry.
    const timeline = data.timeline;
    anchors = timeline.flatMap((version,index) => index === 0 || themeNames.some(name=>version.sceneIndices[name] !== timeline[index-1].sceneIndices[name]) ? [index] : []);
    if (anchors[anchors.length-1] !== timeline.length-1) anchors.push(timeline.length-1);
    const firstDate = new Date(startTime);
    // Ticks follow the archive clock (UTC): a major tick on the first of each
    // month, minor ticks splitting each month into even steps of about two
    // days (so months of 28 to 31 days keep the same rhythm), and a minor tick
    // at each end. Minor ticks within a day of an end are skipped so the end
    // tick does not read as a double line.
    /** @type {Map<number,boolean>} time → major */
    const tickTimes = new Map([[startTime,false],[endTime,false]]);
    for (let year=firstDate.getUTCFullYear(),month=firstDate.getUTCMonth();Date.UTC(year,month,1)<=endTime;month++) {
      const monthStart = Date.UTC(year,month,1), monthLength = Date.UTC(year,month+1,1)-monthStart;
      const steps = Math.round(monthLength/DAY/2);
      for (let step = 0; step < steps; step++) {
        const time = monthStart+monthLength*step/steps, major = step === 0;
        if (time < startTime || time > endTime) continue;
        if (!major && Math.min(time-startTime,endTime-time) < DAY) continue;
        tickTimes.set(time,major);
      }
    }
    const tickEntries = [...tickTimes].sort(([a],[b])=>a-b);
    tickPositions = tickEntries.map(([time])=>timePosition(time));
    ticks = tickEntries.map(([time,major],index) => {
      const tick = document.createElement('i'); tick.dataset.time = String(time);
      tick.style.left = tickPositions[index]*100+'%';
      tick.classList.toggle('major',major);
      ticksElement.append(tick); return tick;
    });
    /** @param {Date} date */
    const monthName = date => date.toLocaleString('en-US',{month:'short',timeZone:'UTC'});
    const labels = [{text:monthName(firstDate),position:0}];
    for (let year=firstDate.getUTCFullYear(),month=firstDate.getUTCMonth()+1;Date.UTC(year,month,1)<endTime;month++) {
      const time = Date.UTC(year,month,1);
      labels.push({text:monthName(new Date(time)),position:timePosition(time)});
    }
    labels.forEach((entry,index) => {
      const label = document.createElement('span'); label.className = 'month';
      if (index === 0) label.classList.add('edge-start');
      if (index === labels.length-1) label.classList.add('edge-end');
      label.textContent = entry.text; label.dataset.position = String(entry.position); label.style.left = entry.position*100+'%';
      monthsElement.append(label);
    });
  }
  /** Check the guarantees the player relies on. @param {Payload} payload */
  function prepare(payload) {
    if (!payload.timeline?.length) throw new Error('No timeline found');
    for (const name of themeNames) {
      const themeScenes = payload.themes?.[name]?.scenes;
      if (!Array.isArray(themeScenes)) throw new Error('The archive is missing light or dark scene data');
      for (const version of payload.timeline) {
        const index = version.sceneIndices?.[name];
        if (!Number.isInteger(index) || !themeScenes[index]) throw new Error(`Version ${version.version} has no ${name} layout`);
      }
    }
  }
  function configure() {
    activateThemeScenes();
    buildTimeline();
    updateArchiveDetails();
    initialized = true; slider.disabled = anchors.length < 2; saveButton.disabled = false;
    syncPlaybackControls();
    setProgress(0);
    resize();
  }
  async function load() {
    try {
      const payload = $('scene-data').textContent?.trim() || '';
      const bytes = Uint8Array.from(atob(payload),char=>char.charCodeAt(0));
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      const decoded = await new Response(stream).json();
      prepare(decoded);
      data = decoded;
      configure();
    } catch (caught) {
      showMessage('Unable to load the timeline','Please reopen this HTML file.',String(/** @type {any} */ (caught)?.message || caught));
      slider.disabled = playButton.disabled = true;
      previousButton.disabled = nextButton.disabled = true;
      throw caught;
    }
  }

  /** Move the timeline clock by a duration. @param {number} ms */
  function shiftTime(ms) { setProgress(progress + ms/Math.max(1,endTime-startTime)); }
  // Image export

  /**
   * Render the stage as it is now to a PNG. The stage is cloned into an SVG
   * <foreignObject> with the page styles and embedded fonts. Animated styles
   * (boxes, text and clips are driven by paused Web Animations) do not survive
   * cloning, so their current computed values are written inline first.
   * @param {number} scale Device pixels per CSS pixel.
   * @returns {Promise<Blob>}
   */
  async function renderImage(scale = 2) {
    const clone = /** @type {HTMLElement} */ (stage.cloneNode(true));
    const originals = [stage, ...stage.querySelectorAll('*')], copies = [clone, ...clone.querySelectorAll('*')];
    originals.forEach((original, index) => {
      const animations = original.getAnimations();
      if (!animations.length) return;
      const computed = getComputedStyle(original), target = /** @type {HTMLElement} */ (copies[index]).style;
      for (const animation of animations) for (const keyframe of /** @type {KeyframeEffect} */ (animation.effect).getKeyframes()) {
        for (const property of Object.keys(keyframe)) {
          if (['offset','computedOffset','easing','composite'].includes(property)) continue;
          /** @type {any} */ (target)[property] = /** @type {any} */ (computed)[property];
        }
      }
    });
    clone.removeAttribute('inert');
    Object.assign(clone.style, {transform:'none', position:'relative', left:'0', top:'0', backgroundColor:getComputedStyle(stage).backgroundColor, colorScheme:theme});
    // Scene backgrounds can be translucent (window vibrancy); composite them
    // over the same surface the player shows behind the stage.
    const root = document.createElement('div'), style = document.createElement('style');
    // Scale inside the content: Safari rasterizes <foreignObject> at its own
    // size and does not enlarge it through the SVG viewBox.
    Object.assign(root.style, {backgroundColor:getComputedStyle(shell).backgroundColor, width:'1200px', height:'780px', transform:`scale(${scale})`, transformOrigin:'0 0'});
    style.textContent = [...document.querySelectorAll('style')].map(node => node.textContent).join('\n');
    root.append(style, clone);
    const markup = new XMLSerializer().serializeToString(root);
    const canvas = await drawMarkup(markup, 1200*scale, 780*scale);
    return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG export failed')), 'image/png'));
  }
  /**
   * Draw serialized XHTML, already sized to width × height, through an SVG image.
   * @param {string} markup @param {number} width @param {number} height
   */
  async function drawMarkup(markup, width, height) {
    const image = new Image();
    image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="${width}" height="${height}">${markup}</foreignObject></svg>`);
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d', {willReadFrequently:true})).drawImage(image, 0, 0);
    return canvas;
  }
  /** @type {Promise<number>|null} */
  let exportScale = null;
  /**
   * 2x when the browser scales box-shadow blur inside an SVG image. Safari
   * keeps the 1x blur at 2x and paints large shadows as solid blocks, so it
   * exports at 1x. A probe 3px outside a blurred box tells them apart (~200
   * with a scaled blur, ~240 without).
   */
  function chooseExportScale() {
    exportScale ??= drawMarkup('<div xmlns="http://www.w3.org/1999/xhtml" style="position:relative;width:120px;height:60px;background:#fff;transform:scale(2);transform-origin:0 0"><div style="position:absolute;left:10px;top:10px;width:80px;height:20px;background:#fff;box-shadow:#000 0 0 8px 0"></div></div>', 240, 120)
      .then(canvas => /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d', {willReadFrequently:true})).getImageData(186, 40, 1, 1).data[0] < 225 ? 2 : 1, () => 1);
    return exportScale;
  }
  async function saveImage() {
    stop();
    const version = versions[selectedIndex];
    saveButton.disabled = true;
    try {
      const url = URL.createObjectURL(await renderImage(await chooseExportScale()));
      const link = document.createElement('a');
      link.href = url; link.download = `codex-${version.version}-${theme}.png`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (caught) {
      console.error(caught);
    } finally {
      saveButton.disabled = !initialized;
    }
  }

  slider.addEventListener('input',() => {stop();setProgress(Number(slider.value)/10000);});
  slider.addEventListener('keydown',event => {
    if (event.key === 'Home' || event.key === 'End' || event.key === 'PageUp' || event.key === 'PageDown') {
      event.preventDefault(); stop();
      if (event.key === 'Home') setProgress(0);
      else if (event.key === 'End') setProgress(1);
      else shiftTime((event.key === 'PageUp' ? 1 : -1)*WEEK);
    }
  });
  // Over the timeline, the wheel scrubs: one mouse notch (~100px) moves a week,
  // like PageUp/PageDown. Either axis works, so trackpad swipes scrub too. At an
  // end the page scrolls as usual; ctrl+wheel stays the browser's zoom gesture.
  /** @type {HTMLElement} */ (document.querySelector('.timeline-wrap')).addEventListener('wheel',event => {
    if (!initialized || slider.disabled || event.ctrlKey) return;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (!delta || (delta < 0 && progress <= 0) || (delta > 0 && progress >= 1)) return;
    event.preventDefault(); stop();
    const pixels = delta * (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 100/3 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 800 : 1);
    shiftTime(pixels/100*WEEK);
  },{passive:false});
  playButton.addEventListener('click',() => playing ? stop() : play(1));
  previousButton.addEventListener('click',() => selectVersion(selectedIndex-1));
  nextButton.addEventListener('click',() => selectVersion(selectedIndex+1));
  themeToggle.addEventListener('click',() => setTheme(theme === 'dark' ? 'light' : 'dark'));
  saveButton.addEventListener('click',saveImage);
  $('about-open').addEventListener('click',() => {stop();aboutDialog.showModal();});
  $('about-close').addEventListener('click',() => aboutDialog.close());
  aboutDialog.addEventListener('click',event => {
    if (event.target !== aboutDialog) return;
    const rect = aboutDialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) aboutDialog.close();
  });
  document.addEventListener('keydown',event => {if(event.key === 'Escape' && opened && !aboutDialog.open){event.preventDefault();closeMenu();}});
  document.addEventListener('visibilitychange',() => {if(document.hidden)stop();});
  reducedMotion.addEventListener('change',() => {
    stop(); syncPlaybackControls();
    if (explicitSelection) selectVersion(selectedIndex); else setProgress(progress);
  });
  new ResizeObserver(resize).observe(/** @type {Element} */ (document.querySelector('.page')));
  applyThemeAppearance();

  // Hooks for verify/verify.cjs.
  /** @type {any} */ (window).codexTimeline = {
    ready:load(), selectVersion, setTheme, renderImage,
    getState:() => ({theme, version:versions[selectedIndex]?.version})
  };
})();
