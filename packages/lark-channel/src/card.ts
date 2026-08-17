/**
 * Schema 2.0 card builders.
 *
 * Why this file exists:
 * Feishu's card **schema 2.0** dropped support for the legacy `tag: "action"`
 * element (the old container that wrapped a row of buttons). Posting a card
 * with `schema: "2.0"` and an `action` element fails with
 * `ErrCode 200861 / unsupported tag action`.
 *
 * The correct schema-2.0 shape is to put `tag: "button"` elements **directly**
 * in `body.elements` (or inside a `column_set` layout). Every builder below
 * is guaranteed to never emit an `action` element.
 */

export type ButtonType = 'default' | 'primary' | 'danger';

export interface ButtonSpec {
  /** Button label. */
  text: string;
  /** Visual variant. Defaults to `default`. */
  type?: ButtonType;
  /** Callback payload returned in the `cardAction` event. */
  value?: Record<string, unknown>;
  /** Open a URL instead of firing a callback. */
  url?: string;
}

/** A schema-2.0 button element. */
export function button(spec: ButtonSpec): Record<string, unknown> {
  const value = spec.value ?? {};
  const result: Record<string, unknown> = {
    tag: 'button',
    text: { tag: 'plain_text', content: spec.text },
    type: spec.type ?? 'default',
  };
  if (spec.url) {
    result.url = spec.url;
  } else {
    // `value` for legacy callbacks + `behaviors.callback` for schema-2.0.
    result.value = value;
    result.behaviors = [{ type: 'callback', value }];
  }
  return result;
}

export interface MarkdownCardOptions {
  /** Full-width layout. Defaults to `true`. */
  wide?: boolean;
  /** Action buttons rendered as top-level `tag: button` elements. */
  buttons?: ButtonSpec[];
  /** Optional footer note. */
  note?: string;
}

/**
 * A schema-2.0 interactive card with markdown content and optional buttons.
 *
 * Buttons are placed directly in `body.elements` — never wrapped in the
 * unsupported `tag: "action"` container.
 */
export function markdownCard(markdown: string, opts: MarkdownCardOptions = {}): Record<string, unknown> {
  const elements: unknown[] = [{ tag: 'markdown', content: markdown }];

  if (opts.buttons?.length) {
    for (const spec of opts.buttons) elements.push(button(spec));
  }
  if (opts.note) {
    elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: opts.note }] });
  }

  return {
    schema: '2.0',
    config: { wide_screen_mode: opts.wide ?? true },
    body: { elements },
  };
}

export interface StreamingCardOptions {
  /** Initial placeholder text. Defaults to `…`. */
  initial?: string;
  /** Summary shown in chat lists while streaming. */
  summary?: string;
  /** element_id used by the streaming content API. */
  elementId?: string;
}

/**
 * A schema-2.0 card with Feishu's native typewriter streaming mode enabled.
 * Use this together with `channel.stream(to, { card: { initial, producer } })`
 * or the cardkit `cardElement.content` update API.
 */
export function streamingCard(opts: StreamingCardOptions = {}): Record<string, unknown> {
  const elementId = opts.elementId ?? 'stream_md';
  return {
    schema: '2.0',
    config: {
      streaming_mode: true,
      summary: { content: opts.summary ?? '生成中…' },
      streaming_config: {
        print_frequency_ms: { default: 70 },
        print_step: { default: 1 },
        print_strategy: 'fast',
      },
    },
    body: {
      elements: [{ tag: 'markdown', element_id: elementId, content: opts.initial ?? '…' }],
    },
  };
}

/** Returns true when every top-level element is schema-2.0 safe (no `action`). */
export function hasLegacyAction(card: Record<string, unknown>): boolean {
  const body = card.body as { elements?: unknown[] } | undefined;
  return !!body?.elements?.some(
    (el) => typeof el === 'object' && el !== null && (el as { tag?: string }).tag === 'action',
  );
}
