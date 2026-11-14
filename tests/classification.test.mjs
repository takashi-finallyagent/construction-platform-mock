import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { buildApp } from '../server/app.ts'
import { createAuth } from '../server/auth.ts'
import { readConfig } from '../server/config.ts'
import { assertRuntimeRole, createPool, transaction } from '../server/db.ts'
import { migrate } from '../server/migrate.ts'
import { classificationSchema } from '../server/classification-schema.ts'
import { normalizeClassification, classificationView } from '../server/classification.ts'
import { deriveClassificationIssues } from '../server/classification-issues.ts'
import { CATALOG_VERSION, RULES_VERSION, TRADE_CATALOG, emptyClassification } from '../src/product/classification-model.ts'

const dbName=`classification_test_${randomBytes(6).toString('hex')}`
const adminUrl=new URL(process.env.DATABASE_ADMIN_URL), runtimeUrl=new URL(process.env.DATABASE_URL)
assert.equal(adminUrl.hostname,'127.0.0.1'); assert.equal(runtimeUrl.hostname,'127.0.0.1')
const controlUrl=new URL(adminUrl); controlUrl.pathname='/postgres'
adminUrl.pathname=runtimeUrl.pathname=`/${dbName}`
const control=createPool(controlUrl.href), owner=createPool(adminUrl.href), runtime=createPool(runtimeUrl.href)
const config=readConfig({...process.env,DATABASE_URL:runtimeUrl.href})
const companies=[randomUUID(),randomUUID()]
const password=randomBytes(30).toString('base64url')
const input={name:'分類試験',siteAddress:'東京都 試験現場',customerName:'試験発注者',workDescription:'修繕作業',plannedStart:'2026-11-01',plannedEnd:'2026-11-02'}
const basis={version:1,...input}
let app, account, other, viewer, cookies, created=false
const known=value=>({state:'known',value,reason:null})
const unknown=()=>({state:'unknown',value:null,reason:null})
const na=()=>({state:'not_applicable',value:null,reason:'当該の依頼はありません'})
const item=(relationship='primary',trades=['fittings'])=>({id:randomUUID(),description:'扉を修繕',tradeCandidates:known(trades),relationship:known(relationship),parentItemId:null})
const path=(job,company=companies[0])=>`/api/companies/${company}/jobs/${job.id}/classification`
const req=(method,url,payload,cookie=cookies?.[0],extra={})=>app.inject({method,url,headers:{origin:config.origin,...(cookie?{cookie}:{}),...extra},...(payload===undefined?{}:{payload})})
const put=(job,data=emptyClassification(),version=0,jobVersion=job.version,cookie=cookies?.[0])=>req('PUT',path(job),{version,jobVersion,data},cookie)
async function job(company=companies[0],actor=account.id) {
  return transaction(runtime,actor,async c=>(await c.query(`INSERT INTO jobs(id,company_id,name,site_address,customer_name,work_description,planned_start,planned_end,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,version`,[randomUUID(),company,input.name,input.siteAddress,input.customerName,input.workDescription,input.plannedStart,input.plannedEnd,actor])).rows[0])
}
const direct=(j,data,version=2,jobVersion=1,actor=account.id)=>transaction(runtime,actor,c=>c.query(
  'UPDATE job_classifications SET data=$3,version=$4,basis_job_version=$5 WHERE company_id=$1 AND job_id=$2',
  [companies[0],j.id,JSON.stringify(data),version,jobVersion]))
const history=async j=>(await req('GET',`${path(j)}/audit`)).json()

before(async()=>{
  await control.query(`CREATE DATABASE ${dbName}`); created=true
  await migrate(owner,config,process.env.DB_APP_PASSWORD)
  await migrate(owner,config,process.env.DB_APP_PASSWORD)
  const auth=createAuth(owner,config,true)
  const users=[]
  for(const [email,name] of [['owner@classification.invalid','分類記録者'],['other@classification.invalid','他社'],['viewer@classification.invalid','閲覧者']]) {
    users.push((await auth.api.signUpEmail({body:{email,name,password}})).user)
  }
  ;[account,other,viewer]=users
  await owner.query("INSERT INTO companies(id,name) VALUES($1,'分類会社A'),($2,'分類会社B')",companies)
  await owner.query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner'),($3,$4,'manager'),($1,$5,'viewer')",[companies[0],account.id,companies[1],other.id,viewer.id])
  app=await buildApp(runtime,config)
  cookies=[]
  for(const user of users) {
    const r=await req('POST','/api/auth/sign-in/email',{email:user.email,password},null)
    assert.equal(r.statusCode,200,r.body)
    const raw=r.headers['set-cookie']; cookies.push((Array.isArray(raw)?raw:[raw]).map(c=>c.split(';')[0]).join('; '))
  }
})
after(async()=>{
  await app?.close(); await runtime.end(); await owner.end()
  try { if(created) { assert.match(dbName,/^classification_test_[a-f0-9]{12}$/); await control.query(`DROP DATABASE ${dbName} WITH (FORCE)`) } }
  finally { await control.end() }
})

