const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
// Sources live beside this script; renderers, captures and ledgers live in data/.
const root=path.join(__dirname,'..','data');
const readJSON=async file=>JSON.parse(await fs.readFile(path.join(root,file),'utf8'));
(async()=>{
  const args=process.argv.slice(2),requested=[];
  let theme='dark',fresh=false;
  for(let i=0;i<args.length;i++){
    if(args[i]==='--fresh') fresh=true;
    else if(args[i]==='--theme') theme=args[++i];
    else if(args[i].startsWith('--theme=')) theme=args[i].slice('--theme='.length);
    else if(args[i].startsWith('--')) throw Error('Unknown capture option: '+args[i]);
    else requested.push(args[i]);
  }
  if(!['dark','light'].includes(theme))throw Error('--theme must be dark or light');
  const captureDirectory=theme==='dark'?'captures':'captures-light';
  const ledger=theme==='dark'?'capture-results.json':'capture-results-light.json';
  const temporaryLedger=ledger.replace(/\.json$/,'.tmp.json');
  await fs.mkdir(path.join(root,captureDirectory),{recursive:true});
  const catalog=await readJSON('timeline-catalog.json');
  const results=await readJSON(ledger).catch(()=>({}));
  const modelFixtures=await readJSON('model-fixtures.json');
  const extract=await fs.readFile(path.join(__dirname,'capture-scene.js'),'utf8');
  const fixtureSource=extract+await fs.readFile(path.join(__dirname,'bridge.js'),'utf8')+await fs.readFile(path.join(__dirname,'server.py'),'utf8');
  const candidates=await Promise.all(catalog.filter(x=>x.status==='extracted'&&(!requested.length||requested.includes(x.captureId))).map(async item=>{
    const host=await fs.readFile(path.join(root,'renderers',item.version,'host.mjs'),'utf8');
    // See REVISION_SOURCES in paths.py: only this capture's own model fixture counts.
    const revision=crypto.createHash('sha256').update(fixtureSource+JSON.stringify(modelFixtures[item.captureId])+host+theme,'utf8').digest('hex');
    return {...item,revision};
  }));
  const queue=candidates.filter(x=>fresh||results[x.captureId]?.status!=='captured'||results[x.captureId]?.theme!==theme||results[x.captureId]?.revision!==x.revision);
  const browser=await chromium.launch({channel:'chrome',headless:true});
  let next=0,failures=0,checkpoint=Promise.resolve();
  async function worker(){
    while(next<queue.length){
      const item=queue[next++],version=item.version,captureId=item.captureId,revision=item.revision,started=Date.now();
      console.log('CAPTURE',theme,captureId,version);
      const context=await browser.newContext({viewport:{width:1200,height:780},colorScheme:theme,locale:'en-US',serviceWorkers:'block'});
      const blocked=[],failed=[],errors=[];
      let page,result;
      try {
        await context.route('**/*',r=>{const u=new URL(r.request().url());if(u.hostname==='127.0.0.1')return r.continue();blocked.push(u.href);return r.abort();});
        page=await context.newPage();
        page.on('requestfailed',r=>failed.push({url:r.url(),error:r.failure()}));
        page.on('pageerror',e=>errors.push(e.stack));
        await page.goto(`http://127.0.0.1:4823/?v=${version}&capture=${captureId}&theme=${theme}`,{waitUntil:'load',timeout:25000});
        await page.waitForFunction(()=>{
          const body=document.body.innerText;
          return /Let[’']s build|What should we (?:build|work on)\?|What can I help/i.test(body)&&document.querySelector('[contenteditable="true"],textarea');
        },{},{timeout:15000});
        await page.evaluate(()=>document.fonts.ready);
        await page.waitForTimeout(1200);
        await page.evaluate(()=>{
          for(const animation of document.getAnimations()){
            if(animation.effect.getTiming().iterations===Infinity){animation.pause();animation.currentTime=500;}
            else animation.finish();
          }
        });
        const {lab,responseNames}=await page.evaluate(()=>({lab:window.__lab,responseNames:Object.keys(window.__labResponses??{})})),text=await page.locator('body').innerText();
        const httpNames=[...lab.rpc.filter(r=>r.method==='httpFetch.fetch').map(r=>r.name),...lab.messages.filter(m=>m.type==='fetch').map(m=>new URL(m.url,'https://fixture.invalid').pathname.slice(1))];
        const unhandledHttpRequests=[...new Set(httpNames.filter(name=>!responseNames.includes(name)))];
        const appearance=await page.evaluate(()=>{
          const html=document.documentElement,windowRoot=document.querySelector('[data-codex-window-type="electron"]')||html;
          const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
          let hero=null,node;
          while(node=walker.nextNode()){
            if(/^(Let[’']s build|What should we (?:build|work on)\?|What can I help.*)$/i.test(node.textContent.trim())){hero=node.parentElement;break;}
          }
          const windowStyle=getComputedStyle(windowRoot);
          return {
            documentTheme:html.dataset.theme,documentClasses:html.className,
            systemTheme:window.electronBridge.getSystemThemeVariant(),
            prefersLight:matchMedia('(prefers-color-scheme: light)').matches,
            windowClasses:windowRoot.className,
            bodyBackground:getComputedStyle(document.body).backgroundColor,
            windowBackground:windowStyle.backgroundColor,
            surface:windowStyle.getPropertyValue('--codex-base-surface').trim(),
            ink:windowStyle.getPropertyValue('--codex-base-ink').trim(),
            heroColor:hero?getComputedStyle(hero).color:null,
          };
        });
        if(lab.fixture?.theme!==theme||appearance.systemTheme!==theme||appearance.documentTheme!==theme||appearance.prefersLight!==(theme==='light'))throw Error('Native appearance does not match requested '+theme+' theme');
        const fatal=lab.messages.filter(x=>x.type==='log-message'&&/ErrorBoundary|Fatal error|is not a function|Cannot read properties/.test(x.message));
        if(errors.length||fatal.length||/Oops, an error has occurred/.test(text)) throw Error('Renderer error: '+(errors[0]||fatal[0]?.message||text));
        if(item.packageArchivedAt.slice(0,10)>='2026-10-01'&&!await page.locator('[data-app-navigation-rail="true"]').count()) throw Error('October reference navigation rail is absent');
        const scene=await page.evaluate(`(${extract})()`);
        const model=modelFixtures[captureId];
        if(JSON.stringify(lab.fixture.model)!==JSON.stringify(model))throw Error('Model fixture mismatch');
        const normalize=value=>value.toLowerCase().replace(/^gpt-?/,'').replace(/[^a-z0-9.]/g,'');
        const modelLabels=scene.elements.filter(e=>e.kind==='text'&&normalize(e.text||'')===normalize(model.displayName));
        if(modelLabels.length!==1||scene.elements.some(e=>e.kind==='text'&&e.text==='Custom'))throw Error('Expected one native model label for '+model.model);
        const effortNames=model.reasoningEffort==='low'?['Low','Light']:[model.reasoningEffort.charAt(0).toUpperCase()+model.reasoningEffort.slice(1)];
        const effortLabels=scene.elements.filter(e=>e.kind==='text'&&effortNames.includes(e.text)&&e.semantic?.region==='composer');
        if(effortLabels.length!==1)throw Error('Expected one native reasoning label for '+model.reasoningEffort);
        const renderedModel={...model,visibleLabel:modelLabels[0].text,visibleEffort:effortLabels[0].text};
        Object.assign(scene,{captureId,kind:item.kind,archivedAt:item.archivedAt,packageArchivedAt:item.packageArchivedAt,theme,fixture:lab.fixture,appearance,renderedModel});
        if(scene.elements.length<15)throw Error('Main interface has too few visual elements');
        await page.screenshot({path:path.join(root,captureDirectory,`${captureId}.png`)});
        await fs.writeFile(path.join(root,captureDirectory,`${captureId}.json`),JSON.stringify(scene));
        result={status:'captured',revision,version,captureId,theme,elements:scene.elements.length,text,errors,blocked,failed,unhandledHttpRequests,unhandledMcpRequests:lab.unhandledMcpRequests,fixture:lab.fixture,appearance,renderedModel,ms:Date.now()-started,at:new Date().toISOString()};
        await fs.writeFile(path.join(root,captureDirectory,`${captureId}-log.json`),JSON.stringify({lab,...result},null,2));
        console.log('OK',theme,captureId,scene.elements.length,Math.round(result.ms/1000)+'s');
      } catch(error){
        result={status:'failed',version,captureId,theme,revision,fixture:{theme},error:String(error),errors,blocked,failed,ms:Date.now()-started};
        if(page){
          result.text=await page.locator('body').innerText().catch(()=>null);
          result.lab=await page.evaluate(()=>window.__lab).catch(()=>null);
          if(result.lab?.fixture)result.fixture=result.lab.fixture;
          await page.screenshot({path:path.join(root,captureDirectory,`${captureId}-failure.png`)}).catch(()=>{});
        }
        failures++;
        console.log('FAIL',captureId,String(error).slice(0,220));
      } finally {
        results[captureId]=result;
        // Keep writes on the event loop serialized so two capture workers cannot truncate the ledger.
        checkpoint=checkpoint.then(async()=>{
          await fs.writeFile(path.join(root,temporaryLedger),JSON.stringify(results,null,2));
          await fs.rename(path.join(root,temporaryLedger),path.join(root,ledger));
        });
        await checkpoint;
        await context.close();
      }
    }
  }
  try{await Promise.all([worker(),worker()]);}
  finally{
    await fs.writeFile(path.join(root,ledger),JSON.stringify(results,null,2));
    await browser.close();
  }
  console.log('SUMMARY',JSON.stringify(Object.values(results).reduce((a,r)=>(a[r.status]=(a[r.status]||0)+1,a),{})));
  // A failed capture stops rebuild.py here instead of publishing stale scenes.
  if(failures)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
