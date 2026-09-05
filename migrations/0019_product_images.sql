-- One image per product, same shape as event covers.
CREATE TABLE product_images (
  product_id   INTEGER PRIMARY KEY REFERENCES products(id),
  content_type TEXT    NOT NULL,
  bytes        BLOB    NOT NULL,
  size         INTEGER NOT NULL,
  width        INTEGER NOT NULL,
  height       INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
