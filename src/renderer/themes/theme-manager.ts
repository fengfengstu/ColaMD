const themes: Record<string, string> = {
  light: 'theme-light',
  dark: 'theme-dark',
  elegant: 'theme-elegant',
  sepia: 'theme-sepia',
  notion: 'theme-notion',
  bear: 'theme-bear',
  writer: 'theme-writer',
  'solarized-dark': 'theme-solarized-dark',
  nord: 'theme-nord',
  gruvbox: 'theme-gruvbox',
  dracula: 'theme-dracula',
  midnight: 'theme-midnight'
}

let customStyleEl: HTMLStyleElement | null = null

export function applyTheme(name: string, customCSS?: string): void {
  const body = document.body

  // Remove all theme classes
  Object.values(themes).forEach(cls => body.classList.remove(cls))
  body.classList.remove('theme-custom')

  // Remove custom theme style
  if (customStyleEl) {
    customStyleEl.remove()
    customStyleEl = null
  }

  if (customCSS || name.startsWith('custom:')) {
    if (customCSS) {
      customStyleEl = document.createElement('style')
      customStyleEl.textContent = customCSS
      document.head.appendChild(customStyleEl)
    }
    body.classList.add('theme-custom')
  } else if (themes[name]) {
    body.classList.add(themes[name])
  }

  // Persist theme choice
  localStorage.setItem('colamd-theme', name)

  // Tell the main process so the theme menu can show the selected state
  window.electronAPI?.reportTheme?.(name)

  // …and hand it the resolved shell colours. Windows paints the window controls
  // inside our own row (titleBarOverlay), and that overlay has to be told a real
  // colour: the chrome surface and the row icons' grey, read off the live computed
  // style so a custom theme works the same as a built-in one.
  const bar = document.getElementById('titlebar')
  if (bar) {
    const surface = getComputedStyle(bar).backgroundColor
    // The OS draws its three glyphs, and they have to sit at the same weight as
    // our four: the platform wants one SOLID colour, while the row's icons are a
    // translucent mix over the chrome, so composite it the way the browser would
    // before handing it over.
    //
    // Both values go over as plain #rrggbb, because the platform parses no CSS
    // Color 4: Chromium hands us `color(srgb 0.1 0.1 0.1)`, Windows rejected the
    // whole overlay call, and the buttons kept the colours from window creation on
    // every theme — including a light strip on a black row (real Windows test,
    // 2026-09-15). Painting each colour onto a canvas and reading the pixel back
    // gives the platform the one string it understands.
    const iconEl = document.getElementById('file-toggle-btn') ?? document.body
    const icon = getComputedStyle(iconEl).color
    const surfaceHex = painted(surface, '#ffffff')
    window.electronAPI?.reportTitlebarColors?.({ background: surfaceHex, symbol: painted(icon, surfaceHex) })
  }
}

// Resolve a colour to #rrggbb, as painted over an opaque one: a translucent value
// is composited exactly the way the browser would, and any CSS colour syntax the
// canvas understands (the platform understands fewer) comes back as hex.
function painted(color: string, background: string): string {
  const hex = (value: number): string => value.toString(16).padStart(2, '0')
  try {
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const ctx = canvas.getContext('2d')
    if (!ctx) return color
    ctx.fillStyle = background
    ctx.fillRect(0, 0, 1, 1)
    ctx.fillStyle = color
    ctx.fillRect(0, 0, 1, 1)
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
    return `#${hex(r)}${hex(g)}${hex(b)}`
  } catch {
    // An unparseable colour keeps the caller's value rather than turning the
    // window controls invisible.
    return color
  }
}

export function loadSavedTheme(): string {
  const saved = localStorage.getItem('colamd-theme')
  if (!saved) return 'elegant'
  // Custom themes are stored as "custom:<file>.css". Preserve the name so a
  // newly opened window can reload its stylesheet instead of falling back.
  if (themes[saved] || saved.startsWith('custom:')) return saved
  return 'elegant'
}
