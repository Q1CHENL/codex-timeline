// Check the built page against the native renders: it loads cleanly offline,
// every timeline node can be selected, and every distinct screen and its
// Save image export match the native screenshot.
const {chromium}=require('playwright');
const {PNG}=require('pngjs');
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const data=path.join(__dirname,'..','data');
const MISMATCH_BUDGET=.001; // share of pixels; the native-to-player baseline is under 0.06%

const pngFromBase64=text=>PNG.sync.read(Buffer.from(text,'base64'));
async function exportImage(page){
  return pngFromBase64(await page.evaluate(async()=>{
    const bytes=new Uint8Array(await (await window.codexTimeline.renderImage(1)).arrayBuffer());
    let text='';for(let i=0;i<bytes.length;i+=0x8000)text+=String.fromCharCode(...bytes.subarray(i,i+0x8000));
    return btoa(text);
  }));
}

(async()=>{
  const {default:pixelmatch}=await import('pixelmatch');
  const prepared=JSON.parse(await fs.readFile(path.join(data,'prepared-data.json'),'utf8'));
  const html=await fs.readFile(path.join(data,'preview.html'));
  const errors=[],external=[],failures=[];let checked=0,maxRatio=0;
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const context=await browser.newContext({viewport:{width:1200,height:780},deviceScaleFactor:1,reducedMotion:'reduce'});
    await context.route('**/*',route=>{
      if(route.request().url().startsWith('file:'))return route.continue();
      external.push(route.request().url());return route.abort();
    });
    const open=async()=>{
      const page=await context.newPage();page.on('pageerror',error=>errors.push(String(error)));
      await page.goto('file://'+path.join(data,'preview.html'));await page.evaluate(()=>window.codexTimeline.ready);
      return page;
    };
    // The exporter keeps the normal layout; the stage page shows the stage unscaled at 1200 × 780.
    const exporter=await open(),stage=await open();
    await stage.evaluate(()=>{document.body.append(document.querySelector('#stage'));document.querySelector('main').style.display='none';});
    await stage.addStyleTag({content:'#stage{position:fixed!important;left:0!important;top:0!important;transform:none!important}'});

    const unselectable=await exporter.evaluate(timeline=>timeline.flatMap((node,index)=>{
      window.codexTimeline.selectVersion(index);
      return window.codexTimeline.getState().version===node.version?[]:[node.version];
    }),prepared.timeline);
    if(unselectable.length)failures.push({reason:'timeline nodes cannot be selected',versions:unselectable});

    for(const theme of ['dark','light']){
      for(const page of [stage,exporter])await page.evaluate(name=>window.codexTimeline.setTheme(name),theme);
      const seen=new Set();
      for(const [index,node] of prepared.timeline.entries()){
        const scene=node.sceneIndices[theme];if(seen.has(scene))continue;seen.add(scene);
        for(const page of [stage,exporter])await page.evaluate(i=>window.codexTimeline.selectVersion(i),index);
        const native=PNG.sync.read(await fs.readFile(path.join(data,theme==='dark'?'captures':'captures-light',node.captureId+'.png')));
        for(const [kind,image] of [['player',PNG.sync.read(await stage.screenshot())],['export',await exportImage(exporter)]]){
          if(image.width!==1200||image.height!==780)throw Error(`${kind} image is ${image.width} × ${image.height}`);
          const ratio=pixelmatch(image.data,native.data,null,1200,780,{threshold:.15,includeAA:false})/(1200*780);
          maxRatio=Math.max(maxRatio,ratio);
          if(ratio>MISMATCH_BUDGET)failures.push({theme,captureId:node.captureId,kind,ratio});
        }
        checked++;
      }
    }
  }finally{await browser.close()}
  const report={htmlSha256:crypto.createHash('sha256').update(html).digest('hex'),scenesChecked:checked,maxMismatchRatio:maxRatio,mismatchBudget:MISMATCH_BUDGET,errors,external,failures};
  await fs.writeFile(path.join(data,'verification.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
  if(errors.length||external.length||failures.length)process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1});
