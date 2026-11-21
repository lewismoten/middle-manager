// Plan gauge: a horizontal meter of the weekly window. Fill = used, lighter band = projected at
// reset, tick = even pace. Values are labelled next to it in text, so color is never the only cue.

import { s } from './svg.ts';

export interface GaugeSpec {
  used: number;
  evenPace: number;
  projected: number;
  label: string;
}

export function gauge(g: GaugeSpec): SVGSVGElement {
  const c = (v: number) => Math.max(0, Math.min(100, v));
  const svg = s('svg', {
    class: 'gauge',
    viewBox: '0 0 100 16',
    preserveAspectRatio: 'none',
    role: 'img',
    'aria-label': g.label,
  });
  svg.append(
    s('rect', { class: 'g-track', x: 0, y: 3, width: 100, height: 10, rx: 2 }),
    s('rect', { class: 'g-proj', x: 0, y: 3, width: c(g.projected), height: 10, rx: 2 }),
    s('rect', { class: 'g-used', x: 0, y: 3, width: c(g.used), height: 10, rx: 2 }),
    s('line', { class: 'g-even', x1: c(g.evenPace), x2: c(g.evenPace), y1: 0, y2: 16 }),
  );
  return svg;
}
