// Measures the pixel coordinates of the caret inside a textarea by rendering
// a hidden mirror DIV with the same content + computed styles, terminating at
// the caret with a marker span. The marker's offset is the caret's offset.
//
// Based on the well-known textarea-caret-position trick. The list of style
// properties below is the minimum that affects glyph layout — font, padding,
// border, sizing, and the few quirky bits like `tab-size` and `direction`.
// Don't add unrelated styles (e.g. `color`); irrelevant copying just bloats
// the temporary DOM.

const STYLE_PROPS = [
  'direction',
  'boxSizing',
  'width',
  'height',
  'overflowX',
  'overflowY',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'borderStyle',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch',
  'fontSize', 'fontSizeAdjust', 'lineHeight', 'fontFamily',
  'textAlign', 'textTransform', 'textIndent', 'textDecoration',
  'letterSpacing', 'wordSpacing',
  'tabSize',
  'whiteSpace',
] as const;

export interface CaretCoordinates {
  /** Caret x relative to the textarea's content box (i.e. inside its padding). */
  left: number;
  /** Caret y of the *top* of the line containing the caret. */
  top: number;
  /** Line-box height in CSS pixels (= line-height). */
  height: number;
}

export function getCaretCoordinates(
  el: HTMLTextAreaElement,
  position: number,
): CaretCoordinates {
  const doc = el.ownerDocument;
  const win = doc.defaultView ?? window;

  const mirror = doc.createElement('div');
  mirror.id = 'helix-caret-mirror';
  const style = mirror.style;

  // Take the textarea offscreen but keep it in-flow so width / borders measure
  // the same as the original. Visibility hidden (not display:none) is required
  // for layout to actually happen.
  style.whiteSpace = 'pre-wrap';
  style.wordWrap = 'break-word';
  style.position = 'absolute';
  style.visibility = 'hidden';
  style.top = '0';
  style.left = '-9999px';

  const computed = win.getComputedStyle(el);
  for (const prop of STYLE_PROPS) {
    // Some props are read-only in CSSStyleDeclaration's typed surface; cast to
    // any to assign. Setting an empty value (computed returns "") is a no-op.
    (style as unknown as Record<string, string>)[prop] = computed[prop as never] as unknown as string;
  }

  // Firefox keeps overflowX/Y as 'visible' on a textarea — but it scrolls the
  // contents anyway. Use 'auto' to match what the user actually sees.
  if (style.overflowX === 'visible') style.overflowX = 'auto';
  if (style.overflowY === 'visible') style.overflowY = 'auto';

  mirror.textContent = el.value.substring(0, position);

  // The marker is what we measure. Use a zero-width-joiner inside so the span
  // has a non-zero height even at the start of an empty line.
  const marker = doc.createElement('span');
  marker.textContent = el.value.substring(position) || '.';
  mirror.appendChild(marker);

  doc.body.appendChild(mirror);
  const coords: CaretCoordinates = {
    left: marker.offsetLeft + parseInt(computed.borderLeftWidth, 10),
    top: marker.offsetTop + parseInt(computed.borderTopWidth, 10),
    height: parseInt(computed.lineHeight, 10) || parseInt(computed.fontSize, 10) * 1.4,
  };
  doc.body.removeChild(mirror);
  return coords;
}
