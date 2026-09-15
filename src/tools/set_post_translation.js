import {z} from "zod";
import SubstackApi from "../api/substack/SubstackApi.js";
import {postBodySchema, summarizeNodes} from "../api/substack/document.js";
import {logger} from "../logger.js";

// Reverse-engineered from the dashboard's own network calls, 2026-09-15 — this endpoint pair has no
// public documentation. Substack's "Additional post languages" editor feature stores every language
// edition of a post as one entry in a `translations` array on the *same* draft object (not a
// separate post): each entry is {post_id, language, draft_title, draft_subtitle, draft_body,
// from_author}. Adding a language in the editor UI always produces an AI-generated translation
// first; this tool exists to write a caller-supplied translation in its place.
export const setPostTranslationSchema = z.strictObject({
  draft_id: z
    .number()
    .int()
    .describe(
      "The numeric id of the draft to add or replace a language edition on, as returned by " +
        "list_posts (`id`) or create_draft_post (`draft_id`)."
    ),
  language: z
    .string()
    .min(1)
    .describe(
      "The Substack language code for this edition, e.g. 'zh-hant' for Traditional Chinese. " +
        "Verified live only for 'zh-hant' — other codes are the editor's own labels and unconfirmed " +
        "against this endpoint."
    ),
  title: z
    .string()
    .optional()
    .describe(
      "Title for this language edition. Omit to keep the existing translation's title if one " +
        "exists, or fall back to the draft's own main title."
    ),
  subtitle: z
    .string()
    .optional()
    .describe(
      "Subtitle for this language edition. Omit to keep the existing translation's subtitle if " +
        "one exists, or fall back to the draft's own main subtitle."
    ),
  // Loose here, not the full document vocabulary: set_post_body is the one tool that publishes it
  // (see that file for why paying for it twice would more than double what every session
  // downloads). The handler below validates the body just as strictly, against the same
  // postBodySchema — it is simply not the schema handed to registerTool, so it does not appear a
  // second time in tools/list.
  body: z.looseObject({}).describe(
    "The body of this language edition, in the same document format as set_post_body — see that " +
      "tool's published schema for the full node vocabulary. This replaces whatever Substack's own " +
      "automatic translation produced — the point of this tool is to supply your own translation " +
      "instead of the AI-generated one. An invalid document is rejected with the same errors " +
      "set_post_body would give."
  ),
  source_language: z
    .string()
    .optional()
    .describe(
      "The language code of the draft's own main content, e.g. 'en'. Only used the first time a " +
        "language edition is created for this draft, to seed Substack's automatic-translation " +
        "step — whose output this tool immediately overwrites. Defaults to 'en'."
    ),
});

// Full validation, body included — used inside the handler, never handed to registerTool. Keeping
// this separate from the schema above is the whole point: the published schema stays cheap, the
// data is still validated exactly as strictly as set_post_body validates it.
const fullSchema = setPostTranslationSchema.extend({body: postBodySchema});

export const setPostTranslationHandler = async (args) => {
  logger.debug('set_post_translation.start', {args});

  let validatedArgs;

  try {
    validatedArgs = fullSchema.parse(args);
  } catch (error) {
    // `issues`, not `errors`: zod 4 renamed it, and reading the old name yields undefined.
    logger.error('set_post_translation.args.invalid', {issues: error.issues ?? error.message});
    throw error;
  }

  const {draft_id, language, title, subtitle, body, source_language = 'en'} = validatedArgs;

  const substack_api = new SubstackApi({
    publication_url: process.env.SUBSTACK_PUBLICATION_URL,
    auth_token: process.env.SUBSTACK_SESSION_TOKEN,
  });

  // Read first: the PUT below writes the whole `translations` array, and an array is replaced
  // wholesale rather than merged by Substack's API — unlike top-level fields, which genuinely merge
  // (see updateDraft). Skipping this read would silently drop any other language edition on the
  // same draft.
  const draft = await substack_api.getDraft(draft_id);
  const existing = Array.isArray(draft?.translations) ? draft.translations : [];
  const existing_entry = existing.find((entry) => entry.language === language);

  if (!existing_entry) {
    // Creates the language slot and seeds it with an AI-generated translation, which the write
    // below immediately overwrites. Whether the PUT below would create a new language entry on its
    // own, with no prior POST, could not be determined without it — this mirrors the dashboard's
    // own two-step flow instead, verified live 2026-09-15.
    logger.info('set_post_translation.creating', {draft_id, language, source_language});
    await substack_api.createDraftTranslation(draft_id, language, {source_language});
  }

  const nodes = summarizeNodes(body);

  const entry = {
    post_id: draft_id,
    language,
    draft_title: title ?? existing_entry?.draft_title ?? draft?.draft_title ?? '',
    draft_subtitle: subtitle ?? existing_entry?.draft_subtitle ?? draft?.draft_subtitle ?? '',
    // JSON.stringify, because draft_body goes on the wire as a string — same as the top-level field
    // set_post_body writes.
    draft_body: JSON.stringify(body),
    from_author: true,
  };

  const translations = [...existing.filter((item) => item.language !== language), entry];

  // Logged before the request, not only after: this replaces a translation outright, and the one it
  // replaces is not recoverable from anywhere in this server.
  logger.info('set_post_translation.writing', {
    draft_id,
    language,
    nodes,
    was_new: !existing_entry,
  });

  await substack_api.updateDraft(draft_id, {translations});

  logger.info('set_post_translation.done', {draft_id, language, nodes});

  return {
    draft_id,
    language,
    nodes,
    was_new: !existing_entry,
    translations_count: translations.length,
  };
};
