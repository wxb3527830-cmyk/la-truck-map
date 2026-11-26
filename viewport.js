export function isIosInAppBrowser(ua) {
  const ios = /iPhone|iPad|iPod/i.test(ua);
  const embedded = /MicroMessenger|FBAN|FBAV|Instagram|\bLine\/|Twitter|Grok/i.test(ua);
  // iOS webviews usually omit Safari; exclude other full iOS browsers.
  return ios && (embedded || (/AppleWebKit/i.test(ua) && !/Safari|CriOS|FxiOS|EdgiOS|OPiOS/i.test(ua)));
}

// CSS owns the shell. Observe only the map container's size, never overlay positions.
export function pinVisibleViewport(map) {
  const container = map.getContainer();
  let { width, height } = container.getBoundingClientRect();
  let frame = null;
  function update() {
    frame = null;
    const next = container.getBoundingClientRect();
    if (Math.abs(next.width - width) <= 2 && Math.abs(next.height - height) <= 2) return;
    width = next.width;
    height = next.height;
    map.invalidateSize({ pan: false, debounceMoveend: true });
  }
  const schedule = () => { if (frame === null) frame = requestAnimationFrame(update); };
  const observer = new ResizeObserver(schedule);
  observer.observe(container);
  // These also support browsers that deliver window resize before observer delivery.
  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);
  return () => {
    observer.disconnect();
    window.removeEventListener('resize', schedule);
    window.removeEventListener('orientationchange', schedule);
    if (frame !== null) cancelAnimationFrame(frame);
  };
}
