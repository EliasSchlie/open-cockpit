// Shared poll-and-diff logic for `watch` and `term watch` commands.
// Usage: node watch-poll.js <intervalSec> <apiJson> <socketPath>

const net = require("net");
const interval = parseInt(process.argv[2]) * 1000;
const json = process.argv[3];
const sock = process.argv[4];

function stripAnsi(s) {
  return s
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b[()][AB012]/g, "")
    .replace(/\x1b\[?\??[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b[>=]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

function query() {
  return new Promise((resolve, reject) => {
    let buf = "";
    const c = net.createConnection(sock);
    c.on("connect", () => c.write(json + "\n"));
    c.on("data", (d) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i !== -1) {
        c.destroy();
        resolve(buf.slice(0, i));
      }
    });
    c.on("error", reject);
    setTimeout(() => {
      c.destroy();
      reject(new Error("timeout"));
    }, 5000);
  });
}

let prevLines = [];
async function poll() {
  try {
    const resp = JSON.parse(await query());
    if (resp.error) {
      process.stderr.write("Error: " + resp.error + "\n");
      process.exit(1);
    }
    const raw = resp.buffer || "";
    const clean = stripAnsi(raw)
      .split("\n")
      .map((l) => l.trimEnd());

    if (prevLines.length === 0) {
      process.stdout.write(clean.join("\n") + "\n");
    } else {
      // O(n) diff: find longest common suffix between prevLines tail and clean
      const maxCheck = Math.min(prevLines.length, clean.length);
      let common = 0;
      for (let i = 1; i <= maxCheck; i++) {
        if (prevLines[prevLines.length - i] === clean[clean.length - i]) {
          common = i;
        } else {
          break;
        }
      }
      if (common > 0) {
        const newEnd = clean.length - common;
        const prevEnd = prevLines.length - common;
        if (newEnd > prevEnd) {
          const newLines = clean.slice(prevEnd, newEnd);
          process.stdout.write(newLines.join("\n") + "\n");
        } else if (newEnd < prevEnd) {
          const newLines = clean.slice(0, newEnd);
          if (newLines.length > 0) {
            process.stdout.write(
              "\n--- buffer changed ---\n" + clean.join("\n") + "\n",
            );
          }
        }
      } else if (clean.join("\n") !== prevLines.join("\n")) {
        process.stdout.write(
          "\n--- buffer changed ---\n" + clean.join("\n") + "\n",
        );
      }
    }
    prevLines = clean;
  } catch (e) {
    process.stderr.write("Connection lost: " + e.message + "\n");
    process.exit(1);
  }
}

poll();
setInterval(poll, interval);