test('catalog and fresh empty values preserve unknown versus unanswered without defaults',()=>{
  assert.equal(TRADE_CATALOG.length,29)
  assert.equal(new Set(TRADE_CATALOG.map(t=>t.code)).size,29)
  assert.equal(TRADE_CATALOG.filter(t=>t.kind==='general').length,2)
  const codes=TRADE_CATALOG.map(t=>t.code)
  assert.deepEqual(classificationSchema.properties.workItems.items.properties.tradeCandidates.anyOf[1].properties.value.items.enum,codes)
  assert.deepEqual(classificationSchema.properties.permit.properties.reportedTrades.anyOf[1].properties.value.items.enum,codes)
  const a=emptyClassification(),b=emptyClassification(); a.context.market=known('private')
  assert.equal(b.context.market.state,'unanswered'); assert.equal(b.workItems.length,0)
  assert.deepEqual(normalizeClassification(b),b)
})

test('GET is side effect free, including viewer before and after the first save',async()=>{
  const j=await job()
  for(const cookie of [cookies[0],cookies[2]]) {
    const r=await req('GET',path(j),undefined,cookie)
    assert.equal(r.statusCode,200,r.body); assert.equal(r.json().record,null)
    assert.equal(r.headers['cache-control'],'no-store'); assert.equal(r.json().currentJob.version,1)
    assert.ok(r.json().issues.some(i=>i.code==='SCOPE_REQUIRED'))
  }
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM job_classifications WHERE job_id=$1',[j.id])).rows[0].n,0)
  assert.equal((await put(j)).statusCode,201)
  assert.equal((await req('GET',path(j),undefined,cookies[2])).statusCode,200)
})

test('save attributes actor and complete snapshots; same data advances only classification version',async()=>{
  const j=await job(), data=emptyClassification(); data.conditions.electricalWork=unknown(); data.note='  作業前に記録  '
  const first=await put(j,data); assert.equal(first.statusCode,201,first.body)
  const record=first.json().record
  assert.equal(record.version,1); assert.equal(record.data.note,'作業前に記録')
  assert.deepEqual(record.createdBy,{id:account.id,name:account.name}); assert.deepEqual(record.updatedBy,record.createdBy)
  assert.deepEqual(record.basisJob,basis); assert.equal(record.rulesVersion,RULES_VERSION); assert.equal(record.catalogVersion,CATALOG_VERSION)
  assert.match(record.createdAt,/Z$/); assert.equal(record.updatedAt,record.createdAt)
  for(const version of [1,2]) { const r=await put(j,data,version); assert.equal(r.statusCode,200,r.body); assert.equal(r.json().record.version,version+1) }
  const h=await history(j); assert.equal(h.events.length,3); assert.equal(h.events[2].beforeData,null)
  assert.deepEqual(h.events[2].afterData,record); assert.equal(h.events[0].beforeData.version,2)
  assert.equal(h.events[0].afterData.version,3); assert.ok(h.events[0].requestId)
  assert.equal((await owner.query('SELECT version FROM jobs WHERE id=$1',[j.id])).rows[0].version,1)
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM audit_events WHERE target_id=$1',[j.id])).rows[0].n,1)
})

test('authentication, company mismatch, viewer writes/history, and Origin enforce existing boundaries',async()=>{
  const j=await job(), body={version:0,jobVersion:1,data:emptyClassification()}
  assert.equal((await req('GET',path(j),undefined,null)).statusCode,401)
  for(const suffix of ['', '/audit']) assert.equal((await req('GET',path(j)+suffix,undefined,cookies[1])).statusCode,404)
  assert.equal((await req('GET',path(j,companies[1]),undefined,cookies[1])).statusCode,404)
  assert.equal((await req('PUT',path(j),body,cookies[1])).statusCode,404)
  assert.equal((await req('PUT',path(j),body,cookies[2])).statusCode,403)
  assert.equal((await req('GET',path(j)+'/audit',undefined,cookies[2])).statusCode,403)
  assert.equal((await req('PUT',path(j),body,cookies[0],{origin:'https://invalid.example'})).statusCode,403)
  assert.equal((await req('GET',path({id:randomUUID()}))).statusCode,404)
  assert.equal((await req('GET',path(j),undefined,'construction.session_token=forged')).statusCode,401)
})

