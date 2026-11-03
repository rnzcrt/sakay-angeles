const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url === 'https://github.com/login/oauth/access_token') {
    const request = JSON.parse(init.body || '{}');
    return Response.json({ access_token: request.code === 'outsider' ? 'mock-outsider-token' : 'mock-admin-token' });
  }
  if (url === 'https://api.github.com/user') {
    const outsider = String(init.headers?.Authorization || '').includes('mock-outsider-token');
    return Response.json({ login: outsider ? 'not-allowed' : process.env.MOCK_GITHUB_LOGIN || 'allowed-admin' });
  }
  return realFetch(input, init);
};
