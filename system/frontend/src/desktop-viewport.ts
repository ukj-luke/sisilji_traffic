// 데스크톱 핀치 확대에서는 CSS 뷰포트가 그대로이고 실제로 보이는 영역만 이동합니다.
export function followDesktopViewport() {
  const viewport = window.visualViewport
  const root = document.getElementById('root')
  if (!viewport || !root) return

  const pointer = window.matchMedia('(hover: hover) and (pointer: fine)')
  let frame = 0
  const sync = () => {
    frame = 0
    const active =
      pointer.matches && viewport.scale > 1.001 && !document.fullscreenElement
    if (!active && !root.hasAttribute('data-visual-viewport')) return
    root.toggleAttribute('data-visual-viewport', active)
    const values = {
      '--view-width': viewport.width,
      '--view-height': viewport.height,
      '--view-left': viewport.offsetLeft,
      '--view-top': viewport.offsetTop,
    }
    for (const [key, value] of Object.entries(values)) {
      if (!active) root.style.removeProperty(key)
      else if (root.style.getPropertyValue(key) !== value + 'px')
        root.style.setProperty(key, value + 'px')
    }
  }
  function schedule() {
    if (!frame) frame = requestAnimationFrame(sync)
  }
  sync()
  viewport.addEventListener('resize', schedule)
  viewport.addEventListener('scroll', schedule)
  window.addEventListener('resize', schedule)
  pointer.addEventListener('change', schedule)
  document.addEventListener('fullscreenchange', schedule)
  return () => {
    cancelAnimationFrame(frame)
    viewport.removeEventListener('resize', schedule)
    viewport.removeEventListener('scroll', schedule)
    window.removeEventListener('resize', schedule)
    pointer.removeEventListener('change', schedule)
    document.removeEventListener('fullscreenchange', schedule)
    root.removeAttribute('data-visual-viewport')
    for (const key of ['width', 'height', 'left', 'top'])
      root.style.removeProperty('--view-' + key)
  }
}
