import { BrowserWindow } from 'electron'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

export type ImageExportPreset = 'desktop' | 'mobile'

export interface ImageExportSnapshot {
  html: string
  styles: string
  bodyClass: string
  background: string
}

const PRESETS: Record<ImageExportPreset, { width: number; height: number; padding: number }> = {
  desktop: { width: 1200, height: 800, padding: 64 },
  mobile: { width: 414, height: 896, padding: 28 },
}

// Every step below used to be able to wait forever: a screenshot command that
// never comes back leaves the user with no window, no file and no message,
// which is exactly what #88 reported on Windows. Each wait now has a deadline,
// so the worst case is a visible error instead of silence.
const LAYOUT_TIMEOUT_MS = 15000
const CAPTURE_TIMEOUT_MS = 20000
// The scroll fallback below is slow on a long document, so it gets a smaller
// deadline per page and a ceiling for the whole export: failing with a message
// beats grinding for minutes.
const FALLBACK_CAPTURE_TIMEOUT_MS = 8000
const FALLBACK_TOTAL_BUDGET_MS = 60000

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超过 ${ms}ms 没有返回`)), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) }
    )
  })
}

function exportHTML(snapshot: ImageExportSnapshot, preset: ImageExportPreset): string {
  const { width, padding } = PRESETS[preset]
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self' data: file:; style-src 'unsafe-inline'; img-src 'self' data: blob: https: http: file:; font-src 'self' data:">
  <style>${snapshot.styles}
    html, body { width: ${width}px !important; min-width: ${width}px !important; height: auto !important; min-height: 0 !important; overflow: visible !important; background: ${snapshot.background} !important; }
    body { margin: 0 !important; padding: 0 !important; }
    *::-webkit-scrollbar { display: none !important; }
    #titlebar, #file-panel, #source-editor, #update-banner { display: none !important; }
    #editor { display: block !important; width: ${width}px !important; height: auto !important; min-height: 0 !important; overflow: visible !important; margin: 0 !important; padding: ${padding}px !important; background: ${snapshot.background} !important; }
    #editor .ProseMirror { width: auto !important; max-width: none !important; min-height: 0 !important; }
  </style>
</head>
<body class="${snapshot.bodyClass}"><div id="editor"><div class="ProseMirror">${snapshot.html}</div></div></body>
</html>`
}

interface PageDimensions {
  width: number
  height: number
}

// Measure without waiting for anything, for the case where the polite version
// below runs out of time.
async function measureLayout(win: BrowserWindow): Promise<PageDimensions> {
  return win.webContents.executeJavaScript(`(() => {
    const editor = document.getElementById('editor')
    const content = editor?.querySelector('.ProseMirror')
    const editorBounds = editor?.getBoundingClientRect()
    const contentBounds = content?.getBoundingClientRect()
    const editorStyle = editor ? getComputedStyle(editor) : null
    const paddingBottom = editorStyle ? Number.parseFloat(editorStyle.paddingBottom) || 0 : 0
    return {
      width: Math.ceil(editorBounds?.width ?? document.documentElement.scrollWidth),
      height: Math.ceil(contentBounds && editorBounds
        ? contentBounds.bottom - editorBounds.top + paddingBottom
        : editor?.scrollHeight ?? document.documentElement.scrollHeight),
    }
  })()`)
}

async function waitForLayout(win: BrowserWindow): Promise<PageDimensions> {
  return win.webContents.executeJavaScript(`(async () => {
    await document.fonts.ready
    await Promise.all(Array.from(document.images).map((image) => image.complete ? undefined : new Promise((resolve) => {
      image.addEventListener('load', resolve, { once: true })
      image.addEventListener('error', resolve, { once: true })
    })))
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const editor = document.getElementById('editor')
    const content = editor?.querySelector('.ProseMirror')
    const editorBounds = editor?.getBoundingClientRect()
    const contentBounds = content?.getBoundingClientRect()
    const editorStyle = editor ? getComputedStyle(editor) : null
    const paddingBottom = editorStyle ? Number.parseFloat(editorStyle.paddingBottom) || 0 : 0
    return {
      width: Math.ceil(editorBounds?.width ?? document.documentElement.scrollWidth),
      height: Math.ceil(contentBounds && editorBounds
        ? contentBounds.bottom - editorBounds.top + paddingBottom
        : editor?.scrollHeight ?? document.documentElement.scrollHeight),
    }
  })()`)
}

