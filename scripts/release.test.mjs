import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './release-command.mjs';

const source = fileURLToPath(new URL('..', import.meta.url));
const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
const realNpm = execFileSync('which', ['npm'], { encoding: 'utf8' }).trim();
const temporary = [];
afterEach(() => { while (temporary.length) { rmSync(temporary.pop(), { recursive: true, force: true }); } });
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

// Only git's URL display is substituted. All git reads, commits, tags and pushes
// use real git against a disposable local bare remote, never GitHub.
function gitShim() {
    const fs = require('node:fs');
    const { spawnSync } = require('node:child_process');
    const a = process.argv.slice(2);
    fs.appendFileSync(process.env.TEST_LOG, JSON.stringify(['git', ...a]) + '\n');
    const state = JSON.parse(fs.readFileSync(process.env.TEST_STATE));
    if (a.join(' ') === 'remote get-url origin') {
        console.log(state.wrongOrigin ? 'git@github.com:someone/else.git' : 'git@github.com:Papersync/obsidian-papersync.git');
        return;
    }
    if (state.failPush && a.includes('push')) { process.exit(1); }
    if (state.failFetch && a[0] === 'fetch') { process.exit(1); }
    if (state.remoteMoved && a[0] === 'ls-remote' && a.includes('--heads')) {
        console.log('f'.repeat(40) + '\trefs/heads/master'); return;
    }
    const result = spawnSync(process.env.REAL_GIT, a, { stdio: 'inherit' });
    process.exit(result.status ?? 1);
}

function npmShim() {
    const fs = require('node:fs');
    const { spawnSync } = require('node:child_process');
    const a = process.argv.slice(2);
    fs.appendFileSync(process.env.TEST_LOG, JSON.stringify(['npm', ...a]) + '\n');
    const state = JSON.parse(fs.readFileSync(process.env.TEST_STATE));
    if (a[0] === 'version') {
        const result = spawnSync(process.env.REAL_NPM, a, { stdio: 'inherit' });
        process.exit(result.status ?? 1);
    }
    process.exit(a[1] === state.failCheck ? 1 : 0);
}

