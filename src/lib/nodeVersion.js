'use strict';

// Keep this file's syntax conservative — it must PARSE on old Node versions
// (Ubuntu's default apt repo ships Node 18) so the friendly message below is
// what the user sees, not a SyntaxError from a dependency.

const MIN_MAJOR = 20;

/**
 * Check a Node.js version string against the package's engines floor.
 *
 * @param {string} version - e.g. process.versions.node ('18.19.1')
 * @returns {{ok: boolean, major: number, message: string|null}}
 */
function checkNodeVersion(version) {
    const major = parseInt(String(version).split('.')[0], 10) || 0;
    if (major >= MIN_MAJOR) {
        return { ok: true, major, message: null };
    }
    const message = [
        `relayer-mcp requires Node.js ${MIN_MAJOR} or newer — you are running v${version}.`,
        '',
        "Ubuntu's default apt repository only ships Node 18. Install Node 20 with nvm:",
        '',
        '  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash',
        '  \\. "$HOME/.nvm/nvm.sh" && nvm install 20',
        '',
        'Or via NodeSource: https://github.com/nodesource/distributions#installation-instructions',
        '',
    ].join('\n');
    return { ok: false, major, message };
}

module.exports = { checkNodeVersion, MIN_MAJOR };
