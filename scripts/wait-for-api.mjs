// Waits for the API before `pnpm dev` starts the web server, so a tab left open does not fill the log with refused connections while the server is still compiling. Gives up after a minute and lets Vite start anyway, so a server that fails to start still leaves the page reachable to say so.
const target = process.env.RT511_API ?? 'http://127.0.0.1:8511';
const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  const up = await fetch(`${target}/api/regions`).then((response) => response.ok, () => false);
  if (up) process.exit(0);
  await new Promise((resolve) => setTimeout(resolve, 500));
}
console.warn(`no API at ${target} after a minute; starting the web server anyway`);
