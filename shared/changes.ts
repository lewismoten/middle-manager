interface ChangeList<T> {
  total: number;
  items: T[];
}

export interface Changes {
  now: string;
  runs: ChangeList<{ id: number; status: string; ended_at: string }>;
  cards: ChangeList<{ id: number; title: string; moved_at: string }>;
  jobs: ChangeList<{ id: number; name: string; failing_since: string }>;
  plans: ChangeList<{
    id: string;
    name: string;
    window: string;
    previous_pct: number;
    used_pct: number;
  }>;
}
