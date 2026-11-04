// Stand-in until infra-3's data-access helper lands. On AWS the agent reaches
// the data through the public sandbox URL, which needs the team login. Delete
// this file and its call in server.mjs once the executors take that helper.
export function withTeamLogin(fetchImpl, { origin, username, password }) {
  if (!origin || !username || !password) return fetchImpl;
  const allowed = new URL(origin).origin;
  const authorization = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  return (input, init = {}) => {
    const target = new URL(input?.url ?? input);
    if (target.origin !== allowed) return fetchImpl(input, init);
    const headers = new Headers(init.headers);
    headers.set('authorization', authorization);
    return fetchImpl(input, { ...init, headers });
  };
}

export function installTeamLogin(env = process.env) {
  globalThis.fetch = withTeamLogin(globalThis.fetch, {
    origin: env.VIRTUAL_LAB_ORIGIN,
    username: env.SANDBOX_ACCESS_USERNAME,
    password: env.SANDBOX_ACCESS_PASSWORD,
  });
}