test('concurrent initial and existing saves, and commit-response retry, cannot silently overwrite',async()=>{
  const j=await job()
  let rs=await Promise.all([put(j),put(j)])
  assert.deepEqual(rs.map(r=>r.statusCode).sort(),[201,409])
  assert.equal((await put(j)).statusCode,409)
  const a=emptyClassification(),b=emptyClassification(); a.note='A'; b.note='B'
  rs=await Promise.all([put(j,a,1),put(j,b,1)])
  assert.deepEqual(rs.map(r=>r.statusCode).sort(),[200,409])
  assert.equal((await history(j)).events.length,2)
})

test('changed job basis is retained, stale differences ordered, and explicit resave captures current job',async()=>{
  const j=await job(); assert.equal((await put(j)).statusCode,201)
  const current={...input,name:'改称',siteAddress:'別の所在地',customerName:'別発注者',workDescription:'追加作業',plannedStart:null,plannedEnd:null}
  await transaction(runtime,account.id,c=>c.query(`UPDATE jobs SET name=$2,site_address=$3,customer_name=$4,work_description=$5,
    planned_start=$6,planned_end=$7,version=version+1 WHERE id=$1`,[j.id,...Object.values(current)]))
  let view=(await req('GET',path(j))).json()
  assert.deepEqual(view.staleReasons,['job_changed']); assert.deepEqual(view.record.basisJob,basis)
  assert.deepEqual(view.jobDifferences.map(d=>d.field),Object.keys(current))
  assert.equal(view.issues[0].code,'JOB_CHANGED'); assert.equal((await put(j,emptyClassification(),1,1)).statusCode,409)
  const saved=await put(j,emptyClassification(),1,2); assert.equal(saved.statusCode,200,saved.body)
  assert.deepEqual(saved.json().record.basisJob,{version:2,...current}); assert.deepEqual(saved.json().staleReasons,[])
  await transaction(runtime,account.id,c=>c.query('UPDATE jobs SET version=version+1 WHERE id=$1',[j.id]))
  view=(await req('GET',path(j))).json(); assert.deepEqual(view.staleReasons,['job_changed']); assert.deepEqual(view.jobDifferences,[])
})

test('job lock serializes concurrent job and classification updates in both orders',async()=>{
  const j=await job(), lock=await runtime.connect()
  try {
    await lock.query('BEGIN'); await lock.query("SELECT set_config('app.user_id',$1,true),set_config('app.request_id',$2,true)",[account.id,randomUUID()])
    await lock.query('SELECT role FROM lock_membership($1)',[companies[0]])
    await lock.query("UPDATE jobs SET name='先行工事更新',version=version+1 WHERE id=$1",[j.id])
    const pending=put(j); await lock.query('COMMIT')
    assert.equal((await pending).statusCode,409)
  } finally { await lock.query('ROLLBACK'); lock.release() }
  assert.equal((await put(j,emptyClassification(),0,2)).statusCode,201)
  await transaction(runtime,account.id,c=>c.query('UPDATE jobs SET version=version+1 WHERE id=$1',[j.id]))
  const view=(await req('GET',path(j))).json(); assert.equal(view.record.basisJob.version,2); assert.equal(view.currentJob.version,3)
  assert.deepEqual(view.staleReasons,['job_changed'])
})

test('classification audit failure rolls back first save and later update atomically',async()=>{
  const j=await job(), fresh=await job(); assert.equal((await put(j)).statusCode,201)
  const before=(await req('GET',path(j))).json().record
  await owner.query("CREATE FUNCTION public.fail_classification_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private audit fault'; END; $$")
  await owner.query('CREATE TRIGGER fail_classification_audit BEFORE INSERT ON classification_audit_events FOR EACH ROW EXECUTE FUNCTION public.fail_classification_audit()')
  try {
    const data=emptyClassification(); data.note='未保存であるべき'
    for(const [target,version] of [[j,1],[fresh,0]]) {
      const r=await put(target,data,version); assert.equal(r.statusCode,500); assert.doesNotMatch(r.body,/private audit fault|INSERT|classification_audit_events/)
    }
    assert.deepEqual((await req('GET',path(j))).json().record,before)
    assert.equal((await req('GET',path(fresh))).json().record,null); assert.equal((await history(j)).events.length,1)
    assert.equal((await history(fresh)).events.length,0)
  } finally { await owner.query('DROP TRIGGER fail_classification_audit ON classification_audit_events'); await owner.query('DROP FUNCTION public.fail_classification_audit()') }
})

