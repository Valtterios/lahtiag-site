-- The hosted Checkout page's URL, kept on the pending ticket so a buyer
-- whose phone lost the page can continue the same payment instead of
-- starting another (which the held seat would refuse as sold out).
ALTER TABLE tickets ADD COLUMN checkout_url TEXT;
