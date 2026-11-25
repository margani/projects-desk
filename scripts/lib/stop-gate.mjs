// The Claude Code Stop hook (#49): a session must not close with "Task done"
// while its project has issues it could still finish. A written rule alone did
// not stop that.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { repoSlug } from './issues.mjs';

export const WAITING_LABELS = ['needs-owner', 'awaiting-release', 'other-session'];
// Claude Code's own cap on continuations resets at every tool call, so it does
// not end a session that works a little and closes again.
const MAX_WITHOUT_PROGRESS = 3;
const MAX_IN_A_ROW = 15;
// A home or "all projects" folder is not one project.
const MAX_CHILDREN = 6;

/**
 * Only the last lines count, and quoted or fenced text does not: a reply that
 * explains the closing line must not be treated as one.
 */
export function isClosing(message) {
  const lines = String(message ?? '')
    .replace(/```[\s\S]*?(```|$)/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-3)
    .filter((l) => !l.startsWith('>'))
    .map((l) => l.replace(/"[^"]*"|“[^”]*”|«[^»]*»/g, '').replace(/[*_`]/g, ''));
  return lines.some((l) => /\btask (is )?(done|complete)\b.{0,60}?(fresh session|new session|\/clear)/i.test(l)
    || /\bstart the next (one|task) in a (fresh|new) session\b/i.test(l)
    || /^task (is )?done[.!]?$/i.test(l)
    || /\bI(['’]m| am) (not waiting for anything|waiting for nothing)\b/i.test(l));
}

const run = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 15_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
    if (error) reject(new Error(String(stderr || error.message).trim().split('\n')[0]));
    else resolve(stdout);
  });
});

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

const slugOfRemote = (url) => /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url.trim())?.[1] ?? null;

async function originSlug(dir) {
  try {
    return slugOfRemote(await run('git', ['-C', dir, 'remote', 'get-url', 'origin']));
  } catch {
    return null;
  }
}

/** True for a folder that is, or is inside, a git checkout. */
async function isCheckout(dir) {
  try {
    await run('git', ['-C', dir, 'rev-parse', '--show-toplevel']);
    return true;
  } catch {
    return false;
  }
}

/**
 * The GitHub repositories of a project folder. A folder that only holds
 * checkouts is answered by its status file, then by the child of the same name,
 * then by all its children.
 */
export async function findRepos(root, statusDir) {
  if (await isCheckout(root)) {
    const slug = await originSlug(root);
    return slug ? [slug] : [];
  }
  const fromStatus = repoSlug(readJson(join(statusDir, `${basename(root)}.json`))?.repo_url);
  if (fromStatus) return [fromStatus];
  let children;
  try {
    children = readdirSync(root).filter((name) => {
      try {
        return statSync(join(root, name)).isDirectory() && existsSync(join(root, name, '.git'));
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
  if (children.includes(basename(root))) children = [basename(root)];
  if (children.length > MAX_CHILDREN) return [];
  const slugs = await Promise.all(children.map((name) => originSlug(join(root, name))));
  return [...new Set(slugs.filter(Boolean))];
}

function ownerTaskUrls(statusDir, root) {
  const tasks = readJson(join(statusDir, `${basename(root)}.json`))?.owner_tasks;
  return new Set((Array.isArray(tasks) ? tasks : []).map((t) => t?.url).filter(Boolean));
}

/** Open issues of one repository that nobody else is holding. */
async function openWork(slug, { gh, owner, ownerTasks }) {
  const permission = JSON.parse(await gh(['repo', 'view', slug, '--json', 'viewerPermission'])).viewerPermission;
  // Someone else's project, cloned to read or to send a patch.
  if (permission === 'READ' || permission === 'NONE') return [];
  let list;
  try {
    list = JSON.parse(await gh(['issue', 'list', '-R', slug, '--state', 'open', '--limit', '200', '--json', 'number,title,url,assignees,labels']));
  } catch (error) {
    if (/disabled issues/i.test(error.message)) return [];
    throw error;
  }
  return list.filter((i) => !i.assignees.some((a) => a.login.toLowerCase() === owner)
    && !i.labels.some((l) => WAITING_LABELS.includes(l.name.toLowerCase()))
    && !ownerTasks.has(i.url));
}

function reasonFor(issues, owner) {
  const shown = issues.slice(0, 30).map((i) => `- ${i.url} ${i.title.slice(0, 120)}`);
  if (issues.length > shown.length) shown.push(`- and ${issues.length - shown.length} more`);
  return [
    `Stop blocked: this project has ${issues.length} open issue(s) that are not waiting on anyone else, so this is not the end of the task.`,
    ...shown,
    'Do them now. Only where it is true, mark an issue as waiting instead:',
    `- it needs the owner or their decision: assign ${owner}, add the label needs-owner, and ask with AskUserQuestion;`,
    '- it is fixed and the owner was asked to approve the release: label awaiting-release;',
    '- another session is working on it right now: label other-session and say which in a comment.',
    'Do not just reword or drop the closing line to get past this check.',
  ].join('\n');
}

/**
 * Returns the hook's JSON answer, or null to stay out of the way. Everything
 * that cannot be checked lets the session stop, with a warning the user sees.
 */
export async function runGate(input, { gh, owner, stateDir, statusDir, projectDir }) {
  if (!isClosing(input.last_assistant_message)) return null;
  const warn = (text) => ({ systemMessage: `stop-gate: ${text}` });
  const root = projectDir || input.cwd;
  const issues = [];
  const failures = [];
  let login = owner;
  try {
    const repos = await findRepos(root, statusDir);
    if (!repos.length) return null;
    login = (login || (await gh(['api', 'user', '-q', '.login']))).trim().toLowerCase();
    const ownerTasks = ownerTaskUrls(statusDir, root);
    for (const slug of repos) {
      try {
        issues.push(...await openWork(slug, { gh, owner: login, ownerTasks }));
      } catch (error) {
        failures.push(`${slug}: ${error.message}`);
      }
    }
  } catch (error) {
    failures.push(error.message);
  }

  const stateFile = join(stateDir, `${String(input.session_id).replace(/[^\w-]/g, '_')}.json`);
  const before = readJson(stateFile) ?? { urls: [], stuck: 0, total: 0 };
  const save = (state) => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(stateFile, JSON.stringify(state));
  };
  const notChecked = failures.length ? `open issues were not checked (${failures.join('; ')})` : null;

  if (!issues.length) {
    if (notChecked) return warn(notChecked);
    try {
      if (before.total) save({ urls: [], stuck: 0, total: 0 });
    } catch (error) {
      return warn(`could not reset the block count (${error.message})`);
    }
    return null;
  }

  const urls = issues.map((i) => i.url);
  const progressed = before.urls.some((url) => !urls.includes(url));
  const stuck = progressed ? 0 : before.stuck;
  const stillOpen = `${urls.length} issue(s) still open: ${urls.slice(0, 10).join(' ')}`;
  if (stuck >= MAX_WITHOUT_PROGRESS || before.total >= MAX_IN_A_ROW) {
    return warn(`gave up after ${before.total} block(s). The session stopped with ${stillOpen}`);
  }
  try {
    save({ urls, stuck: stuck + 1, total: before.total + 1 });
  } catch (error) {
    // Without a count, blocking again could go on for ever.
    if (input.stop_hook_active) return warn(`could not save the block count (${error.message}); ${stillOpen}`);
  }
  return {
    decision: 'block',
    reason: reasonFor(issues, login),
    ...(notChecked ? warn(notChecked) : {}),
  };
}

export const ghWith = (bin) => (args) => run(bin, args);