test('single JOIN snapshot cannot mix a job read with a later committed classification',async()=>{
  const j=await job(); assert.equal((await put(j)).statusCode,201)
  const wrapped=Object.create(runtime), connect=runtime.connect.bind(runtime)
  wrapped.query=runtime.query.bind(runtime)
  let joined=0
  wrapped.connect=async()=>{
    const c=await connect()
    return {query:async(sql,...args)=>{
      const result=await c.query(sql,...args)
      if(typeof sql==='string' && sql.includes('FROM public.jobs j LEFT JOIN public.job_classifications c')) {
        joined++
        await transaction(runtime,account.id,async writer=>{
          await writer.query('SELECT role FROM lock_membership($1)',[companies[0]])
          await writer.query("UPDATE jobs SET name='読取直後の変更',version=version+1 WHERE id=$1",[j.id])
          await writer.query('UPDATE job_classifications SET version=version+1,basis_job_version=2 WHERE job_id=$1',[j.id])
        })
      }
      return result
    },release:destroy=>c.release(destroy)}
  }
  const isolated=await buildApp(wrapped,config)
  try {
    const r=await isolated.inject({method:'GET',url:path(j),headers:{cookie:cookies[2]}})
    assert.equal(r.statusCode,200,r.body); assert.equal(joined,1)
    const v=r.json(); assert.equal(v.currentJob.version,1); assert.equal(v.record.version,1); assert.equal(v.record.basisJob.version,1)
    assert.deepEqual(v.staleReasons,[])
    const current=(await req('GET',path(j))).json(); assert.equal(current.currentJob.version,2); assert.equal(current.record.basisJob.version,2)
  } finally { await isolated.close() }
})

test('transient write failure is 503; response lost after real COMMIT leaves one attributable version',async()=>{
  const j=await job(); assert.equal((await put(j)).statusCode,201)
  const wrapped=Object.create(runtime), connect=runtime.connect.bind(runtime)
  wrapped.query=runtime.query.bind(runtime)
  let mode='transient', armed=true
  wrapped.connect=async()=>{
    const c=await connect(); let wrote=false
    return {query:async(sql,...args)=>{
      if(typeof sql==='string' && sql.includes('UPDATE public.job_classifications')) {
        wrote=true
        if(mode==='transient' && armed) {armed=false; throw Object.assign(new Error('private db fault'),{code:'40001'})}
      }
      const result=await c.query(sql,...args)
      if(sql==='COMMIT' && wrote && mode==='commit' && armed) {armed=false; throw new Error('Connection terminated unexpectedly')}
      return result
    },release:destroy=>c.release(destroy)}
  }
  const isolated=await buildApp(wrapped,config)
  const send=()=>isolated.inject({method:'PUT',url:path(j),headers:{origin:config.origin,cookie:cookies[0]},payload:{version:1,jobVersion:1,data:emptyClassification()}})
  try {
    const fail=await send(); assert.equal(fail.statusCode,503); assert.doesNotMatch(fail.body,/private db fault/)
    assert.equal((await history(j)).events.length,1)
    mode='commit'; armed=true
    const lost=await send(); assert.equal(lost.statusCode,503,lost.body)
    assert.equal((await req('GET',path(j))).json().record.version,2); assert.equal((await history(j)).events.length,2)
    assert.equal((await send()).statusCode,409)
  } finally { await isolated.close() }
})

