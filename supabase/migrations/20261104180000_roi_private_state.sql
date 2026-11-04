-- Backend-only ROI state. This migration does not alter existing application data,
-- Storage buckets, Auth users or Storage policies. Create a private bucket separately.
CREATE SCHEMA IF NOT EXISTS roi;

CREATE TABLE IF NOT EXISTS roi.state (
    id smallint PRIMARY KEY CHECK (id = 1),
    bucket text NOT NULL,
    prefix text NOT NULL,
    payload jsonb CHECK (payload IS NULL OR jsonb_typeof(payload) = 'object'),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS roi.images (
    upload_id text PRIMARY KEY,
    source_key text NOT NULL UNIQUE,
    inference_key text NOT NULL UNIQUE,
    source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
    inference_sha256 text NOT NULL CHECK (inference_sha256 ~ '^[a-f0-9]{64}$')
);

-- Also records planned uploads until their manifest commits, covering crash orphans.
CREATE TABLE IF NOT EXISTS roi.delete_outbox (
    object_key text PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE roi.state ENABLE ROW LEVEL SECURITY;
ALTER TABLE roi.images ENABLE ROW LEVEL SECURITY;
ALTER TABLE roi.delete_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON SCHEMA roi FROM PUBLIC;
REVOKE ALL ON roi.state, roi.images, roi.delete_outbox FROM PUBLIC;

-- Roles exist on Supabase; the guard also lets this migration run on plain Postgres.
DO $roi_permissions$
DECLARE application_role text;
BEGIN
    FOREACH application_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = application_role) THEN
            EXECUTE format('REVOKE ALL ON SCHEMA roi FROM %I', application_role);
            EXECUTE format('REVOKE ALL ON roi.state, roi.images, roi.delete_outbox FROM %I', application_role);
        END IF;
    END LOOP;
END
$roi_permissions$;
