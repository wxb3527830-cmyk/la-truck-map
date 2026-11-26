// WKWebView/keyboard geometry is independent of the CSS layout viewport.
export function visibleViewportRect(win) {
  const v = win.visualViewport;
  return {
    top: v?.offsetTop || 0, left: v?.offsetLeft || 0,
    width: v?.width || win.innerWidth, height: v?.height || win.innerHeight,
  };
}

export function isIosInAppBrowser(ua) {
  const ios = /iPhone|iPad|iPod/i.test(ua);
  const embedded = /MicroMessenger|FBAN|FBAV|Instagram|\bLine\/|Twitter|Grok/i.test(ua);
  // iOS webviews usually omit Safari; exclude other full iOS browsers.
  return ios && (embedded || (/AppleWebKit/i.test(ua) && !/Safari|CriOS|FxiOS|EdgiOS|OPiOS/i.test(ua)));
}

export function pinVisibleViewport(map) {
  const shell = document.querySelector('main');
  const get = selector => document.querySelector(selector);
  let frame;
  function update() {
    frame = null;
    const rect = visibleViewportRect(window);
    shell.dataset.compact = String(rect.height <= 480);
    for (const [key, value] of Object.entries(rect)) shell.style.setProperty(`--view-${key}`, `${value}px`);
    // Measure actual wrapping, safe areas and card growth instead of guessing offsets.
    const base = shell.getBoundingClientRect();
    const bottom = selector => {
      const el = get(selector);
      return el.getClientRects().length ? el.getBoundingClientRect().bottom - base.top : 0;
    };
    shell.style.setProperty('--dock-bottom', `${bottom('.search-dock')}px`);
    shell.style.setProperty('--status-bottom', `${bottom('.map-top')}px`);
    const headerBottom = Math.max(bottom('.map-top'), bottom('#inapp-hint'));
    shell.style.setProperty('--header-bottom', `${headerBottom}px`);
    const footer = get('footer').getBoundingClientRect();
    shell.style.setProperty('--footer-height', `${footer.height}px`);
    const card = get('.route-card').getBoundingClientRect();
    shell.style.setProperty('--card-bottom-space', `${base.bottom - card.top}px`);
    // Prevent focus-induced document scrolling without scrolling the map or inner panels.
    if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
    map.invalidateSize({ pan: false, debounceMoveend: true });
  }
  const schedule = () => { if (frame == null) frame = requestAnimationFrame(update); };
  window.visualViewport?.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('scroll', schedule);
  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);
  window.addEventListener('scroll', schedule);
  document.addEventListener('focusin', schedule);
  const observer = new ResizeObserver(schedule);
  for (const selector of ['.search-dock', '.map-top', '#inapp-hint', '.route-card', 'footer']) observer.observe(get(selector));
  update();
}
