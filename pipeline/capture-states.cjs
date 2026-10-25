// Record how each home screen responds to the pointer and keyboard, for the
// player's interaction layer. A screen has layouts: the one it opens with, and
// one for each of its toggles (sidebar, panels, collapsible sections). In each
// layout, every control's hover appearance (with its tooltip), the menu, popover
// or dialog a click on it opens (with the submenus its items open) or the layout
// it toggles to, and the composer with text typed into it. Toggles do not
// combine: in a toggled layout, only the toggle back responds among them. A control that looks the same and
// sits in the same place as in the first layout keeps that layout's hover and
// menu (prepare-scenes.py applies them to this layout) and is only clicked when
// it toggles.
//
// A state is stored as an element list relative to a reference list: an element
// identical to one in the reference is a number (its index there), anything else
// is the element itself. A layout is relative to the base capture, and the states
// within it to the layout's own elements. Screens shared by several versions are recorded once, for
// the first version showing them, so this runs after prepare-scenes.py (which
// then runs again to attach the states). Requires pipeline/server.py.
const {chromium}=require('playwright');
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const root=path.join(__dirname,'..','data');
const readJSON=async file=>JSON.parse(await fs.readFile(path.join(root,file),'utf8'));
const HOME=/Let[’']s build|What should we (?:build|work on)\?|What can I help/i;
const CONTROLS='button,[role="button"],a[href]';
const EDITOR='[contenteditable="true"],textarea';
// Layouts per screen: the first and one per toggle.
const MAX_LAYOUTS=16;
const WORKERS=3;

// Finish transitions; looping animations pause at a fixed frame, as in capture-all.cjs.
const settle=page=>page.evaluate(()=>{for(const animation of document.getAnimations()){
  if(animation.effect.getTiming().iterations===Infinity){animation.pause();animation.currentTime=500;}else animation.finish();}});
// The element's look without its DOM identity, at any depth (its clip ancestors carry
// theirs too): classes and data-state change with state, and generated ids (React's,
// SVG masks and gradients) differ between loads and shift when a tooltip mounts.
const signature=element=>JSON.stringify(element,(key,value)=>key==='source'?undefined:value).replace(/\b(id=\\"|url\(#|href=\\"#)[^"\\)]*/g,'$1');
function encode(base,state){
  const index=new Map(base.map((element,i)=>[signature(element),i]));
  return state.map(element=>index.get(signature(element))??element);
}
const changed=(encoded,base)=>encoded.length!==base.length||encoded.some((entry,i)=>entry!==i);
// The screen's controls (each the topmost element at its own centre), its composer, and a neutral point that touches neither.
const scan=page=>page.evaluate(([controlsSelector,editorSelector])=>{
  const visible=element=>{const r=element.getBoundingClientRect();return r.width>0&&r.height>0&&r.right>0&&r.bottom>0&&r.x<1200&&r.y<780&&r;};
  const top=(element,r)=>{const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return hit&&(hit===element||element.contains(hit));};
  const box=r=>[r.x,r.y,r.width,r.height].map(v=>Math.round(v*100)/100);
  const controls=[];
  for(const element of document.querySelectorAll(controlsSelector)){
    const r=visible(element);if(!r||!top(element,r)||element.closest(editorSelector)||controls.some(c=>c.element.contains(element)))continue;
    controls.push({element,label:(element.getAttribute('aria-label')||element.innerText||'').trim().replace(/\s+/g,' ').slice(0,80),rect:box(r)});
  }
  const editorElement=[...document.querySelectorAll(editorSelector)].find(e=>visible(e));
  const candidates=[[600,300],[700,450],[900,250],[2,778],[1198,778],[2,2]];
  const neutral=candidates.find(([x,y])=>!document.elementFromPoint(x,y)?.closest(`${controlsSelector},${editorSelector}`))||[600,300];
  return {controls:controls.map(({element,...c})=>c),editor:editorElement?{rect:box(editorElement.getBoundingClientRect())}:null,neutral};
},[CONTROLS,EDITOR]);
const centre=([x,y,w,h])=>[x+w/2,y+h/2];
// The visible layout: each element's kind, box and text, in any order. Unlike the DOM it
// ignores what does not show (emptied tooltip containers, off-screen buffers).
const boxes=elements=>elements.map(e=>JSON.stringify([e.kind,...[e.x,e.y,e.w,e.h].map(Math.round),e.text??'']));
const geometry=elements=>JSON.stringify(boxes(elements).sort());
// Whether every element of a layout outside the clicked control is still where it was:
// true when a click only added things (the control itself may restyle or relabel while open).
function keeps(elements,layout,[x,y,w,h]){
  const outside=layout.filter(e=>!(e.x>=x-1&&e.y>=y-1&&e.x+e.w<=x+w+1&&e.y+e.h<=y+h+1));
  const left=new Map();for(const box of boxes(elements))left.set(box,(left.get(box)??0)+1);
  return boxes(outside).every(box=>{const count=left.get(box);if(!count)return false;left.set(box,count-1);return true;});
}
// A control's own look: the elements inside its box.
const inside=(elements,[x,y,w,h])=>elements.filter(e=>e.x>=x-1&&e.y>=y-1&&e.x+e.w<=x+w+1&&e.y+e.h<=y+h+1).map(signature).sort().join('\n');
const words=label=>new Set(label.toLowerCase().match(/[a-z]{4,}/g)??[]);
// Where a toggle's way back may be in the toggled layout: the same spot, the same label, or a shared word (Hide/Show sidebar).
function returnCandidates(control,controls){
  const rank=candidate=>{
    const [x,y]=centre(candidate.rect),[cx,cy]=centre(control.rect);
    if(Math.hypot(x-cx,y-cy)<4)return 0;
    if(candidate.label&&candidate.label===control.label)return 1;
    return [...words(candidate.label)].some(word=>words(control.label).has(word))?2:null;
  };
  return controls.map(candidate=>({candidate,rank:rank(candidate)})).filter(c=>c.rank!==null).sort((a,b)=>a.rank-b.rank).slice(0,3).map(c=>c.candidate);
}

(async()=>{
  const args=process.argv.slice(2);
  const theme=args.includes('--theme')?args[args.indexOf('--theme')+1]:'dark';
  const requested=args.filter((arg,i)=>!arg.startsWith('--')&&args[i-1]!=='--theme');
  const extract=await fs.readFile(path.join(__dirname,'capture-scene.js'),'utf8');
  const self=await fs.readFile(__filename,'utf8');
  const ledgerName=theme==='dark'?'capture-results.json':'capture-results-light.json';
  const statesLedgerName=theme==='dark'?'state-results.json':'state-results-light.json';
  const captures=await readJSON(ledgerName);
  const results=await readJSON(statesLedgerName).catch(()=>({}));
  const directory=path.join(root,'states',theme);await fs.mkdir(directory,{recursive:true});
  const timeline=(await readJSON('prepared-data.json')).timeline;
  const representatives=new Set(timeline.filter((row,i)=>timeline.findIndex(other=>other.sceneIndices[theme]===row.sceneIndices[theme])===i).map(row=>row.captureId));
  const queue=(await readJSON('timeline-catalog.json')).filter(item=>(requested.length?requested.includes(item.captureId):representatives.has(item.captureId))&&captures[item.captureId]?.status==='captured').map(item=>{
    // Current when its base capture and this recorder are unchanged.
    const revision=crypto.createHash('sha256').update(captures[item.captureId].revision+self,'utf8').digest('hex');
    return {...item,revision};
  }).filter(item=>results[item.captureId]?.revision!==item.revision||results[item.captureId]?.status!=='recorded');
  const browser=await chromium.launch({channel:'chrome',headless:true});
  let next=0,failures=0,checkpoint=Promise.resolve();
  // Save the ledger after every screen, one write at a time, so an interrupted run resumes where it stopped.
  const save=()=>checkpoint=checkpoint.then(async()=>{
    const temporary=path.join(root,statesLedgerName.replace(/\.json$/,'.tmp.json'));
    await fs.writeFile(temporary,JSON.stringify(results,null,2));await fs.rename(temporary,path.join(root,statesLedgerName));
  });
  async function worker(){
    while(next<queue.length){
      const item=queue[next++],started=Date.now();
      const context=await browser.newContext({viewport:{width:1200,height:780},colorScheme:theme,locale:'en-US',serviceWorkers:'block'});
      try{
        await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
        // What a state mounts on a layer of its own paints above the screen: a new layer on the
        // body (tooltip, menu or dialog portals), or a new positioned element with a z-index
        // inside the app (the sidebar sliding out over a collapsed layout). Elements present
        // when the layout was entered are remembered.
        await context.addInitScript(()=>{
          window.__labRemember=()=>{window.__labKnown=new WeakSet(document.querySelectorAll('*'));};
          // The bounds of the menus, popovers and dialogs a state shows (tooltips aside), or null.
          // Portals are often zero-size wrappers around fixed-position content; measure what they show.
          window.__labPanel=()=>{
            const box=e=>{const r=e.getBoundingClientRect();return r.width&&r.height?r:null;};
            const mounted=window.__labFloating().filter(e=>!e.matches('[role=tooltip]')&&!e.querySelector('[role=tooltip]')).flatMap(e=>[e,...e.querySelectorAll('*')]);
            const surfaces=mounted.filter(n=>n.matches('[role=menu],[role=dialog],[role=listbox]'));
            const rects=(surfaces.length?surfaces:mounted).map(box).filter(Boolean);
            if(!rects.length)return null;
            const left=Math.min(...rects.map(r=>r.left)),top=Math.min(...rects.map(r=>r.top));
            return [left,top,Math.max(...rects.map(r=>r.right))-left,Math.max(...rects.map(r=>r.bottom))-top].map(v=>Math.round(v*100)/100);
          };
          // Items in an open menu that open more: a submenu, a popover or dialog, or a section
          // that expands in place ("Advanced").
          window.__labSubmenus=()=>{
            const opens=element=>element.matches('[role^=menuitem],[aria-haspopup],[aria-expanded]')&&(element.matches('[aria-haspopup]:not([aria-haspopup=false]),[aria-expanded=false]')||[element,element.parentElement].some(node=>/^(open|closed)$/.test(node?.dataset.state??'')));
            const items=window.__labFloating().flatMap(layer=>[layer,...layer.querySelectorAll('*')]).filter(opens);
            // Only items one can point at: the topmost element at their centre (a collapsed section hides its items).
            const visible=item=>{const r=item.getBoundingClientRect();const hit=r.width&&r.height&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return hit&&item.contains(hit);};
            return items.filter(item=>!items.some(other=>other!==item&&other.contains(item))&&visible(item)).map(item=>{const r=item.getBoundingClientRect();return r.width&&r.height?{label:(item.getAttribute('aria-label')||item.innerText||'').trim().replace(/\s+/g,' ').slice(0,60),rect:[r.x,r.y,r.width,r.height].map(v=>Math.round(v*100)/100)}:null;}).filter(Boolean);
          };
          window.__labFloating=()=>{
            const known=window.__labKnown;
            return [...document.querySelectorAll('body *')].filter(element=>{
              if(known.has(element))return false;
              if(element.parentElement===document.body)return true;
              const style=getComputedStyle(element);
              return (style.position==='fixed'||style.position==='absolute')&&Number.parseInt(style.zIndex)>0;
            });
          };
        });
        const page=await context.newPage();
        const url=`http://127.0.0.1:4823/?v=${item.version}&capture=${item.captureId}&theme=${theme}`;
        // Elements in a layer the state mounted are marked: they paint above the screen.
        const snapshot=async()=>{
          await settle(page);
          const layered=new Set(await page.evaluate(()=>{
            let next=0;
            return [...new Set(window.__labFloating().flatMap(layer=>[layer,...layer.querySelectorAll('*')]))].filter(node=>!node.parentElement?.closest('svg'))
              .map(node=>node.id||=`lab-layer-${next++}`);
          }));
          const elements=(await page.evaluate(`(${extract})()`)).elements;
          for(const element of elements)if(layered.has(element.source?.id))element.layer='overlay';
          return elements;
        };
        const home=()=>page.evaluate(source=>new RegExp(source,'i').test(document.body.innerText),HOME.source);
        const press=async rect=>{await page.mouse.click(...centre(rect));await page.waitForTimeout(700);await settle(page);};
        // Where every element sits and what it says: a cheap check that the screen is untouched.
        const dom=()=>page.evaluate(()=>location.href+document.body.innerText+JSON.stringify([...document.body.querySelectorAll('*')].map(e=>{const r=e.getBoundingClientRect();return [e.tagName,Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)];})));
        // Layouts are compared and recorded unfocused with the pointer at rest, like the base:
        // a focused control can reveal more (section actions), a hovered one its tooltip. Some
        // layouts settle late (a terminal panel mounts after its process starts): wait until
        // nothing moves for a moment, up to a few seconds.
        const steady=async()=>{for(let last=await dom(),tries=0;tries<12;tries++){await page.waitForTimeout(250);await settle(page);const now=await dom();if(now===last)break;last=now;}};
        const unfocus=async()=>{
          await page.evaluate(()=>document.activeElement?.blur());await page.mouse.move(...(await scan(page)).neutral);await page.waitForTimeout(500);
          await steady();
        };
        // A fresh page, toggled into a layout by replaying the clicks that reach it, at rest.
        const load=async(steps=[])=>{
          await page.goto(url,{waitUntil:'load',timeout:25000});
          await page.waitForFunction(([home,editor])=>new RegExp(home,'i').test(document.body.innerText)&&document.querySelector(editor),[HOME.source,EDITOR],{timeout:15000});
          await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(1200);await settle(page);
          // The first layout keeps the focus and pointer of its base capture. A toggled layout can
          // keep easing for over a second after the page stops changing by whole pixels (the side
          // panel's width), so it gets that long before it counts as settled.
          for(const rect of steps){await press(rect);}
          if(steps.length){await page.waitForTimeout(2500);await unfocus();}else await steady();
          await page.evaluate(()=>window.__labRemember());
        };
        // States are recorded against the base capture's elements, so the page must show exactly them.
        const looks=elements=>JSON.stringify(elements.map(signature).sort());
        const captured=looks(JSON.parse(await fs.readFile(path.join(root,theme==='dark'?'captures':'captures-light',item.captureId+'.json'),'utf8')).elements);
        let base=[];
        for(let attempt=0;attempt<3&&looks(base)!==captured;attempt++){await load();base=await snapshot();}
        if(looks(base)!==captured)throw Error('The page does not settle on the captured screen');
        const layouts=[{steps:[],geometry:geometry(base),state:null}];
        // Each item of an open menu that opens more, opened by hovering it (or clicking, when
        // hovering does not), with the bounds of everything then open, the state, and what its
        // own new items open in turn, up to three levels. Every item is opened from a freshly
        // opened menu, replaying the items above it.
        // What is open: its bounds and what it says (a submenu can open within the menu's bounds).
        const open=()=>page.evaluate(()=>JSON.stringify([window.__labPanel(),window.__labFloating().filter(layer=>!layer.closest('[role=tooltip]')).map(layer=>layer.innerText).join('\n')]));
        // A click can move items under the pointer (a section expanding pushes the next item
        // there), so after one the pointer goes back to the menu's own control.
        const operate=async(item,by,control)=>{
          if(by==='hover')await page.mouse.move(...centre(item.rect));
          else{await page.mouse.click(...centre(item.rect));await page.mouse.move(...centre(control.rect));}
          await page.waitForTimeout(700);await settle(page);
        };
        async function submenus(control,elements,restore,trail=[],known=new Set()){
          const found=[];
          const items=(await page.evaluate(()=>window.__labSubmenus())).filter(item=>!known.has(item.label));
          const inner=new Set([...known,...items.map(item=>item.label)]);
          for(const item of items){
            await restore();await press(control.rect);
            for(const step of trail)await operate(step,step.by,control);
            const before=await open();
            await operate(item,'hover',control);
            let by='hover';
            if(await open()===before){by='click';await operate(item,'click',control);}
            const panel=await page.evaluate(()=>window.__labPanel());
            if(!panel||await open()===before||!await home())continue;
            const node={...item,by,panel,state:encode(elements,await snapshot())};
            node.submenus=trail.length<2?await submenus(control,elements,restore,[...trail,node],inner):[];
            found.push(node);
          }
          return found;
        }
        // Controls that left the home screen or changed it for good (navigation, suggestions, dismissals) do the same in every layout.
        const inert=new Set();
        // The first layout's controls, as recorded, with their own look.
        let first=[];
        for(let index=0;index<layouts.length;index++){
          const layout=layouts[index];
          let elements=base;
          if(index){await load(layout.steps);elements=await snapshot();layout.state=encode(base,elements);}
          const {controls,editor,neutral}=await scan(page);
          const rest=async()=>{await page.mouse.move(...neutral);await page.waitForTimeout(500);};
          await rest();
          let clean=await dom();
          // Back to this layout as it was: cheap when nothing visible changed, a reload otherwise.
          // A page the app re-rendered but that looks the same (Back, Forward) becomes the new
          // reference for what is new.
          const restore=async()=>{
            await page.keyboard.press('Escape');await page.waitForTimeout(400);
            await page.evaluate(()=>document.activeElement?.blur());await rest();
            if(await dom()===clean)return;
            if(geometry(await snapshot())!==layout.geometry)await load(layout.steps);
            else await page.evaluate(()=>window.__labRemember());
            clean=await dom();
          };
          const seen=new Set(elements.map(signature));
          const recorded=controls.map(control=>({...control,look:inside(elements,control.rect)}));
          for(const control of recorded)if(index)control.same=first.find(other=>other.label===control.label&&other.rect.join()===control.rect.join()&&other.look===control.look);
          for(const control of recorded){
            if(control.same)continue;
            await page.mouse.move(...centre(control.rect));await page.waitForTimeout(700);
            const hover=encode(elements,await snapshot());
            await rest();
            if(changed(hover,elements))control.hover=hover;
          }
          // A click that mounts a new layer on the body (a menu, popover or dialog) while the
          // home screen stays is recorded open, with the panel's bounds. A click that instead
          // rearranges the home screen toggles to another layout, when a control there leads
          // back (the same spot, label or a shared word: Hide/Show sidebar).
          for(const control of recorded){
            if(inert.has(control.label)||control.same&&control.same.toggle===undefined)continue;
            await press(control.rect);
            const panel=await home()&&await page.evaluate(()=>window.__labPanel());
            // New floating content that leaves everything else in place is a menu, popover or
            // dialog (or the sidebar sliding out); a click that moves the rest is a toggle.
            const after=panel&&await snapshot();
            const fresh=panel&&after.some(element=>element.layer==='overlay'&&!seen.has(signature({...element,layer:undefined})));
            if(fresh&&keeps(after,elements,control.rect)){if(!control.same)control.open={panel,state:encode(elements,after),submenus:await submenus(control,elements,restore)};}
            else if(!await home())inert.add(control.label);
            else{
              await unfocus();
              const target=geometry(await snapshot());
              if(target!==layout.geometry){
                let to=layouts.findIndex(other=>other.geometry===target);
                if(to<0&&!index&&layouts.length<MAX_LAYOUTS){
                  const {controls:targetControls}=await scan(page);
                  for(const [attempt,candidate] of returnCandidates(control,targetControls).entries()){
                    if(attempt){await load(layout.steps);await press(control.rect);await unfocus();}
                    await press(candidate.rect);await unfocus();
                    if(geometry(await snapshot())===layout.geometry){to=layouts.push({steps:[...layout.steps,control.rect],geometry:target,state:null})-1;break;}
                  }
                }
                if(to>=0)control.toggle=to;
                else if(!index&&layouts.length<MAX_LAYOUTS)inert.add(control.label);
              }
            }
            await restore();
          }
          let typed=null;
          if(editor){
            const [x,y,w,h]=editor.rect;
            await page.mouse.click(x+Math.min(40,w/2),y+h/2);await page.keyboard.type('x');await rest();
            typed=encode(elements,await snapshot());
          }
          layout.controls=recorded.filter(control=>control.hover||control.open||control.toggle!==undefined||control.same?.hover||control.same?.open);
          layout.editor=editor&&{...editor,typed};
          if(!index)first=recorded;
        }
        // A reused control refers to its index among the first layout's recorded controls.
        const output=layouts.map(({geometry,...layout})=>({...layout,controls:layout.controls.map(({look,same,...control})=>same?{...control,reuse:layouts[0].controls.indexOf(same)}:control)}));
        await fs.writeFile(path.join(directory,item.captureId+'.json'),JSON.stringify({captureId:item.captureId,theme,layouts:output}));
        const count=key=>layouts.reduce((sum,layout)=>sum+layout.controls.filter(control=>control[key]!==undefined).length,0);
        results[item.captureId]={status:'recorded',revision:item.revision,layouts:layouts.length,controls:layouts[0].controls.length,editor:!!layouts[0].editor,ms:Date.now()-started};
        console.log('OK',theme,item.captureId,`${layouts.length} layouts, ${layouts[0].controls.length} controls, ${count('open')} open, ${count('toggle')} toggle`,Math.round((Date.now()-started)/1000)+'s');
      }catch(error){
        failures++;results[item.captureId]={status:'failed',revision:item.revision,error:String(error)};
        console.log('FAIL',theme,item.captureId,String(error).slice(0,200));
      }finally{await context.close();await save();}
    }
  }
  try{await Promise.all(Array.from({length:WORKERS},worker));}
  finally{
    await save();
    await browser.close();
  }
  console.log('SUMMARY',JSON.stringify({recorded:Object.values(results).filter(r=>r.status==='recorded').length,failed:failures}));
  if(failures)process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1;});