function ghShim() {
    const fs = require('node:fs');
    const path = require('node:path');
    const { execFileSync } = require('node:child_process');
    const a = process.argv.slice(2);
    const state = JSON.parse(fs.readFileSync(process.env.TEST_STATE));
    fs.appendFileSync(process.env.TEST_LOG, JSON.stringify(['gh', ...a]) + '\n');
    const value = (flag) => a[a.indexOf(flag) + 1];
    const head = () => execFileSync(process.env.REAL_GIT, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const print = (obj) => console.log(JSON.stringify(obj));
    if (a[0] === 'api') {
        if (a[1].includes('/releases/tags/')) {
            // Mirrors GitHub: this endpoint never returns drafts.
            print({ status: '404', message: 'Not Found' }); process.exit(1);
        }
        if (!a[1].includes('/releases?')) { print({ default_branch: state.defaultBranch ?? 'master' }); return; }
        if (state.apiError) {
            print({ status: String(state.apiError), message: 'fixture response' }); process.exit(1);
        }
        print(state.release ? [{ tag_name: 'other' }, state.release] : []); return;
    }
    if (a[0] === 'run' && a[1] === 'list') {
        state.requestedSha = value('--commit');
        fs.writeFileSync(process.env.TEST_STATE, JSON.stringify(state));
        const release = value('--workflow') === 'release.yml';
        const status = (release ? state.releaseStatus : state.verifyStatus) ?? 'completed';
        const conclusion = (release ? state.releaseConclusion : state.verifyConclusion) ?? 'success';
        print(state.noRuns ? [] : [{ databaseId: release ? 2 : 1, headSha: state.wrongSha ? 'f'.repeat(40) : value('--commit'), status, conclusion }]);
        return;
    }
    if (a[0] === 'run' && a[1] === 'view') {
        const release = a[2] === '2';
        const sha = state.requestedSha ?? head();
        print({ headSha: state.wrongDetailSha ? 'f'.repeat(40) : sha, status: 'completed', conclusion: 'success',
            jobs: (release ? ['build', 'publish'] : ['verify', 'e2e']).filter((name) => name !== state.missingJob).map((name) => ({ name,
                status: 'completed', conclusion: name === state.skippedJob ? 'skipped' : 'success' })) });
        return;
    }
    if (a[0] === 'release' && a[1] === 'download') {
        const content = execFileSync(process.env.REAL_GIT, ['show', `${state.tagSha ?? head()}:manifest.json`], { encoding: 'utf8' });
        fs.writeFileSync(path.join(value('--dir'), 'manifest.json'), state.badManifest ? '{"version":"0.0.0"}' : content);
        return;
    }
    if (a[0] === 'release' && a[1] === 'edit') { process.exit(state.publishFailure ? 1 : 0); }
    throw new Error('Unexpected GitHub command: ' + a.join(' '));
}

function fixture(defaultBranch = 'master') {
    const temp = mkdtempSync(path.join(tmpdir(), 'papersync-release-test-'));
    temporary.push(temp);
    const dir = path.join(temp, 'checkout'); const bare = path.join(temp, 'origin.git'); const bin = path.join(temp, 'bin');
    mkdirSync(dir); mkdirSync(bin); mkdirSync(path.join(dir, 'scripts'));
    const stateFile = path.join(temp, 'state.json'); const log = path.join(temp, 'commands.jsonl');
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Papersync', GIT_AUTHOR_EMAIL: 'contact@papersync.ai',
        GIT_COMMITTER_NAME: 'Papersync', GIT_COMMITTER_EMAIL: 'contact@papersync.ai',
        npm_config_update_notifier: 'false', npm_config_audit: 'false', NPM_CONFIG_USERCONFIG: '/dev/null',
        REAL_GIT: realGit, REAL_NPM: realNpm, TEST_STATE: stateFile, TEST_LOG: log };
    const git = (...args) => execFileSync(realGit, args, { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    for (const name of ['release.sh', 'release.mjs', 'release-command.mjs']) { copyFileSync(path.join(source, 'scripts', name), path.join(dir, 'scripts', name)); }
    copyFileSync(path.join(source, 'version-bump.mjs'), path.join(dir, 'version-bump.mjs'));
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'release-fixture', version: '0.1.4', type: 'module', scripts: { version: 'node version-bump.mjs && git add manifest.json versions.json README.md' } }));
    writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ name: 'release-fixture', version: '0.1.4', lockfileVersion: 3, packages: { '': { name: 'release-fixture', version: '0.1.4' } } }));
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id: 'papersync', version: '0.1.4', minAppVersion: '1.13.4' }));
    writeFileSync(path.join(dir, 'versions.json'), JSON.stringify({ '0.1.4': '1.13.4' }));
    writeFileSync(path.join(dir, 'README.md'), '<img alt="Version 0.1.4" src="https://img.shields.io/badge/version-0.1.4-blue">');
    git('init', '-b', defaultBranch); git('config', 'user.name', 'Papersync'); git('config', 'user.email', 'contact@papersync.ai');
    git('add', '.'); git('commit', '-m', 'fixture baseline');
    execFileSync(realGit, ['init', '--bare', bare], { env, stdio: 'ignore' });
    git('remote', 'add', 'origin', bare); git('push', '-u', 'origin', defaultBranch);
    const state = { defaultBranch };
    writeFileSync(stateFile, JSON.stringify(state)); writeFileSync(log, '');
    for (const [name, fn] of [['git', gitShim], ['npm', npmShim], ['gh', ghShim]]) {
        writeFileSync(path.join(bin, name), `#!/usr/bin/env node\n(${fn.toString()})();\n`, { mode: 0o755 });
    }
    env.PATH = `${bin}${path.delimiter}${env.PATH}`;
    const configure = (changes) => { Object.assign(state, changes); writeFileSync(stateFile, JSON.stringify(state)); };
    const cli = (...args) => {
        const result = spawnSync('bash', [path.join(dir, 'scripts/release.sh'), ...args], { cwd: dir, env, encoding: 'utf8', timeout: 15_000 });
        assert.ifError(result.error);
        return { ...result, output: result.stdout + result.stderr };
    };
    const commands = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    return { temp, dir, bare, env, git, cli, configure, commands,
        change: (name, content) => writeFileSync(path.join(dir, name), content),
        commit: () => { git('add', '.'); git('commit', '-m', 'fixture change'); },
        tag: () => { const sha = git('rev-parse', 'HEAD'); git('tag', '-a', '0.1.4', '-m', '0.1.4'); git('push', 'origin', 'refs/tags/0.1.4'); configure({ tagSha: sha }); return sha; } };
}

