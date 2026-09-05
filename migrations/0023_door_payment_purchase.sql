-- A tapped payment can also buy a shop item on the spot.
ALTER TABLE door_payments ADD COLUMN purchase_id TEXT;