test('API and direct SQL reject the same malformed data and preserve rows/history',async()=>{
  const j=await job(); assert.equal((await put(j)).statusCode,201)
  const invalid=[]
  const add=edit=>{const d=emptyClassification(); edit(d); invalid.push(d)}
  add(d=>{d.extra=true}); add(d=>{delete d.note}); add(d=>{d.schemaVersion='1'}); add(d=>{d.schemaVersion=2})
  add(d=>{d.context.market=known('invalid')}); add(d=>{d.context.market={state:'unanswered',value:'private',reason:null}})
  add(d=>{d.context.market={state:'unknown',value:null,reason:'理由'}}); add(d=>{d.context.market={state:'known',value:'private',reason:'理由'}})
  add(d=>{d.context.market=na()}); add(d=>{d.context.market.state='checked'}); add(d=>{d.amounts.contract=known({yen:'0',taxBasis:'unknown',extra:1})})
  for(const yen of [-1,0,'-1','1.1','1e3','1,000','01','1000000000000','',null]) add(d=>{d.amounts.contract=known({yen,taxBasis:'tax_included'})})
  add(d=>{d.workItems=[item(),item()]}); invalid.at(-1).workItems[1].id=invalid.at(-1).workItems[0].id.toUpperCase()
  add(d=>{d.workItems=[item(),item()]}); add(d=>{d.workItems=[item('ancillary')]})
  add(d=>{d.workItems=[item()]; d.workItems[0].parentItemId=d.workItems[0].id})
  add(d=>{d.workItems=[item('ancillary'),item('ancillary')]; d.workItems[0].parentItemId=d.workItems[1].id; d.workItems[1].parentItemId=d.workItems[0].id})
  add(d=>{d.workItems=[item(),item('ancillary'),item('ancillary')]; d.workItems[1].parentItemId=d.workItems[0].id; d.workItems[2].parentItemId=d.workItems[1].id})
  add(d=>{d.workItems=[item('independent',['fittings','fittings'])]}); add(d=>{d.workItems=[item('independent',['unknown_trade'])]})
  add(d=>{d.workItems=[item('independent',[])]}); add(d=>{d.workItems=[item()]; d.workItems[0].id='invalid'})
  add(d=>{d.workItems=[item()]; d.workItems[0].description='　 '}); add(d=>{d.workItems=[item()]; d.workItems[0].description='工'.repeat(301)})
  add(d=>{d.workItems=Array.from({length:13},()=>item('independent'))})
  add(d=>{d.amounts.suppliedMaterials=known('no'); d.amounts.suppliedMaterialValue=known({yen:'0',taxBasis:'unknown'})})
  add(d=>{d.amounts.splitContracts=known('yes'); d.amounts.splitReason=na()})
  add(d=>{d.amounts.subcontractTotal=na()}); add(d=>{d.amounts.subcontracting=known('no'); d.amounts.subcontractTotal={state:'not_applicable',value:null,reason:'　'}})
  add(d=>{d.amounts.splitReason=known(' '.repeat(2))}); add(d=>{d.amounts.splitReason=known('x'.repeat(501))})
  add(d=>{d.permit.declaration=known('not_held'); d.permit.reportedTrades=known(['electrical'])})
  add(d=>{d.permit.note='x'.repeat(1001)}); add(d=>{d.note='x'.repeat(2001)})
  for(const [index,d] of invalid.entries()) {
    const r=await put(j,d,1); assert.equal(r.statusCode,400,`case ${index}: ${r.body}`)
    await assert.rejects(direct(j,d),e=>e.code==='23514',`case ${index}`)
  }
  assert.equal((await history(j)).events.length,1); assert.equal((await req('GET',path(j))).json().record.version,1)
})

test('API and SQL normalize Japanese/Unicode trim and preserve valid limits and explicit unknown/not-applicable',async()=>{
  const j=await job(),d=emptyClassification()
  d.context.market=known('private'); d.context.companyRole=known('subcontractor'); d.context.workKind=known('repair'); d.context.targetKind=known('building')
  d.workItems=[item('primary',['building_general','fittings']),item('ancillary',['electrical'])]; d.workItems[1].parentItemId=d.workItems[0].id.toUpperCase()
  d.workItems[0].id=d.workItems[0].id.toUpperCase(); d.workItems[0].description='\uFEFF\u3000扉を修繕\u00A0\n'
  d.amounts.contract=known({yen:'0',taxBasis:'unknown'}); d.amounts.suppliedMaterials=known('no')
  d.amounts.suppliedMaterialValue=na(); d.amounts.suppliedMaterialTransport=unknown()
  d.amounts.splitContracts=known('no'); d.amounts.relatedContractValue=na(); d.amounts.splitReason=na()
  d.amounts.subcontracting=known('no'); d.amounts.subcontractTotal=na(); d.note='😀'.repeat(2000)
  const r=await put(j,d); assert.equal(r.statusCode,201,r.body)
  const normalized=r.json().record.data; assert.equal(normalized.workItems[0].description,'扉を修繕')
  assert.equal(normalized.amounts.contract.value.yen,'0'); assert.equal(normalized.note.length,4000)
  await direct(j,d); assert.deepEqual((await req('GET',path(j))).json().record.data,normalized)
  d.amounts.contract=known({yen:'999999999999',taxBasis:'tax_excluded'}); await direct(j,d,3)
  const view=(await req('GET',path(j))).json(); assert.ok(view.issues.some(i=>i.code==='TAX_BASIS_REVIEW'))
  assert.ok(!view.issues.some(i=>i.path==='/amounts/suppliedMaterialTransport'))
})

test('32 KiB UTF-8 body limit and strict versions/query/unsupported JSON values reject before saving',async()=>{
  const j=await job(),body={version:0,jobVersion:1,data:emptyClassification()}
  for(const patch of [{version:'0'},{version:0.1},{version:-1},{version:2147483647},{jobVersion:'1'},{jobVersion:0},{jobVersion:2147483648},{actorName:'偽名'}]) {
    assert.equal((await req('PUT',path(j),{...body,...patch})).statusCode,400)
  }
  for(const query of ['limit=0','limit=101','limit=01','cursor=0','cursor=2147483648','extra=1']) {
    assert.equal((await req('GET',path(j)+'/audit?'+query)).statusCode,400)
  }
  const raw=JSON.stringify(body)
  for(const bytes of [32768,32769]) {
    const r=await req('PUT',path(j),raw+' '.repeat(bytes-Buffer.byteLength(raw)),cookies[0],{'content-type':'application/json'})
    assert.equal(r.statusCode,bytes===32768?201:413,r.body)
  }
  for(const note of ['\u0000','\uD800']) { const d=emptyClassification(); d.note=note; assert.equal((await put(j,d,1)).statusCode,400) }
  const tooDeep=emptyClassification(); let node={}; tooDeep.extra=node; for(let i=0;i<40;i++) node=node.child={}
  assert.equal((await put(j,tooDeep,1)).statusCode,400)
  assert.equal((await history(j)).events.length,1)
})