function succeeds(result) { assert.equal(result.status, 0, result.output); }
function fails(result, pattern) { assert.notEqual(result.status, 0, result.output); assert.match(result.output, pattern); }
const isGitPush = (a) => a[0] === 'git' && a.includes('push');
const noRemoteWrites = (f) => assert.deepEqual(f.commands().filter((a) => isGitPush(a) || (a[0] === 'gh' && a[1] === 'release' && a[2] === 'edit')), []);
const draftRelease = () => ({ tag_name: '0.1.4', draft: true, prerelease: false, body: 'Reviewed release notes.', assets: ['main.js', 'manifest.json', 'styles.css'].map((name) => ({ name, size: 100 })) });

test('no arguments and help do not mutate or contact GitHub', () => {
    const f = fixture(); succeeds(f.cli()); succeeds(f.cli('--help')); assert.deepEqual(f.commands(), []);
});

test('prepare performs the real version lifecycle, commits as Papersync and never tags or pushes', () => {
    const f = fixture(); f.git('switch', '-c', 'release/next');
    f.env.GIT_AUTHOR_NAME = 'Wrong identity'; f.env.GIT_COMMITTER_EMAIL = 'wrong@example.invalid';
    succeeds(f.cli('prepare', 'patch'));
    for (const name of ['package.json', 'package-lock.json', 'manifest.json']) { assert.equal(readJson(path.join(f.dir, name)).version, '0.1.5'); }
    assert.equal(readJson(path.join(f.dir, 'versions.json'))['0.1.5'], '1.13.4');
    assert.match(readFileSync(path.join(f.dir, 'README.md'), 'utf8'), /version-0\.1\.5-blue/);
    assert.equal(f.git('log', '-1', '--format=%an <%ae>|%cn <%ce>'), 'Papersync <contact@papersync.ai>|Papersync <contact@papersync.ai>');
    assert.equal(f.git('tag'), ''); assert.equal(f.git('status', '--porcelain'), ''); noRemoteWrites(f);
    assert(f.commands().some((a) => a.join(' ') === 'npm run test:coverage'));
});

test('prepare refuses the default branch and stops before a version change', () => {
    const f = fixture(); fails(f.cli('prepare', 'patch'), /release branch/); assert.equal(f.git('tag'), ''); noRemoteWrites(f);
});

test('prepare minor stays on 0.x', () => {
    const f = fixture(); f.git('switch', '-c', 'release/next'); succeeds(f.cli('prepare', 'minor'));
    assert.equal(readJson(path.join(f.dir, 'manifest.json')).version, '0.2.0'); noRemoteWrites(f);
});

test('prepare refuses a second bump on an already-bumped branch', () => {
    const f = fixture(); f.git('switch', '-c', 'release/next'); succeeds(f.cli('prepare', 'patch'));
    fails(f.cli('prepare', 'patch'), /already has a version bump/); noRemoteWrites(f);
});

test('failed local coverage stops prepare before the bump', () => {
    const f = fixture(); f.git('switch', '-c', 'release/next'); f.configure({ failCheck: 'test:coverage' });
    fails(f.cli('prepare', 'patch'), /npm failed/); assert.equal(readJson(path.join(f.dir, 'manifest.json')).version, '0.1.4'); noRemoteWrites(f);
});

