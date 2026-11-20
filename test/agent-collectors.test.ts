import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runAgentCollectors, type CollectorEnv } from '../server/agents/collect.ts';
import {
  argvDetails,
  cleanRemote,
  discoverProcesses,
  expandShellScripts,
  inferKind,
  matchProcesses,
  parseMatchRules,
  parseProcStat,
  parsePs,
  redactSecrets,
  shellWords,
  type GitInfo,
  type ProcInfo,
} from '../server/agents/process-scan.ts';
import { listRuns, startRun } from '../server/agents/runs.ts';
import {
  discoverUnits,
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
    expect(argvDetails(['bash', '-c', 'codex exec -m my-model 2>&1']).prompt).toBeNull();
    expect(argvDetails(['claude', '-p', '--model', 'opus', 'Expanded brief']).prompt).toBe(
      'Expanded brief',
    );
    expect(argvDetails(['codex', 'exec', '-'])).toEqual({ model: null, prompt: null });
  });

  it('reads both brief labels from the fleet commands for runs 21 and 23', () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'worker-brief-'));
    // Preserve the captured ExecStart escaping. Redirect only the brief lookup to the fixture.
    const commands = [
      String.raw`/bin/bash -c exec bash -c cd\ /home/ai/dev/GameMaker-patchwork-wt/q18-q21-keys-followups-1119\ \&\&\ npm\ ci\ \>\ /home/ai/GameMaker-SandboxEdition/.for-lewis/research/agents/codex-runs/q18-q21-keys-followups-1119-kaylee-npmci.log\ 2\>\&1\ \&\&\ /home/ai/.hermes/node/bin/codex\ exec\ -m\ gpt-6.2-astra\ -s\ workspace-write\ -c\ sandbox_workspace_write.network_access=true\ -C\ /home/ai/dev/GameMaker-patchwork-wt/q18-q21-keys-followups-1119\ \"\$\(cat\ /home/ai/GameMaker-SandboxEdition/.for-lewis/tools/codex-briefs/q18-q21-keys-followups-1119.txt\)\"  > /home/ai/GameMaker-SandboxEdition/.for-lewis/research/agents/codex-runs/q18-q21-keys-followups-1119-kaylee.log 2>&1 < /dev/null`,
      String.raw`/bin/bash -c exec bash -c claude\ -p\ --model\ opus\ --permission-mode\ bypassPermissions\ \"\$\(cat\ /home/ai/GameMaker-SandboxEdition/.for-lewis/tools/codex-briefs/mm-product-reviewer.txt\)\"  > /home/ai/GameMaker-SandboxEdition/.for-lewis/research/agents/claude-runs/mm-product-reviewer-20261119-1830.log 2>&1 < /dev/null`,
    ];
    try {
      for (const command of commands) {
        expect(expandShellScripts(shellWords(command)).join(' ')).not.toContain('2>');
        const name = path.basename(command.match(/codex-briefs\/([^\\]+)\\\)/)![1]!);
        writeFileSync(path.join(cwd, name), `Review ${name}\nSecond line`);
        const local = command.replace(
          '/home/ai/GameMaker-SandboxEdition/.for-lewis/tools/codex-briefs/',
          '',
        );
        expect(argvDetails(local, cwd).prompt).toBe(`Review ${name}`);
      }
      expect(
        argvDetails(['bash', '-c', 'codex exec >>log 2>&1 </dev/null "Keep going"']).prompt,
      ).toBe('Keep going');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
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
  // Session folders the scans look in for a missing model: empty, never the host's own.
  const sessions = mkdtempSync(path.join(tmpdir(), 'mm-scan-sessions-'));
  afterAll(() => rmSync(sessions, { recursive: true, force: true }));
  const dirs = { claude_dir: sessions, codex_dir: sessions };

  it('merges units and processes into one run per pid, then ends what vanished', async () => {
    const config = testConfig({
      machines: [{ id: 'server-1', name: 'S' }],
      collectors: [
        { id: 'procs', kind: 'process-scan', match: ['codex exec', 'claude -p'], ...dirs },
        { id: 'workers', kind: 'systemd-workers', prefix: 'worker-', ...dirs },
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

describe('model from argv, then from the session log', () => {
  // A worker unit as systemd prints its ExecStart: nested bash -c, spaces escaped with "\".
  const UNIT_CMD = String.raw`/bin/bash -c exec bash -c cd\ web\ \&\&\ npm\ ci\ \>\ ../npm.log\ 2\>\&1\;\ cd\ ..\ \&\&\ /opt/node/bin/codex\ exec\ -m\ gpt-test-large\ -s\ workspace-write\ -c\ sandbox_workspace_write.network_access=true\ \"\$\(cat\ /work/brief.txt\)\"`;

  it('splits shell words with quotes, escapes and operators', () => {
    expect(shellWords(String.raw`a\ b "c \"d\"" 'e f' g;h&&i 2>&1`)).toEqual([
      'a b',
      'c "d"',
      'e f',
      'g',
      ';',
      'h',
      '&&',
      'i',
    ]);
    expect(shellWords(`x '' y`)).toEqual(['x', '', 'y']);
  });

  it('reads -m from a codex exec inside an escaped systemd ExecStart', () => {
    expect(argvDetails(shellWords(UNIT_CMD))).toMatchObject({ model: 'gpt-test-large' });
  });

  it('reads the model through a bash -c wrapper in a process argv', () => {
    const argv = ['/bin/bash', '-c', 'npm ci > /dev/null 2>&1; claude -p --model opus "$(cat b)"'];
    expect(argvDetails(argv).model).toBe('opus');
    expect(argvDetails(['bash', '-lc', 'codex exec --model=gpt-y "ship it"'])).toEqual({
      model: 'gpt-y',
      prompt: 'ship it',
    });
  });

  it("reads codex config overrides and ignores other commands' -m", () => {
    expect(argvDetails(['codex', 'exec', '-c', 'model="gpt-z"', 'go']).model).toBe('gpt-z');
    expect(argvDetails(['codex', 'exec', '--config', 'model=gpt-z', 'go']).model).toBe('gpt-z');
    expect(argvDetails(['codex', 'exec', '-c', 'sandbox=x', 'go']).model).toBeNull();
    expect(argvDetails(['sh', '-c', 'git commit -m wip && codex exec "review it"'])).toEqual({
      model: null,
      prompt: 'review it',
    });
  });

  it('a systemd worker run gets its model from argv', async () => {
    const units = parseShow(
      `Id=worker-c.service\nActiveState=active\nMainPID=700\nWorkingDirectory=/work/repo\nExecStart={ path=/bin/bash ; argv[]=${UNIT_CMD} ; ignore_errors=no }\n`,
    );
    const [d] = await discoverUnits(units, {}, noGit, () => null);
    expect(d).toMatchObject({ agent_kind: 'codex', model: 'gpt-test-large' });
  });

  it('fills a missing model from the Codex turn context and Claude messages', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mm-model-'));
    try {
      const codexDir = path.join(root, 'codex');
      const claudeDir = path.join(root, 'claude');
      const id = '0000bbbb-1111-2222-3333-444455556666';
      const day = path.join(codexDir, '2026', '11', '19');
      mkdirSync(day, { recursive: true });
      const line = (o: unknown) => JSON.stringify(o) + '\n';
      writeFileSync(
        path.join(day, `rollout-2026-11-19T12-00-00-${id}.jsonl`),
        line({ type: 'session_meta', payload: { id, cwd: '/work/codex', timestamp: T0 } }) +
          // Newer logs: the model under collaboration_mode.settings only.
          line({
            type: 'turn_context',
            payload: { cwd: '/work/codex', collaboration_mode: { settings: { model: 'gpt-log' } } },
          }),
      );
      const proj = path.join(claudeDir, claudeProjectDir('/work/claude'));
      mkdirSync(proj, { recursive: true });
      writeFileSync(
        path.join(proj, 'sess-9.jsonl'),
        line({ type: 'assistant', message: { id: 'm1', model: 'claude-log', usage: {} } }),
      );
      const config = testConfig({
        machines: [{ id: 'server-1', name: 'S' }],
        collectors: [
          {
            id: 'procs',
            kind: 'process-scan',
            match: ['codex exec', 'claude -p'],
            codex_dir: codexDir,
            claude_dir: claudeDir,
          },
        ],
      });
      const db = memoryDb(config);
      const procs = [
        proc(801, 1, 'codex exec "no model flag"', { cwd: '/work/codex' }),
        proc(802, 1, 'claude -p hello', { cwd: '/work/claude' }),
      ];
      procs[0]!.argv = ['codex', 'exec', 'no model flag'];
      const env: CollectorEnv = {
        listProcesses: async () => procs,
        listUnits: async () => [],
        git: async (cwd) => ({ branch: null, origin: null, worktree: cwd }),
        tail: new SessionTail(),
        now: () => new Date('2026-11-19T12:05:00.000Z'),
      };
      const [r] = await runAgentCollectors(db, config, env);
      expect(r).toMatchObject({ ok: true, inserted: 2, models_filled: 2 });
      const runs = listRuns(db, {});
      expect(runs.find((x) => x.pid === 801)).toMatchObject({
        model: 'gpt-log',
        log_ref: `codex:${id}`,
      });
      expect(runs.find((x) => x.pid === 802)).toMatchObject({ model: 'claude-log' });
      // Argv wins over the log; a run that already has a model is not looked up again.
      expect((await runAgentCollectors(db, config, env))[0]).toMatchObject({ models_filled: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
