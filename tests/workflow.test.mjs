import {after,before,test} from 'node:test'
import assert from 'node:assert/strict'
import {randomBytes,randomUUID} from 'node:crypto'
import {mkdtemp,readdir,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve,sep} from 'node:path'
import sharp from 'sharp'
import {buildApp} from '../server/app.ts'
import {createAuth} from '../server/auth.ts'
import {readConfig} from '../server/config.ts'
import {assertRuntimeRole,createPool,transaction} from '../server/db.ts'
import {migrate} from '../server/migrate.ts'
import {emptyWorkflow,draftPublication,emptyTerms,documentTotals} from '../src/product/workflow-model.ts'
import {emptyClassification,RULES_VERSION,CATALOG_VERSION} from '../src/product/classification-model.ts'
import {workflowSchema} from '../src/product/workflow-schema.ts'

const dbName=`workflow_test_${randomBytes(6).toString('hex')}`
const adminUrl=new URL(process.env.DATABASE_ADMIN_URL),runtimeUrl=new URL(process.env.DATABASE_URL)
assert.equal(adminUrl.hostname,'127.0.0.1');assert.equal(runtimeUrl.hostname,'127.0.0.1')
assert.equal(adminUrl.port,'55432');assert.equal(runtimeUrl.port,'55432')
const controlUrl=new URL(adminUrl);controlUrl.pathname='/postgres';adminUrl.pathname=runtimeUrl.pathname=`/${dbName}`
const control=createPool(controlUrl.href),owner=createPool(adminUrl.href),runtime=createPool(runtimeUrl.href)
const config=readConfig({...process.env,DATABASE_URL:runtimeUrl.href}),companies=[randomUUID(),randomUUID()]
const password=randomBytes(30).toString('base64url'),today=new Date(Date.now()+9*3600000).toISOString().slice(0,10)
const classificationVersions=new Map()
let app,users,cookies,created=false,storage,oldStorage,png
const path=(j,c=companies[0])=>`/api/companies/${c}/jobs/${j.id}`
const req=(method,url,payload,cookie=cookies?.[0],headers={})=>app.inject({method,url,headers:{origin:config.origin,...(cookie?{cookie}:{}),...headers},...(payload===undefined?{}:{payload})})
const get=async j=>{const r=await req('GET',path(j)+'/workflow');assert.equal(r.statusCode,200,r.body);return r.json()}
const put=(j,data=emptyWorkflow(),version=0,jobVersion=j.version,classificationVersion=classificationVersions.get(j.id) ?? null,cookie=cookies?.[0])=>req('PUT',path(j)+'/workflow',{version,jobVersion,classificationVersion,data},cookie)
const history=async j=>(await req('GET',path(j)+'/workflow/audit')).json()
const direct=(j,data,version=2,jobVersion=1,classificationVersion=classificationVersions.get(j.id) ?? null,actor=users[0].id)=>transaction(runtime,actor,c=>c.query(
  'UPDATE job_workflows SET version=$3,data=$4,basis_job_version=$5,classification_version=$6 WHERE company_id=$1 AND job_id=$2',
  [companies[0],j.id,version,JSON.stringify(data),jobVersion,classificationVersion]))
async function job(company=companies[0],actor=users[0].id) {
  return transaction(runtime,actor,async c=>(await c.query(`INSERT INTO jobs(id,company_id,name,site_address,customer_name,work_description,created_by)
    VALUES($1,$2,'試験工事','試験所在地','発注者','修繕',$3) RETURNING id,version`,[randomUUID(),company,actor])).rows[0])
}
const line=(quantity='1',unitPrice='1000')=>({id:randomUUID(),description:'修繕作業',category:'labor',quantity,unit:'式',unitPrice})
const estimate=(status='draft')=>({id:randomUUID(),...draftPublication(),status,title:'見積',recipient:'発注者',recipientAddress:'所在地',issuer:'施工者',issuerAddress:'施工者所在地',issuedOn:today,validUntil:null,items:[line()],taxRate:'10',rounding:'floor',notes:''})
const contract=(estimateId,status='draft')=>({id:randomUUID(),...draftPublication(),status,title:'契約',estimateId,kind:'initial',originalContractId:null,changeReason:'',effectiveDate:today,partyRole:'receiving',counterparty:'発注者',
  terms:{...Object.fromEntries(Object.keys(emptyTerms()).map(k=>[k,'協議内容を明記'])) ,startDate:today,endDate:today,handoverDate:today}})