test('draft handles already-bumped 0.1.4, pushing only its exact annotated tag', () => {
    const f = fixture(); succeeds(f.cli('draft', '0.1.4'));
    assert.equal(f.git('cat-file', '-t', '0.1.4'), 'tag');
    assert.equal(f.git('for-each-ref', '--format=%(taggername) <%(taggeremail:trim)>', 'refs/tags/0.1.4'), 'Papersync <contact@papersync.ai>');
    assert.deepEqual(f.commands().filter(isGitPush), [['git', '-c', 'push.followTags=false', 'push', 'origin', 'refs/tags/0.1.4']]);
    assert.equal(readJson(path.join(f.dir, 'manifest.json')).version, '0.1.4');
    assert(!f.commands().some((a) => a[0] === 'npm' || a.includes('edit')));
});

test('default branch discovery also supports main', () => {
    const f = fixture('main'); succeeds(f.cli('draft', '0.1.4'));
});

for (const [name, state, pattern] of [
    ['pending verification', { verifyStatus: 'in_progress', verifyConclusion: '' }, /must pass/],
    ['failed verification', { verifyConclusion: 'failure' }, /must pass/],
    ['no verification run', { noRuns: true }, /must pass/],
    ['a different source run', { wrongSha: true }, /must pass/],
    ['a substituted run detail', { wrongDetailSha: true }, /exact source/],
    ['skipped E2E', { skippedJob: 'e2e' }, /e2e must pass/],
    ['missing E2E', { missingJob: 'e2e' }, /e2e must pass/],
    ['release API access failure', { apiError: 403 }, /GitHub request failed/],
    ['remote default moving', { remoteMoved: true }, /default branch moved/],
    ['fetch failure', { failFetch: true }, /git failed/],
    ['wrong repository', { wrongOrigin: true }, /origin must point/],
]) {
    test(`draft refuses ${name} without remote writes`, () => {
        const f = fixture(); f.configure(state); fails(f.cli('draft', '0.1.4'), pattern); assert.equal(f.git('tag'), ''); noRemoteWrites(f);
    });
}

test('draft requires clean, merged default-branch source and matching metadata', () => {
    const f = fixture(); f.change('untracked', 'dirty'); fails(f.cli('draft', '0.1.4'), /clean/);
    f.commit(); fails(f.cli('draft', '0.1.4'), /pull the merged/);
    f.git('push', 'origin', 'master');
    f.change('versions.json', '{}'); f.commit(); f.git('push', 'origin', 'master');
    fails(f.cli('draft', '0.1.4'), /versions.json/); noRemoteWrites(f);
});

test('a tag push can resume without recreating the local tag', () => {
    const f = fixture(); f.configure({ failPush: true }); fails(f.cli('draft', '0.1.4'), /git failed/);
    const tag = f.git('rev-parse', 'refs/tags/0.1.4'); f.configure({ failPush: false }); succeeds(f.cli('draft', '0.1.4'));
    assert.equal(f.git('rev-parse', 'refs/tags/0.1.4'), tag);
    assert.equal(f.commands().filter((a) => a.includes('tag') && a.includes('-a')).length, 1);
});

test('existing tags are reused only on the same source and published releases are untouched', () => {
    const f = fixture(); f.tag(); succeeds(f.cli('draft', '0.1.4')); noRemoteWrites(f);
    f.change('new-source', 'new'); f.commit(); f.git('push', 'origin', 'master');
    fails(f.cli('draft', '0.1.4'), /remote tag.*different source/); noRemoteWrites(f);
    const other = fixture(); other.configure({ release: { ...draftRelease(), draft: false } });
    fails(other.cli('draft', '0.1.4'), /already published/); noRemoteWrites(other);
});

test('a conflicting local tag is never moved', () => {
    const f = fixture(); f.git('tag', '0.1.4'); f.change('new-source', 'new'); f.commit(); f.git('push', 'origin', 'master');
    fails(f.cli('draft', '0.1.4'), /local tag.*different source/); noRemoteWrites(f);
});

