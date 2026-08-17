import { test } from 'node:test';
import assert from 'node:assert/strict';
import { button, markdownCard, streamingCard, hasLegacyAction } from '../src/card.ts';

test('markdownCard is schema 2.0 with no legacy action element', () => {
  const card = markdownCard('hello **world**', {
    buttons: [{ text: '点我', type: 'primary', value: { act: 'click' } }],
    note: 'footer',
  });

  assert.equal(card.schema, '2.0');
  assert.equal(hasLegacyAction(card), false, 'must not contain tag: action');

  const elements = (card.body as { elements: unknown[] }).elements;
  // First element is the markdown body.
  assert.equal((elements[0] as { tag: string }).tag, 'markdown');
  // Buttons are top-level `tag: button` elements (schema-2.0 style).
  assert.equal((elements[1] as { tag: string }).tag, 'button');
  assert.equal((elements[1] as { type: string }).type, 'primary');
  assert.deepEqual((elements[1] as { value: unknown }).value, { act: 'click' });
  assert.equal((elements[2] as { tag: string }).tag, 'note');
});

test('streamingCard enables native typewriter streaming on schema 2.0', () => {
  const card = streamingCard();
  assert.equal(card.schema, '2.0');
  assert.equal(hasLegacyAction(card), false);
  const cfg = card.config as { streaming_mode: boolean };
  assert.equal(cfg.streaming_mode, true);
});

test('button without url always carries a value payload', () => {
  const b = button({ text: 'ok' });
  assert.equal(b.tag, 'button');
  assert.deepEqual(b.value, {});
});

test('button includes schema-2.0 behaviors.callback for legacy value', () => {
  const b = button({ text: 'stop', value: { action: 'stop' } });
  assert.deepEqual(b.value, { action: 'stop' });
  assert.deepEqual(b.behaviors, [{ type: 'callback', value: { action: 'stop' } }]);
});

test('url button uses url instead of value/behaviors', () => {
  const b = button({ text: 'go', url: 'https://example.com' });
  assert.equal(b.url, 'https://example.com');
  assert.equal(b.value, undefined);
  assert.equal(b.behaviors, undefined);
});

test('hasLegacyAction detects a broken action element', () => {
  const broken = {
    schema: '2.0',
    body: { elements: [{ tag: 'div' }, { tag: 'action', actions: [] }] },
  };
  assert.equal(hasLegacyAction(broken), true);
});
