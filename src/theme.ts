export type ThemePreference = 'auto' | 'light' | 'dark';

/** Auto follows the operating system; the other two override it. */
export const themes: readonly ThemePreference[] = ['auto', 'light', 'dark'];

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'auto' || value === 'light' || value === 'dark';
}

export function nextTheme(current: ThemePreference): ThemePreference {
  const index = themes.indexOf(current);
  return themes[(index + 1) % themes.length] ?? 'auto';
}

const labels: Record<ThemePreference, string> = { auto: 'Auto', light: 'Light', dark: 'Dark' };

export function themeLabel(preference: ThemePreference): string {
  return labels[preference];
}
