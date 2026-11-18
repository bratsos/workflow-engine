// Parallel Vitest processes all call a fixture's createSqlite* and share its one
// .generated directory; regenerating it while another process generates or loads
// it fails ("PrismaClient is not a constructor"), so generate once per input, under a lock.
const { createHash } = require("node:crypto");
const {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} = require("node:fs");
const { join } = require("node:path");

// A generation takes seconds. A lock whose owner process is gone is taken over
// at once; older than this it is taken over even if its owner is alive.
// shortcut: such a hung owner would delete its successor's lock when it wakes, ignore until it happens.
const STALE_MS = 5 * 60_000;

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const read = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch {}
};

function ownerGone(lock) {
  let owner;
  try {
    owner = JSON.parse(read(join(lock, "owner")));
  } catch {
    // The owner file is written just after mkdir: until then, judge by age only.
    try {
      owner = { at: statSync(lock).mtimeMs };
    } catch {
      return false; // released meanwhile
    }
  }
  if (Date.now() - owner.at > STALE_MS) return true;
  if (!owner.pid) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}

// Only the guard's holder removes a stale lock, after re-checking it, so two waiters
// that saw the same dead owner cannot remove each other's new lock.
function takeOver(lock) {
  const guard = `${lock}.takeover`;
  try {
    mkdirSync(guard);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    try {
      if (Date.now() - statSync(guard).mtimeMs > STALE_MS) rmSync(guard, { recursive: true });
    } catch {}
    return;
  }
  try {
    if (ownerGone(lock)) rmSync(lock, { recursive: true, force: true });
  } finally {
    rmSync(guard, { recursive: true, force: true });
  }
}

function withLock(dir, fn) {
  const lock = join(dir, ".lock");
  mkdirSync(dir, { recursive: true });
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    if (ownerGone(lock)) takeOver(lock);
    pause(100);
  }
  try {
    writeFileSync(join(lock, "owner"), JSON.stringify({ pid: process.pid, at: Date.now() }));
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

// Skips `generate` when the last successful run had the same inputs; the stamp is
// written only after success, so a failed or killed run is redone by the next caller.
function generateOnce(dir, inputs, generate) {
  const stamp = join(dir, ".stamp");
  // The output embeds its absolute path, so the directory is an input too.
  const key = createHash("sha256").update([dir, ...inputs].join("\0")).digest("hex");
  withLock(dir, () => {
    if (read(stamp) === key) return;
    rmSync(stamp, { force: true });
    generate();
    writeFileSync(stamp, key);
  });
}

module.exports = { generateOnce, withLock };
