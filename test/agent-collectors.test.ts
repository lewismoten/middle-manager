import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runAgentCollectors, type CollectorEnv } from '../server/agents/collect.ts';
import {
  argvDetails,
  cleanRemote,
  discoverProcesses,
  inferKind,
  matchProcesses,
  parseMatchRules,
  parseProcStat,
  parsePs,
  redactSecrets,
  type GitInfo,
  type ProcInfo,
} from '../server/agents/process-scan.ts';
import { listRuns, startRun } from '../server/agents/runs.ts';
import {
  parseExecStart,
  parseShow,
  parseSystemdTime,
  unitStatus,
  type UnitInfo,
} from '../server/agents/systemd.ts';
import {
  claudeProjectDir,
  claudeReader,
  codexReader,
  readerFor,
  SessionTail,
} from '../server/agents/tokens.ts';
import { memoryDb, testConfig } from './helpers.ts';

const T0 = '2026-11-19T12:00:00.000Z';

function proc(pid: number, ppid: number, command: string, extra: Partial<ProcInfo> = {}): ProcInfo {
  return {
    pid,
    ppid,
    argv: command.split(' '),
    command,
    cwd: '/work/repo',
    started_at: T0,
    ...extra,
  };
}

const noGit = async (): Promise<GitInfo> => ({
  branch: 'feature/demo',
  origin: 'https://example.com/owner/repo.git',
  worktree: '/work/repo',
});
const fakeGit = () => {
  const calls: string[] = [];
  const fn = (cwd: string | null) => {
    if (cwd) calls.push(cwd);
    return noGit();
  };
  return { fn, calls };
};

describe('process-scan', () => {
  it('parses /proc/<pid>/stat with spaces and parens in the name', () => {
    const fields = Array.from({ length: 50 }, (_, i) => String(i));
    const text = `123 (my (odd) name) S 77 ${fields.slice(5).join(' ')}`;
    // rest[1] = ppid (77); rest[19] is field 22.
    expect(parseProcStat(text)?.ppid).toBe(77);
    expect(parseProcStat('garbage')).toBeNull();
  });

  it('parses ps output', () => {
    const out = parsePs(
      '  101     1 Thu Nov 19 12:00:00 2026 codex exec "do it"\n' +
        '  102   101 Thu Nov 19 12:01:00 2026 claude -p hi\nnoise\n',
    );
    expect(out.map((p) => [p.pid, p.ppid, p.command])).toEqual([
      [101, 1, 'codex exec "do it"'],
      [102, 101, 'claude -p hi'],
    ]);
    expect(out[0]?.started_at).toMatch(/^2026-11-19T/);
  });

  it('matches by pattern, drops wrappers, links sub-agents', () => {
    const rules = parseMatchRules([
      'claude -p',
      'codex exec',
      { pattern: 'hermes', kind: 'hermes', role: 'orchestrator' },
    ]);
    const procs = [
      proc(1, 0, 'init'),
      proc(10, 1, 'hermes run board'),
      proc(20, 10, 'bash -c claude -p "fix it"'),
      proc(21, 20, 'claude -p fix it --model opus'),
      proc(30, 21, 'timeout 600 codex exec --model m2 write tests'),
      proc(31, 30, 'codex exec --model m2 write tests'),
      proc(40, 1, 'vim notes'),
      proc(50, 1, 'claude -p self', {}),
    ];
    const m = matchProcesses(procs, rules, 50);
    const byPid = Object.fromEntries(m.map((x) => [x.proc.pid, x.parentPid]));
    expect(byPid).toEqual({ 10: null, 21: 10, 31: 21 });
    expect(matchProcesses(procs, [])).toEqual([]);
  });

  it('turns matches into runs with git info looked up once per cwd', async () => {
    const git = fakeGit();
    const found = await discoverProcesses(
      [proc(5, 1, 'claude -p review the PR --model sonnet'), proc(6, 1, 'codex exec go')],
      parseMatchRules(['claude -p', 'codex exec']),
      git.fn,
      0,
    );
    expect(found[0]).toMatchObject({
      pid: 5,
      agent_kind: 'claude-code',
      role: 'agent',
      model: 'sonnet',
      prompt: 'review',
      branch: 'feature/demo',
      worktree: '/work/repo',
      harness: 'claude -p',
    });
    expect(found[1]).toMatchObject({ agent_kind: 'codex', prompt: 'go' });
    expect(git.calls).toEqual(['/work/repo', '/work/repo']);
  });

  it('reads model and prompt from argv', () => {
    expect(argvDetails(['codex', 'exec', '-m', 'gpt-x', 'Write the docs'])).toEqual({
      model: 'gpt-x',
      prompt: 'Write the docs',
    });
    expect(argvDetails(['claude', '--model=opus', '-p', '--verbose'])).toEqual({
      model: 'opus',
      prompt: null,
    });
    expect(argvDetails(['codex', 'exec', '-'])).toEqual({ model: null, prompt: null });
  });

  it('infers agent kind and strips credentials from remotes', () => {
    expect(inferKind('/usr/bin/claude -p x')).toBe('claude-code');
    expect(inferKind('node codex exec')).toBe('codex');
    expect(inferKind('ollama run x')).toBe('local');
    expect(inferKind('python agent.py')).toBe('other');
    expect(cleanRemote('https://user:secret@example.com/o/r.git')).toBe(
      'https://example.com/o/r.git',
    );
    expect(cleanRemote('git@example.com:o/r.git')).toBe('git@example.com:o/r.git');
    expect(cleanRemote(null)).toBeNull();
  });

  it('masks credentials in command lines', () => {
    expect(
      redactSecrets(
        'OPENAI_API_KEY=abc123 codex exec --api-key "s e c" --token=xyz -p hi sk-abcdefghijklmnopqrstu',
      ),
    ).toBe('OPENAI_API_KEY=*** codex exec --api-key *** --token=*** -p hi ***');
    expect(redactSecrets('claude -p "fix the auth bug" --model opus')).toBe(
      'claude -p "fix the auth bug" --model opus',
    );
  });

  it('rejects malformed match rules', () => {
    expect(() => parseMatchRules('claude')).toThrow(/list/);
    expect(() => parseMatchRules([3])).toThrow(/match\[0\]/);
  });
});

