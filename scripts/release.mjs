import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { run } from './release-command.mjs';

const REPO = 'Papersync/obsidian-papersync';
const identity = {
    GIT_AUTHOR_NAME: 'Papersync', GIT_AUTHOR_EMAIL: 'contact@papersync.ai',
    GIT_COMMITTER_NAME: 'Papersync', GIT_COMMITTER_EMAIL: 'contact@papersync.ai',
};
const gitIdentity = ['-c', 'user.name=Papersync', '-c', 'user.email=contact@papersync.ai'];
process.chdir(fileURLToPath(new URL('..', import.meta.url)));

function insist(condition, message) { if (!condition) { throw new Error(message); } }
function version(value) {
    insist(/^0\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value ?? ''), 'use an exact 0.x.y version without a v prefix');
    insist(value.split('.').every((part) => Number.isSafeInteger(Number(part))), 'version is too large');
    return value;
}
const json = (text) => JSON.parse(text);
async function command(name, args, options) {
    const result = await run(name, args, options);
    insist(result.status === 0, `${name} failed: ${result.stderr || result.stdout}`);
    return result.stdout;
}
const git = (...args) => command('git', args);
const gh = (...args) => command('gh', [...args, '--repo', REPO]);

async function api(endpoint) {
    const result = await run('gh', ['api', `repos/${REPO}${endpoint}`]);
    if (result.status !== 0) {
        throw new Error(`GitHub request failed: ${result.stderr || result.stdout}`);
    }
    return json(result.stdout);
}

// GitHub's /releases/tags/{tag} endpoint never returns draft releases, so a
// draft is found by listing releases (drafts included for repo writers).
async function releaseByTag(value) {
    const releases = await api('/releases?per_page=100');
    insist(Array.isArray(releases), 'unexpected GitHub releases response');
    return releases.find((release) => release.tag_name === value) ?? null;
}

function metadata(read, expected) {
    const manifest = json(read('manifest.json'));
    const pkg = json(read('package.json'));
    const lock = json(read('package-lock.json'));
    const history = json(read('versions.json'));
    insist(manifest.id === 'papersync', 'manifest must keep the papersync plugin ID');
    const value = version(manifest.version);
    insist(!expected || value === expected, `manifest version is ${value}, expected ${expected}`);
    insist([pkg.version, lock.version, lock.packages?.['']?.version].every((v) => v === value), 'package, lockfile and manifest versions disagree');
    insist(history[value] === manifest.minAppVersion, 'versions.json does not match minAppVersion');
    return manifest;
}

async function repository() {
    insist(!(await git('status', '--porcelain')), 'working tree must be clean');
    const remote = await git('remote', 'get-url', 'origin');
    insist(/^(git@github\.com:|https:\/\/github\.com\/)Papersync\/obsidian-papersync(?:\.git)?$/i.test(remote), `origin must point to ${REPO}`);
    const info = await api('');
    insist(typeof info.default_branch === 'string' && info.default_branch, 'GitHub did not return the default branch');
    return info.default_branch;
}

async function passedWorkflow(workflow, branch, sha, requiredJobs) {
    const runs = json(await gh('run', 'list', '--workflow', workflow, '--branch', branch, '--commit', sha,
        '--event', 'push', '--limit', '20', '--json', 'databaseId,headSha,status,conclusion'));
    const latest = runs.find((item) => item.headSha === sha);
    insist(latest?.status === 'completed' && latest.conclusion === 'success', `${workflow} must pass on ${sha}; wait for CI or fix its failure`);
    const detail = json(await gh('run', 'view', String(latest.databaseId), '--json', 'headSha,status,conclusion,jobs'));
    insist(detail.headSha === sha && detail.status === 'completed' && detail.conclusion === 'success', `${workflow} did not pass on the exact source`);
    for (const name of requiredJobs) {
        insist(detail.jobs?.some((job) => job.name === name && job.status === 'completed' && job.conclusion === 'success'), `${workflow}: ${name} must pass, not be skipped`);
    }
}

async function remoteTag(value) {
    const refs = (await git('ls-remote', '--tags', 'origin', `refs/tags/${value}`, `refs/tags/${value}^{}`))
        .split('\n').filter(Boolean).map((line) => line.split(/\s+/));
    return refs.find(([, ref]) => ref.endsWith('^{}'))?.[0] ?? refs[0]?.[0] ?? '';
}

async function prepare(bump) {
    insist(['patch', 'minor'].includes(bump), 'prepare accepts patch or minor; major releases are disabled');
    const defaultBranch = await repository();
    const branch = await git('branch', '--show-current');
    insist(branch && ![defaultBranch, 'master', 'main'].includes(branch), 'prepare on a release branch, not the default branch or detached HEAD');
    await git('fetch', '--quiet', 'origin', defaultBranch);
    const before = metadata((file) => readFileSync(file, 'utf8'));
    const merged = json(await git('show', `origin/${defaultBranch}:manifest.json`));
    insist(before.version === merged.version, 'this branch already has a version bump; finish its PR instead of bumping again');
    // Normal total is about two minutes. Each independent step has its own ceiling.
    for (const [script, timeout] of [['lint', 120_000], ['tsc', 180_000], ['test:release', 120_000], ['test:coverage', 300_000], ['build', 120_000]]) {
        console.log(`== ${script}`);
        await command('npm', ['run', script], { timeout, show: true });
    }
    await command('npm', ['version', bump, '--no-git-tag-version'], { timeout: 60_000, show: true });
    const after = metadata((file) => readFileSync(file, 'utf8'));
    insist(before.version !== after.version, 'npm did not bump the version');
    await git('add', 'package.json', 'package-lock.json', 'manifest.json', 'versions.json', 'README.md');
    await command('git', [...gitIdentity, 'commit', '-m', `chore(release): ${after.version}`], { env: identity, show: true });
    console.log(`Prepared ${after.version} on ${branch}. No tag or remote write was made.`);
    console.log(`Next: push this branch and open a PR into ${defaultBranch}, then wait for Verify and E2E before merging.`);
}

