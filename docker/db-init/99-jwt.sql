-- Vendored verbatim from supabase/supabase@master:docker/volumes/db/jwt.sql
-- Runs once, inside supabase/postgres's initdb hooks. Do not edit by hand;
-- re-vendor from upstream instead.
\set jwt_secret `echo "$JWT_SECRET"`
\set jwt_exp `echo "$JWT_EXP"`

ALTER DATABASE postgres SET "app.settings.jwt_secret" TO :'jwt_secret';
ALTER DATABASE postgres SET "app.settings.jwt_exp" TO :'jwt_exp';
