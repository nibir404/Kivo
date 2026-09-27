CREATE TABLE profiles (
  id UUID PRIMARY KEY,
  display_name VARCHAR(80) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
