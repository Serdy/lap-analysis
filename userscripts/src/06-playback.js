  function bindHover() {
    const el = document.getElementById(PLOT_ID);
    if (!el) return;
    const compare = isCompare();
    const maxX = compare ? maxLapTime() : (primaryRider().data.length - 1) * DT;

    const inRange = (pos) => pos && pos.x != null && pos.x >= 0 && pos.x <= maxX;

    $(el)
      .off('plothover.srtele')
      .on('plothover.srtele', function (event, pos) {
        // While dragging, the hover position scrubs the playhead itself.
        if (dragging && inRange(pos)) { setSeek(pos.x); return; }
        if (!inRange(pos)) {
          if (playing || hasSeeked) renderPlaybackPos(); // keep the playhead visible
          else hideTransient();
          return;
        }
        // Plain hover = a preview that moves the crosshair + dots + map + legend readout,
        // without moving the playhead. (No floating tooltip — the legend is the readout.)
        if (compare) seekToTime(pos.x);
        else seekTo(pos.x / DT);
      })
      // Click anywhere on the chart sets the playhead; play then starts from there.
      .off('plotclick.srtele')
      .on('plotclick.srtele', function (event, pos) { if (inRange(pos)) setSeek(pos.x); })
      .off('mousedown.srtele')
      .on('mousedown.srtele', function () { dragging = true; })
      .off('mouseleave.srtele')
      .on('mouseleave.srtele', function () {
        if (playing || hasSeeked) renderPlaybackPos(); // snap back to the playhead
        else hideTransient();
      });

    // A drag can end with the mouse released outside the chart, so listen on document.
    $(document).off('mouseup.srtele').on('mouseup.srtele', function () { dragging = false; });
  }

  // --- Playback: animate a dot along the chart (and the map) over the lap time ---
  let playing = false;
  let playIdx = 0;
  let rafId = null;
  let lastTs = null;
  let dragging = false; // scrubbing the playhead by dragging on the chart
  let hasSeeked = false; // a playhead has been set (click/drag/play) -> keep it visible

  function setPlayIcon() {
    const b = document.getElementById('sr-play');
    if (!b) return;
    b.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
    b.title = playing ? 'Pause' : 'Play';
    b.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    b.classList.toggle('is-playing', playing);
  }

  function hideTransient() {
    if (crosshair) crosshair.style.display = 'none';
    playDots.forEach((d) => { d.style.display = 'none'; });
    hideMapDots();
  }

  // SINGLE mode: position crosshair + chart dot + map dot + legend at a FRACTIONAL sample
  // index, interpolating between bracketing samples for smooth playback. Returns tooltip HTML.
  function seekTo(idxFloat) {
    if (!plot || !crosshair || !playDots[0]) return '';
    const rider = primaryRider();
    if (!rider) return '';
    const pts = rider.data;
    const maxIdx = pts.length - 1;
    if (idxFloat < 0) idxFloat = 0;
    if (idxFloat > maxIdx) idxFloat = maxIdx;
    const i0 = Math.floor(idxFloat);
    const i1 = Math.min(i0 + 1, maxIdx);
    const f = idxFloat - i0;
    const a = pts[i0], b = pts[i1];
    const lat = a[0] + (b[0] - a[0]) * f;
    const lng = a[1] + (b[1] - a[1]) * f;
    const spd = a[2] + (b[2] - a[2]) * f;
    const acc = a[4] + (b[4] - a[4]) * f;
    const lean = a[5] + (b[5] - a[5]) * f;
    const t = idxFloat * DT;

    const base = plot.pointOffset({ x: t, y: 0, yaxis: 1 });
    crosshair.style.left = base.left + 'px';
    crosshair.style.display = 'block';

    const sp = plot.pointOffset({ x: t, y: spd * speedMult(), yaxis: 1 });
    playDots[0].style.left = sp.left + 'px';
    playDots[0].style.top = sp.top + 'px';
    playDots[0].style.display = 'block';

    setMapDot(lat, lng, rider.color || '#fa554f');
    setLegendValues(spd, acc, lean);

    return (
      '<div class="sr-tip-time">' + fmtTime(t) + '</div>' +
      row(COLORS.speed, 'Speed', (spd * speedMult()).toFixed(2) + ' ' + speedUnit()) +
      row(COLORS.g, 'Acc/Brk G', (acc / G).toFixed(2)) +
      row(COLORS.lean, 'Lean Angle', lean.toFixed(1))
    );
  }

  // COMPARE mode: place every rider's chart dot + map dot + legend speed at an elapsed TIME.
  // Each rider is sampled at the same time, clamped to its own lap length — so a faster lap's
  // dot pulls ahead on the track and clamps at its finish once that lap ends. Returns tooltip.
  function seekToTime(t) {
    if (!plot || !crosshair) return '';
    const riders = validRiders();
    if (!riders.length) return '';
    const maxT = maxLapTime();
    if (t < 0) t = 0;
    if (t > maxT) t = maxT;

    const base = plot.pointOffset({ x: t, y: 0, yaxis: 1 });
    crosshair.style.left = base.left + 'px';
    crosshair.style.display = 'block';

    const speeds = [];
    let tip = '<div class="sr-tip-time">' + fmtTime(t) + '</div>';
    riders.forEach((rider, i) => {
      const pts = rider.data;
      const last = pts.length - 1;
      let fi = t / DT;
      if (fi > last) fi = last; // shorter lap: clamp at its finish
      const i0 = Math.floor(fi), i1 = Math.min(i0 + 1, last), f = fi - i0;
      const a = pts[i0], b = pts[i1];
      const lat = a[0] + (b[0] - a[0]) * f;
      const lng = a[1] + (b[1] - a[1]) * f;
      const spd = a[2] + (b[2] - a[2]) * f;
      speeds.push(spd);
      const dot = playDots[i];
      if (dot) {
        // chart dot rides this rider's own line, so anchor it at the rider's clamped time.
        const sp = plot.pointOffset({ x: fi * DT, y: spd * speedMult(), yaxis: 1 });
        dot.style.left = sp.left + 'px';
        dot.style.top = sp.top + 'px';
        dot.style.display = 'block';
      }
      setMapDotAt(i, lat, lng, riderColor(i));
      tip += row(riderColor(i), riderLabel(i), (spd * speedMult()).toFixed(0) + ' ' + speedUnit());
    });
    setCompareLegend(speeds);
    return tip;
  }

  function renderPlaybackPos() {
    if (isCompare()) seekToTime(playIdx * DT);
    else seekTo(playIdx);
  }

  // Move the playhead to an elapsed time (s) and render it. Used by click + drag on the
  // chart, so pressing play afterwards resumes from here (and clicking mid-play jumps).
  function setSeek(t) {
    const n = paceRider().data.length;
    let idx = t / DT;
    if (idx < 0) idx = 0;
    if (idx > n - 1) idx = n - 1;
    playIdx = idx;
    hasSeeked = true;
    renderPlaybackPos();
  }

  // Playback is paced in real time. In compare mode it runs against the LONGEST lap so the
  // whole race plays out (the faster rider finishes first and its dot waits at the line).
  function paceRider() {
    if (!isCompare()) return primaryRider();
    return validRiders().reduce((a, b) => (b.data.length > a.data.length ? b : a));
  }

  function frame(ts) {
    if (!playing) return;
    if (!document.getElementById(PLOT_ID)) { stopPlayback(); return; }
    if (lastTs == null) lastTs = ts;
    const dtSec = (ts - lastTs) / 1000;
    lastTs = ts;
    const n = paceRider().data.length;
    playIdx += dtSec / DT; // real-time: advance one sample per 0.1 s elapsed
    if (playIdx >= n - 1) {
      playIdx = n - 1;
      renderPlaybackPos();
      stopPlayback();
      return;
    }
    renderPlaybackPos();
    rafId = window.requestAnimationFrame(frame);
  }

  function startPlayback() {
    if (playing) return;
    hideSiteRiderMarkers(); // re-hide any site dot that appeared after the initial render
    const n = paceRider().data.length;
    if (playIdx >= n - 1) playIdx = 0; // at the very end -> restart from the beginning
    hasSeeked = true; // keep the playhead visible once play has been used
    playing = true;
    lastTs = null;
    setPlayIcon();
    rafId = window.requestAnimationFrame(frame);
  }

  function stopPlayback() {
    playing = false;
    if (rafId) window.cancelAnimationFrame(rafId);
    rafId = null;
    setPlayIcon();
  }

  function togglePlayback() {
    if (playing) stopPlayback();
    else startPlayback();
  }

