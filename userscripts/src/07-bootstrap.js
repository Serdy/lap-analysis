  function render() {
    if (!ready()) return;
    if (window.SRSRCNG.currentlyViewing && window.SRSRCNG.currentlyViewing !== 'map') return;
    // In compare mode keep the site's two per-rider traces; only colour the trace solo.
    if (!isCompare()) renderTrackColour();
    hideSiteSpeedChart();
    hidePlaybackControls();
    hideSiteRiderMarkers();
    if (!ensurePanel()) return;
    applyLayout();
    if (draw()) {
      ensureOverlays();
      bindHover();
      if (isCompare()) {
        seedCompareLegend(); // seed each rider's readout
        renderCompareEvents(); // render braking-onset + corner markers
      } else {
        updateLegend(0);
      }
    }
  }

  // Flot doesn't auto-resize our chart; redraw + re-bind on resize.
  let resizeId = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeId);
    resizeId = setTimeout(() => {
      if (!document.getElementById(PLOT_ID)) return;
      applyLayout();
      if (draw()) {
        ensureOverlays();
        bindHover();
      }
    }, 150);
  });

  // The map pane is swapped in via jQuery .html(); re-inject when our panel is gone
  // but the speed chart is present.
  const obs = new MutationObserver(() => {
    if (!document.getElementById(PANEL_ID) && mapPaneReady()) render();
  });
  obs.observe(document.body, { childList: true, subtree: true });

  // Poll until BOTH the chart and the track overlay are up. The map (window.SRSRCNG.map)
  // can initialise after our chart, so we keep retrying the track colour until it exists
  // instead of assuming a load order.
  let tries = 0;
  const poll = setInterval(() => {
    tries += 1;
    // single mode also waits for the accel trace; compare mode has no overlay.
    const chartUp = document.getElementById(PLOT_ID) && (isCompare() || trackLayer);
    if (chartUp || tries > 60) {
      clearInterval(poll);
      return;
    }
    render();
  }, 250);
})();
