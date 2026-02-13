import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { JsonStorage } from '@consensus-tools/consensus-tools/src/storage/JsonStorage.ts';
import { LedgerEngine } from '@consensus-tools/consensus-tools/src/ledger/ledger.ts';
import { JobEngine } from '@consensus-tools/consensus-tools/src/jobs/engine.ts';
import { ConsensusToolsServer } from '@consensus-tools/consensus-tools/src/network/server.ts';
import { defaultConfig } from '@consensus-tools/consensus-tools/src/config.ts';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const cliBin = path.join(repoRoot, 'node_modules', '.bin', 'consensus-tools');

function parseJson<T = any>(stdout: string): T {
  return JSON.parse(stdout.trim());
}

async function runCli(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
  timeout = 30_000
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(cliBin, args, {
    cwd,
    timeout,
    env: {
      ...process.env,
      ...env
    }
  });
}

async function runBash(
  scriptPath: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
  timeout = 30_000
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('bash', [scriptPath, ...args], {
    cwd,
    timeout,
    env: {
      ...process.env,
      ...env
    }
  });
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('failed to allocate ephemeral port'));
        return;
      }
      const port = addr.port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on('error', reject);
  });
}

async function startPrefixProxy(innerPort: number, outerPort: number, prefix: string) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (!url.pathname.startsWith(prefix)) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }

      const suffix = url.pathname.slice(prefix.length) || '/';
      const target = `http://127.0.0.1:${innerPort}${suffix}${url.search}`;

      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? Buffer.concat(chunks) : undefined;

      const headers: Record<string, string> = {};
      const auth = req.headers.authorization;
      if (typeof auth === 'string') headers.authorization = auth;
      const contentType = req.headers['content-type'];
      if (typeof contentType === 'string') headers['content-type'] = contentType;

      const upstream = await fetch(target, {
        method: req.method || 'GET',
        headers,
        body: body && body.length ? body : undefined
      });

      const text = await upstream.text();
      res.statusCode = upstream.status;
      res.setHeader('content-type', upstream.headers.get('content-type') || 'application/json');
      res.end(text);
    } catch (err: any) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: err?.message || String(err) }));
    }
  });

  await new Promise<void>((resolve) => server.listen(outerPort, '127.0.0.1', () => resolve()));
  return server;
}

test('local generated API scripts e2e (npm-installed package)', async () => {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'consensus-local-api-e2e-'));

  await runCli(['init', '--force'], workdir);

  const env = {
    CONSENSUS_MODE: 'local',
    CONSENSUS_ROOT: path.join(workdir, '.board-local')
  };

  const apiDir = path.join(workdir, '.consensus', 'api');

  const post = await runBash(
    path.join(apiDir, 'jobs_post.sh'),
    ['Local E2E Job', 'desc', 'payload'],
    repoRoot,
    env
  );
  const job = parseJson<any>(post.stdout);
  assert.ok(job.id?.startsWith('job_'));

  const sub = await runBash(
    path.join(apiDir, 'submissions_create.sh'),
    [job.id, '{"answer":"ok"}', 'local submit', '0.91'],
    repoRoot,
    env
  );
  const submission = parseJson<any>(sub.stdout);
  assert.equal(submission.jobId, job.id);

  // resolve.sh currently embeds TypeScript-only syntax in a JS eval block.
  // Resolve directly through engine to complete local end-to-end validation.
  const localState = path.join(env.CONSENSUS_ROOT!, 'state.json');
  const storage = new JsonStorage(localState);
  await storage.init();
  const ledger = new LedgerEngine(storage, defaultConfig);
  const engine = new JobEngine(storage, ledger, defaultConfig);
  const resolution = await engine.resolveJob('cli@local', job.id, {});
  assert.equal(resolution.jobId, job.id);

  const result = await runBash(path.join(apiDir, 'result_get.sh'), [job.id], repoRoot, env);
  const finalResult = parseJson<any>(result.stdout);
  assert.equal(finalResult.jobId, job.id);
  assert.ok(Array.isArray(finalResult.winningSubmissionIds));
});

