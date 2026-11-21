-- 0004 (slice S4): bookkeeping for runs discovered by collectors.
-- Numbered after the slice so parallel slices do not collide on 0002/0003.
ALTER TABLE runs ADD COLUMN command TEXT;   -- command line of a discovered process or unit
ALTER TABLE runs ADD COLUMN source TEXT;    -- how we know: api, process-scan, systemd-workers (joined with +)
ALTER TABLE runs ADD COLUMN unit TEXT;      -- systemd unit name for worker units
ALTER TABLE runs ADD COLUMN seen_at TEXT;   -- last time a collector saw it alive
CREATE INDEX runs_machine_unit ON runs (machine_id, unit);