describe('systemd-workers', () => {
  const show = [
    'Id=worker-alpha.service',
    'ActiveState=active',
    'SubState=running',
    'ExecMainStartTimestamp=@1795089600',
    'ExecMainExitTimestamp=',
    'MainPID=4321',
    'WorkingDirectory=/work/repo',
    'ExecStart={ path=/usr/bin/codex ; argv[]=/usr/bin/codex exec --model m1 ship ; ignore_errors=no ; start_time=[n/a] }',
    'Description=/usr/bin/codex exec ship',
    '',
    'Id=worker-beta.service',
    'ActiveState=failed',
    'SubState=failed',
    'ExecMainStartTimestamp=@1795089000',
    'ExecMainExitTimestamp=@1795089300',
    'MainPID=0',
    'WorkingDirectory=',
    'ExecStart=',
    'Description=beta',
  ].join('\n');

  it('parses systemctl show', () => {
    const units = parseShow(show);
    expect(units).toHaveLength(2);
    expect(units[0]).toMatchObject({
      unit: 'worker-alpha.service',
      main_pid: 4321,
      cwd: '/work/repo',
      command: '/usr/bin/codex exec --model m1 ship',
      started_at: new Date(1795089600 * 1000).toISOString(),
    });
    expect(units[1]).toMatchObject({ main_pid: null, cwd: null, command: null });
    expect(unitStatus(units[0] as UnitInfo)).toBe('running');
    expect(unitStatus(units[1] as UnitInfo)).toBe('failed');
  });

  it('parses times and ExecStart', () => {
    expect(parseSystemdTime('Thu 2026-11-19 12:00:00 UTC')).toBe(T0);
    expect(parseSystemdTime('n/a')).toBeNull();
    expect(parseSystemdTime('')).toBeNull();
    expect(parseExecStart('{ path=/bin/x ; argv[]=/bin/x a b ; ignore_errors=no }')).toBe(
      '/bin/x a b',
    );
    expect(parseExecStart(undefined)).toBeNull();
  });
});

