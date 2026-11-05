import { sb } from './supabase'

/** Downscale to ~1600px wide and re-encode (WebP, falling back to JPEG) before upload. Phone photos are often 5MB+. */
export async function compressImage(file: File, maxWidth = 1600): Promise<Blob> {
  if (!file.type.startsWith('image/')) throw new Error('Please choose an image file.')
  if (file.type === 'image/svg+xml') return file
  const bmp = await createImageBitmap(file)
  const scale = Math.min(1, maxWidth / bmp.width)
  const w = Math.round(bmp.width * scale)
  const h = Math.round(bmp.height * scale)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not process the image.')
  ctx.drawImage(bmp, 0, 0, w, h)
  bmp.close?.()
  const blob = (type: string, q: number) => new Promise<Blob | null>((res) => canvas.toBlob(res, type, q))
  return (await blob('image/webp', 0.82)) ?? (await blob('image/jpeg', 0.85)) ?? Promise.reject(new Error('Could not compress the image.'))
}

/** Uploads to the public property-images bucket and returns the public URL. */
export async function uploadImage(file: File, folder: string): Promise<string> {
  const blob = await compressImage(file)
  const ext = blob.type === 'image/webp' ? 'webp' : blob.type === 'image/svg+xml' ? 'svg' : 'jpg'
  const path = `${folder}/${crypto.randomUUID()}.${ext}`
  const { error } = await sb().storage.from('property-images').upload(path, blob, { contentType: blob.type, cacheControl: '31536000' })
  if (error) throw error
  return sb().storage.from('property-images').getPublicUrl(path).data.publicUrl
}

/** Receipts are private; we store the object path and sign a short-lived URL to view it. */
export async function uploadReceipt(file: File, folder: string): Promise<string> {
  const blob = await compressImage(file)
  const path = `${folder}/${crypto.randomUUID()}.${blob.type === 'image/webp' ? 'webp' : 'jpg'}`
  const { error } = await sb().storage.from('expense-receipts').upload(path, blob, { contentType: blob.type })
  if (error) throw error
  return path
}
export async function receiptUrl(path: string): Promise<string | null> {
  const { data } = await sb().storage.from('expense-receipts').createSignedUrl(path, 300)
  return data?.signedUrl ?? null
}

export const MAX_VIDEO_BYTES = 40 * 1024 * 1024
export type UploadedMedia = { url: string; path: string; kind: 'image' | 'video'; size: number }

/** Library upload: images are compressed, short videos (mp4/webm, up to 40 MB) go up as they are. */
export async function uploadMedia(file: File, folder = 'library'): Promise<UploadedMedia> {
  const isVideo = file.type === 'video/mp4' || file.type === 'video/webm'
  if (isVideo && file.size > MAX_VIDEO_BYTES) throw new Error('Videos must be under 40 MB. Trim the clip or lower its quality first.')
  if (!isVideo && !file.type.startsWith('image/')) throw new Error('Choose an image, or an MP4 / WebM video.')
  const blob = isVideo ? file : await compressImage(file)
  const ext = isVideo ? (file.type === 'video/webm' ? 'webm' : 'mp4') : blob.type === 'image/webp' ? 'webp' : blob.type === 'image/svg+xml' ? 'svg' : 'jpg'
  const path = `${folder}/${crypto.randomUUID()}.${ext}`
  const { error } = await sb().storage.from('property-images').upload(path, blob, { contentType: blob.type || file.type, cacheControl: '31536000' })
  if (error) throw error
  return { url: sb().storage.from('property-images').getPublicUrl(path).data.publicUrl, path, kind: isVideo ? 'video' : 'image', size: blob.size }
}
