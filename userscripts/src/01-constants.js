
  const PANEL_ID = 'sr-tele-panel';
  const PLOT_ID = 'sr-tele-plot';
  const DT = 0.1; // seconds per sample (10 Hz)
  const G = 9.81;

  // Refined "instrument" palette: speed is the warm hero, G a clean emerald, lean a cool azure.
  const COLORS = { speed: '#ff5c52', g: '#46cf86', lean: '#4ea8ff' };
  const AXIS_FONT_FAMILY = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

  // Crisp, optically-centred SVG icons (unicode glyphs render off-centre).
  const ICON_PLAY =
    '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" style="margin-left:1.5px"><path d="M4 2.6 L13 8 L4 13.4 Z"/></svg>';
  const ICON_PAUSE =
    '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><rect x="3.5" y="2.5" width="3" height="11" rx="1"/><rect x="9.5" y="2.5" width="3" height="11" rx="1"/></svg>';

