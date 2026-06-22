
  function ensureStyles() {
    if (document.getElementById('sr-tele-styles')) return;
    const css =
      '.sr-play-btn{position:absolute;left:12px;top:50%;transform:translateY(-50%);' +
      'width:34px;height:34px;padding:0;border:none;border-radius:50%;-webkit-appearance:none;appearance:none;' +
      'cursor:pointer;color:#fff;display:inline-flex;align-items:center;justify-content:center;' +
      'background:radial-gradient(circle at 50% 32%, #f0514c 0%, #e23b3b 55%, #c22f2b 100%);' +
      'box-shadow:0 2px 7px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.22), inset 0 -2px 4px rgba(0,0,0,.25);' +
      'transition:transform .13s cubic-bezier(.34,1.56,.64,1), box-shadow .15s ease, filter .15s ease;}' +
      '.sr-play-btn, .sr-play-btn:focus, .sr-play-btn:active{outline:none !important;}' +
      '.sr-play-btn:hover{filter:brightness(1.08);transform:translateY(-50%) scale(1.09);' +
      'box-shadow:0 4px 12px rgba(226,59,59,.5), inset 0 1px 0 rgba(255,255,255,.25);}' +
      '.sr-play-btn:active{transform:translateY(-50%) scale(.93);transition-duration:.05s;}' +
      '.sr-play-btn:focus-visible{box-shadow:0 0 0 3px rgba(226,59,59,.45), 0 2px 7px rgba(0,0,0,.5) !important;}' +
      '.sr-play-btn.is-playing{filter:brightness(.96);}' +
      '.sr-play-btn svg{display:block;}' +
      // Stop axis tick labels (e.g. negative lean values "-20","-40","-50") wrapping onto
      // two lines. The label class name varies by Flot build, so target every div in the
      // plot and let it lay out on one line with room to grow.
      '#' + PLOT_ID + ' div:not(.sr-ov){white-space:nowrap !important;width:auto !important;}' +
      // The chart is clickable/draggable to set the playhead.
      '#' + PLOT_ID + '{cursor:pointer;}' +
      // Instrument-panel chrome behind the chart: subtle top-lit gradient + hairline accent.
      '#' + PANEL_ID + '{background:linear-gradient(180deg,#1b1e24 0%,#0d0f13 100%) !important;' +
      'border-top:1px solid rgba(255,255,255,.06);box-shadow:inset 0 1px 0 rgba(255,255,255,.05);}' +
      // Readout legend: uppercase micro-labels + tabular mono values, like an instrument cluster.
      '.sr-leg-chip{display:inline-flex;align-items:center;margin:0 13px;}' +
      '.sr-leg-swatch{display:inline-block;width:16px;height:3px;border-radius:2px;margin-right:8px;}' +
      '.sr-leg-label{font-size:9.5px;letter-spacing:1px;text-transform:uppercase;color:#838c9a;font-weight:600;}' +
      '.sr-leg-val{display:inline-block;margin-left:8px;text-align:left;font-weight:600;' +
      'font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;font-size:11.5px;' +
      'font-family:' + AXIS_FONT_FAMILY + ';}';
    const el = document.createElement('style');
    el.id = 'sr-tele-styles';
    el.textContent = css;
    document.head.appendChild(el);
  }

