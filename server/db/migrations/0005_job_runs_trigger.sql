-- 0005 (slice S5): who or what started each job run.
-- Numbered after the slice so parallel slices do not collide.
ALTER TABLE job_runs ADD COLUMN trigger TEXT;  -- schedule | manual
ALTER TABLE job_runs ADD COLUMN actor TEXT;    -- token name for manual runs
CREATE INDEX job_runs_open ON job_runs (ended_at) WHERE ended_at IS NULL;
