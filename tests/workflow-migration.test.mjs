import {test} from 'node:test'
import assert from 'node:assert/strict'
import {randomBytes,randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {getMigrations} from 'better-auth/db/migration'
import {authOptions,createAuth} from '../server/auth.ts'
import {readConfig} from '../server/config.ts'
import {createPool,transaction,assertRuntimeRole} from '../server/db.ts'
import {migrate} from '../server/migrate.ts'
import {emptyClassification} from '../src/product/classification-model.ts'
import {buildApp} from '../server/app.ts'
import {emptyWorkflow,draftPublication,emptyTerms} from '../src/product/workflow-model.ts'
import {deriveClassificationIssues} from '../server/classification-issues.ts'

test('005 upgrade preserves populated jobs, classifications and audit history without fabricating workflows/files',async()=>{
  const dbName=`workflow_upgrade_${randomBytes(6).toString('hex')}`,adminUrl=new URL(process.env.DATABASE_ADMIN_URL),runtimeUrl=new URL(process.env.DATABASE_URL)
  assert.equal(adminUrl.hostname,'127.0.0.1');assert.equal(runtimeUrl.hostname,'127.0.0.1');assert.equal(adminUrl.port,'55432');assert.equal(runtimeUrl.port,'55432')
  const controlUrl=new URL(adminUrl);controlUrl.pathname='/postgres';adminUrl.pathname=runtimeUrl.pathname=`/${dbName}`
  const control=createPool(controlUrl.href),owner=createPool(adminUrl.href),runtime=createPool(runtimeUrl.href),config=readConfig({...process.env,DATABASE_URL:runtimeUrl.href})
  let created=false,app
  try{
    await control.query(`CREATE DATABASE ${dbName}`);created=true
    await (await getMigrations(authOptions(owner,config))).runMigrations()
    for(const file of ['001_foundation.sql','002_membership_lock.sql','003_job_audit.sql','004_job_classification.sql'])await owner.query(await readFile(new URL(`../server/migrations/${file}`,import.meta.url),'utf8'))
    await owner.query('CREATE TABLE schema_migrations(version integer PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())')
    await owner.query('INSERT INTO schema_migrations(version) VALUES(1),(2),(3),(4)')
    const auth=createAuth(owner,config,true),password=randomBytes(30).toString('base64url'),user=(await auth.api.signUpEmail({body:{name:'移行前記録者',email:'upgrade@workflow.invalid',password}})).user
    const companyId=randomUUID(),jobId=randomUUID()
    await owner.query("INSERT INTO companies(id,name) VALUES($1,'移行前会社')",[companyId]);await owner.query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner')",[companyId,user.id])
    await transaction(owner,user.id,async c=>{
      await c.query("INSERT INTO jobs(id,company_id,name,site_address,customer_name,work_description,created_by) VALUES($1,$2,'移行前工事','所在地','発注者','修繕',$3)",[jobId,companyId,user.id])
      await c.query('INSERT INTO job_classifications(company_id,job_id,version,data,basis_job_version) VALUES($1,$2,1,$3,1)',[companyId,jobId,JSON.stringify(emptyClassification())])
      await c.query('UPDATE job_classifications SET version=2 WHERE job_id=$1',[jobId])
      await c.query("UPDATE jobs SET name='更新後工事',version=2 WHERE id=$1",[jobId])
    })
    const snapshot=async()=>({
      jobs:(await owner.query('SELECT * FROM jobs ORDER BY id')).rows,
      classifications:(await owner.query('SELECT * FROM job_classifications ORDER BY company_id,job_id')).rows,
      jobAudit:(await owner.query('SELECT * FROM audit_events ORDER BY target_id,target_version')).rows,
      classificationAudit:(await owner.query('SELECT * FROM classification_audit_events ORDER BY job_id,target_version')).rows,
      memberships:(await owner.query('SELECT * FROM memberships ORDER BY company_id,user_id')).rows,
    })
    const before=await snapshot();await migrate(owner,config,process.env.DB_APP_PASSWORD);await assertRuntimeRole(runtime)
    assert.deepEqual(await snapshot(),before)
    for(const table of ['job_workflows','workflow_audit_events','job_files'])assert.equal((await owner.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,0)
    const migrations=(await owner.query('SELECT * FROM schema_migrations ORDER BY version')).rows;assert.deepEqual(migrations.map(r=>r.version),[1,2,3,4,5,6])
    await migrate(owner,config,process.env.DB_APP_PASSWORD);assert.deepEqual(await snapshot(),before);assert.deepEqual((await owner.query('SELECT * FROM schema_migrations ORDER BY version')).rows,migrations)
    app=await buildApp(runtime,config)
    const login=await app.inject({method:'POST',url:'/api/auth/sign-in/email',headers:{origin:config.origin},payload:{email:user.email,password}});assert.equal(login.statusCode,200,login.body)
    const raw=login.headers['set-cookie'],cookie=(Array.isArray(raw)?raw:[raw]).map(c=>c.split(';')[0]).join('; ')
    const result=await app.inject({method:'GET',url:`/api/companies/${companyId}/jobs/${jobId}/workflow`,headers:{cookie}})
    assert.equal(result.statusCode,200,result.body);assert.equal(result.json().version,0);assert.equal(result.json().jobVersion,2);assert.equal(result.json().classificationVersion,2)
    assert.deepEqual(await snapshot(),before)
  }finally{
    await app?.close();await runtime.end();await owner.end()
    try{if(created){assert.match(dbName,/^workflow_upgrade_[a-f0-9]{12}$/);await control.query(`DROP DATABASE ${dbName} WITH (FORCE)`)}}finally{await control.end()}
  }
})

test('006 preserves preexisting evidence-free payments and audit exactly, validates only new appends and permits unrelated writes',async()=>{
  const dbName=`payment_upgrade_${randomBytes(6).toString('hex')}`,adminUrl=new URL(process.env.DATABASE_ADMIN_URL),runtimeUrl=new URL(process.env.DATABASE_URL)
  assert.equal(adminUrl.hostname,'127.0.0.1');assert.equal(runtimeUrl.hostname,'127.0.0.1');assert.equal(adminUrl.port,'55432');assert.equal(runtimeUrl.port,'55432')
  const controlUrl=new URL(adminUrl);controlUrl.pathname='/postgres';adminUrl.pathname=runtimeUrl.pathname=`/${dbName}`
  const control=createPool(controlUrl.href),owner=createPool(adminUrl.href),runtime=createPool(runtimeUrl.href),config=readConfig({...process.env,DATABASE_URL:runtimeUrl.href})
  let created=false,app
  try{
    await control.query(`CREATE DATABASE ${dbName}`);created=true
    await (await getMigrations(authOptions(owner,config))).runMigrations()
    for(const file of ['001_foundation.sql','002_membership_lock.sql','003_job_audit.sql','004_job_classification.sql','005_job_workflow.sql'])await owner.query(await readFile(new URL(`../server/migrations/${file}`,import.meta.url),'utf8'))
    await owner.query('CREATE TABLE schema_migrations(version integer PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())')
    await owner.query('INSERT INTO schema_migrations(version) VALUES(1),(2),(3),(4),(5)')
    const password=randomBytes(30).toString('base64url'),user=(await createAuth(owner,config,true).api.signUpEmail({body:{name:'旧支払記録者',email:'payment-upgrade@workflow.invalid',password}})).user
    const companyId=randomUUID(),jobId=randomUUID(),fileId=randomUUID(),today=new Date(Date.now()+9*3600000).toISOString().slice(0,10),known=value=>({state:'known',value,reason:null})
    await owner.query("INSERT INTO companies(id,name) VALUES($1,'旧支払会社')",[companyId]);await owner.query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner')",[companyId,user.id])
    const classification=emptyClassification()
    for(const [key,value] of Object.entries({market:'private',companyRole:'prime_contractor',workKind:'repair',targetKind:'building'}))classification.context[key]=known(value)
    classification.workItems=[{id:randomUUID(),description:'修繕',tradeCandidates:known(['fittings']),relationship:known('independent'),parentItemId:null}]
    classification.amounts.contract=known({yen:'1000',taxBasis:'tax_included'})
    for(const key of ['suppliedMaterials','splitContracts','subcontracting'])classification.amounts[key]=known('no')
    for(const key of Object.keys(classification.conditions))classification.conditions[key]=known('no')
    classification.permit.declaration=known('not_held')
    const d=emptyWorkflow(),estimateId=randomUUID(),contractId=randomUUID(),invoiceId=randomUUID()
    const priced={items:[{id:randomUUID(),description:'修繕',category:'labor',quantity:'1',unit:'式',unitPrice:'1000'}],taxRate:'10',rounding:'floor'}
    d.estimates=[{id:estimateId,...draftPublication(),status:'issued',title:'見積',recipient:'発注者',recipientAddress:'発注者住所',issuer:'施工者',issuerAddress:'施工者住所',issuedOn:today,validUntil:null,...priced,notes:''}]
    d.contracts=[{id:contractId,...draftPublication(),status:'issued',title:'契約',estimateId,kind:'initial',originalContractId:null,changeReason:'',effectiveDate:today,partyRole:'receiving',counterparty:'発注者',terms:{...Object.fromEntries(Object.keys(emptyTerms()).map(k=>[k,'合意事項'])),startDate:today,endDate:today,handoverDate:today}}]
    d.invoices=[{id:invoiceId,...draftPublication(),status:'issued',number:'LEGACY-1',direction:'receivable',contractId,recipient:'発注者',issuer:'施工者',issuedOn:today,dueOn:today,bank:'振込先',registrationNumber:'',...priced,notes:''}]
    const legacy={id:randomUUID(),invoiceId,type:'payment',reversesId:null,paidOn:today,amountYen:'500',method:'振込',reference:'',evidenceIds:[],note:'移行前の実績原本'}
    d.payments=[legacy]
    const basis={version:1,name:'旧工事',siteAddress:'所在地',customerName:'発注者',workDescription:'修繕',plannedStart:null,plannedEnd:null}
    d.reviews=deriveClassificationIssues(classification,basis,[]).filter(i=>i.kind==='review').map(issue=>({id:randomUUID(),issueId:issue.id,jobVersion:1,classificationVersion:1,conclusion:'confirmed',reviewedOn:today,evidenceIds:[fileId],note:'確認根拠'}))
    await transaction(owner,user.id,async client=>{
      await client.query("INSERT INTO jobs(id,company_id,name,site_address,customer_name,work_description,created_by) VALUES($1,$2,'旧工事','所在地','発注者','修繕',$3)",[jobId,companyId,user.id])
      await client.query('INSERT INTO job_classifications(company_id,job_id,version,data,basis_job_version) VALUES($1,$2,1,$3,1)',[companyId,jobId,JSON.stringify(classification)])
      await client.query("INSERT INTO job_files(id,company_id,job_id,name,content_type,size,sha256,kind,storage_key) VALUES($1,$2,$3,'証拠.pdf','application/pdf',1,$4,'evidence',$5)",[fileId,companyId,jobId,'a'.repeat(64),randomUUID()])
      await client.query('INSERT INTO job_workflows(company_id,job_id,version,data,basis_job_version,classification_version) VALUES($1,$2,1,$3,1,1)',[companyId,jobId,JSON.stringify(d)])
    })
    const snapshot=async()=>({workflow:(await owner.query('SELECT * FROM job_workflows')).rows,audit:(await owner.query('SELECT * FROM workflow_audit_events ORDER BY version')).rows,files:(await owner.query('SELECT * FROM job_files')).rows})
    const before=await snapshot();assert.deepEqual(before.workflow[0].data.payments,[legacy])
    await assert.rejects(assertRuntimeRole(runtime))
    await migrate(owner,config,process.env.DB_APP_PASSWORD);await assertRuntimeRole(runtime);assert.deepEqual(await snapshot(),before)
    await migrate(owner,config,process.env.DB_APP_PASSWORD);assert.deepEqual(await snapshot(),before)
    app=await buildApp(runtime,config)
    const login=await app.inject({method:'POST',url:'/api/auth/sign-in/email',headers:{origin:config.origin},payload:{email:user.email,password}});assert.equal(login.statusCode,200,login.body)
    const raw=login.headers['set-cookie'],cookie=(Array.isArray(raw)?raw:[raw]).map(c=>c.split(';')[0]).join('; '),url=`/api/companies/${companyId}/jobs/${jobId}/workflow`
    const send=(data,version)=>app.inject({method:'PUT',url,headers:{origin:config.origin,cookie},payload:{version,jobVersion:1,classificationVersion:1,data}})
    const unchanged=before.workflow[0].data;unchanged.laborInsurance.note='過去記録はそのままで別項目を記録'
    let r=await send(unchanged,1);assert.equal(r.statusCode,200,r.body);assert.deepEqual(r.json().data.payments,[legacy])
    await transaction(runtime,user.id,c=>c.query('UPDATE job_workflows SET version=3 WHERE job_id=$1',[jobId]))
    const missing=r.json().data;missing.payments.push({...legacy,id:randomUUID()})
    assert.equal((await send(missing,3)).statusCode,400)
    await assert.rejects(transaction(runtime,user.id,c=>c.query('UPDATE job_workflows SET version=4,data=$2 WHERE job_id=$1',[jobId,JSON.stringify(missing)])),e=>e.code==='23514')
    const reversal=r.json().data;reversal.payments.push({...legacy,id:randomUUID(),type:'reversal',reversesId:legacy.id,evidenceIds:[fileId],note:'過去の実績を理由付きで取消'})
    r=await send(reversal,3);assert.equal(r.statusCode,200,r.body);assert.deepEqual(r.json().data.payments[0],legacy)
    const audit=(await owner.query('SELECT * FROM workflow_audit_events ORDER BY version')).rows;assert.equal(audit.length,4);assert.deepEqual(audit[0],before.audit[0]);assert.deepEqual(audit[3].after_data.payments[0],legacy)
  }finally{
    await app?.close();await runtime.end();await owner.end()
    try{if(created){assert.match(dbName,/^payment_upgrade_[a-f0-9]{12}$/);await control.query(`DROP DATABASE ${dbName} WITH (FORCE)`)}}finally{await control.end()}
  }
})
