-- Pacing finds the current window by reset time (plan_id, window, resets_at range). With readings
-- every 5 minutes over the 120-day retention, scanning by read_at for that got slow.
CREATE INDEX plan_readings_plan_window_reset ON plan_readings (plan_id, "window", resets_at);
