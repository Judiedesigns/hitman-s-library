-- How much of the page each colour actually covers, 0..1.
--
-- The extractor already ranks colours by painted area to decide which ones are
-- worth keeping; it just threw the number away afterwards. Keeping it lets the
-- palette be drawn at the proportions the site uses, which is the difference
-- between a list of nine swatches and a picture of a colour scheme.
--
-- Nullable: a row extracted before this column existed has no share, and the
-- palette falls back to equal bands rather than inventing a number.
ALTER TABLE design_colors ADD COLUMN IF NOT EXISTS area_share REAL;
