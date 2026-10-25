/* Generated from verified exports in this version's unmodified renderer. */
__IMPORTS__
__INITIALIZE__

export const adapter = __ADAPTER__;

export async function connectHost(port, lab = window.__lab) {
  const services = {
    httpFetch: {
      fetch: (id, request) => {
        const name = new URL(request.url, 'https://fixture.invalid').pathname.slice(1);
        lab.rpc.push({method: 'httpFetch.fetch', name});
        const responses = window.__labResponses ?? {};
        const found = Object.hasOwn(responses, name);
        const body = JSON.stringify(found ? responses[name] : {error: `No fixture for ${name}`});
        return {response: {
          status: found ? 200 : 501,
          statusText: found ? 'OK' : 'Not implemented',
          headers: {'content-type': 'application/json'},
          body: new Response(body).body,
        }};
      },
      cancel: () => {},
    },
    requestUserInputAutoResolution: {setDisabled: () => {}},
    // A new account's global state: empty until the app writes to it.
    applicationState: {
      read: (key) => ({value: lab.globalState?.[key] ?? null}),
      write: (key, value) => {
        lab.globalState = {...lab.globalState, [key]: value};
        return {success: true};
      },
    },
    appInfo: {
      get: () => {
        lab.rpc.push({method: 'appInfo.get'});
        return {
          version: lab.number ?? lab.version,
          buildNumber: String(window.__historyConfig?.build ?? ''),
          buildFlavor: 'prod',
          systemVersion: '25.0.0',
          systemName: 'macOS',
          platform: 'darwin',
        };
      },
      getSystemInfo: () => window.__labResponses['os-info'],
    },
  };
  __CONNECT__
  lab.connected = true;
  return window.__labHost;
}
