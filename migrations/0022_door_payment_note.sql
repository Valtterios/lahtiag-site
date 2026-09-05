-- What the board typed as the description in the Stripe app (usually the buyer's name).
ALTER TABLE door_payments ADD COLUMN note TEXT;
