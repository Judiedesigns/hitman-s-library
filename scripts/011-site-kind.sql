-- What kind of site each source is — the axis the library is browsed on.
--
-- It replaced `industry`, which recorded what business a site's customer was in.
-- That answered a question nobody browsing a design library was asking, and it
-- answered it badly: 104 of 279 sources were filed as "SaaS" and another 105 as
-- some flavour of uncategorised, so three quarters of the shelf sat in two
-- buckets that told you nothing. hex.inc, a brand and product studio, was filed
-- under E-commerce.
--
-- `industry` is deliberately left in place. Nothing reads it any more, but it is
-- the only record of how a source was originally filed.
--
-- NULL is not an error. A newly added source has no kind until someone files it,
-- and the gallery shows those under "Unsorted", which sorts last.
ALTER TABLE design_sources ADD COLUMN IF NOT EXISTS kind TEXT;

CREATE INDEX IF NOT EXISTS design_sources_kind_idx ON design_sources (kind);