test('publish checks CI and assets, then publishes exactly the reviewed draft', () => {
    const f = fixture(); f.tag(); f.configure({ release: draftRelease() }); succeeds(f.cli('publish', '0.1.4'));
    assert.deepEqual(f.commands().filter((a) => a[1] === 'release' && a[2] === 'edit'), [['gh', 'release', 'edit', '0.1.4', '--draft=false', '--latest', '--repo', 'Papersync/obsidian-papersync']]);
    const download = f.commands().find((a) => a[1] === 'release' && a[2] === 'download');
    assert(!existsSync(download[download.indexOf('--dir') + 1]));
    assert(!f.commands().some((a) => isGitPush(a) || a[0] === 'npm'));
});

test('publish follows the tested tag even after the default branch advances', () => {
    const f = fixture(); f.tag(); f.configure({ release: draftRelease() });
    f.change('later-work', 'new default branch source'); f.commit(); f.git('push', 'origin', 'master');
    succeeds(f.cli('publish', '0.1.4'));
});

for (const [name, state, pattern] of [
    ['a missing draft', { release: null }, /run the draft stage first/],
    ['empty notes', { release: { ...draftRelease(), body: ' ' } }, /notes first/],
    ['a missing asset', { release: { ...draftRelease(), assets: [] } }, /asset/],
    ['a published release', { release: { ...draftRelease(), draft: false } }, /unpublished normal draft/],
    ['a prerelease', { release: { ...draftRelease(), prerelease: true } }, /unpublished normal draft/],
    ['a wrong manifest asset', { badManifest: true }, /manifest asset differs/],
    ['a failed Release workflow', { releaseConclusion: 'failure' }, /release.yml must pass/],
    ['a skipped Release build', { skippedJob: 'build' }, /build must pass/],
    ['skipped Verify E2E', { skippedJob: 'e2e' }, /e2e must pass/],
]) {
    test(`publish refuses ${name}`, () => {
        const f = fixture(); f.tag(); f.configure({ release: draftRelease(), ...state });
        fails(f.cli('publish', '0.1.4'), pattern); noRemoteWrites(f);
        const download = f.commands().find((a) => a[1] === 'release' && a[2] === 'download');
        if (download) { assert(!existsSync(download[download.indexOf('--dir') + 1])); }
    });
}

test('publish refuses an absent remote tag', () => {
    const f = fixture(); fails(f.cli('publish', '0.1.4'), /does not exist/); noRemoteWrites(f);
});

test('invalid and legacy command forms fail without remote writes', () => {
    const f = fixture();
    for (const a of [['patch'], ['prepare', 'major'], ['draft'], ['draft', 'v0.1.4'], ['draft', '1.0.0'], ['publish', '0.1.4', 'extra']]) {
        assert.notEqual(f.cli(...a).status, 0);
    }
    assert.deepEqual(f.commands(), []);
});

test('command timeout stops its child process', async () => {
    const temp = mkdtempSync(path.join(tmpdir(), 'papersync-release-timeout-')); temporary.push(temp);
    const pidFile = path.join(temp, 'pid');
    await assert.rejects(run(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`], { timeout: 500 }), /exceeded/);
    if (existsSync(pidFile)) { assert.throws(() => process.kill(Number(readFileSync(pidFile, 'utf8')), 0), { code: 'ESRCH' }); }
});

test('command timeout also stops the grandchildren in its owned group', async () => {
    const temp = mkdtempSync(path.join(tmpdir(), 'papersync-release-group-')); temporary.push(temp);
    const pidFile = path.join(temp, 'pid');
    const code = `const child = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'}); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); setInterval(() => {}, 1000);`;
    await assert.rejects(run(process.execPath, ['-e', code], { timeout: 1_000 }), /exceeded/);
    assert(existsSync(pidFile), 'child must start before testing group teardown');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    const deadline = Date.now() + 2_000; // Allow init to reap the killed grandchild.
    let alive = true;
    while (alive && Date.now() < deadline) {
        try { process.kill(pid, 0); await new Promise((resolve) => setTimeout(resolve, 25)); }
        catch (error) { if (error.code === 'ESRCH') { alive = false; } else { throw error; } }
    }
    assert.equal(alive, false, 'grandchild must not survive a timeout');
});

test('missing command reports a startup error without leaving timers behind', async () => {
    await assert.rejects(run('/nonexistent/papersync-release-command', []), { code: 'ENOENT' });
});
