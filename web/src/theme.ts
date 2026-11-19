// Theme: follow the OS by default; the toggle cycles Auto -> Light -> Dark.

export type ThemeChoice = 'auto' | 'light' | 'dark';
const KEY = 'mm.theme';
const ORDER: ThemeChoice[] = ['auto', 'light', 'dark'];
const LABEL: Record<ThemeChoice, string> = { auto: 'Auto', light: 'Light', dark: 'Dark' };
const ICON: Record<ThemeChoice, string> = { auto: '◐', light: '☀', dark: '☾' };

export function currentTheme(): ThemeChoice {
  const t = document.documentElement.getAttribute('data-theme');
  return t === 'light' || t === 'dark' ? t : 'auto';
}

export function applyTheme(choice: ThemeChoice): void {
  if (choice === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', choice);
  try {
    if (choice === 'auto') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    /* storage unavailable */
  }
}

export function setupThemeToggle(button: HTMLButtonElement): void {
  const render = () => {
    const t = currentTheme();
    const next = ORDER[(ORDER.indexOf(t) + 1) % ORDER.length] as ThemeChoice;
    button.replaceChildren();
    const icon = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = ICON[t];
    button.append(icon, ` ${LABEL[t]}`);
    const desc = t === 'auto' ? 'follows your system' : LABEL[t].toLowerCase();
    button.setAttribute('aria-label', `Theme: ${desc}. Switch to ${LABEL[next]}`);
    button.title = `Theme: ${desc}`;
  };
  button.addEventListener('click', () => {
    const t = currentTheme();
    applyTheme(ORDER[(ORDER.indexOf(t) + 1) % ORDER.length] as ThemeChoice);
    render();
  });
  render();
}
