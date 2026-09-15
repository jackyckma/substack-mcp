import {test, describe, before, after, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {HttpResponse} from 'msw';
import {setPostTranslationHandler, setPostTranslationSchema} from './set_post_translation.js';
import {createMswServer, DRAFT_DETAIL_RESPONSE} from '../../test/helpers/msw-server.js';
import {setTestEnv} from '../../test/helpers/env.js';

const msw = createMswServer();
let restoreEnv;

before(() => {
  restoreEnv = setTestEnv();
  msw.start();
});
afterEach(() => msw.reset());
after(() => {
  msw.stop();
  restoreEnv();
});

const BODY = {type: 'doc', content: [{type: 'paragraph', content: [{type: 'text', text: '今天值得記載。'}]}]};

describe('setPostTranslationSchema', () => {
  test('requires draft_id, language and body', () => {
    assert.throws(() => setPostTranslationSchema.parse({}), z.ZodError);
    assert.throws(() => setPostTranslationSchema.parse({draft_id: 1}), z.ZodError);
    assert.throws(() => setPostTranslationSchema.parse({draft_id: 1, language: 'zh-hant'}), z.ZodError);
  });

  test('accepts the minimum shape', () => {
    const parsed = setPostTranslationSchema.parse({draft_id: 1, language: 'zh-hant', body: BODY});
    assert.equal(parsed.draft_id, 1);
    assert.equal(parsed.language, 'zh-hant');
  });

  test('rejects an unknown key by name', () => {
    assert.throws(
      () => setPostTranslationSchema.parse({draft_id: 1, language: 'zh-hant', body: BODY, lang: 'x'}),
      (error) => /Unrecognized key/.test(error.message) && /\blang\b/.test(error.message)
    );
  });
});

describe('setPostTranslationHandler', () => {
  test('creates the language slot on first use, then overwrites it with the given content', async () => {
    const result = await setPostTranslationHandler({
      draft_id: 167712345,
      language: 'zh-hant',
      title: '你好',
      body: BODY,
    });

    assert.equal(result.was_new, true);
    assert.equal(result.translations_count, 1);
    assert.deepEqual(result.nodes, {paragraph: 1});

    const creation = msw.requests.find((r) => r.url.endsWith('/translations/zh-hant') && r.method === 'POST');
    assert.ok(creation, 'expected the translation-creation POST to have been sent');
    assert.deepEqual(creation.body, {sourceLanguage: 'en'});

    const write = msw.requests.find((r) => r.method === 'PUT' && r.url.endsWith('/167712345'));
    assert.ok(write, 'expected a PUT to the draft with the merged translations array');
    assert.deepEqual(write.body, {
      translations: [
        {
          post_id: 167712345,
          language: 'zh-hant',
          draft_title: '你好',
          draft_subtitle: 'Its subtitle',
          draft_body: JSON.stringify(BODY),
          from_author: true,
        },
      ],
    });
  });

  test('skips re-creating the slot when the language already has an edition, and preserves other languages', async () => {
    msw.server.use(
      msw.draftDetailHandler(() => HttpResponse.json({
        ...DRAFT_DETAIL_RESPONSE,
        translations: [
          {post_id: 167712345, language: 'zh-hant', draft_title: 'Old', draft_subtitle: '', draft_body: '{}', from_author: true},
          {post_id: 167712345, language: 'ja', draft_title: 'こんにちは', draft_subtitle: '', draft_body: '{}', from_author: true},
        ],
      }, {status: 200}))
    );

    const result = await setPostTranslationHandler({
      draft_id: 167712345,
      language: 'zh-hant',
      title: '新標題',
      body: BODY,
    });

    assert.equal(result.was_new, false);
    assert.equal(result.translations_count, 2);

    const creation = msw.requests.find((r) => r.url.endsWith('/translations/zh-hant') && r.method === 'POST');
    assert.equal(creation, undefined, 'should not re-create a slot that already exists');

    const write = msw.requests.find((r) => r.method === 'PUT' && r.url.endsWith('/167712345'));
    const languages = write.body.translations.map((t) => t.language).sort();
    assert.deepEqual(languages, ['ja', 'zh-hant']);

    const zhEntry = write.body.translations.find((t) => t.language === 'zh-hant');
    assert.equal(zhEntry.draft_title, '新標題');

    const jaEntry = write.body.translations.find((t) => t.language === 'ja');
    assert.equal(jaEntry.draft_title, 'こんにちは', 'the Japanese edition must survive untouched');
  });

  test('falls back to the existing translation title, then the draft title, when title is omitted', async () => {
    msw.server.use(
      msw.draftDetailHandler(() => HttpResponse.json({
        ...DRAFT_DETAIL_RESPONSE,
        draft_title: 'Main title',
        translations: [],
      }, {status: 200}))
    );

    const result = await setPostTranslationHandler({draft_id: 167712345, language: 'zh-hant', body: BODY});
    assert.equal(result.was_new, true);

    const write = msw.requests.find((r) => r.method === 'PUT' && r.url.endsWith('/167712345'));
    assert.equal(write.body.translations[0].draft_title, 'Main title');
  });

  test('rejects a body with an unrecognised node type', async () => {
    await assert.rejects(
      () => setPostTranslationHandler({draft_id: 1, language: 'zh-hant', body: {type: 'doc', content: [{type: 'notARealNode'}]}}),
      z.ZodError
    );
  });
});
