import { toPng } from 'html-to-image'

/**
 * Rasterize a DOM node to a PNG File for WhatsApp Cloud API image send.
 * Prefer this over string HTML + html2canvas.
 */
export async function captureElementAsPngFile(
  el: HTMLElement,
  basename: string,
): Promise<File> {
  // Wait a tick so layout/images settle (esp. proxied thumbs).
  await new Promise((r) => requestAnimationFrame(() => r(undefined)))
  await waitForImages(el)

  const dataUrl = await toPng(el, {
    cacheBust: true,
    pixelRatio: 2,
    backgroundColor: '#182229',
  })

  const res = await fetch(dataUrl)
  const blob = await res.blob()
  const safe = basename.replace(/[^\w.-]+/g, '_') || 'capture'
  return new File([blob], `${safe}-${Date.now()}.png`, { type: 'image/png' })
}

async function waitForImages(root: HTMLElement): Promise<void> {
  const imgs = Array.from(root.querySelectorAll('img'))
  await Promise.all(
    imgs.map(
      (img) =>
        new Promise<void>((resolve) => {
          if (img.complete && img.naturalWidth > 0) {
            resolve()
            return
          }
          const done = () => resolve()
          img.addEventListener('load', done, { once: true })
          img.addEventListener('error', done, { once: true })
          // Safety timeout so a hung image never blocks send forever.
          setTimeout(done, 4000)
        }),
    ),
  )
}