test('direct SQL cannot choose identity/actors/timestamps/rules, jump versions, or reuse stale job basis',async()=>{
  const j=await job(); assert.equal((await put(j)).statusCode,201)
  for(const [version,jobVersion] of [[0,1],[1,1],[3,1],[2,0],[2,2]]) await assert.rejects(direct(j,emptyClassification(),version,jobVersion),e=>e.code==='23514')
  for(const [column,value] of [['company_id',companies[1]],['job_id',randomUUID()],['basis_job_snapshot','{}'],['created_by',other.id],
    ['created_by_name','偽名'],['created_at','2001-01-01'],['updated_by',other.id],['updated_by_name','偽名'],['updated_at','2001-01-01'],
    ['rules_version','fake'],['catalog_version','fake']]) {
    await assert.rejects(transaction(runtime,account.id,c=>c.query(`UPDATE job_classifications SET ${column}=$2,version=2 WHERE job_id=$1`,[j.id,value])),e=>e.code==='42501')
  }
  assert.equal((await runtime.query('UPDATE job_classifications SET version=version+1')).rowCount,0)
  const noRequest=await runtime.connect()
  try {
    await noRequest.query('BEGIN'); await noRequest.query("SELECT set_config('app.user_id',$1,true)",[account.id])
    await assert.rejects(noRequest.query('UPDATE job_classifications SET version=version+1 WHERE job_id=$1',[j.id]),e=>e.code==='23514')
  } finally { await noRequest.query('ROLLBACK'); noRequest.release() }
  assert.equal((await direct(j,emptyClassification(),2,1,viewer.id)).rowCount,0)
  assert.equal((await direct(j,emptyClassification(),2,1,other.id)).rowCount,0)
  await direct(j,emptyClassification())
  const h=await history(j); assert.equal(h.events.length,2); assert.equal(h.events[0].afterData.version,2)
})

test('RLS, composite keys and audit privileges prevent tenant leakage and forged history',async()=>{
  const j=await job(); assert.equal((await put(j)).statusCode,201)
  for(const actor of [other.id,viewer.id]) {
    const result=await transaction(runtime,actor,async c=>({records:(await c.query('SELECT * FROM job_classifications')).rowCount,
      audit:(await c.query('SELECT * FROM classification_audit_events')).rowCount}))
    assert.equal(result.audit,0); if(actor===other.id) assert.equal(result.records,0)
  }
  assert.equal((await runtime.query('SELECT * FROM job_classifications')).rowCount,0)
  for(const sql of ['INSERT INTO classification_audit_events SELECT * FROM classification_audit_events LIMIT 1',
    'UPDATE classification_audit_events SET actor_name=actor_name','DELETE FROM classification_audit_events','TRUNCATE classification_audit_events',
    'DELETE FROM job_classifications','TRUNCATE job_classifications','ALTER TABLE job_classifications DISABLE TRIGGER ALL',
    'ALTER TABLE classification_audit_events DISABLE ROW LEVEL SECURITY',"GRANT UPDATE ON memberships TO construction_app"]) {
    if(sql.startsWith('GRANT')) {
      // PostgreSQL warns rather than errors when a role has nothing it can grant.
      await runtime.query(sql); assert.equal((await runtime.query("SELECT has_any_column_privilege(current_user,'memberships','UPDATE') AS granted")).rows[0].granted,false)
    } else await assert.rejects(transaction(runtime,account.id,c=>c.query(sql)),e=>e.code==='42501')
  }
  await assert.rejects(transaction(runtime,account.id,c=>c.query(`INSERT INTO job_classifications(company_id,job_id,version,data,basis_job_version)
    VALUES($1,$2,1,$3,1)`,[companies[1],j.id,JSON.stringify(emptyClassification())])),e=>e.code==='42501')
})

