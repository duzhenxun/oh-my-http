/**
 * oh-my-http 公共 API。
 *
 * 作为库使用：
 *   import { loadConfig, createServer, listen } from 'oh-my-http'
 *   const cfg = loadConfig([], { OHMY_PASS: 's3cret' })
 *   await listen(createServer(cfg), cfg)
 */
export { NAME, VERSION, BANNER } from './version.js'
export { USAGE, loadConfig, normalizeMount } from './config.js'
export {
  MIN_PASSWORD,
  ROLES,
  createAccountStore,
  validPassword,
  validUsername,
} from './accounts.js'
export { checkCredentials, basicAuthCredentials, basicAuthHeader, verifyUserPass } from './auth.js'
export {
  DEFAULT_TRUSTED,
  clientIP,
  ipToNumber,
  isTrusted,
  matchPrefix,
  normalizeIP,
  parsePrefix,
  peerIP,
  prefixContains,
} from './ip.js'
export {
  createHandler,
  createServer,
  evaluateAccess,
  explainAccess,
  authenticatedUser,
  isAuthEnabled,
  lanAddresses,
  listen,
  MIME,
  withAuthState,
} from './server.js'
export {
  createLoginThrottle,
  createSessionStore,
  parseCookies,
  safeNext,
  serializeCookie,
} from './session.js'
export { serveStatic, relativeToMount } from './static.js'
export {
  CHECK_INTERVAL_MS,
  DEFAULT_REGISTRY,
  checkForUpdate,
  compareVersions,
  fetchLatestVersion,
  parseVersion,
  readUpdateCache,
  updateCacheFile,
  upgradeHint,
  writeUpdateCache,
} from './update.js'
export {
  COMMANDS,
  DEFAULT_STATE_DIR,
  humanDuration,
  isAlive,
  listStates,
  logFileFor,
  looksLikeOurs,
  openLog,
  readState,
  redactArgv,
  removeState,
  restoreArgv,
  stateFileFor,
  stateStatus,
  stopProcess,
  stripOptions,
  tailLog,
  waitForState,
  writeState,
} from './runtime.js'

export { createServer as default } from './server.js'
