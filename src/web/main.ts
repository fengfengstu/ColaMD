// The web playground entry: the same editor core and the same theme CSS as the
// desktop app, with the desktop chrome left out. Nothing here reaches for
// Electron: the editor core only calls it in four optional, guarded places.
//
// Scope is deliberate (MVP): typing, the 12 themes, and one sample document.
// Tabs, the file list, search, export, diagrams and formulas stay in the app.

import { createEditor, setMarkdown } from '../renderer/editor/editor'
import { applyTheme } from '../renderer/themes/theme-manager'
import { SAMPLES } from './sample'
import '../renderer/themes/base.css'
import '../renderer/themes/premium.css'
import './web.css'

type Lang = 'zh' | 'en'

// id, 中文名, English name. Same twelve themes as the desktop app.
const THEMES: Array<[string, string, string]> = [
  ['light', '浅色', 'Light'],
  ['elegant', '雅致', 'Elegant'],
  ['notion', '简白', 'Notion'],
  ['writer', '作家', 'Writer'],
  ['bear', '熊红', 'Bear'],
  ['sepia', '羊皮纸', 'Sepia'],
  ['dark', '深色', 'Dark'],
  ['midnight', '午夜', 'Midnight'],
  ['solarized-dark', '夜航', 'Solarized Dark'],
  ['nord', '极地', 'Nord'],
  ['gruvbox', '暖木', 'Gruvbox'],
  ['dracula', '德古拉', 'Dracula']
]

const COPY = {
  zh: {
    docTitle: 'ColaMD 主题体验',
    subtitle: '主题体验',
    note: '这是网页预览：写的字不会保存，也不会联网。真正的 ColaMD 把文件放在你自己的电脑上。',
    cta: '下载桌面版',
    toggle: 'EN'
  },
  en: {
    docTitle: 'ColaMD themes in the browser',
    subtitle: 'themes, in the browser',
    note: 'This is a web preview: nothing is saved and nothing leaves the page. The real ColaMD keeps your files on your own computer.',
    cta: 'Download for desktop',
    toggle: '中文'
  }
} as const

const THEME_KEY = 'colamd-try-theme'
const LANG_KEY = 'colamd-try-lang'

function initialLang(): Lang {
  const saved = localStorage.getItem(LANG_KEY)
  if (saved === 'zh' || saved === 'en') return saved
  return (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

function initialTheme(): string {
  const saved = localStorage.getItem(THEME_KEY)
  return THEMES.some(([id]) => id === saved) ? (saved as string) : 'elegant'
}

function renderThemeSwitch(lang: Lang, active: string, onPick: (id: string) => void): void {
  const host = document.getElementById('theme-switch') as HTMLElement
  host.textContent = ''
  for (const [id, zh, en] of THEMES) {
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.theme = id
    button.textContent = lang === 'zh' ? zh : en
    button.setAttribute('aria-pressed', String(id === active))
    button.addEventListener('click', () => onPick(id))
    host.append(button)
  }
}

function applyCopy(lang: Lang): void {
  const copy = COPY[lang]
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  document.title = copy.docTitle
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-i18n]'))) {
    const key = el.dataset.i18n as keyof typeof copy
    if (key in copy) el.textContent = copy[key]
  }
  const toggle = document.getElementById('lang-toggle') as HTMLElement
  toggle.textContent = copy.toggle
}

let lang: Lang = initialLang()
let theme = initialTheme()

function setTheme(id: string): void {
  theme = id
  applyTheme(id)
  localStorage.setItem(THEME_KEY, id)
  renderThemeSwitch(lang, theme, setTheme)
}

function setLang(next: Lang): void {
  lang = next
  localStorage.setItem(LANG_KEY, next)
  applyCopy(next)
  renderThemeSwitch(next, theme, setTheme)
  setMarkdown(SAMPLES[next], true)
}

document.getElementById('lang-toggle')?.addEventListener('click', () => {
  setLang(lang === 'zh' ? 'en' : 'zh')
})

applyTheme(theme)
applyCopy(lang)
renderThemeSwitch(lang, theme, setTheme)

async function boot(): Promise<void> {
  await createEditor('editor')
  setMarkdown(SAMPLES[lang], true)
  document.querySelector<HTMLElement>('.ProseMirror')?.focus()
}

void boot()
