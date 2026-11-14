import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { localDate, seedWorkspace, type FieldJob, type FieldPhoto, type IssuedDocument } from './model'
import { assertStageChange, validateReview, type ComplianceReview } from './compliance'
import { appendPaymentEvent, revisePaymentCase, type PaymentEvent, type PaymentRevision } from './payment'
import { loadWorkspace, loadPhotos, loadDocuments, saveWorkspace, putPhoto, putDocument, saveError } from './storage'

interface FieldState {
  jobs: FieldJob[]
  photos: FieldPhoto[]
  documents: IssuedDocument[]
  ready: boolean
  error: string
  updateJob: (job: FieldJob) => Promise<void>
  addPhoto: (photo: FieldPhoto) => Promise<void>
  issueDocument: (doc: IssuedDocument) => Promise<void>
  recordReview: (jobId: string, review: ComplianceReview) => Promise<void>
  savePaymentTerms: (jobId: string, caseId: string, revision: PaymentRevision) => Promise<void>
  recordPaymentEvent: (jobId: string, caseId: string, event: PaymentEvent) => Promise<void>
}
const Context = createContext<FieldState | null>(null)

export function FieldProvider({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<FieldJob[]>([])
  const jobsRef = useRef<FieldJob[]>([])
  const [photos, setPhotos] = useState<FieldPhoto[]>([])
  const [documents, setDocuments] = useState<IssuedDocument[]>([])
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const mutations = useRef(Promise.resolve())
  useEffect(() => {
    let cancelled = false
    void Promise.all([loadWorkspace(), loadPhotos(), loadDocuments()]).then(async ([saved, storedPhotos, storedDocuments]) => {
      if (cancelled) return
      if (saved && (saved.version !== 1 || !Array.isArray(saved.jobs))) throw new Error('保存データの形式が異なります。データを削除せず管理者へお問い合わせください。')
      const workspace = saved ?? seedWorkspace()
      if (!saved) await saveWorkspace(workspace)
      if (cancelled) return
      jobsRef.current = workspace.jobs
      setJobs(jobsRef.current)
      setPhotos(storedPhotos)
      setDocuments(storedDocuments.sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
      setReady(true)
    }).catch((reason: unknown) => { if (!cancelled) { setError(saveError(reason)); setReady(true) } })
    return () => { cancelled = true }
  }, [])

  const updateJob = useCallback((job: FieldJob) => {
    const operation = mutations.current.then(async () => {
      const previous = jobsRef.current.find((item) => item.id === job.id)
      const savedJob = { ...job, complianceReviews: previous?.complianceReviews ?? [], paymentCases: previous?.paymentCases ?? [] }
      assertStageChange(previous, savedJob, localDate())
      const next = previous ? jobsRef.current.map((item) => item.id === job.id ? savedJob : item) : [savedJob, ...jobsRef.current]
      await saveWorkspace({ version: 1, jobs: next })
      jobsRef.current = next
      setJobs(next)
    })
    mutations.current = operation.catch(() => {})
    return operation
  }, [])

  const recordReview = useCallback((jobId: string, review: ComplianceReview) => {
    const operation = mutations.current.then(async () => {
      const job = jobsRef.current.find((item) => item.id === jobId)
      if (!job) throw new Error('工事が見つかりません。')
      validateReview(review, job, localDate())
      const next = jobsRef.current.map((item) => item.id === jobId ? { ...item, complianceReviews: [...(item.complianceReviews ?? []), review] } : item)
      await saveWorkspace({ version: 1, jobs: next })
      jobsRef.current = next
      setJobs(next)
    })
    mutations.current = operation.catch(() => {})
    return operation
  }, [])

  const addPhoto = useCallback(async (photo: FieldPhoto) => {
    if (!(photo.blob instanceof Blob) || !photo.blob.size) throw new Error('写真が空です。もう一度撮影してください。')
    await putPhoto(photo)
    setPhotos((current) => [photo, ...current.filter((p) => p.id !== photo.id)])
  }, [])

  const savePaymentTerms = useCallback((jobId: string, caseId: string, revision: PaymentRevision) => {
    const operation = mutations.current.then(async () => {
      const job = jobsRef.current.find((item) => item.id === jobId)
      if (!job) throw new Error('工事が見つかりません。')
      const cases = job.paymentCases ?? []
      const previous = cases.find((item) => item.id === caseId)
      const saved = revisePaymentCase(previous, caseId, revision)
      const paymentCases = previous ? cases.map((item) => item.id === caseId ? saved : item) : [...cases, saved]
      const next = jobsRef.current.map((item) => item.id === jobId ? { ...item, paymentCases } : item)
      await saveWorkspace({ version: 1, jobs: next })
      jobsRef.current = next; setJobs(next)
    })
    mutations.current = operation.catch(() => {})
    return operation
  }, [])

  const recordPaymentEvent = useCallback((jobId: string, caseId: string, event: PaymentEvent) => {
    const operation = mutations.current.then(async () => {
      const job = jobsRef.current.find((item) => item.id === jobId)
      const item = job?.paymentCases?.find((value) => value.id === caseId)
      if (!job || !item) throw new Error('取引が見つかりません。')
      const saved = appendPaymentEvent(item, event, localDate())
      const paymentCases = job.paymentCases!.map((value) => value.id === caseId ? saved : value)
      const next = jobsRef.current.map((value) => value.id === jobId ? { ...value, paymentCases } : value)
      await saveWorkspace({ version: 1, jobs: next })
      jobsRef.current = next; setJobs(next)
    })
    mutations.current = operation.catch(() => {})
    return operation
  }, [])
  const issueDocument = useCallback(async (doc: IssuedDocument) => {
    await putDocument(doc)
    setDocuments((current) => [doc, ...current.filter((d) => d.id !== doc.id)])
  }, [])

  return <Context.Provider value={{ jobs, photos, documents, ready, error, updateJob, addPhoto, issueDocument, recordReview, savePaymentTerms, recordPaymentEvent }}>{children}</Context.Provider>
}
export function useField() {
  const context = useContext(Context)
  if (!context) throw new Error('FieldProvider is missing')
  return context
}
