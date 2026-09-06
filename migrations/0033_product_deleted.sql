-- Deleting a product that was ever bought hides it from every menu but
-- keeps the row, so purchases keep their line (src/lib/purchases.ts).
ALTER TABLE products ADD COLUMN deleted_at INTEGER;
