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

  // --- Independent srEvents (braking triangles + corner chips) bootstrap ---
  //
  // Why this exists: the site sometimes serves ITS OWN older copy of this exact
  // userscript (bundled as plugins-serdiuk-analysis.min.js) that builds #sr-tele-panel
  // + the plot before ours runs. When that happens, `chartUp` above is already true on
  // the very first poll tick, so the poll clears without ever calling render() — and
  // since render() is the only place that calls renderCompareEvents(), the srEvents
  // overlay silently never appears even though we're loaded and running.
  //
  // renderCompareEvents() (05-map.js) is fully self-contained: it only needs isCompare()
  // + window.SRSRCNG.map + window.L, owns its own pane or events, and is idempotent
  // (map-instance guard bails out if already built for the current map). So instead of
  // fighting the foreign copy for the chart panel — which would double up MainLoop /
  // handlers / DOM — we give the overlay its OWN poll + observer that never checks
  // PANEL_ID/PLOT_ID at all, and never calls the chart's render()/draw().
  let eventsTries = 0;
  const eventsPoll = setInterval(() => {
    eventsTries += 1;
    const eventsUp = isCompare() && window.SRSRCNG && window.SRSRCNG.map && window.L;
    if (eventsUp) renderCompareEvents();
    // Keep polling even after success: the map can be replaced (pane .html() swap)
    // after our first render, and renderCompareEvents()'s own map-instance guard makes
    // repeat calls a cheap no-op when nothing changed.
    if (eventsTries > 60) clearInterval(eventsPoll);
  }, 250);

  // Re-run on map-pane swaps regardless of who owns #sr-tele-panel/the plot — this is
  // deliberately a SEPARATE branch from the render() rebuild above (which only fires
  // when our panel is missing) so it also fires when a foreign copy's panel is present.
  const eventsObs = new MutationObserver(() => {
    if (isCompare() && mapPaneReady()) renderCompareEvents();
  });
  eventsObs.observe(document.body, { childList: true, subtree: true });
})();