const invoice=(contractId,status='draft')=>({id:randomUUID(),...draftPublication(),status,number:'INV-001',direction:'receivable',contractId,recipient:'発注者',issuer:'施工者',issuedOn:today,dueOn:today,bank:'指定口座',registrationNumber:'',items:[line()],taxRate:'10',rounding:'floor',notes:''})
const photo=(fileId,id=randomUUID())=>({id,fileId,phase:'before',caption:'施工前',capturedAt:null,source:'camera'})
const payment=(invoiceId,amountYen='500',evidenceIds=[])=>({id:randomUUID(),invoiceId,type:'payment',reversesId:null,paidOn:today,amountYen,method:'振込',reference:'',evidenceIds,note:''})
async function upload(j,id=randomUUID(),body=png,name='現場写真.png',kind='photo',type='image/png',cookie=cookies[0]) {
  return req('PUT',path(j)+`/files/${id}`,body,cookie,{'content-type':type,'x-file-name':encodeURIComponent(name),'x-file-kind':kind})
}
const known=value=>({state:'known',value,reason:null})
function completeClassification() {
  const d=emptyClassification()
  for(const [key,value] of Object.entries({market:'private',companyRole:'prime_contractor',workKind:'repair',targetKind:'building'}))d.context[key]=known(value)
  d.workItems=[{id:randomUUID(),description:'扉の修繕',tradeCandidates:known(['fittings']),relationship:known('independent'),parentItemId:null}]
  d.amounts.contract=known({yen:'1000',taxBasis:'tax_included'})
  for(const field of ['suppliedMaterials','splitContracts','subcontracting'])d.amounts[field]=known('no')
  for(const key of Object.keys(d.conditions))d.conditions[key]=known('no')
  d.permit.declaration=known('not_held')
  return d
}
async function reviewedData(j,classification=completeClassification()) {
  const current=classificationVersions.get(j.id) ?? 0
  const r=await req('PUT',path(j)+'/classification',{version:current,jobVersion:j.version,data:classification});assert.equal(r.statusCode,current?200:201,r.body)
  classificationVersions.set(j.id,r.json().record.version)
  const f=(await upload(j)).json(),d=emptyWorkflow()
  d.reviews=r.json().issues.filter(i=>i.kind==='review').map(issue=>({id:randomUUID(),issueId:issue.id,classificationVersion:r.json().record.version,jobVersion:j.version,conclusion:'confirmed',reviewedOn:today,evidenceIds:[f.id],note:'資料と照合した理由を記録'}))
  return d
}
async function issuedSet(j) {
  const data=await reviewedData(j),e=estimate('issued'),c=contract(e.id,'issued'),i=invoice(c.id,'issued')
  data.estimates=[e];data.contracts=[c];data.invoices=[i]
  const r=await put(j,data);assert.equal(r.statusCode,201,r.body);return r.json()
}
before(async()=>{
  oldStorage=process.env.FILE_STORAGE_DIR;storage=await mkdtemp(join(tmpdir(),'workflow-files-'));process.env.FILE_STORAGE_DIR=storage
  png=await sharp({create:{width:2,height:2,channels:3,background:'#123456'}}).png().toBuffer()
  await control.query(`CREATE DATABASE ${dbName}`);created=true
  await migrate(owner,config,process.env.DB_APP_PASSWORD);await migrate(owner,config,process.env.DB_APP_PASSWORD)
  const auth=createAuth(owner,config,true);users=[]
  for(const [email,name] of [['owner@workflow.invalid','記録者'],['other@workflow.invalid','他社'],['viewer@workflow.invalid','閲覧者']]) users.push((await auth.api.signUpEmail({body:{email,name,password}})).user)
  await owner.query("INSERT INTO companies(id,name) VALUES($1,'会社A'),($2,'会社B')",companies)
  await owner.query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner'),($3,$4,'manager'),($1,$5,'viewer')",[companies[0],users[0].id,companies[1],users[1].id,users[2].id])
  app=await buildApp(runtime,config);cookies=[]
  for(const user of users) {
    const r=await req('POST','/api/auth/sign-in/email',{email:user.email,password},null);assert.equal(r.statusCode,200,r.body)
    const raw=r.headers['set-cookie'];cookies.push((Array.isArray(raw)?raw:[raw]).map(c=>c.split(';')[0]).join('; '))
  }
})
after(async()=>{
  await app?.close();await runtime.end();await owner.end()
  try {if(created){assert.match(dbName,/^workflow_test_[a-f0-9]{12}$/);await control.query(`DROP DATABASE ${dbName} WITH (FORCE)`)}}
  finally {
    await control.end()
    if(storage){const target=resolve(storage);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&target.includes('workflow-files-'));await rm(target,{recursive:true,force:true})}
    if(oldStorage===undefined)delete process.env.FILE_STORAGE_DIR;else process.env.FILE_STORAGE_DIR=oldStorage
  }
})

