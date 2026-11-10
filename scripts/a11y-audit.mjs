/**
 * A small, dependency-free accessibility audit that runs inside the popup page.
 *
 * It is deliberately conservative: it checks programmatically provable facts
 * (names, labels, references, heading order, duplicate IDs and text contrast)
 * and returns findings instead of throwing. Callers assert that findings is
 * empty. The function must stay self-contained because the installed-extension
 * suite serializes it through CDP.
 */
export function auditAccessibility() {
  const findings = [];
  const normalize = text => (text || '').replace(/\s+/g, ' ').trim();
  const isVisible = element => {
    if (!element || element.hidden) return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const labelFor = element => {
    if (!element.id) return '';
    const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(element.id) : element.id;
    const label = document.querySelector(`label[for="${escaped}"]`);
    return normalize(label?.textContent);
  };
  const accessibleName = element => {
    const aria = normalize(element.getAttribute('aria-label'));
    if (aria) return aria;
    const labelledby = normalize(element.getAttribute('aria-labelledby'));
    if (labelledby) {
      const text = labelledby.split(/\s+/)
        .map(id => normalize(document.getElementById(id)?.textContent)).filter(Boolean).join(' ');
      if (text) return text;
    }
    const tag = element.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
      const label = labelFor(element);
      if (label) return label;
      const wrapping = element.closest('label');
      if (wrapping && normalize(wrapping.textContent)) return normalize(wrapping.textContent);
      if (tag === 'INPUT' && ['button', 'submit', 'reset'].includes(element.type)) return normalize(element.value);
      return normalize(element.getAttribute('title'));
    }
    if (tag === 'IMG') return normalize(element.getAttribute('alt'));
    return normalize(element.textContent);
  };
  const describe = element => `<${element.tagName.toLowerCase()}` +
    `${element.id ? ` id="${element.id}"` : ''}>`;

  const ids = new Map();
  for (const element of document.querySelectorAll('[id]')) {
    ids.set(element.id, (ids.get(element.id) || 0) + 1);
  }
  for (const [id, count] of ids) {
    if (count > 1) findings.push(`Duplicate id "${id}" appears ${count} times`);
  }

  for (const element of document.querySelectorAll('[aria-labelledby], [aria-describedby], [aria-controls]')) {
    for (const attribute of ['aria-labelledby', 'aria-describedby', 'aria-controls']) {
      const value = element.getAttribute(attribute);
      if (!value) continue;
      for (const id of value.split(/\s+/)) {
        if (!document.getElementById(id)) findings.push(`${describe(element)} references missing ${attribute} target "${id}"`);
      }
    }
  }

  if (!normalize(document.documentElement.lang)) findings.push('The document has no lang attribute');

  for (const image of document.querySelectorAll('img')) {
    if (!image.hasAttribute('alt')) findings.push(`${describe(image)} has no alt attribute`);
  }

  const controls = [...document.querySelectorAll(
    'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])',
  )].filter(isVisible);
  for (const control of controls) {
    if (!accessibleName(control)) findings.push(`${describe(control)} has no accessible name`);
    const tabindex = control.getAttribute('tabindex');
    if (tabindex !== null && Number(tabindex) > 0) findings.push(`${describe(control)} has a positive tabindex`);
    if (control.tagName === 'BUTTON' && !control.hasAttribute('type')) {
      findings.push(`${describe(control)} has no explicit button type`);
    }
  }

  const headings = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].filter(isVisible);
  if (!headings.some(heading => heading.tagName === 'H1')) findings.push('No visible h1 heading');
  let previousLevel = 0;
  for (const heading of headings) {
    const level = Number(heading.tagName.slice(1));
    if (previousLevel && level > previousLevel + 1) {
      findings.push(`${describe(heading)} skips from h${previousLevel} to h${level}`);
    }
    previousLevel = level;
  }

  for (const region of document.querySelectorAll('[aria-live]')) {
    const value = region.getAttribute('aria-live');
    if (!['off', 'polite', 'assertive'].includes(value)) {
      findings.push(`${describe(region)} has invalid aria-live="${value}"`);
    }
  }

  const parseColor = value => {
    const match = /^rgba?\(([^)]+)\)$/.exec((value || '').trim());
    if (!match) return null;
    const parts = match[1].split(',').map(part => Number(part.trim()));
    if (parts.length < 3 || parts.slice(0, 3).some(part => !Number.isFinite(part))) return null;
    return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
  };
  const composite = (foreground, background) => {
    const alpha = foreground[3] + background[3] * (1 - foreground[3]);
    if (alpha === 0) return [255, 255, 255, 1];
    return [
      (foreground[0] * foreground[3] + background[0] * background[3] * (1 - foreground[3])) / alpha,
      (foreground[1] * foreground[3] + background[1] * background[3] * (1 - foreground[3])) / alpha,
      (foreground[2] * foreground[3] + background[2] * background[3] * (1 - foreground[3])) / alpha,
      alpha,
    ];
  };
  const luminance = color => {
    const channel = value => {
      const normalized = value / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(color[0]) + 0.7152 * channel(color[1]) + 0.0722 * channel(color[2]);
  };
  const contrast = (first, second) => {
    const lighter = Math.max(luminance(first), luminance(second));
    const darker = Math.min(luminance(first), luminance(second));
    return (lighter + 0.05) / (darker + 0.05);
  };
  const backgroundColor = element => {
    const layers = [];
    for (let node = element; node; node = node.parentElement) {
      const color = parseColor(getComputedStyle(node).backgroundColor);
      if (color && color[3] > 0) {
        layers.push(color);
        if (color[3] >= 1) break;
      }
    }
    let background = [255, 255, 255, 1];
    for (let index = layers.length - 1; index >= 0; index--) background = composite(layers[index], background);
    return background;
  };
  const contrastTargets = [...document.querySelectorAll(
    'h1, h2, p, label, button, select, input, footer, .song, .artist, .counts, .positions, #playlist-name',
  )].filter(isVisible);
  let checkedContrast = 0;
  for (const element of contrastTargets) {
    const style = getComputedStyle(element);
    const foreground = parseColor(style.color);
    if (!foreground) continue;
    const background = backgroundColor(element);
    const effectiveForeground = foreground[3] < 1 ? composite(foreground, background) : foreground;
    const size = Number.parseFloat(style.fontSize);
    const weight = Number.parseInt(style.fontWeight, 10) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const required = large ? 3 : 4.5;
    const ratio = contrast(effectiveForeground, background);
    checkedContrast++;
    if (ratio + 0.01 < required) {
      findings.push(`${describe(element)} has ${ratio.toFixed(2)}:1 text contrast; needs ${required}:1`);
    }
  }

  return { findings, checkedControls: controls.length, checkedHeadings: headings.length, checkedContrast };
}
