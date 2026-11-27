-- Domain records live outside Supabase's exposed public schema. Only the
-- server-side PostgreSQL role may access them; no browser database key is used.
CREATE SCHEMA IF NOT EXISTS foresight;
REVOKE ALL ON SCHEMA foresight FROM PUBLIC;
CREATE TABLE IF NOT EXISTS foresight.schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS foresight.workspaces (id TEXT PRIMARY KEY, site_id TEXT NOT NULL, name TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('demonstration','development','private','legacy')), created_at TEXT NOT NULL, expires_at TEXT);
CREATE TABLE IF NOT EXISTS foresight.memberships (workspace_id TEXT NOT NULL REFERENCES foresight.workspaces(id), user_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('viewer','reporter','supervisor','administrator')), PRIMARY KEY(workspace_id,user_id));
CREATE INDEX IF NOT EXISTS membership_user ON foresight.memberships(user_id);
CREATE TABLE IF NOT EXISTS foresight.entities (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES foresight.workspaces(id), kind TEXT NOT NULL, zone_id TEXT, revision INTEGER NOT NULL CHECK(revision>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL CHECK(jsonb_typeof(payload::jsonb)='object'), sequence BIGINT GENERATED ALWAYS AS IDENTITY, UNIQUE(workspace_id,id));
CREATE INDEX IF NOT EXISTS entity_scope ON foresight.entities(workspace_id,kind,created_at);
CREATE TABLE IF NOT EXISTS foresight.entity_links (workspace_id TEXT NOT NULL, source_id TEXT NOT NULL, target_id TEXT NOT NULL, relation TEXT NOT NULL, PRIMARY KEY(workspace_id,source_id,target_id,relation), FOREIGN KEY(workspace_id,source_id) REFERENCES foresight.entities(workspace_id,id), FOREIGN KEY(workspace_id,target_id) REFERENCES foresight.entities(workspace_id,id));
CREATE TABLE IF NOT EXISTS foresight.audit_events (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES foresight.workspaces(id), entity_id TEXT REFERENCES foresight.entities(id), actor TEXT NOT NULL, operation TEXT NOT NULL, server_at TEXT NOT NULL, before_json TEXT, after_json TEXT, sequence BIGINT GENERATED ALWAYS AS IDENTITY);
CREATE TABLE IF NOT EXISTS foresight.idempotency (workspace_id TEXT NOT NULL REFERENCES foresight.workspaces(id), key TEXT NOT NULL, input_hash TEXT NOT NULL, result_json TEXT NOT NULL, PRIMARY KEY(workspace_id,key));
CREATE TABLE IF NOT EXISTS foresight.usage (workspace_id TEXT NOT NULL REFERENCES foresight.workspaces(id), day TEXT NOT NULL, category TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(workspace_id,day,category));
CREATE OR REPLACE FUNCTION foresight.reject_audit_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Audit events are append-only'; END; $$;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='audit_append_only' AND tgrelid='foresight.audit_events'::regclass) THEN
    CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON foresight.audit_events FOR EACH ROW EXECUTE FUNCTION foresight.reject_audit_change();
  END IF;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA foresight FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA foresight FROM PUBLIC;
INSERT INTO foresight.schema_migrations VALUES(1,to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ON CONFLICT(version) DO NOTHING;