describe('collectors end to end (fake host)', () => {
  it('merges units and processes into one run per pid, then ends what vanished', async () => {
    const config = testConfig({
      machines: [{ id: 'server-1', name: 'S' }],
      collectors: [
        { id: 'procs', kind: 'process-scan', match: ['codex exec', 'claude -p'] },
        { id: 'workers', kind: 'systemd-workers', prefix: 'worker-' },
        { id: 'boards', kind: 'hermes-kanban' },
      ],
    });
    const db = memoryDb(config);
    let procs: ProcInfo[] = [
      proc(4321, 1, '/usr/bin/codex exec --model m1 ship'),
      proc(4400, 4321, 'claude -p check it'),
    ];
    let units = parseShow(
      'Id=worker-alpha.service\nActiveState=active\nMainPID=4321\nExecMainStartTimestamp=@1795089600\nExecStart={ path=/usr/bin/codex ; argv[]=/usr/bin/codex exec --model m1 ship ; x=y }\n',
    );
    const env: CollectorEnv = {
      listProcesses: async () => procs,
      listUnits: async () => units,
      git: noGit,
      tail: new SessionTail(),
      now: () => new Date('2026-11-19T12:30:00.000Z'),
    };
    const reports = await runAgentCollectors(db, config, env);
    expect(reports.map((r) => [r.id, r.ok, r.inserted])).toEqual([
      ['workers', true, 1],
      ['procs', true, 1],
    ]);
    const runs = listRuns(db, { active: true });
    expect(runs).toHaveLength(2);
    const worker = runs.find((r) => r.unit === 'worker-alpha.service');
    expect(worker).toMatchObject({
      pid: 4321,
      source: 'process-scan+systemd-workers',
      model: 'm1',
      agent_kind: 'codex',
    });
    expect(runs.find((r) => r.pid === 4400)).toMatchObject({
      parent_run_id: worker?.id,
      role: 'sub-agent',
    });

    procs = [];
    units = [];
    await runAgentCollectors(db, config, env);
    expect(listRuns(db, { active: true })).toHaveLength(0);
    expect(listRuns(db, {}).map((r) => r.status)).toEqual(['ended', 'ended']);
  });

  it('reports a collector failure without throwing', async () => {
    const config = testConfig({ collectors: [{ id: 'p', kind: 'process-scan', match: 'oops' }] });
    const db = memoryDb(config);
    const env = {
      listProcesses: async () => [],
      listUnits: async () => [],
      git: noGit,
      tail: new SessionTail(),
      now: () => new Date(),
    };
    const [r] = await runAgentCollectors(db, config, env);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/list/) });
  });
});