// The screenshots come from the debugger protocol, which can capture past the
// viewport. If that route stalls, scroll the page instead and let Electron take
// the picture: lower resolution, but a finished export beats a stuck one.
async function captureSliceByScroll(
  win: BrowserWindow,
  offset: number,
  clip: { width: number; height: number }
): Promise<Buffer> {
  await win.webContents.executeJavaScript(`(() => {
    window.scrollTo(0, ${offset})
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })()`)
  const image = await withTimeout(
    win.webContents.capturePage({ x: 0, y: 0, width: clip.width, height: clip.height }),
    FALLBACK_CAPTURE_TIMEOUT_MS,
    'capturePage'
  )
  return image.toPNG()
}

async function captureSlice(
  win: BrowserWindow,
  offset: number,
  clip: { x: number; y: number; width: number; height: number },
  fallbackSpentMs: { value: number }
): Promise<Buffer> {
  // Test hook, in the spirit of COLAMD_STARTUP_TRACE: force the fallback so the
  // path that only Windows takes can be exercised on a machine where the normal
  // route works.
  if (process.env.COLAMD_FORCE_CAPTURE_FALLBACK === '1') {
    return captureSliceByScroll(win, offset, clip)
  }
  try {
    const screenshot = await withTimeout(
      win.webContents.debugger.sendCommand('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: true,
        clip: { ...clip, scale: 2 },
      }) as Promise<{ data: string }>,
      CAPTURE_TIMEOUT_MS,
      'Page.captureScreenshot'
    )
    return Buffer.from(screenshot.data, 'base64')
  } catch (error) {
    if (fallbackSpentMs.value > FALLBACK_TOTAL_BUDGET_MS) throw error
    console.error('Falling back to capturePage', error)
    const startedAt = Date.now()
    const buffer = await captureSliceByScroll(win, offset, clip)
    fallbackSpentMs.value += Date.now() - startedAt
    return buffer
  }
}

export async function renderDocumentPNGs(snapshot: ImageExportSnapshot, preset: ImageExportPreset): Promise<Buffer[]> {
  const { width, height: pageHeight } = PRESETS[preset]
  const win = new BrowserWindow({
    show: false,
    width,
    height: pageHeight,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // A hidden window still has to produce frames, otherwise every screenshot
      // waits for a picture that is never painted. (Electron paints initially
      // hidden windows by default; throttling is what switches that off.)
      backgroundThrottling: false,
    },
  })

  let tempDir: string | undefined
  try {
    tempDir = await mkdtemp(join(tmpdir(), 'colamd-image-export-'))
    const exportPath = join(tempDir, 'document.html')
    await writeFile(exportPath, exportHTML(snapshot, preset), 'utf8')
    await win.loadFile(exportPath)
    win.webContents.beginFrameSubscription(() => {})
    win.webContents.debugger.attach('1.3')
    const dimensions = await withTimeout(waitForLayout(win), LAYOUT_TIMEOUT_MS, 'waitForLayout')
      .catch((error) => {
        console.error('Layout never settled, measuring as-is', error)
        return measureLayout(win)
      })
    const pages: Buffer[] = []
    const fallbackSpentMs = { value: 0 }
    for (let offset = 0; offset < dimensions.height; offset += pageHeight) {
      const height = Math.min(pageHeight, dimensions.height - offset)
      pages.push(await captureSlice(win, offset, { x: 0, y: offset, width: dimensions.width, height }, fallbackSpentMs))
    }
    return pages
  } finally {
    if (!win.isDestroyed()) {
      if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach()
      win.webContents.endFrameSubscription()
      win.destroy()
    }
    if (tempDir) await rm(tempDir, { recursive: true, force: true })
  }
}
