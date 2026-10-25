// Actual reader HTTP routing; generated PDF, in-memory saves, external requests blocked.
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const root = path.resolve(__dirname, '..');
const deps = process.env.READER_TEST_NODE_MODULES || 'node_modules';
const { chromium } = require(path.join(deps, 'playwright'));
const { PDFDocument, StandardFonts } = require(path.join(root, 'static/lib/pdf-lib.min.js'));
const source = `
import functools,json,sys,threading
from http.server import ThreadingHTTPServer
from app.server import PDFReaderHandler
class AuditHandler(PDFReaderHandler):
 def log_message(self,*args): pass
 def do_GET(self):
  if self.path.startswith('/api/cloud-anno'):
   self._json_response(200,{'ok':True,'configured':False,'enabled':False}); return
  if self.path.startswith('/api/ai-config'):
   self._json_response(200,{'model':'audit','models':[],'thinking':'omit','revision':'audit'}); return
  super().do_GET()
with ThreadingHTTPServer(('127.0.0.1',0),functools.partial(AuditHandler,directory=${JSON.stringify(root)})) as s:
 t=threading.Thread(target=s.serve_forever,daemon=True);t.start()
 print(json.dumps({'origin':'http://127.0.0.1:'+str(s.server_port)}),flush=True)
 try: sys.stdin.read()
 finally: s.shutdown();t.join()
`;
(async () => {
 const child = spawn(process.env.READER_TEST_PYTHON || 'python', ['-u', '-c', source], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: {...process.env, PYTHONIOENCODING:'utf-8'} });
 let browser;
 child.stderr.on('data', b => process.stderr.write(b));
 try {
  const origin = await new Promise((resolve,reject) => {
   const timer = setTimeout(() => reject(new Error('server startup timeout')),15000);
   readline.createInterface({input:child.stdout}).on('line', line => {try {const j=JSON.parse(line); if(j.origin){clearTimeout(timer);resolve(j.origin);}}catch{}});
   child.once('error',reject);
   child.once('exit',code => {clearTimeout(timer);reject(new Error('server exited '+code));});
  });
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for(let i=1;i<=3;i++) doc.addPage([595,842]).drawText('Architecture audit page '+i,{x:40,y:700,font,size:18});
  const pdf = Buffer.from(await doc.save()).toString('base64');
  browser = await chromium.launch({executablePath:process.env.READER_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  for(const entry of ['/','/index.html','/LOCALPdfReader.html?_readerLoad=audit','/static/index.html']) {
   const context=await browser.newContext();
   await context.route('**/*',route => {
    const u=new URL(route.request().url());
    return u.hostname==='127.0.0.1' || ['data:','blob:'].includes(u.protocol) ? route.continue() : route.abort();
   });
   const page=await context.newPage(), errors=[], failures=[];
   page.on('pageerror',e=>errors.push(e.message));
   page.on('response',r=>{if(r.status()>=400)failures.push([r.status(),r.url()]);});
   async function openPdf(){
    await page.evaluate(async b64=>{const bytes=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));await processSelectedFile(new File([bytes],'architecture-audit.pdf',{type:'application/pdf'}),null);await state.annotationsReady;},pdf);
    await page.waitForFunction(()=>state.pdfDoc?.numPages===3 && state.pagesRendered.has(1));
   }
   assert.equal((await page.goto(origin+entry)).status(),200);
   await openPdf();
   await page.evaluate(async()=>{
    performAction(()=>{state.annotations[1]=[{id:'audit-note',type:'highlight',color:'#fde047',rects:[{x:.1,y:.1,w:.2,h:.02}],text:'audit'}];},[1]);
    await saveAnnotationsToStorage();
   });
   await page.reload();await openPdf();
   await page.waitForFunction(()=>state.annotations[1]?.some(a=>a.id==='audit-note'));
   await page.evaluate(()=>updateZoom(1.5));
   await page.waitForFunction(()=>renderedPageScales.get(1)===1.5);
   const saved=await page.evaluate(async()=>{
    let bytes;
    state.fileHandle={queryPermission:async()=> 'granted',createWritable:async()=>({write:async blob=>{bytes=await blob.arrayBuffer();},close:async()=>{}})};
    await performSave();
    const d=await PDFLib.PDFDocument.load(bytes);
    const a=JSON.parse(new TextDecoder().decode(d.getInfoDict().get(PDFLib.PDFName.of('ReaderProAnnos')).asBytes()));
    return {pages:d.getPageCount(),hasNote:a[1].some(x=>x.id==='audit-note'),dirty:state.unsavedChanges};
   });
   assert.deepEqual(saved,{pages:3,hasNote:true,dirty:false});
   assert.deepEqual(errors,[]);assert.deepEqual(failures,[]);
   console.log(JSON.stringify({entry,pdfOpen:true,draftRestore:true,zoom:true,saveSnapshot:true,pageErrors:errors,failedResponses:failures}));
   await context.close();
  }
 } finally {
  if(browser)await browser.close();
  child.stdin.end();
  await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);setTimeout(()=>{child.kill();resolve();},3000).unref();});
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