test('standalone CLI full lifecycle e2e via hosted API shape', async () => {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'consensus-cli-hosted-e2e-'));
  const stateFile = path.join(workdir, 'state.json');
  const authToken = 'local-e2e-token';

  const innerPort = await getFreePort();
  const outerPort = await getFreePort();
  const boardPrefix = '/v1/boards/board_all';

  const storage = new JsonStorage(stateFile);
  await storage.init();
  const ledger = new LedgerEngine(storage, defaultConfig);
  const engine = new JobEngine(storage, ledger, defaultConfig);

  const cfg = {
    ...defaultConfig,
    local: {
      ...defaultConfig.local,
      server: {
        enabled: true,
        host: '127.0.0.1',
        port: innerPort,
        authToken
      }
    }
  };

  const embedded = new ConsensusToolsServer(cfg, engine, ledger);
  await embedded.start();
  const proxy = await startPrefixProxy(innerPort, outerPort, boardPrefix);

  try {
    const envBase = {
      CONSENSUS_API_KEY: authToken
    };

    await runCli(['init', '--force'], workdir, envBase);

    await runCli(
      ['config', 'set', 'defaults.reward', '9'],
      workdir,
      envBase
    );
    const defaultsReward = await runCli(['config', 'get', 'defaults.reward'], workdir, envBase);
    assert.equal(parseJson<number>(defaultsReward.stdout), 9);

    await runCli(
      ['board', 'use', 'remote', `http://127.0.0.1:${outerPort}${boardPrefix}`],
      workdir,
      envBase
    );

    const posted = await runCli(
      [
        'jobs',
        'post',
        '--title',
        'CLI hosted e2e',
        '--desc',
        'vote flow',
        '--input',
        'payload',
        '--mode',
        'SUBMISSION',
        '--policy',
        'APPROVAL_VOTE',
        '--reward',
        '5',
        '--stake',
        '0',
        '--expires',
        '600',
        '--json'
      ],
      workdir,
      {
        ...envBase,
        CONSENSUS_AGENT_ID: 'owner'
      }
    );
    const job = parseJson<any>(posted.stdout);
    assert.ok(job.id?.startsWith('job_'));

    const listed = await runCli(['jobs', 'list', '--json'], workdir, envBase);
    const jobs = parseJson<any[]>(listed.stdout);
    assert.ok(jobs.some((j) => j.id === job.id));

    const got = await runCli(['jobs', 'get', job.id, '--json'], workdir, envBase);
    const gotJob = parseJson<any>(got.stdout);
    assert.equal(gotJob.id, job.id);

    const subA = await runCli(
      [
        'submissions',
        'create',
        job.id,
        '--artifact',
        '{"answer":"A"}',
        '--summary',
        'from A',
        '--confidence',
        '0.55',
        '--json'
      ],
      workdir,
      {
        ...envBase,
        CONSENSUS_AGENT_ID: 'agentA'
      }
    );
    const submissionA = parseJson<any>(subA.stdout);

    const subB = await runCli(
      [
        'submissions',
        'create',
        job.id,
        '--artifact',
        '{"answer":"B"}',
        '--summary',
        'from B',
        '--confidence',
        '0.65',
        '--json'
      ],
      workdir,
      {
        ...envBase,
        CONSENSUS_AGENT_ID: 'agentB'
      }
    );
    const submissionB = parseJson<any>(subB.stdout);
    assert.notEqual(submissionA.id, submissionB.id);

    const listedSubs = await runCli(['submissions', 'list', job.id, '--json'], workdir, envBase);
    const submissions = parseJson<any[]>(listedSubs.stdout);
    assert.equal(submissions.length, 2);

    const vote = await runCli(
      [
        'votes',
        'cast',
        job.id,
        '--submission',
        submissionB.id,
        '--yes',
        '--weight',
        '1',
        '--json'
      ],
      workdir,
      {
        ...envBase,
        CONSENSUS_AGENT_ID: 'voter1'
      }
    );
    const castVote = parseJson<any>(vote.stdout);
    assert.equal(castVote.submissionId, submissionB.id);

    const voteList = await runCli(['votes', 'list', job.id, '--json'], workdir, envBase);
    const votes = parseJson<any[]>(voteList.stdout);
    assert.ok(Array.isArray(votes));

    const resolved = await runCli(['resolve', job.id, '--json'], workdir, {
      ...envBase,
      CONSENSUS_AGENT_ID: 'owner'
    });
    const resolution = parseJson<any>(resolved.stdout);
    assert.equal(resolution.jobId, job.id);
    assert.equal(resolution.winningSubmissionIds[0], submissionB.id);

    const result = await runCli(['result', 'get', job.id, '--json'], workdir, envBase);
    const status = parseJson<any>(result.stdout);
    assert.equal(status.job.id, job.id);
    assert.equal(status.resolution.winningSubmissionIds[0], submissionB.id);
  } finally {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await embedded.stop();
  }
});
