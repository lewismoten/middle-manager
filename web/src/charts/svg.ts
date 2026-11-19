// Small inline-SVG helpers: element builder and linear scales. No chart library (SPEC 2).

export const SVG_NS = 'http://www.w3.org/2000/svg';

type SvgAttrs = Record<string, string | number | null | undefined>;

export function s<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: SvgAttrs = {},
  ...children: (SVGElement | string | null | undefined | false)[]
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== null && v !== undefined) el.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

export interface Scale {
  (v: number): number;
  domain: [number, number];
  range: [number, number];
}

/** Linear scale, clamped to the range. */
export function linear(domain: [number, number], range: [number, number]): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const f = ((v: number) => {
    const t = d1 === d0 ? 0 : (v - d0) / (d1 - d0);
    return r0 + (r1 - r0) * Math.max(0, Math.min(1, t));
  }) as Scale;
  f.domain = domain;
  f.range = range;
  return f;
}

export const fix = (n: number) => Math.round(n * 10) / 10;

export function points(xy: [number, number][]): string {
  return xy.map(([x, y]) => `${fix(x)},${fix(y)}`).join(' ');
}

/** Redraws `draw(width)` into `host` now and whenever its width changes. */
export function responsive(host: HTMLElement, draw: (width: number) => void): void {
  let last = -1;
  const run = () => {
    const w = Math.floor(host.clientWidth);
    if (w > 0 && w !== last) {
      last = w;
      draw(w);
    }
  };
  new ResizeObserver(run).observe(host);
  requestAnimationFrame(run);
}
