import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('public test commands remain runnable without private repository access', () => {
  const root = JSON.parse(read('package.json'));
  const timeline = JSON.parse(read('packages/task-timeline-component/package.json'));
  assert.equal(root.scripts.test, 'npm run test:clockoli && npm run test:timeline');
  assert.equal(root.scripts['test:clockoli'], 'node --test test/*.test.js');
  assert.equal(root.scripts['test:browser'], 'playwright test test/basic-browser.functional.spec.js --workers=1');
  assert.equal(root.scripts['test:private'], 'node scripts/run-private-tests.js');
  assert.equal(root.scripts['test:timeline'], 'node scripts/verify-timeline-build.js && npm run test:all --workspace task-timeline-component-clockoli');
  assert.equal(timeline.scripts['test:all'], 'npm test && npm run test:package');
  assert.deepEqual(readdirSync(new URL('../test/', import.meta.url)).filter(name => name.endsWith('.functional.spec.js')),
    ['basic-browser.functional.spec.js']);
});

test('public CI runs private regressions for trusted main and same-repository PRs only', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /pull_request:/);
  assert.doesNotMatch(ci, /pull_request_target:/);
  const [publicJobs, privateJob] = ci.split(/\n  private-regressions:\n/);
  assert.ok(privateJob, 'a separate private test job is required');
  assert.doesNotMatch(publicJobs, /test-private|secrets\./);
  assert.match(publicJobs, /npm test/);
  assert.match(publicJobs, /npm run check/);
  assert.match(privateJob, /needs: test/);
  const shardList = privateJob.match(/shard:\s*\[([0-9,\s]+)\]/)?.[1];
  assert.ok(shardList, 'a 20-shard matrix is required');
  assert.deepEqual(shardList.split(",").map(Number), Array.from({ length: 20 }, (_, index) => index + 1));
  assert.match(privateJob, /fail-fast: false/);
  assert.match(privateJob, /name: private-regressions \(\$\{\{ matrix\.shard \}\}\/20\)/);
  assert.match(privateJob, /if: matrix\.shard == 1/);
  assert.match(privateJob, /--fully-parallel --workers=1 --shard="\$SHARD_INDEX\/20"/);
  assert.match(privateJob, /npm run test:private -- --unit/);
  const condition = privateJob.match(/    if: >-\n([\s\S]*?)\n    strategy:/)?.[1].trim().replace(/\s+/g, ' ');
  assert.equal(condition,
    "github.repository == 'Clockoli/clockoli' && " +
    "((github.event_name == 'push' && github.ref == 'refs/heads/main') || " +
    "(github.event_name == 'pull_request' && github.base_ref == 'main' && " +
    "github.event.pull_request.head.repo.full_name == github.repository && " +
    "github.event.pull_request.user.login != 'dependabot[bot]'))");
  assert.match(privateJob, /repository: \$\{\{ secrets\.PRIVATE_TESTS_REPOSITORY \}\}/);
  assert.match(privateJob, /id: private-test-ref/);
  assert.match(privateJob, /PUBLIC_BRANCH: \$\{\{ github\.head_ref \|\| github\.ref_name \}\}/);
  assert.match(privateJob, /git\/ref\/heads\/\$branch_path/);
  assert.match(privateJob, /200\) selected="\$PUBLIC_BRANCH"/);
  assert.match(privateJob, /404\) selected=main/);
  assert.match(privateJob, /ref: \$\{\{ steps\.private-test-ref\.outputs\.ref \}\}/);
  assert.match(privateJob, /Could not check internal regression branch/);

  assert.match(privateJob, /PRIVATE_TESTS_REPOSITORY: \$\{\{ secrets\.PRIVATE_TESTS_REPOSITORY \}\}/);
  assert.doesNotMatch(privateJob, /repository:\s+(?!\$\{\{)[^\s]+\/[^\s]+/);
  assert.doesNotMatch(privateJob, /https:\/\/api\.github\.com\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\//);
  assert.match(privateJob, /token: \$\{\{ secrets\.PRIVATE_TESTS_READ_TOKEN \}\}/);
  assert.doesNotMatch(privateJob, /PRIVATE_TESTS_DEPLOY_KEY|ssh-key:/);
  assert.match(privateJob, /persist-credentials: false/);
  assert.match(privateJob, /npm run test:private/);
  assert.match(privateJob, /RUNNER_TEMP\/private-regressions-unit\.log/);
  assert.match(privateJob, /RUNNER_TEMP\/private-regressions-browser\.log/);
  assert.doesNotMatch(privateJob, /repository_dispatch|PUBLIC_STATUS_TOKEN|upload-artifact/);
});

test('real releases require the latest trusted main CI private job on the exact tagged commit', () => {
  const release = read('.github/workflows/release.yml');
  assert.match(release, /private-regressions/);
  assert.match(release, /actions: read/);
  assert.match(release, /actions\/workflows\/ci\.yml\/runs\?event=push&branch=main&head_sha=\$\{SHA\}/);
  assert.match(release, /\.head_sha == \$sha and \.event == "push" and \.head_branch == "main"/);
  assert.match(release, /actions\/runs\/\$\{RUN_ID\}\/jobs\?filter=latest/);
  assert.match(release, /SHARD_JOBS=/);
  assert.match(release, /sort_by\(\.id\) \| last/);
  assert.match(release, /group_by\(\.index\)/);
  assert.match(release, /length == 20/);
  assert.match(release, /\[range\(1; 21\)\]/);
  assert.match(release, /all\(\.\[\]; \.conclusion == "success"\)/);
  assert.match(release, /any\(\.\[\]; \.conclusion != null and \.conclusion != "success"\)/);
  assert.doesNotMatch(release, /\.name == "private-regressions"/);
  assert.doesNotMatch(release, /check-runs|statuses\?per_page|PRIVATE_TESTS_STATUS_ACTOR|PRIVATE_TESTS_APP_ID/);
});
