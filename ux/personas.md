# Billet CMS personas

Fixture people. The CMS has no sign-in of its own: an editor is a site user in
`cms_identities` (site admins by default), and every editor can do everything.
The sandbox runs a fixture site beside the CMS on one database, as `e2e/` does.

| Persona | Site account | In `cms_identities` | Device | Who they are |
|---|---|---|---|---|
| Priya Shah | priya@example.com | yes | MacBook, 1280 | Owns the Northwind site. Builds pages, fixes mistakes, publishes. |
| Leo Marchetti | leo@example.com | yes | iPhone, 390 | Writes the copy. Edits and previews from a phone between meetings. |
| Ade Mensah | ade@example.com | yes | MacBook, 1280 | The developer. Pulls content into local and preview environments. |
| Zofia Wiśniewska-Kowalczyk | zofia.wisniewska-kowalczyk.design-studio@example.com | yes | iPhone SE, 320 | Long name, long email, non-ASCII. Exists to break layouts. |
| Tom Okafor | tom@example.com | no | Android, 390 | A site user who isn't an editor. Should be turned away politely. |

Fixture site (Northwind Studio), richer than `e2e/`'s one hero block so the
editor has something to show:

- Blocks: `hero` (heading, photo), `text` (rich text), `gallery` (list of
  images, 1–6), `quote` (text, attribution, link), `cta` (heading, link).
- Slots: `home.hero`, `footer.cta`.
- Page types: `landing` (hero first, max 1; then text, gallery, quote, cta)
  and `article` (text required; quote, gallery).
- Content: a published home hero with a draft newer than it; three pages
  (`/about` published, `/work` with three revisions, `/draft-ideas` never
  published); one redirect; six images including one too narrow for the hero,
  one used on two pages and one used nowhere; one live and one revoked
  export token. One page with a 200-character title and emoji.
- Media storage: the in-memory store or a local bucket, so uploads work in a
  bay.
