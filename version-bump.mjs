import { readFileSync, writeFileSync } from "fs";

const targetVersion = process.env.npm_package_version;

// read minAppVersion from manifest.json and bump version to target version
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
// Trailing newline: every other file in the repo ends with one, and without it
// each release re-adds a "No newline at end of file" diff.
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t") + "\n");

// update versions.json with target version and minAppVersion from manifest.json
// but only if the target version is not already in versions.json
const versions = JSON.parse(readFileSync('versions.json', 'utf8'));
if (!(targetVersion in versions)) {
    versions[targetVersion] = minAppVersion;
    writeFileSync('versions.json', JSON.stringify(versions, null, '\t') + '\n');
}

// keep the README version badge in step with manifest.json. A shields.io
// dynamic badge cannot read a private repo, so the badge is static and bumped here.
const readme = readFileSync('README.md', 'utf8');
writeFileSync(
    'README.md',
    readme.replace(
        /alt="Version [^"]*" src="https:\/\/img\.shields\.io\/badge\/version-[^"]*"/,
        `alt="Version ${targetVersion}" src="https://img.shields.io/badge/version-${targetVersion}-blue"`,
    ),
);