test('102 audit versions paginate without duplicates after new inserts and retain actor names',async()=>{
  const j=await job(); assert.equal((await put(j)).statusCode,201)
  await transaction(runtime,account.id,async c=>{
    await c.query('SELECT role FROM lock_membership($1)',[companies[0]]); await c.query('SELECT id FROM jobs WHERE id=$1 FOR UPDATE',[j.id])
    for(let version=2;version<=102;version++) await c.query('UPDATE job_classifications SET version=$2 WHERE job_id=$1',[j.id,version])
  })
  const first=(await req('GET',path(j)+'/audit?limit=50')).json(); assert.equal(first.events.length,50); assert.equal(first.nextCursor,'53')
  await direct(j,emptyClassification(),103)
  const second=(await req('GET',path(j)+'/audit?limit=50&cursor='+first.nextCursor)).json()
  const last=(await req('GET',path(j)+'/audit?limit=50&cursor='+second.nextCursor)).json()
  assert.equal(second.events.length,50); assert.equal(last.events.length,2); assert.equal(last.nextCursor,null)
  const versions=[...first.events,...second.events,...last.events].map(e=>e.targetVersion)
  assert.equal(new Set(versions).size,102); assert.deepEqual(versions,Array.from({length:102},(_,i)=>102-i))
  await owner.query('UPDATE "user" SET name=$2 WHERE id=$1',[account.id,'変更後の名前'])
  try {
    await direct(j,emptyClassification(),104)
    const events=(await history(j)).events
    assert.equal(events[0].actorName,'変更後の名前'); assert.equal(events[1].actorName,account.name)
    assert.equal(events[0].afterData.createdBy.name,account.name); assert.equal(events[0].beforeData.updatedBy.name,account.name)
  } finally { await owner.query('UPDATE "user" SET name=$2 WHERE id=$1',[account.id,account.name]) }
})

test('issue rules keep uncertainty, conditional reviews, sources and deterministic ordering',()=>{
  const data=emptyClassification(), d=normalizeClassification(data)
  let issues=deriveClassificationIssues(d,basis,[])
  assert.ok(issues.some(i=>i.code==='FIELD_UNANSWERED')); assert.ok(issues.some(i=>i.code==='ELECTRICAL_REVIEW'))
  assert.equal(new Set(issues.map(i=>i.id)).size,issues.length)
  assert.deepEqual(issues,deriveClassificationIssues(d,basis,[]))
  data.context.market=known('public'); data.context.companyRole=known('owner'); data.context.workKind=known('repair')
  data.context.targetKind=unknown(); data.workItems=[item('primary',['electrical','building_general']),item('ancillary')]
  data.workItems[1].parentItemId=data.workItems[0].id
  for(const key of Object.keys(data.conditions)) data.conditions[key]=known('no')
  data.amounts.contract=known({yen:'990000',taxBasis:'unknown'}); data.permit.declaration=known('held')
  for(const key of ['suppliedMaterials','splitContracts','subcontracting']) data.amounts[key]=known('no')
  issues=deriveClassificationIssues(normalizeClassification(data),basis,['job_changed','rules_changed','catalog_changed'])
  assert.deepEqual(issues.slice(0,3).map(i=>i.code),['JOB_CHANGED','RULES_CHANGED','CATALOG_CHANGED'])
  assert.deepEqual(issues.filter(i=>i.code==='OUT_OF_SCOPE').map(i=>i.path),['/context/market','/context/companyRole'])
  for(const code of ['ELECTRICAL_REVIEW','ASBESTOS_REVIEW','BUILDING_REVIEW','GENERAL_TRADE_REVIEW','ANCILLARY_REVIEW','PERMIT_REVIEW','AMOUNT_BASIS_REVIEW','REGIONAL_REVIEW','EVIDENCE_REVIEW']) assert.ok(issues.some(i=>i.code===code),code)
  assert.ok(issues.some(i=>i.code==='FIELD_UNKNOWN'&&i.path==='/amounts/contract/value/taxBasis'))
  for(const code of ['RECYCLING_REVIEW','WASTE_REVIEW','SUPPLIED_MATERIAL_REVIEW','SPLIT_CONTRACT_REVIEW','SUBCONTRACT_REVIEW']) assert.ok(!issues.some(i=>i.code===code),code)
  assert.ok(!issues.some(i=>i.code==='FIELD_UNANSWERED'&&i.path==='/amounts/suppliedMaterialValue'))
  assert.deepEqual(issues.find(i=>i.code==='ELECTRICAL_REVIEW').sourceIds,['L06'])
  assert.ok(issues.every(i=>!['approved','complete','exempt','compliant'].includes(i.kind)))
  data.context.workKind=known('demolition'); data.conditions.demolitionWork=known('yes')
  issues=deriveClassificationIssues(normalizeClassification(data),basis,[])
  for(const code of ['RECYCLING_REVIEW','WASTE_REVIEW','ASBESTOS_REVIEW']) assert.ok(issues.some(i=>i.code===code))
})

