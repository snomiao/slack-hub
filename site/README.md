# slack-hub.pages.dev

The landing page. Static files, no build step. Deployed by
`.github/workflows/pages.yml` on every push to main that touches `site/` (or run
it by hand: Actions → Pages → Run workflow). By hand (Cloudflare Pages, direct upload):

    bunx wrangler@4.105.0 pages deploy site --project-name slack-hub --branch main

The old https://slack-term.pages.dev is a separate Pages project holding only a
`_redirects` (`/* https://slack-hub.pages.dev/:splat 301`); the same workflow
redeploys it.

`icon.svg` is the source of the icon; `icon.png` is its 512 px export.
