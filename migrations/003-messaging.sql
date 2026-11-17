-- MineTech v2 messaging and scheduling tables (SQLite). Check-ins, people and
-- messages stay audited entities; these tables hold what scheduling and
-- provider lookups need. Same workspace scoping as 001.
CREATE TABLE IF NOT EXISTS escalation_steps (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), checkin_id TEXT NOT NULL REFERENCES entities(id), step TEXT NOT NULL CHECK(step IN ('reminder','overdue','supervisor')), due_at TEXT NOT NULL, claimed_until TEXT, executed_at TEXT, cancelled_at TEXT, outcome TEXT, idempotency_key TEXT NOT NULL UNIQUE);
CREATE INDEX IF NOT EXISTS escalation_due ON escalation_steps(due_at) WHERE executed_at IS NULL AND cancelled_at IS NULL;
CREATE INDEX IF NOT EXISTS escalation_checkin ON escalation_steps(workspace_id,checkin_id);
CREATE TABLE IF NOT EXISTS provider_messages (provider TEXT NOT NULL, provider_message_id TEXT NOT NULL, direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')), workspace_id TEXT NOT NULL REFERENCES workspaces(id), message_id TEXT NOT NULL REFERENCES entities(id), recorded_at TEXT NOT NULL, PRIMARY KEY(provider,provider_message_id,direction));
CREATE TABLE IF NOT EXISTS contact_index (workspace_id TEXT NOT NULL REFERENCES workspaces(id), phone_hash TEXT NOT NULL, person_id TEXT NOT NULL REFERENCES entities(id), PRIMARY KEY(workspace_id,phone_hash));
CREATE TABLE IF NOT EXISTS conversations (workspace_id TEXT NOT NULL REFERENCES workspaces(id), phone_hash TEXT NOT NULL, channel TEXT NOT NULL, state_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(workspace_id,phone_hash,channel));
CREATE TABLE IF NOT EXISTS messaging_channels (provider TEXT NOT NULL, channel_key TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id), created_at TEXT NOT NULL, PRIMARY KEY(provider,channel_key));
CREATE TABLE IF NOT EXISTS message_queue (message_id TEXT PRIMARY KEY REFERENCES entities(id), idempotency_key TEXT NOT NULL UNIQUE, workspace_id TEXT NOT NULL REFERENCES workspaces(id), due_at TEXT NOT NULL, claimed_until TEXT, attempts INTEGER NOT NULL DEFAULT 0, sent_at TEXT, receipt_deadline TEXT, settled_at TEXT);
CREATE INDEX IF NOT EXISTS message_queue_due ON message_queue(due_at) WHERE sent_at IS NULL;
CREATE TABLE IF NOT EXISTS service_heartbeats (service TEXT PRIMARY KEY, beat_at TEXT NOT NULL, detail TEXT NOT NULL);
INSERT OR IGNORE INTO schema_migrations VALUES(3,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