test('rules/catalog staleness is derived without rewriting saved snapshots',async()=>{
  const j=await job(); const record=(await put(j)).json().record
  const old=structuredClone(record); old.rulesVersion='old-rule'; old.catalogVersion='old-catalog'
  const view=classificationView(companies[0],j.id,basis,old)
  assert.deepEqual(view.staleReasons,['rules_changed','catalog_changed']); assert.equal(old.rulesVersion,'old-rule')
  assert.deepEqual((await req('GET',path(j))).json().record,record)
  assert.equal((await req('PUT',path(j),{version:1,jobVersion:1,data:record.data,rulesVersion:'fake'})).statusCode,400)
})

test('startup fails closed for classification RLS, forbidden column grants, functions and misplaced triggers',async()=>{
  await assertRuntimeRole(runtime)
  for(const table of ['job_classifications','classification_audit_events']) {
    await owner.query(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`)
    try { await assert.rejects(assertRuntimeRole(runtime),/non-owner/) } finally { await owner.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`) }
  }
  for(const sql of ['GRANT INSERT ON classification_audit_events TO construction_app','GRANT UPDATE(updated_at) ON job_classifications TO construction_app',
    'GRANT INSERT(rules_version) ON job_classifications TO construction_app','GRANT EXECUTE ON FUNCTION public.validate_classification_data(jsonb) TO construction_app']) {
    await owner.query(sql)
    try { await assert.rejects(assertRuntimeRole(runtime),/non-owner/) } finally { await migrate(owner,config,process.env.DB_APP_PASSWORD) }
  }
  await owner.query('ALTER TABLE job_classifications DISABLE TRIGGER classifications_guard_write')
  try { await assert.rejects(assertRuntimeRole(runtime),/non-owner/) } finally { await owner.query('ALTER TABLE job_classifications ENABLE TRIGGER classifications_guard_write') }
  await owner.query('DROP TRIGGER jobs_guard_write ON jobs')
  await owner.query('CREATE TRIGGER jobs_guard_write BEFORE INSERT OR UPDATE ON job_classifications FOR EACH ROW EXECUTE FUNCTION public.guard_job_write()')
  try { await assert.rejects(assertRuntimeRole(runtime),/non-owner/) }
  finally { await owner.query('DROP TRIGGER jobs_guard_write ON job_classifications'); await owner.query('CREATE TRIGGER jobs_guard_write BEFORE INSERT OR UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION public.guard_job_write()') }
  await assertRuntimeRole(runtime)
})

test('SQL validator fails closed for unsupported schema keywords and schema matches API schema',async()=>{
  await assert.rejects(owner.query('SELECT matches_classification_schema($1::jsonb,$2::jsonb)', ['"text"',JSON.stringify({type:'string',format:'email'})]),e=>e.code==='23514')
  const result=await owner.query('SELECT matches_classification_schema($1::jsonb,$2::jsonb) AS valid',[JSON.stringify(emptyClassification()),JSON.stringify(classificationSchema)])
  assert.equal(result.rows[0].valid,true)
  const definition=(await owner.query("SELECT pg_get_functiondef('public.validate_classification_data(jsonb)'::regprocedure) AS source")).rows[0].source
  const embedded=definition.match(/\$schema\$([\s\S]+?)\$schema\$/)
  assert.ok(embedded); assert.deepEqual(JSON.parse(embedded[1]),classificationSchema)
})

test('membership suspension serializes with a classification write and removes session access',async()=>{
  const j=await job(),c=await runtime.connect(),admin=await owner.connect()
  try {
    await c.query('BEGIN'); await c.query("SELECT set_config('app.user_id',$1,true),set_config('app.request_id',$2,true)",[account.id,randomUUID()])
    await c.query('SELECT role FROM lock_membership($1)',[companies[0]])
    const stopping=admin.query('UPDATE memberships SET active=false WHERE company_id=$1 AND user_id=$2',[companies[0],account.id])
    await c.query('SELECT id FROM jobs WHERE id=$1 FOR UPDATE',[j.id])
    await c.query('INSERT INTO job_classifications(company_id,job_id,version,data,basis_job_version) VALUES($1,$2,1,$3,1)',[companies[0],j.id,JSON.stringify(emptyClassification())])
    await c.query('COMMIT'); await stopping
    assert.equal((await req('GET',path(j))).statusCode,404); assert.equal((await put(j)).statusCode,404)
    assert.equal((await req('GET',path(j)+'/audit')).statusCode,404)
    assert.equal((await owner.query('SELECT count(*)::int AS n FROM classification_audit_events WHERE job_id=$1',[j.id])).rows[0].n,1)
  } finally {
    await c.query('ROLLBACK'); c.release(); admin.release()
    await owner.query('UPDATE memberships SET active=true WHERE company_id=$1 AND user_id=$2',[companies[0],account.id])
  }
})
