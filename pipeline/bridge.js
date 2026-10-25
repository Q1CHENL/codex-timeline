/* Fixture-only replacement for Electron preload. No account or filesystem access. */
(() => {
  const config = window.__historyConfig;
  const version = config.version, number = version;
  const theme = config.theme ?? 'dark';
  const modelFixture = config.modelFixture;
  // Before 26.227.1448, native API-key allowlists exclude GPT-5.3 even where
  // its label is known. These verified states use the native ChatGPT model/list
  // branch; the account is synthetic and the original frontend is unchanged.
  const legacyModelListStates = new Set(['model-gpt-5.3-codex', '260205.0946', '260205.1301', '260206.1259', '260206.1448', '260208.1016', '260210.1703', '260212.1136', '26.212.1823', '26.217.1959', '26.224.1209', '26.226.940']);
  const authMode = legacyModelListStates.has(config.captureId) ? 'chatgpt' : 'apikey';
  if (!modelFixture?.model) throw Error('Verified model fixture is required');
  // Reconstruct the dated model configuration through the original model selector:
  // the catalog's visible models with their reasoning levels, the dated selection as default.
  const modelList = modelFixture.catalogModels.map(row => ({id: row.model, model: row.model, displayName: row.displayName,
    description: row.description, hidden: false, isDefault: row.model === modelFixture.model,
    supportedReasoningEfforts: row.reasoningEfforts.map(level => ({reasoningEffort: level.effort, description: level.description})),
    defaultReasoningEffort: row.model === modelFixture.model ? modelFixture.reasoningEffort : row.defaultReasoningEffort}));
  if (!modelList.some(row => row.isDefault)) throw Error('The dated selection must be a visible catalog model');
  window.__lab = { version, captureId: config.captureId, number, theme, messages: [], rpc: [], errors: [], unhandledMcpRequests: [], shared: {} };
  const lab = window.__lab;
  // The October bundle selects its legacy shell when this real layout gate is absent.
  // Enable the branch verified against the user's screenshot; July has no such gate.
  const navigationLayout = config.navigationLayout;
  const featureGates = navigationLayout ? {'3085093835': {name: '3085093835', value: true, rule_id: 'history-lab-layout', secondary_exposures: []}} : {};
  // Native model-name branch verified against the current desktop screenshot.
  // Older packages without this gate keep their own prefix formatting; the
  // gate's historical rollout date is unknown, so this is a reference setting.
  featureGates['3849065407'] = {name: '3849065407', value: true, rule_id: 'history-prefix-reference', secondary_exposures: []};
  lab.fixture = {theme, authMode, model: modelFixture, appearanceProfile: 'packaged-default', navigationLayout, sidebarWidth: null, engineVersion: config.engineVersion ?? null};
  // Empty preferences preserve this package's own appearance and feature defaults.
  // No current account's theme, fonts, sidebar dimensions or voice opt-ins are copied.
  const appearance = {};
  Object.assign(lab.shared, {
    statsig_default_enable_features: [],
    host_config: {id: 'local', kind: 'local', display_name: 'Local'},
    remote_ssh_connections: [], remote_wsl_connections: [], remote_control_connections: [],
  });
  const emit = (data) => queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', {data})));
  const responses = {
    'extension-info': {version: number},
    'get-configuration': {value: null},
    'list-pending-automation-run-threads': {threadIds: []},
    'git-origins': {origins: []},
    'recommended-skills': {skills: []},
    'local-plugins': {plugins: []},
    'get-settings': {values: appearance, configuredValues: appearance},
    'settings/user': {settings: {}, announcements: {}, eligible_announcements: []},
    'get-global-state': {value: null},
    // Native empty-state responses: no real account token, project, import history
    // or operating-system dictation service exists in this isolated renderer.
    'account-info': {accountId: null, userId: null, authenticatedUserId: null, plan: null, email: null, computeResidency: null, hasChatGptToken: false},
    'wham/accounts/check': {accounts: [], account_ordering: [], default_account_id: null},
    'wham/environments': [],
    'pins': [],
    'projectless-workspace-root': {workspaceRoot: null},
    'ambient-suggestions': {file: {projectRoot: '', generatedAtMs: null, currentSuggestionIds: [], suggestions: []}},
    'external-agent-import-detect': {items: [], unsupportedProjects: []},
    'external-agent-import-status': {importedSessionCount: 0, latestImportedAtMs: null},
    'global-dictation-hotkey-state': {supported: false, configuredHotkey: null, configuredToggleHotkey: null},
    'hotkey-window-hotkey-state': {supported: false, configuredHotkey: null, isGateEnabled: false, isDevMode: false, isDevOverrideEnabled: false, isActive: false},
    'browser-use-origin-state-read': {approvalMode: 'alwaysAsk', historyApprovalMode: 'alwaysAsk', downloadApprovalMode: 'alwaysAsk', uploadApprovalMode: 'alwaysAsk', allowedOrigins: [], deniedOrigins: [], allowedDownloadOrigins: [], deniedDownloadOrigins: [], allowedUploadOrigins: [], deniedUploadOrigins: []},
    'os-info': {platform: 'darwin', arch: 'arm64', release: '25.0.0'},
    'is-copilot-api-available': {available: false},
    'codex-home': {codexHome: '/fixture/.codex'},
    'home-directory': {homeDirectory: '/fixture'},
    'get-setting': {value: null},
    'workspace-root-options': {roots: []},
    'active-workspace-roots': {roots: []},
    'locale-info': {locale: 'en-US', preferredLanguages: ['en-US']},
    'codex-command-keymap-state': {bindings: []},
    'list-pinned-threads': {threadIds: []},
    'list-automations': {items: []},
    'inbox-items': {items: [], unreadRunCounts: {total: 0, automationIds: [], unreadRuns: []}},
    'set-remote-control-connections-enabled': {success: true},
    'set-remote-wsl-connections-enabled': {success: true},
    'wham/tasks/list': {items: [], tasks: [], has_more: false},
    'wham/usage': {},
    'v1/initialize': {has_updates: true, feature_gates: featureGates, dynamic_configs: {}, layer_configs: {}, time: 1, evaluated_keys: {}, hash_used: 'none'},
    'v1/sdk_exception': {},
    'v1/rgstr': {},
    'ces/v1/rgstr': {},
  };
  window.__labResponses = responses;
  // Early bundles call Statsig directly; later ones use the host HTTP service.
  // Both receive the same local fixture without allowing external network access.
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
    const name = url.pathname.slice(1);
    if ((url.origin === 'https://ab.chatgpt.com' && ['v1/initialize', 'v1/sdk_exception', 'v1/rgstr'].includes(name)) ||
        (url.origin === 'https://chatgpt.com' && name === 'ces/v1/rgstr')) {
      lab.rpc.push({method: 'local-browser-fetch', name});
      return Promise.resolve(new Response(JSON.stringify(responses[name]), {status: 200, headers: {'content-type': 'application/json'}}));
    }
    return nativeFetch(input, init);
  };
  window.addEventListener('error', (event) => lab.errors.push(String(event.error?.stack ?? event.message)));
  window.addEventListener('unhandledrejection', (event) => lab.errors.push(String(event.reason?.stack ?? event.reason)));
  window.codexWindowType = 'electron';
  window.__SENTRY_IPC__ = { 'sentry-ipc': Object.fromEntries(['sendRendererStart', 'sendScope', 'sendEnvelope', 'sendStatus', 'sendStructuredLog', 'sendMetric'].map(key => [key, () => {}])) };
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle('electron-dark', theme === 'dark');
  document.documentElement.classList.toggle('electron-light', theme === 'light');
  window.electronBridge = {
    windowType: 'electron',
    getPreloadStartedAtMs: () => performance.timeOrigin,
    getSystemThemeVariant: () => theme,
    subscribeToSystemThemeVariant: () => () => {},
    getSharedObjectSnapshotValue: (key) => lab.shared[key],
    getInitialSidebarBootstrap: () => null,
    getBuildFlavor: () => 'prod',
    getSentryInitOptions: () => ({ appVersion: number, buildFlavor: 'prod', buildNumber: config.build, codexAppSessionId: 'offline-history-lab', desktopTraceSampleRate: 0, initialDesktopTraceSampleRate: 0, sentryEnabled: false }),
    getAppSessionId: () => 'offline-history-lab',
    getDesktopUserAgent: () => `Codex Desktop/${number} (Mac OS; arm64)`,
    isDeviceCheckSupported: () => false,
    isIntelMacBuild: () => false,
    usesOwlAppShell: () => true,
    getPathForFile: () => null,
    startFileDrag: () => false,
    showContextMenu: async () => null,
    getFastModeRolloutMetrics: async () => null,
    acknowledgeChunkedMessage: () => {},
    subscribeToWorkerMessages: () => () => {},
    sendWorkerMessageFromView: async (worker, message) => lab.messages.push({worker, ...message}),
    sendMessageFromView: async (message) => {
      lab.messages.push(message);
      if (message.type === 'shared-object-subscribe') emit({type: 'shared-object-updated', key: message.key, value: lab.shared[message.key]});
      if (message.type === 'shared-object-set') lab.shared[message.key] = message.value;
      if (message.type === 'ready') {
        emit({type: 'codex-app-server-initialized', hostId: 'local', ...(config.engineVersion ? {appServerVersion: config.engineVersion, installedCodexVersion: config.engineVersion} : {})});
        emit({type: 'codex-app-server-connection-changed', hostId: 'local', state: 'connected'});
      }
      if (message.type === 'persisted-atom-sync-request') {
        emit({type: 'persisted-atom-sync', state: {'electron:onboarding-override': 'app', 'electron:onboarding-projectless-completed': true}, canWritePrimaryWindowTabPersistence: false});
      }
      if (message.type === 'fetch') {
        const name = new URL(message.url, 'https://fixture.invalid').pathname.slice(1);
        const found = Object.hasOwn(responses, name);
        emit({type: 'fetch-response', requestId: message.requestId, responseType: 'success', status: found ? 200 : 501, headers: {}, bodyJsonString: JSON.stringify(found ? responses[name] : {error: `No fixture for ${name}`})});
      }
      if (message.type === 'mcp-request') {
        const results = {
          'config/read': {config: {}, origins: {}, layers: []},
          'remoteControl/status/read': {enabled: false, status: 'disabled'},
          // Default OpenAI provider does not require enterprise gateway OAuth.
          'account/gatewayOAuth/read': {providerId: 'openai', providerName: 'OpenAI', required: false, status: null, error: null},
          'account/read': {account: authMode === 'chatgpt' ? {type: 'chatgpt', email: 'archive@example.invalid', planType: 'pro'} : {type: 'apiKey'}, requiresOpenaiAuth: true},
          'getAuthStatus': {authMethod: authMode, requiresOpenaiAuth: true},
          'fs/readFile': {dataBase64: btoa(JSON.stringify({version: 1, attachmentPaths: [], pendingRemovalPaths: [], textExcerptsByPath: {}}))},
          'thread/list': {data: [], nextCursor: null},
          'model/list': {data: modelList, nextCursor: null},
          'mcpServerStatus/list': {data: [], nextCursor: null},
          'collaborationMode/list': {data: []},
          'experimentalFeature/list': {data: [], nextCursor: null},
          'experimentalFeature/enablement/set': {},
          'configRequirements/read': {requirements: null},
          'skills/list': {data: []},
          'app/list': {data: [], nextCursor: null},
          'plugin/list': {marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: []},
          'plugin/installed': {marketplaces: [], marketplaceLoadErrors: []},
          'externalAgentConfig/import/readHistories': {data: [], connectors: []},
          'permissionProfile/list': {data: [], nextCursor: null},
        };
        const failures = {
          // The sample account's workspace marketplace publishes no plugins.
          'plugin/read': {code: -32600, message: 'Plugin not found in marketplace'},
        };
        const method = message.request.method;
        if (!Object.hasOwn(results, method) && !Object.hasOwn(failures, method)) lab.unhandledMcpRequests.push(method);
        emit({type: 'mcp-response', hostId: message.hostId, message: {id: message.request.id, ...(Object.hasOwn(results, method) ? {result: results[method]} : {error: failures[method] ?? {code: -32601, message: `No fixture for ${method}`}})}});
      }
    },
  };
  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.data?.type !== 'connect-app-host') return;
    const { connectHost } = await import('/__lab/host.mjs');
    await connectHost(event.data.port, lab);
  });
})();
