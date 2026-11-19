// The nine pages from SPEC section 8. Until a slice ships, each page shows what will appear
// there and which slice brings it.

export type Skeleton =
  'gauges' | 'chart' | 'columns' | 'table' | 'bars' | 'list' | 'cards' | 'split';

export interface Coming {
  text: string;
  slice: string;
}

export interface Tab {
  id: string;
  label: string;
  title: string;
  lead: string;
  coming: Coming[];
  skeleton: Skeleton;
}

export const SLICES: Record<string, string> = {
  S1: 'foundation',
  S2: 'plans & burndown',
  S3: 'board',
  S4: 'agents',
  S5: 'schedules',
  S6: 'notes & connections',
  S7: 'polish',
  later: 'a later slice',
};

export const TABS: Tab[] = [
  {
    id: 'overview',
    label: 'Overview',
    title: 'Overview',
    lead: 'One screen that answers: are the plans on pace, who is working, and does anything need a person?',
    skeleton: 'gauges',
    coming: [
      {
        text: 'A gauge per plan: used, even pace, projection, mode and reset countdown',
        slice: 'S2',
      },
      { text: 'Board counts by status', slice: 'S3' },
      { text: 'Agents running now, by machine and model', slice: 'S4' },
      { text: 'Jobs that failed in the last 24 hours', slice: 'S5' },
    ],
  },
  {
    id: 'burndown',
    label: 'Burndown',
    title: 'Burndown',
    lead: 'Whether each subscription will run out at the right time, and which model rung to use.',
    skeleton: 'chart',
    coming: [
      {
        text: 'Weekly chart per plan: readings, even-pace line, projection and "now"',
        slice: 'S2',
      },
      { text: 'The 5-hour window when the plan reports one', slice: 'S2' },
      { text: 'Past weeks: how much was left unused at each reset', slice: 'S2' },
      {
        text: 'Pacing table with mode (burn, steady, conserve, stop) and suggested model',
        slice: 'S2',
      },
    ],
  },
  {
    id: 'board',
    label: 'Board',
    title: 'Board',
    lead: 'The work as kanban cards, with history, linked runs and branches.',
    skeleton: 'columns',
    coming: [
      { text: 'Columns by status with project and assignee filters', slice: 'S3' },
      { text: 'Card detail in a side sheet: body, events, runs, branch, PR', slice: 'S3' },
      { text: 'Cards imported from Hermes kanban boards (read-only)', slice: 'S3' },
      { text: 'Sprint and Velocity views', slice: 'S3' },
    ],
  },
  {
    id: 'agents',
    label: 'Agents',
    title: 'Agents',
    lead: 'Every agent run on every machine: who started it, on which model, for which task.',
    skeleton: 'table',
    coming: [
      {
        text: 'Runs active now, grouped by machine, sub-agents indented under their parent',
        slice: 'S4',
      },
      {
        text: 'Model, tokens in/out/cache, task, prompt, live duration, branch and worktree',
        slice: 'S4',
      },
      { text: 'Filters: machine, model, project, role, finished in the last N hours', slice: 'S4' },
      { text: 'Copy-paste curl calls for agents to report themselves', slice: 'S4' },
    ],
  },
  {
    id: 'usage',
    label: 'Usage',
    title: 'Usage',
    lead: 'Where the tokens went, by plan, model, hour and day.',
    skeleton: 'bars',
    coming: [
      { text: 'Tokens per hour and per day, stacked by plan and model', slice: 'S7' },
      { text: 'Runs per day', slice: 'S7' },
      { text: 'Cost notes', slice: 'S7' },
    ],
  },
  {
    id: 'schedules',
    label: 'Schedules',
    title: 'Schedules',
    lead: 'Every scheduled thing in one place: our own jobs and other schedulers on this host.',
    skeleton: 'list',
    coming: [
      { text: 'Jobs: create, edit, enable, run now', slice: 'S5' },
      { text: 'Last runs with capped output', slice: 'S5' },
      { text: 'Read-only mirror of Hermes cron and systemd timers', slice: 'S5' },
    ],
  },
  {
    id: 'notes',
    label: 'Notes',
    title: 'Notes',
    lead: 'Ops logs, summaries and handoffs, rendered from markdown folders.',
    skeleton: 'split',
    coming: [
      { text: 'Documents by date with title search', slice: 'S6' },
      { text: 'Rendered markdown, read from disk on request', slice: 'S6' },
      { text: 'Private collections stay locked until you sign in', slice: 'S6' },
    ],
  },
  {
    id: 'connections',
    label: 'Connections',
    title: 'Connections',
    lead: 'How each plan and model is connected, and whether the connection works right now.',
    skeleton: 'cards',
    coming: [
      {
        text: 'Claude subscription: what is read on this host (the login never leaves it)',
        slice: 'S6',
      },
      { text: 'Codex: session logs', slice: 'S6' },
      { text: 'Local models (Ollama or OpenAI-compatible): live status check', slice: 'S6' },
      { text: 'Last reading time for each', slice: 'S6' },
    ],
  },
  {
    id: 'settings',
    label: 'Settings',
    title: 'Settings',
    lead: 'What this server is running with.',
    skeleton: 'list',
    coming: [
      { text: 'Version, database size, row counts and retention (below)', slice: 'S1' },
      { text: 'Config summary with the file path', slice: 'later' },
      { text: 'Tokens: list, create and revoke when signed in', slice: 'later' },
    ],
  },
];

export function tabFromHash(hash: string): Tab {
  const id = hash.replace(/^#\/?/, '').split(/[/?]/)[0] ?? '';
  return TABS.find((t) => t.id === id) ?? (TABS[0] as Tab);
}
