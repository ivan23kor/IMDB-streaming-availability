# Country support

Keep `scripts/regions.js` aligned with the public country names and localized search routes in JustWatch's server-rendered `locales` and `hrefLangTags` data at https://www.justwatch.com/us/search?q=the+shawshank+redemption+1994. Include countries with a public search route; an active locale alone does not establish that a search route exists.

The United Kingdom uses the `uk` URL path. Brazil uses `br.justwatch.com`. Keep lookups, saved country preferences, and displayed offers in the same country, including while requests finish out of order.