describe('token readers', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mm-tokens-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const claudeDir = path.join(dir, 'claude');
  const codexDir = path.join(dir, 'codex');
  const dirs = { claude_dir: claudeDir, codex_dir: codexDir };
  const jsonl = (...rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

  const assistant = (id: string, i: number, o: number, cr: number, cw: number) => ({
    type: 'assistant',
    message: {
      id,
      model: 'claude-model-x',
      usage: {
        input_tokens: i,
        output_tokens: o,
        cache_read_input_tokens: cr,
        cache_creation_input_tokens: cw,
      },
    },
  });

  it('names Claude project folders like Claude Code', () => {
    expect(claudeProjectDir('/work/my.repo/wt_1')).toBe('-work-my-repo-wt-1');
  });

  it('sums Claude Code usage once per message and reads only appended lines', () => {
    const proj = path.join(claudeDir, claudeProjectDir('/work/repo'));
    mkdirSync(proj, { recursive: true });
    const file = path.join(proj, 'sess-1.jsonl');
    writeFileSync(
      file,
      jsonl(
        { type: 'user', message: { role: 'user', content: 'hi' } },
        assistant('m1', 3, 10, 100, 50),
        assistant('m1', 3, 10, 100, 50), // same message, second content block
        assistant('m2', 2, 20, 150, 0),
      ) + '{"torn":',
    );
    const loc = claudeReader.locate(
      { log_ref: 'claude-code:sess-1', worktree: '/work/repo', started_at: T0 },
      dirs,
    );
    expect(loc).toEqual({ file, ref: 'claude-code:sess-1' });
    const tail = new SessionTail();
    expect(tail.read(claudeReader, file)).toEqual({
      tokens_in: 5,
      tokens_out: 30,
      tokens_cache_read: 250,
      tokens_cache_write: 50,
      model: 'claude-model-x',
    });
    appendFileSync(file, ' 1}\n' + jsonl(assistant('m3', 1, 1, 0, 0)));
    expect(tail.read(claudeReader, file).tokens_out).toBe(31);
    // Found without a log_ref when it is the only fresh session in the project folder.
    const auto = claudeReader.locate(
      { log_ref: null, worktree: '/work/repo', started_at: '2000-01-01T00:00:00Z' },
      dirs,
    );
    expect(auto?.ref).toBe('claude-code:sess-1');
    expect(
      claudeReader.locate({ log_ref: 'claude-code:../x', worktree: null, started_at: T0 }, dirs),
    ).toBeNull();
  });

  it('takes the last Codex total and splits cached input', () => {
    const day = path.join(codexDir, '2026', '11', '19');
    mkdirSync(day, { recursive: true });
    const id = '0000aaaa-1111-2222-3333-444455556666';
    const file = path.join(day, `rollout-2026-11-19T12-00-00-${id}.jsonl`);
    const tc = (input: number, cached: number, out: number) => ({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: input,
            cached_input_tokens: cached,
            output_tokens: out,
            cache_write_input_tokens: 0,
          },
        },
      },
    });
    writeFileSync(
      file,
      jsonl(
        {
          type: 'session_meta',
          payload: { id, cwd: '/work/repo', timestamp: '2026-11-19T12:00:01.000Z' },
        },
        { type: 'turn_context', payload: { model: 'model-medium' } },
        tc(1000, 800, 50),
        { type: 'event_msg', payload: { type: 'token_count', info: null } },
        tc(3000, 2500, 120),
      ),
    );
    const byRef = codexReader.locate(
      { log_ref: `codex:${id}`, worktree: null, started_at: T0 },
      dirs,
    );
    expect(byRef?.file).toBe(file);
    const byCwd = codexReader.locate(
      { log_ref: null, worktree: '/work/repo', started_at: T0 },
      dirs,
    );
    expect(byCwd).toEqual({ file, ref: `codex:${id}` });
    expect(
      codexReader.locate({ log_ref: null, worktree: '/elsewhere', started_at: T0 }, dirs),
    ).toBeNull();
    expect(new SessionTail().read(codexReader, file)).toEqual({
      tokens_in: 500,
      tokens_out: 120,
      tokens_cache_read: 2500,
      tokens_cache_write: 0,
      model: 'model-medium',
    });
  });

  it('picks a reader by log_ref prefix, then by agent kind', () => {
    expect(readerFor({ agent_kind: 'other', log_ref: 'codex:abc' })?.kind).toBe('codex');
    expect(readerFor({ agent_kind: 'claude-code', log_ref: null })?.kind).toBe('claude-code');
    expect(readerFor({ agent_kind: 'hermes', log_ref: null })).toBeNull();
  });

  it('session-tokens collector fills tokens on open runs for this machine', async () => {
    const config = testConfig({
      machines: [{ id: 'server-1', name: 'S' }],
      collectors: [{ id: 't', kind: 'session-tokens', claude_dir: claudeDir, codex_dir: codexDir }],
    });
    const db = memoryDb(config);
    const mine = startRun(db, {
      machine_id: 'server-1',
      agent_kind: 'codex',
      worktree: '/work/repo',
      started_at: T0,
    }).run;
    const theirs = startRun(db, {
      machine_id: 'laptop',
      agent_kind: 'codex',
      worktree: '/work/repo',
      started_at: T0,
    }).run;
    const env: CollectorEnv = {
      listProcesses: async () => [],
      listUnits: async () => [],
      git: noGit,
      tail: new SessionTail(),
      now: () => new Date('2026-11-19T12:10:00.000Z'),
    };
    const [r] = await runAgentCollectors(db, config, env);
    expect(r).toMatchObject({ ok: true, tokens_updated: 1 });
    const runs = listRuns(db, {});
    expect(runs.find((x) => x.id === mine.id)).toMatchObject({
      tokens_out: 120,
      model: 'model-medium',
      log_ref: expect.stringMatching(/^codex:/),
    });
    expect(runs.find((x) => x.id === theirs.id)?.tokens_out).toBeNull();
  });
});