async function draft(value) {
    version(value);
    const defaultBranch = await repository();
    insist(await git('branch', '--show-current') === defaultBranch, `draft from the default branch (${defaultBranch})`);
    await git('fetch', '--quiet', 'origin', defaultBranch);
    const sha = await git('rev-parse', 'HEAD');
    insist(sha === await git('rev-parse', `origin/${defaultBranch}`), 'pull the merged default branch before creating a draft');
    metadata((file) => readFileSync(file, 'utf8'), value);
    await passedWorkflow('verify.yml', defaultBranch, sha, ['verify', 'e2e']);
    const existing = await releaseByTag(value);
    insist(!existing || (existing.draft === true && existing.prerelease === false), `${value} is already published or is a prerelease`);
    const remote = await remoteTag(value);
    insist(!remote || remote === sha, `remote tag ${value} points to different source; tags must never be moved`);
    const local = await run('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${value}^{commit}`]);
    insist(local.status === 0 || local.status === 1, 'could not inspect the local tag');
    insist(local.status !== 0 || local.stdout === sha, `local tag ${value} points to different source; tags must never be moved`);
    if (!remote) {
        const current = (await git('ls-remote', '--heads', 'origin', `refs/heads/${defaultBranch}`)).split(/\s+/)[0];
        insist(current === sha, 'the remote default branch moved; pull it and wait for its CI');
        if (local.status !== 0) {
            await command('git', [...gitIdentity, 'tag', '-a', value, sha, '-m', value], { env: identity });
        }
        await git('-c', 'push.followTags=false', 'push', 'origin', `refs/tags/${value}`);
        console.log(`Pushed only tag ${value}. Release will build a draft, not publish it.`);
    } else {
        console.log(`Tag ${value} is already on GitHub. No tag was recreated or pushed.`);
    }
    console.log(`Check https://github.com/${REPO}/actions/workflows/release.yml`);
    console.log('If that workflow failed, rerun the failed workflow; do not delete or move the tag.');
    console.log(`Review the draft notes and assets, then explicitly run: npm run release -- publish ${value}`);
}

async function publish(value) {
    version(value);
    const defaultBranch = await repository();
    const sha = await remoteTag(value);
    insist(sha, `remote tag ${value} does not exist`);
    // Fetch objects without updating local tags, so a local tag cannot substitute
    // source for the GitHub release we are about to publish.
    await git('fetch', '--quiet', '--no-tags', 'origin', `refs/tags/${value}`);
    const files = new Map();
    for (const name of ['manifest.json', 'package.json', 'package-lock.json', 'versions.json']) {
        files.set(name, await git('show', `${sha}:${name}`));
    }
    const manifest = metadata((name) => files.get(name), value);
    await passedWorkflow('verify.yml', defaultBranch, sha, ['verify', 'e2e']);
    await passedWorkflow('release.yml', value, sha, ['build', 'publish']);
    const release = await releaseByTag(value);
    insist(release, `no GitHub release for ${value}; run the draft stage first`);
    insist(release.tag_name === value && release.draft === true && release.prerelease === false, `${value} must be an unpublished normal draft`);
    insist(typeof release.body === 'string' && release.body.trim(), 'write and review the draft release notes first');
    for (const name of ['main.js', 'manifest.json', 'styles.css']) {
        insist(release.assets?.filter((asset) => asset.name === name && asset.size > 0).length === 1, `draft must contain one non-empty ${name} asset`);
    }
    const folder = mkdtempSync(path.join(tmpdir(), 'papersync-release-'));
    try {
        await gh('release', 'download', value, '--pattern', 'manifest.json', '--dir', folder);
        const asset = json(readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
        insist(isDeepStrictEqual(asset, manifest), 'release manifest asset differs from its tagged source');
    } finally { rmSync(folder, { recursive: true, force: true }); }
    // Running this explicit command confirms the operator reviewed notes/assets.
    await gh('release', 'edit', value, '--draft=false', '--latest');
    console.log(`Published ${value}: https://github.com/${REPO}/releases/tag/${value}`);
}

const usage = `Release stages (see RELEASING.md):
  npm run release -- prepare [patch|minor]  Local bump and commit on a release branch
  npm run release -- draft <0.x.y>         Tag tested merged source; request a draft
  npm run release -- publish <0.x.y>       Verify and publish a reviewed draft
No arguments or --help displays this help without changing anything.`;

try {
    const [stage, value, ...extra] = process.argv.slice(2);
    insist(extra.length === 0, usage);
    if (!stage || ['help', '--help', '-h'].includes(stage)) {
        insist(!value, usage);
        console.log(usage);
    } else if (stage === 'prepare') { await prepare(value ?? 'patch'); }
    else if (stage === 'draft') { await draft(value); }
    else if (stage === 'publish') { await publish(value); }
    else { throw new Error(usage); }
} catch (error) {
    console.error(`release: ${error.message}`);
    process.exitCode = 1;
}
