import { HttpError } from './app.ts';

/** A null rule accepts free text. Every filter takes one value. */
export function checkQuery(
  q: URLSearchParams,
  rules: Record<string, readonly string[] | null>,
  code = 'invalid_input',
) {
  const seen = new Set<string>();
  for (const [key, value] of q) {
    if (!Object.hasOwn(rules, key))
      throw new HttpError(400, code, 'Unknown query parameter: ' + key);
    if (seen.has(key)) throw new HttpError(400, code, 'Repeated query parameter: ' + key);
    seen.add(key);
    const allowed = rules[key];
    if (allowed && !allowed.includes(value))
      throw new HttpError(400, code, key + ' must be one of: ' + allowed.join(', '));
  }
}