test('GET returns empty v0 without writes, viewer reads and tenant/origin/auth boundaries',async()=>{
  const j=await job()
  for(const cookie of [cookies[0],cookies[2]]) {
    const r=await req('GET',path(j)+'/workflow',undefined,cookie);assert.equal(r.statusCode,200,r.body)
    assert.deepEqual(r.json().data,emptyWorkflow());assert.equal(r.json().version,0);assert.equal(r.json().jobVersion,1);assert.equal(r.json().classificationVersion,null)
  }
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM job_workflows')).rows[0].n,0)
  assert.equal((await req('GET',path(j)+'/workflow',undefined,null)).statusCode,401)
  assert.equal((await req('GET',path(j)+'/workflow',undefined,cookies[1])).statusCode,404)
  assert.equal((await put(j,emptyWorkflow(),0,1,null,cookies[2])).statusCode,403)
  assert.equal((await req('GET',path(j)+'/workflow/audit',undefined,cookies[2])).statusCode,403)
  assert.equal((await req('PUT',path(j)+'/workflow',{version:0,jobVersion:1,classificationVersion:null,data:emptyWorkflow()},cookies[0],{origin:'https://wrong.invalid'})).statusCode,403)
})
test('first save/version conflicts and current job/classification bases, audit attribution',async()=>{
  const j=await job();let r=await put(j);assert.equal(r.statusCode,201,r.body)
  assert.equal(r.json().updatedBy,users[0].id);assert.match(r.json().updatedAt,/Z$/)
  assert.equal((await put(j)).statusCode,409)
  assert.equal((await put(j,emptyWorkflow(),1)).statusCode,200)
  await transaction(runtime,users[0].id,c=>c.query('UPDATE jobs SET version=version+1 WHERE id=$1',[j.id]))
  assert.equal((await put(j,emptyWorkflow(),2)).statusCode,409)
  assert.equal((await put(j,emptyWorkflow(),2,2)).statusCode,200)
  r=await req('PUT',path(j)+'/classification',{version:0,jobVersion:2,data:emptyClassification()});assert.equal(r.statusCode,201,r.body)
  assert.equal((await put(j,emptyWorkflow(),3,2)).statusCode,409)
  assert.equal((await put(j,emptyWorkflow(),3,2,1)).statusCode,200)
  const h=await history(j);assert.equal(h.events.length,4);assert.equal(h.events[0].version,4);assert.equal(h.events[0].actorName,users[0].name);assert.equal(h.events[3].beforeData,null)
})
test('strict shared schema, dates, UUIDs, money bounds and workflow-only 512KiB limit',async()=>{
  const j=await job();const invalid=[]
  const add=change=>{const d=emptyWorkflow();change(d);invalid.push(d)}
  add(d=>d.extra='x');add(d=>d.estimates=[{...estimate(),extra:'x'}]);add(d=>{d.tasks=[{id:'',title:'',company:'',startsOn:'',endsOn:'',status:'planned',note:''}]})
  for(const date of ['2026-02-30','2026-13-01','not-date'])add(d=>d.estimates=[{...estimate(),issuedOn:date}])
  for(const quantity of ['-1','1e2','1.001','01',''])add(d=>d.estimates=[{...estimate(),items:[line(quantity)]}])
  add(d=>d.estimates=[{...estimate(),items:[line('999999999','999999999999')]}])
  add(d=>{d.laborInsurance.note='\u0000'});add(d=>{d.laborInsurance.note='\uD800'})
  for(const d of invalid){const r=await put(j,d);assert.equal(r.statusCode,400,r.body)}
  const body={version:0,jobVersion:1,classificationVersion:null,data:emptyWorkflow()},raw=JSON.stringify(body)
  const exact=await req('PUT',path(j)+'/workflow',raw+' '.repeat(512*1024-Buffer.byteLength(raw)),cookies[0],{'content-type':'application/json'})
  assert.equal(exact.statusCode,201,exact.body)
  assert.equal((await req('PUT',path(j)+'/workflow',raw+' '.repeat(512*1024+1-Buffer.byteLength(raw)),cookies[0],{'content-type':'application/json'})).statusCode,413)
  assert.equal((await req('PATCH',path(j),JSON.stringify({})+' '.repeat(32769),cookies[0],{'content-type':'application/json'})).statusCode,413)
  assert.equal((await history(j)).events.length,1)
  const definition=(await owner.query("SELECT pg_get_functiondef('public.validate_workflow_structure(jsonb)'::regprocedure) AS source")).rows[0].source
  assert.deepEqual(JSON.parse(definition.match(/\$schema\$([\s\S]+?)\$schema\$/)[1]),workflowSchema)
})
test('blank drafts save; issuance derives real job/actor/classification and enforces all terms/source',async()=>{
  const j=await job(),d=emptyWorkflow(),e=estimate();e.title=e.recipient=e.issuer=e.issuedOn='';e.items=[];d.estimates=[e]
  let r=await put(j,d);assert.equal(r.statusCode,201,r.body)
  const bad=r.json().data;bad.estimates[0].status='issued';assert.equal((await put(j,bad,1)).statusCode,400)
  const j2=await job();const view=await issuedSet(j2)
  assert.equal(view.data.estimates[0].issuedBy,users[0].id);assert.equal(view.data.estimates[0].basis.job.id,j2.id)
  assert.equal(view.data.contracts[0].basis.classificationVersion,1)
  for(const section of ['estimates','contracts','invoices']) {
    for(const op of ['edit','delete','draft']) {
      const changed=structuredClone(view.data);if(op==='delete')changed[section]=[];else if(op==='edit')changed[section][0].notes='changed';else changed[section][0].status='draft'
      assert.equal((await put(j2,changed,1)).statusCode,400)
      await assert.rejects(direct(j2,changed),e=>e.code==='23514')
    }
  }
  for(const change of [d=>{d.contracts[0].terms.paymentTerms=''},d=>{d.estimates[0].status='draft'},d=>{d.contracts[0].issuedBy=users[1].id},d=>{d.invoices[0].direction='payable'}]) {
    const j3=await job(),data=await reviewedData(j3),e=estimate('issued'),c=contract(e.id,'issued');data.estimates=[e];data.contracts=[c];data.invoices=[invoice(c.id,'issued')];change(data)
    assert.equal((await put(j3,data)).statusCode,400)
  }
})
test('reviews append only and require current classification issue, reason and owned evidence',async()=>{
  const j=await job(),f=(await upload(j)).json()
  const cr=await req('PUT',path(j)+'/classification',{version:0,jobVersion:1,data:emptyClassification()});assert.equal(cr.statusCode,201,cr.body)
  const issue=cr.json().issues[0].id,d=emptyWorkflow(),review={id:randomUUID(),issueId:issue,classificationVersion:1,jobVersion:1,conclusion:'confirmed',reviewedOn:today,evidenceIds:[f.id],note:'確認理由'}
  d.reviews=[review];let r=await put(j,d,0,1,1);assert.equal(r.statusCode,201,r.body)
  for(const change of [d=>{d.reviews[0].note='変更'},d=>{d.reviews=[]},d=>{d.reviews.push({...review,id:randomUUID(),issueId:'unknown'})},d=>{d.reviews.push({...review,id:randomUUID(),classificationVersion:2})},d=>{d.reviews.push({...review,id:randomUUID(),evidenceIds:[]})}]) {
    const changed=structuredClone(r.json().data);change(changed);assert.equal((await put(j,changed,1,1,1)).statusCode,400)
  }
  const more=r.json().data;more.reviews.push({...review,id:randomUUID(),conclusion:'needs_action',evidenceIds:[]});r=await put(j,more,1,1,1);assert.equal(r.statusCode,200,r.body)
  await assert.rejects(direct(j,emptyWorkflow(),3,1,1),e=>e.code==='23514')
})
test('private files preserve bytes; exact retry and content attributes, filename traversal, decoded images',async()=>{
  const j=await job(),id=randomUUID(),r=await upload(j,id);assert.equal(r.statusCode,201,r.body)
  const file=r.json();assert.equal(file.createdBy,users[0].id);assert.equal(file.size,png.length);assert.deepEqual(Object.keys(file).sort(),['id','companyId','jobId','name','contentType','size','sha256','kind','createdAt','createdBy'].sort())
  assert.deepEqual((await upload(j,id)).json(),file);assert.equal((await upload(j,id)).statusCode,200)
  for(const [name,kind] of [['違う.png','photo'],['現場写真.png','evidence']])assert.equal((await upload(j,id,png,name,kind)).statusCode,409)
  const files=await req('GET',path(j)+'/files',undefined,cookies[2]);assert.equal(files.statusCode,200,files.body);assert.equal(files.json().files.length,1)
  const download=await req('GET',path(j)+`/files/${id}`,undefined,cookies[2]);assert.equal(download.statusCode,200,download.body)
  assert.deepEqual(download.rawPayload,png);assert.match(download.headers['content-disposition'],/filename\*=UTF-8''/);assert.equal(download.headers['x-content-type-options'],'nosniff');assert.match(download.headers['content-security-policy'],/sandbox/)
  for(const name of ['../escape.png','..\\escape.png','bad\n.png','.','..','%2f.png']) {
    const headers={'content-type':'image/png','x-file-name':name==='%2f.png'?name:encodeURIComponent(name),'x-file-kind':'photo'}
    assert.equal((await req('PUT',path(j)+`/files/${randomUUID()}`,png,cookies[0],headers)).statusCode,400)
  }
  for(const [body,type] of [[Buffer.from('<svg/>'),'image/png'],[png.subarray(0,20),'image/png'],[png,'image/jpeg']])assert.equal((await upload(j,randomUUID(),body,'file.png','photo',type)).statusCode,415)
  const huge=await sharp({create:{width:5000,height:4001,channels:3,background:'white'}}).png().toBuffer()
  assert.equal((await upload(j,randomUUID(),huge)).statusCode,415)
  const jpg=await sharp(png).jpeg().toBuffer(),webp=await sharp(png).webp().toBuffer()
  for(const [b,t] of [[jpg,'image/jpeg'],[webp,'image/webp']])assert.equal((await upload(j,randomUUID(),b,'image','photo',t)).statusCode,201)
  assert.ok((await readdir(storage)).length>=3)
})
test('file authorization occurs before body parsing; bounded uploads, cross-scope download, immutable SQL metadata',async()=>{
  const j=await job(),id=randomUUID(),file=(await upload(j,id)).json(),big=Buffer.alloc(12*1024*1024+1)
  assert.equal((await upload(j,randomUUID(),big,'x','photo','image/png',null)).statusCode,401)
  assert.equal((await upload(j,randomUUID(),big,'x','photo','image/png',cookies[2])).statusCode,403)
  assert.equal((await upload(j,randomUUID(),big)).statusCode,413)
  assert.equal((await req('GET',path(j)+`/files/${id}`,undefined,cookies[1])).statusCode,404)
  const j2=await job();assert.equal((await req('GET',path(j2)+`/files/${id}`)).statusCode,404)
  assert.equal((await upload(j2,id)).statusCode,409)
  assert.equal((await upload(j,id,png,'x','photo','image/png',cookies[2])).statusCode,403)
  for(const sql of ['UPDATE job_files SET name=name','DELETE FROM job_files','TRUNCATE job_files'])await assert.rejects(transaction(runtime,users[0].id,c=>c.query(sql)),e=>e.code==='42501')
  await assert.rejects(transaction(runtime,users[0].id,c=>c.query('INSERT INTO job_files(id,company_id,job_id,name,content_type,size,sha256,kind,storage_key,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[randomUUID(),companies[0],j.id,'x','image/png',png.length,file.sha256,'photo',randomUUID(),users[1].id])),e=>e.code==='42501')
})
test('PDF is evidence only and always attachment; photo append retries and concurrent appends preserve all records',async()=>{
  const j=await job(),pdf=Buffer.from('%PDF-1.7\n1 0 obj <</Type /Catalog>> endobj\n%%EOF\n')
  assert.equal((await upload(j,randomUUID(),pdf,'proof.pdf','photo','application/pdf')).statusCode,400)
  let r=await upload(j,randomUUID(),pdf,'証拠.pdf','evidence','application/pdf');assert.equal(r.statusCode,201,r.body)
  const pdfId=r.json().id,download=await req('GET',path(j)+`/files/${pdfId}`);assert.match(download.headers['content-disposition'],/^attachment/);assert.deepEqual(download.rawPayload,pdf)
  const f=(await upload(j)).json(),p=photo(f.id)
  r=await req('POST',path(j)+'/workflow/photos',p);assert.equal(r.statusCode,201,r.body)
  const first=r.json();r=await req('POST',path(j)+'/workflow/photos',p);assert.equal(r.statusCode,200,r.body);assert.deepEqual(r.json(),first)
  assert.equal((await req('POST',path(j)+'/workflow/photos',{...p,caption:'違う'})).statusCode,409)
  assert.equal((await req('POST',path(j)+'/workflow/photos',photo(pdfId))).statusCode,400)
  const results=await Promise.all([photo(f.id),photo(f.id)].map(p=>req('POST',path(j)+'/workflow/photos',p)))
  for(const result of results)assert.equal(result.statusCode,201,result.body)
  const current=await get(j);assert.equal(current.data.photos.length,3);assert.equal(current.version,3);assert.equal((await history(j)).events.length,3)
  assert.equal((await put(j,first.data,1)).statusCode,409)
})
test('report freezes actual selected photos and issued notices/reports cannot change or disappear',async()=>{
  const j=await job(),f=(await upload(j)).json(),p=photo(f.id),d=emptyWorkflow();d.photos=[p]
  d.reports=[{id:randomUUID(),...draftPublication(),status:'issued',title:'写真報告',photoIds:[p.id],photoSnapshot:null,notes:''}]
  d.notices=[{id:randomUUID(),...draftPublication(),status:'issued',kind:'construction',title:'お知らせ',recipient:'近隣',startsOn:today,endsOn:today,timeFrom:'09:00',timeTo:'17:00',impacts:[],contactName:'担当',contactPhone:'000',message:'工事のお知らせ'}]
  let r=await put(j,d);assert.equal(r.statusCode,201,r.body);const saved=r.json().data;assert.deepEqual(saved.reports[0].photoSnapshot,[p])
  const changed=structuredClone(saved);changed.photos[0].caption='後から編集';r=await put(j,changed,1);assert.equal(r.statusCode,200,r.body);assert.equal(r.json().data.reports[0].photoSnapshot[0].caption,p.caption)
  for(const section of ['reports','notices'])for(const op of ['edit','delete']) {
    const invalid=r.json().data;if(op==='delete')invalid[section]=[];else invalid[section][0].title='変更'
    assert.equal((await put(j,invalid,2)).statusCode,400);await assert.rejects(direct(j,invalid,3),e=>e.code==='23514')
  }
})
test('exact BigInt totals, source associations, no overpayment and append-only documented reversals',async()=>{
  assert.deepEqual(documentTotals({items:[line('1.25','101')],taxRate:'10',rounding:'round'}),{subtotal:'126',tax:'13',total:'139'})
  const j=await job(),view=await issuedSet(j),d=view.data,invoiceId=d.invoices[0].id,evidence=d.reviews[0].evidenceIds,p=payment(invoiceId,'1100',evidence);d.payments=[p]
  let r=await put(j,d,1);assert.equal(r.statusCode,200,r.body)
  const invalid=[];const add=change=>{const v=structuredClone(r.json().data);change(v);invalid.push(v)}
  add(d=>d.payments.push(payment(invoiceId,'1',evidence)));add(d=>{d.payments[0].amountYen='100'})
  add(d=>d.payments.push({...payment(invoiceId,'1100'),type:'reversal',reversesId:p.id,note:'取消'}))
  add(d=>d.payments.push(payment(randomUUID(),'1',evidence)));add(d=>{d.payments=[]})
  for(const v of invalid){assert.equal((await put(j,v,2)).statusCode,400);await assert.rejects(direct(j,v,3),e=>e.code==='23514')}
  const file=(await upload(j)).json(),more=r.json().data,reversal={...payment(invoiceId,'1100'),type:'reversal',reversesId:p.id,evidenceIds:[file.id],note:'誤入金取消'}
  more.payments.push(reversal);r=await put(j,more,2);assert.equal(r.statusCode,200,r.body);assert.deepEqual(r.json().data.payments[0],p)
  const dup=r.json().data;dup.payments.push({...reversal,id:randomUUID()});assert.equal((await put(j,dup,3)).statusCode,400)
  const repay=r.json().data;repay.payments.push(payment(invoiceId,'1100',evidence));r=await put(j,repay,3);assert.equal(r.statusCode,200,r.body)
})
test('manual contract events/milestones need evidence and preserve originals; change source checks',async()=>{
  const j=await job(),view=await issuedSet(j),d=view.data,f=(await upload(j)).json(),contractId=d.contracts[0].id
  const event={id:randomUUID(),contractId,type:'accepted',eventDate:today,counterparty:'相手方',evidenceIds:[f.id],note:'紙の契約書を受領'}
  d.contractEvents=[event];d.milestones=[{id:randomUUID(),contractId,type:'inspection',eventDate:today,amountYen:null,evidenceIds:[f.id],note:'検査記録'}]
  let r=await put(j,d,1);assert.equal(r.statusCode,200,r.body)
  for(const section of ['contractEvents','milestones']){
    const invalid=r.json().data;invalid[section]=[];assert.equal((await put(j,invalid,2)).statusCode,400);await assert.rejects(direct(j,invalid,3),e=>e.code==='23514')
  }
  for(const invalidEvent of [{...event,id:randomUUID(),evidenceIds:[]},{...event,id:randomUUID(),eventDate:'2199-01-01'},{...event,id:randomUUID(),contractId:randomUUID()}]){
    const invalid=r.json().data;invalid.contractEvents.push(invalidEvent);assert.equal((await put(j,invalid,2)).statusCode,400)
  }
  const more=r.json().data;more.contracts.push({...contract(more.estimates[0].id,'issued'),kind:'change',originalContractId:contractId,changeReason:'追加工事',effectiveDate:today})
  r=await put(j,more,2);assert.equal(r.statusCode,200,r.body)
  assert.equal(r.json().data.contracts[1].originalContractId,contractId)
  const before=r.json().data,second=structuredClone(before)
  second.contracts.push({...contract(second.estimates[0].id,'issued'),kind:'change',originalContractId:contractId,changeReason:`変更後全体額・工期を記載、先行変更 ${before.contracts[1].id}`,effectiveDate:today})
  r=await put(j,second,3);assert.equal(r.statusCode,200,r.body);assert.deepEqual(r.json().data.contracts.slice(0,2),before.contracts)
  const bad=r.json().data;bad.contracts.push({...contract(bad.estimates[0].id,'issued'),kind:'change',originalContractId:bad.contracts[1].id,changeReason:'誤った変更元',effectiveDate:today})
  assert.equal((await put(j,bad,4)).statusCode,400);await assert.rejects(direct(j,bad,5),e=>e.code==='23514')
})
test('W21 new payments/reversals require job-owned evidence in API and SQL, with rejection leaving data/audit unchanged',async()=>{
  const j=await job(),view=await issuedSet(j),invoiceId=view.data.invoices[0].id,evidence=view.data.reviews[0].evidenceIds
  const missing=structuredClone(view.data);missing.payments.push(payment(invoiceId))
  let r=await put(j,missing,1);assert.equal(r.statusCode,400,r.body);assert.match(r.json().message,/根拠資料.*1件/)
  await assert.rejects(direct(j,missing),e=>e.code==='23514')
  assert.deepEqual(await get(j),view);assert.equal((await history(j)).events.length,1)
  const p=payment(invoiceId,'500',evidence),valid=structuredClone(view.data);valid.payments.push(p)
  r=await put(j,valid,1);assert.equal(r.statusCode,200,r.body)
  const missingReversal=r.json().data;missingReversal.payments.push({...payment(invoiceId),type:'reversal',reversesId:p.id,note:'誤記録の取消'})
  assert.equal((await put(j,missingReversal,2)).statusCode,400);await assert.rejects(direct(j,missingReversal,3),e=>e.code==='23514')
  const corrected=r.json().data;corrected.payments.push({...payment(invoiceId,'500',evidence),type:'reversal',reversesId:p.id,note:'誤記録の取消'})
  r=await put(j,corrected,2);assert.equal(r.statusCode,200,r.body)
  assert.deepEqual(r.json().data.payments[0],p)
  // INSERT is covered too; use another job so every new appended payment is checked from index zero.
  const fresh=await job(),data=await reviewedData(fresh),e=estimate('issued'),c=contract(e.id,'issued'),i=invoice(c.id,'issued')
  data.estimates=[e];data.contracts=[c];data.invoices=[i];data.payments=[payment(i.id)]
  assert.equal((await put(fresh,data)).statusCode,400)
  await assert.rejects(transaction(runtime,users[0].id,client=>client.query('INSERT INTO job_workflows(company_id,job_id,version,data,basis_job_version,classification_version) VALUES($1,$2,1,$3,1,1)',[companies[0],fresh.id,JSON.stringify(data)])),e=>e.code==='23514')
  assert.equal((await get(fresh)).version,0);assert.equal((await history(fresh)).events.length,0)
})
test('W08 contract gate rejects absent/missing/unknown/out-of-scope classifications and unresolved/latest needs_action reviews',async()=>{
  const setup=d=>{const e=estimate('issued'),c=contract(e.id,'issued');d.estimates=[e];d.contracts=[c];return d}
  let j=await job(),d=setup(emptyWorkflow()),r=await put(j,d);assert.equal(r.statusCode,400,r.body);assert.match(r.json().message,/分類/)
  assert.equal((await put(j)).statusCode,201);await assert.rejects(direct(j,d),e=>e.code==='23514')
  const cases=[
    cd=>{cd.context.market=known('public')},cd=>{cd.context.workKind=known('new_build')},cd=>{cd.context.companyRole=known('owner')},
    cd=>{cd.conditions.electricalWork={state:'unknown',value:null,reason:null}},cd=>{cd.amounts.contract={state:'unanswered',value:null,reason:null}},
    cd=>{cd.amounts.contract=known({yen:'1000',taxBasis:'unknown'})},
  ]
  for(const change of cases){
    j=await job();const cd=completeClassification();change(cd);d=setup(await reviewedData(j,cd));r=await put(j,d);assert.equal(r.statusCode,400,r.body)
    // Even a syntactically confirmed review of a missing/unknown issue cannot cure its classification answer.
    const cv=(await req('GET',path(j)+'/classification')).json(),f=(await req('GET',path(j)+'/files')).json().files[0]
    d.reviews.push(...cv.issues.filter(i=>['missing','unknown','out_of_scope'].includes(i.kind)).map(issue=>({id:randomUUID(),issueId:issue.id,jobVersion:1,classificationVersion:1,conclusion:'confirmed',reviewedOn:today,evidenceIds:[f.id],note:'回答の代わりにはならない'})))
    assert.equal((await put(j,d)).statusCode,400)
    const draft=structuredClone(d);draft.contracts[0].status='draft';assert.equal((await put(j,draft)).statusCode,201)
    await assert.rejects(direct(j,d),e=>e.code==='23514')
  }
  j=await job();d=setup(await reviewedData(j));const firstReview=d.reviews[0];d.reviews=[];r=await put(j,d)
  assert.equal(r.statusCode,400,r.body);assert.match(r.json().message,/資料確認.*未了[0-9]+件/)
  const draft=structuredClone(d);draft.contracts[0].status='draft';assert.equal((await put(j,draft)).statusCode,201);await assert.rejects(direct(j,d),e=>e.code==='23514')
  j=await job();d=setup(await reviewedData(j));d.reviews.push({...d.reviews[0],id:randomUUID(),conclusion:'needs_action',evidenceIds:[],note:'対応が必要'})
  assert.equal((await put(j,d)).statusCode,400);const pending=structuredClone(d);pending.contracts[0].status='draft';assert.equal((await put(j,pending)).statusCode,201);await assert.rejects(direct(j,d),e=>e.code==='23514')
  const resolved=(await get(j)).data;resolved.contracts[0].status='issued';resolved.reviews.push({...firstReview,id:randomUUID(),evidenceIds:d.reviews[0].evidenceIds,conclusion:'not_applicable',note:'資料に基づき適用外と判断した理由'})
  r=await put(j,resolved,1);assert.equal(r.statusCode,200,r.body)
})
test('current rules/catalog gate and conditional derived reviews match SQL; contract date/party/optional terms align',async()=>{
  const definition=(await owner.query("SELECT pg_get_functiondef('public.validate_workflow_contract_gate(jsonb,integer,public.job_classifications)'::regprocedure) AS source")).rows[0].source
  assert.ok(definition.includes(RULES_VERSION));assert.ok(definition.includes(CATALOG_VERSION))
  const j=await job(),cd=completeClassification()
  cd.amounts.contract=known({yen:'1000',taxBasis:'tax_excluded'});cd.amounts.suppliedMaterials=known('yes')
  cd.amounts.suppliedMaterialValue=known({yen:'100',taxBasis:'tax_included'});cd.amounts.suppliedMaterialTransport=known({yen:'10',taxBasis:'tax_included'})
  cd.amounts.splitContracts=known('yes');cd.amounts.relatedContractValue=known({yen:'100',taxBasis:'tax_included'});cd.amounts.splitReason=known('施工範囲が異なる')
  cd.amounts.subcontracting=known('yes');cd.amounts.subcontractTotal=known({yen:'200',taxBasis:'tax_included'})
  cd.workItems[0].tradeCandidates=known(['building_general','electrical']);cd.workItems[0].relationship=known('primary')
  cd.workItems.push({id:randomUUID(),description:'付帯作業',tradeCandidates:known(['fittings']),relationship:known('ancillary'),parentItemId:cd.workItems[0].id})
  for(const key of Object.keys(cd.conditions))cd.conditions[key]=known('yes')
  const d=await reviewedData(j,cd),e=estimate('issued'),c=contract(e.id,'issued');d.estimates=[e];d.contracts=[c];c.terms.exclusions=c.terms.nonWorkingDays=''
  let r=await put(j,d);assert.equal(r.statusCode,201,r.body)
  const saved=r.json().data
  for(const change of [v=>{v.contracts.at(-1).effectiveDate=null},v=>{v.contracts.at(-1).counterparty='不一致'},v=>{v.contracts.at(-1).terms.scope=''}]){
    const v=structuredClone(saved);v.contracts.push({...contract(e.id,'issued')});change(v)
    assert.equal((await put(j,v,1)).statusCode,400);await assert.rejects(direct(j,v),err=>err.code==='23514')
  }
  const ordering=structuredClone(saved);ordering.contracts.push({...contract(e.id,'issued'),partyRole:'ordering',counterparty:e.issuer});r=await put(j,ordering,1);assert.equal(r.statusCode,200,r.body)
  for(const [column,current] of [['rules_version',RULES_VERSION],['catalog_version',CATALOG_VERSION]]){
    await owner.query('ALTER TABLE job_classifications DISABLE TRIGGER USER')
    try{await owner.query(`UPDATE job_classifications SET ${column}='old-fixture' WHERE job_id=$1`,[j.id])}finally{await owner.query('ALTER TABLE job_classifications ENABLE TRIGGER USER')}
    try{
      const v=r.json().data;v.contracts.push(contract(e.id,'issued'));const result=await put(j,v,2);assert.equal(result.statusCode,400,result.body);assert.match(result.json().message,/確認基準/)
      await assert.rejects(direct(j,v,3),err=>err.code==='23514')
    }finally{
      await owner.query('ALTER TABLE job_classifications DISABLE TRIGGER USER');try{await owner.query(`UPDATE job_classifications SET ${column}=$2 WHERE job_id=$1`,[j.id,current])}finally{await owner.query('ALTER TABLE job_classifications ENABLE TRIGGER USER')}
    }
  }
})
test('W09 stale classification blocks new contracts while invoices/reports/notices/photos and factual history remain writable',async()=>{
  const j=await job(),view=await issuedSet(j),d=view.data,contractId=d.contracts[0].id,f=(await upload(j)).json(),p=photo(f.id)
  await transaction(runtime,users[0].id,c=>c.query('UPDATE jobs SET version=2 WHERE id=$1',[j.id]))
  d.photos=[p];d.tasks=[{id:randomUUID(),title:'工程',company:'担当',startsOn:today,endsOn:today,status:'done',note:''}]
  d.invoices.push(invoice(contractId,'issued'))
  d.reports=[{id:randomUUID(),...draftPublication(),status:'issued',title:'台帳',photoIds:[p.id],photoSnapshot:null,notes:''}]
  d.notices=[{id:randomUUID(),...draftPublication(),status:'issued',kind:'complete',title:'完了',recipient:'近隣',startsOn:today,endsOn:today,timeFrom:'',timeTo:'',impacts:[],contactName:'担当',contactPhone:'000',message:'完了報告'}]
  d.contractEvents=[{id:randomUUID(),contractId,type:'delivered',eventDate:today,counterparty:'発注者',evidenceIds:[f.id],note:'自社→相手、送付者・受取人・方法を記録'}]
  d.payments=[{...payment(d.invoices[0].id),evidenceIds:[f.id]}]
  d.milestones=[{id:randomUUID(),contractId,type:'handover',eventDate:today,amountYen:null,evidenceIds:[f.id],note:'過去事実を現在記録'}]
  let r=await put(j,d,1,2);assert.equal(r.statusCode,200,r.body);assert.equal(r.json().data.invoices[1].basis.job.version,2)
  r=await req('POST',path(j)+'/workflow/photos',photo(f.id));assert.equal(r.statusCode,201,r.body)
  const bad=r.json().data;bad.contracts.push(contract(bad.estimates[0].id,'issued'))
  assert.equal((await put(j,bad,3,2)).statusCode,400);await assert.rejects(direct(j,bad,4,2),e=>e.code==='23514')
  assert.deepEqual((await get(j)).data.contracts[0],view.data.contracts[0])
})
test('W03 concurrent PUTs and classification/job updates reject stale interactive saves without rebasing',async()=>{
  const j=await job();let results=await Promise.all([put(j),put(j)])
  assert.deepEqual(results.map(r=>r.statusCode).sort(),[201,409])
  const a=emptyWorkflow(),b=emptyWorkflow();a.laborInsurance.note='A';b.laborInsurance.note='B'
  results=await Promise.all([put(j,a,1),put(j,b,1)]);assert.deepEqual(results.map(r=>r.statusCode).sort(),[200,409]);assert.equal((await history(j)).events.length,2)
  const locked=await runtime.connect()
  try{
    await locked.query('BEGIN');await locked.query("SELECT set_config('app.user_id',$1,true),set_config('app.request_id',$2,true)",[users[0].id,randomUUID()])
    await locked.query('SELECT role FROM lock_membership($1)',[companies[0]])
    await locked.query('SELECT id FROM jobs WHERE id=$1 FOR UPDATE',[j.id])
    await locked.query('INSERT INTO job_classifications(company_id,job_id,version,data,basis_job_version) VALUES($1,$2,1,$3,1)',[companies[0],j.id,JSON.stringify(emptyClassification())])
    const pending=put(j,emptyWorkflow(),2);await locked.query('COMMIT');assert.equal((await pending).statusCode,409)
    await locked.query('BEGIN');await locked.query("SELECT set_config('app.user_id',$1,true),set_config('app.request_id',$2,true)",[users[0].id,randomUUID()])
    await locked.query('UPDATE jobs SET version=2 WHERE id=$1',[j.id]);const next=put(j,emptyWorkflow(),2,1,1);await locked.query('COMMIT');assert.equal((await next).statusCode,409)
  }finally{await locked.query('ROLLBACK');locked.release()}
  assert.equal((await get(j)).version,2)
})
test('W04 audit failure rolls back insert/update; file DB failure retains private bytes without a successful metadata record',async()=>{
  const j=await job(),fresh=await job();assert.equal((await put(j)).statusCode,201);const previous=await get(j)
  await owner.query("CREATE FUNCTION public.fail_workflow_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private workflow fixture fault'; END; $$")
  await owner.query('CREATE TRIGGER fail_workflow_fixture BEFORE INSERT ON workflow_audit_events FOR EACH ROW EXECUTE FUNCTION public.fail_workflow_fixture()')
  try{
    for(const [target,version] of [[j,1],[fresh,0]]){
      const r=await put(target,emptyWorkflow(),version);assert.equal(r.statusCode,500,r.body);assert.doesNotMatch(r.body,/fixture fault|workflow_audit_events|INSERT/)
    }
    assert.deepEqual(await get(j),previous);assert.equal((await get(fresh)).version,0);assert.equal((await history(j)).events.length,1)
  }finally{await owner.query('DROP TRIGGER fail_workflow_fixture ON workflow_audit_events')}
  const before=(await readdir(storage)).length,id=randomUUID()
  await owner.query('CREATE TRIGGER fail_workflow_fixture AFTER INSERT ON job_files FOR EACH ROW EXECUTE FUNCTION public.fail_workflow_fixture()')
  try{
    const r=await upload(j,id);assert.equal(r.statusCode,500,r.body);assert.equal((await readdir(storage)).length,before+1)
    assert.equal((await owner.query('SELECT 1 FROM job_files WHERE id=$1',[id])).rowCount,0);assert.equal((await req('GET',path(j)+`/files/${id}`)).statusCode,404)
  }finally{await owner.query('DROP TRIGGER fail_workflow_fixture ON job_files');await owner.query('DROP FUNCTION public.fail_workflow_fixture()')}
  assert.equal((await upload(j,id)).statusCode,201)
})
test('lost COMMIT responses retain workflow/file commits, downloads and exact retry semantics',async()=>{
  const j=await job();assert.equal((await put(j)).statusCode,201)
  const wrapped=Object.create(runtime),connect=runtime.connect.bind(runtime);wrapped.query=runtime.query.bind(runtime)
  let mode='workflow',armed=true
  wrapped.connect=async()=>{
    const c=await connect();let wrote=false
    return {query:async(sql,...args)=>{
      if(typeof sql==='string' && (mode==='workflow'?sql.includes('UPDATE public.job_workflows'):sql.includes('INSERT INTO public.job_files')))wrote=true
      const result=await c.query(sql,...args)
      if(sql==='COMMIT' && wrote && armed){armed=false;throw new Error('Connection terminated unexpectedly')}
      return result
    },release:destroy=>c.release(destroy)}
  }
  const isolated=await buildApp(wrapped,config)
  try{
    const send=()=>isolated.inject({method:'PUT',url:path(j)+'/workflow',headers:{origin:config.origin,cookie:cookies[0]},payload:{version:1,jobVersion:1,classificationVersion:null,data:emptyWorkflow()}})
    assert.equal((await send()).statusCode,503);assert.equal((await get(j)).version,2);assert.equal((await history(j)).events.length,2);assert.equal((await send()).statusCode,409)
    mode='file';armed=true;const id=randomUUID()
    const sendFile=()=>isolated.inject({method:'PUT',url:path(j)+`/files/${id}`,headers:{origin:config.origin,cookie:cookies[0],'content-type':'image/png','x-file-name':encodeURIComponent('original.png'),'x-file-kind':'photo'},payload:png})
    assert.equal((await sendFile()).statusCode,503);assert.deepEqual((await req('GET',path(j)+`/files/${id}`)).rawPayload,png)
    assert.equal((await sendFile()).statusCode,200)
  }finally{await isolated.close()}
})
test('cross-job evidence/photo references, cross-invoice reversals and duplicate IDs are rejected by API and SQL',async()=>{
  const j=await job(),otherJob=await job(),foreign=(await upload(otherJob)).json();assert.equal((await put(j)).statusCode,201)
  for(const change of [d=>{d.photos=[photo(foreign.id)]},d=>{d.laborInsurance.evidenceIds=[foreign.id]},d=>{const e=estimate();d.estimates=[e,{...e}]}]){
    const d=emptyWorkflow();change(d);assert.equal((await put(j,d,1)).statusCode,400);await assert.rejects(direct(j,d),e=>e.code==='23514')
  }
  const ready=await job(),view=await issuedSet(ready),d=view.data,f=(await upload(ready)).json()
  d.invoices.push(invoice(d.contracts[0].id,'issued'));const p=payment(d.invoices[0].id,'500',[f.id]);d.payments=[p]
  let r=await put(ready,d,1);assert.equal(r.statusCode,200,r.body)
  for(const edit of [r=>{r.invoiceId=d.invoices[1].id},r=>{r.amountYen='499'},r=>{r.paidOn='2199-01-01'}]){
    const v=r.json().data,reversal={...payment(d.invoices[0].id,'500'),type:'reversal',reversesId:p.id,evidenceIds:[f.id],note:'取消'};edit(reversal);v.payments.push(reversal)
    assert.equal((await put(ready,v,2)).statusCode,400);await assert.rejects(direct(ready,v,3),e=>e.code==='23514')
  }
})
test('R07 record actor/time are reconstructable from first audit appearance, independently of later workspace editor',async()=>{
  const j=await job(),d=await reviewedData(j),record=d.reviews[0];let r=await put(j,d);assert.equal(r.statusCode,201,r.body)
  await owner.query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'manager')",[companies[0],users[1].id])
  try{
    const more=r.json().data;more.laborInsurance.note='別担当者が追記';r=await put(j,more,1,1,1,cookies[1]);assert.equal(r.statusCode,200,r.body);assert.equal(r.json().updatedBy,users[1].id)
    const events=(await history(j)).events,first=events.find(e=>e.afterData.reviews.some(v=>v.id===record.id)&&!e.beforeData?.reviews.some(v=>v.id===record.id))
    assert.equal(first.actorName,users[0].name);assert.match(first.occurredAt,/Z$/);assert.equal(events[0].actorName,users[1].name)
  }finally{await owner.query('DELETE FROM memberships WHERE company_id=$1 AND user_id=$2',[companies[0],users[1].id])}
})
test('direct SQL protects context, identity, versions, schema, RLS, audit and rollback atomicity',async()=>{
  const j=await job();assert.equal((await put(j)).statusCode,201)
  for(const [v,jv,cv] of [[1,1,null],[3,1,null],[2,2,null],[2,1,1]])await assert.rejects(direct(j,emptyWorkflow(),v,jv,cv),e=>e.code==='23514')
  const invalid=emptyWorkflow();invalid.extra={anything:true};await assert.rejects(direct(j,invalid),e=>e.code==='23514')
  for(const sql of ['UPDATE job_workflows SET updated_by=updated_by','DELETE FROM job_workflows','TRUNCATE job_workflows',
    'UPDATE workflow_audit_events SET actor_name=actor_name','DELETE FROM workflow_audit_events','TRUNCATE workflow_audit_events',
    'INSERT INTO workflow_audit_events SELECT * FROM workflow_audit_events LIMIT 1','ALTER TABLE job_workflows DISABLE TRIGGER ALL'])await assert.rejects(transaction(runtime,users[0].id,c=>c.query(sql)),e=>e.code==='42501')
  for(const actor of [users[1].id,users[2].id])assert.equal((await direct(j,emptyWorkflow(),2,1,null,actor)).rowCount,0)
  assert.equal((await runtime.query('SELECT * FROM job_workflows')).rowCount,0)
  await assert.rejects(transaction(runtime,users[0].id,async c=>{await c.query('UPDATE job_workflows SET version=2 WHERE job_id=$1',[j.id]);throw new Error('rollback')}),/rollback/)
  assert.equal((await history(j)).events.length,1);assert.equal((await get(j)).version,1)
  const client=await runtime.connect()
  try {await client.query('BEGIN');await client.query("SELECT set_config('app.user_id',$1,true)",[users[0].id]);await assert.rejects(client.query('UPDATE job_workflows SET version=2 WHERE job_id=$1',[j.id]),e=>e.code==='23514')}
  finally{await client.query('ROLLBACK');client.release()}
})
test('workflow audit pages, stable actor names and startup fail closed on weakened protections',async()=>{
  const j=await job();assert.equal((await put(j)).statusCode,201)
  await transaction(runtime,users[0].id,async c=>{for(let i=2;i<=53;i++)await c.query('UPDATE job_workflows SET version=$2 WHERE job_id=$1',[j.id,i])})
  let r=await req('GET',path(j)+'/workflow/audit?limit=50');assert.equal(r.statusCode,200,r.body);assert.equal(r.json().events.length,50);assert.equal(r.json().nextCursor,'4')
  r=await req('GET',path(j)+'/workflow/audit?cursor=4');assert.equal(r.json().events.length,3);assert.equal(r.json().nextCursor,null)
  for(const query of ['limit=0','limit=51','cursor=0','cursor=2147483648','extra=1'])assert.equal((await req('GET',path(j)+'/workflow/audit?'+query)).statusCode,400)
  for(const table of ['job_workflows','workflow_audit_events','job_files']){
    await owner.query(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`)
    try{await assert.rejects(assertRuntimeRole(runtime),/workflow/)}finally{await owner.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`)}
  }
  for(const sql of ['GRANT INSERT ON workflow_audit_events TO construction_app','GRANT UPDATE(updated_at) ON job_workflows TO construction_app','GRANT UPDATE(name) ON job_files TO construction_app','GRANT EXECUTE ON FUNCTION public.guard_file_write() TO construction_app','GRANT EXECUTE ON FUNCTION public.guard_payment_evidence() TO construction_app']){
    await owner.query(sql);try{await assert.rejects(assertRuntimeRole(runtime),/workflow/)}finally{await migrate(owner,config,process.env.DB_APP_PASSWORD)}
  }
  await owner.query('ALTER TABLE job_files DISABLE TRIGGER files_guard_write')
  try{await assert.rejects(assertRuntimeRole(runtime),/workflow/)}finally{await owner.query('ALTER TABLE job_files ENABLE TRIGGER files_guard_write')}
  await owner.query('ALTER TABLE job_workflows DISABLE TRIGGER workflows_payment_evidence')
  try{await assert.rejects(assertRuntimeRole(runtime),/workflow/)}finally{await owner.query('ALTER TABLE job_workflows ENABLE TRIGGER workflows_payment_evidence')}
  await assertRuntimeRole(runtime)
})
test('membership suspension serializes with workflow write and removes all workflow/file access',async()=>{
  const j=await job(),f=(await upload(j)).json(),client=await runtime.connect(),admin=await owner.connect()
  try{
    await client.query('BEGIN');await client.query("SELECT set_config('app.user_id',$1,true),set_config('app.request_id',$2,true)",[users[0].id,randomUUID()])
    await client.query('SELECT role FROM lock_membership($1)',[companies[0]])
    const stopping=admin.query('UPDATE memberships SET active=false WHERE company_id=$1 AND user_id=$2',[companies[0],users[0].id])
    await client.query('SELECT id FROM jobs WHERE id=$1 FOR UPDATE',[j.id])
    await client.query('INSERT INTO job_workflows(company_id,job_id,version,data,basis_job_version,classification_version) VALUES($1,$2,1,$3,1,NULL)',[companies[0],j.id,JSON.stringify(emptyWorkflow())])
    await client.query('COMMIT');await stopping
    for(const suffix of ['/workflow','/workflow/audit','/files',`/files/${f.id}`])assert.equal((await req('GET',path(j)+suffix)).statusCode,404)
    assert.equal((await put(j,emptyWorkflow(),1)).statusCode,404);assert.equal((await upload(j)).statusCode,404)
    assert.equal((await owner.query('SELECT count(*)::int AS n FROM workflow_audit_events WHERE job_id=$1',[j.id])).rows[0].n,1)
  }finally{
    await client.query('ROLLBACK');client.release();admin.release()
    await owner.query('UPDATE memberships SET active=true WHERE company_id=$1 AND user_id=$2',[companies[0],users[0].id])
  }
})
