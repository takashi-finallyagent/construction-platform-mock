import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { useBlocker } from 'react-router'
import { Camera as CameraIcon, Check, LoaderCircle, RotateCw, SwitchCamera, X } from 'lucide-react'
import { phaseLabels, uid, type FieldJob, type FieldPhoto, type PhotoPhase } from './model'
import { useField } from './FieldProvider'
import { saveError } from './storage'
import { downloadBlob } from './pdf'

export function Camera({ job, phase, onClose }: { job: FieldJob; phase: PhotoPhase; onClose: () => void }) {
  const { addPhoto } = useField()
  const video = useRef<HTMLVideoElement>(null)
  const nativeInput = useRef<HTMLInputElement>(null)
  const savingRef = useRef(false)
  const [facing, setFacing] = useState<'environment' | 'user'>('environment')
  const [retry, setRetry] = useState(0)
  const [error, setError] = useState('')
  const [live, setLive] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(0)
  const [pending, setPending] = useState<FieldPhoto | null>(null)
  const [thumbnail, setThumbnail] = useState<Blob | null>(null)
  const thumbUrl = useBlobUrl(thumbnail)
  const blocker = useBlocker(saving || Boolean(pending))

  useEffect(() => {
    if (blocker.state === 'blocked') {
      blocker.reset()
      setError('未保存の写真があります。保存の再試行、写真の退避、または破棄を選んでください。')
    }
  }, [blocker])

  useEffect(() => {
    let cancelled = false
    let stream: MediaStream | undefined
    setLive(false); setError('')
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('この画面ではカメラを直接起動できません。端末のカメラで撮影してください。')
    } else {
      void navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1440 } } }).then(async (result) => {
        if (cancelled) { result.getTracks().forEach((track) => track.stop()); return }
        stream = result
        if (!video.current) return
        video.current.srcObject = stream
        await video.current.play()
        if (!cancelled) setLive(true)
      }).catch((reason: unknown) => {
        if (cancelled) return
        setError(reason instanceof DOMException && reason.name === 'NotAllowedError'
          ? 'カメラの使用が許可されていません。ブラウザのカメラ設定を確認するか、端末のカメラで撮影してください。'
          : 'カメラを起動できませんでした。ほかのカメラアプリを閉じて、もう一度お試しください。')
      })
    }
    return () => { cancelled = true; stream?.getTracks().forEach((track) => track.stop()); document.body.style.overflow = previousOverflow }
  }, [facing, retry])

  useEffect(() => {
    const preventLoss = (event: BeforeUnloadEvent) => {
      if (savingRef.current || pending) { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('beforeunload', preventLoss)
    return () => window.removeEventListener('beforeunload', preventLoss)
  }, [pending])

  async function persist(photo: FieldPhoto) {
    setPending(photo)
    try {
      await addPhoto(photo)
      setPending(null); setThumbnail(photo.blob); setSaved((count) => count + 1); setError('')
    } catch (reason) { setError(saveError(reason)) }
  }

  function makePhoto(blob: Blob, source: FieldPhoto['source']): FieldPhoto {
    const now = new Date().toISOString()
    return { id: uid(), jobId: job.id, phase, part: job.part, caption: `${job.name} / ${phaseLabels[phase]}`, takenAt: source === 'camera' ? now : null, savedAt: now, source, blob }
  }

  async function capture() {
    const element = video.current
    if (savingRef.current || pending || !element?.videoWidth) return
    savingRef.current = true; setSaving(true)
    try {
      const canvas = document.createElement('canvas')
      canvas.width = element.videoWidth; canvas.height = element.videoHeight
      const context = canvas.getContext('2d')
      if (!context) throw new Error('写真を取得できませんでした。')
      context.drawImage(element, 0, 0)
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('写真を保存できませんでした。')), 'image/jpeg', 0.94))
      await persist(makePhoto(blob, 'camera'))
    } catch (reason) { setError(saveError(reason)) }
    finally { savingRef.current = false; setSaving(false) }
  }

  async function deviceCapture(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || savingRef.current || pending) return
    savingRef.current = true; setSaving(true)
    try {
      if (!file.type.startsWith('image/')) throw new Error('写真を読み取れませんでした。')
      const image = await createImageBitmap(file)
      image.close()
      await persist(makePhoto(file, 'device-camera'))
    } catch (reason) { setError(saveError(reason)) }
    finally { savingRef.current = false; setSaving(false) }
  }

  return <div className="capture-screen" role="dialog" aria-modal="true" aria-label={`${phaseLabels[phase]}の撮影`}>
    <header className="capture-header">
      <div><strong>{job.building}</strong><span>{job.part} / {phaseLabels[phase]}</span></div>
      <button className="capture-icon" onClick={onClose} disabled={saving || Boolean(pending)} aria-label="撮影を終了" title="撮影を終了"><X /></button>
    </header>
    <video ref={video} autoPlay playsInline muted className={live ? 'is-live' : ''} />
    {!live && <div className="capture-unavailable"><CameraIcon size={45} /><p>{error || 'カメラを起動しています…'}</p>
      <button className="field-button" onClick={() => nativeInput.current?.click()} disabled={saving || Boolean(pending)}><CameraIcon size={19} />端末のカメラで撮る</button>
      <button className="capture-link" onClick={() => setRetry((r) => r + 1)}><RotateCw size={17} />もう一度起動</button>
    </div>}
    <input ref={nativeInput} type="file" accept="image/*" capture="environment" onChange={(event) => void deviceCapture(event)} hidden aria-label="端末のカメラ" />
    <div className="capture-bottom">
      {error && live && <div className="capture-error" role="alert">{error}</div>}
      {pending && !saving && <div className="capture-error" role="alert">この写真はまだ台帳に保存されていません。<div className="capture-recovery"><button onClick={async () => { if (savingRef.current) return; savingRef.current = true; setSaving(true); try { await persist(pending) } finally { savingRef.current = false; setSaving(false) } }}>保存を再試行</button><button onClick={() => downloadBlob(pending.blob, `未保存写真_${pending.id}.jpg`)}>写真を退避</button><button onClick={() => { if (window.confirm('台帳に保存できていない写真を破棄します。破棄してよろしいですか？')) { setPending(null); setError('') } }}>破棄</button></div></div>}
      <div className="capture-feedback" role="status" aria-live="polite">{saving ? <><LoaderCircle className="spin" size={18} />端末に保存しています</> : saved > 0 ? <><Check size={18} />この工事に{saved}枚保存しました</> : `${phaseLabels[phase]} / 撮影すると端末に保存`}</div>
      <div className="capture-controls">
        <div className="capture-thumb">{thumbUrl && <img src={thumbUrl} alt="保存した写真" />}</div>
        <button className="shutter" aria-label="写真を撮影" title="写真を撮影" disabled={!live || saving || Boolean(pending)} onClick={() => void capture()}><span /></button>
        <button className="capture-icon" onClick={() => setFacing((value) => value === 'environment' ? 'user' : 'environment')} disabled={saving || Boolean(pending)} aria-label="カメラを切り替える" title="カメラを切り替える"><SwitchCamera size={27} /></button>
      </div>
      <p className="capture-storage">この端末のブラウザに保存 / 他の端末には共有されません</p>
    </div>
  </div>
}

export function useBlobUrl(blob: Blob | null | undefined) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    if (!blob) { setUrl(''); return }
    const next = URL.createObjectURL(blob)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [blob])
  return url
}
