/**
 * Environment handed to executors and build/test commands on the host. Allowlist first, then a
 * deny pattern that wins over the allowlist, so a credential can never ride along under an
 * innocent-looking name. HOME/USERPROFILE are kept on purpose: mvn.cmd reads
 * %USERPROFILE%\mavenrc_pre.cmd and Maven uses ~/.m2, so changing them changes the toolchain.
 */
const ALLOW_EXACT = new Set(
  [
    // OS / process basics
    'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR',
    'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
    'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)',
    'NUMBER_OF_PROCESSORS', 'OS', 'USERNAME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'TZ',
    'PUBLIC', 'ALLUSERSPROFILE', 'COMPUTERNAME', 'HOSTNAME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
    'COMMONPROGRAMW6432', 'USERDOMAIN', 'PSMODULEPATH', 'NODEFAULTCURRENTDIRECTORYINEXEPATH',
    // Trust store locations (paths, not secrets) for corporate TLS inspection
    'NODE_EXTRA_CA_CERTS', 'NODE_USE_SYSTEM_CA', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    // Toolchains
    'JAVA_HOME', 'MAVEN_HOME', 'M2_HOME', 'MAVEN_OPTS', 'GRADLE_HOME', 'GRADLE_USER_HOME', 'GRADLE_OPTS',
    'NVM_DIR', 'NVM_HOME', 'NVM_SYMLINK', 'VOLTA_HOME', 'SDKMAN_DIR', 'PYENV_ROOT', 'GOPATH', 'GOROOT',
    'DOTNET_ROOT', 'CARGO_HOME', 'RUSTUP_HOME',
  ].map((k) => k.toUpperCase()),
);
const ALLOW_PREFIX = ['LC_', 'PROCESSOR_'];

const DENY_PATTERN =
  /(TOKEN|SECRET|PASSW(OR)?D|API_?KEY|PRIVATE_?KEY|CREDENTIAL|_PAT$|^PAT_|AUTH|COOKIE|SESSION)/i;
const DENY_PREFIX = [
  'GH_', 'GITHUB_', 'COPILOT_', 'OPENAI_', 'ANTHROPIC_', 'AZURE_', 'AWS_', 'GOOGLE_', 'GCP_',
  'JIRA_', 'CONFLUENCE_', 'NPM_CONFIG_', 'GATEHOUSE_', 'NODE_OPTIONS',
];

export interface ScrubResult {
  env: NodeJS.ProcessEnv;
  kept: string[];
  dropped: string[];
}

export function scrubEnv(source: NodeJS.ProcessEnv, extra: NodeJS.ProcessEnv = {}): ScrubResult {
  const env: NodeJS.ProcessEnv = {};
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (isAllowed(name)) {
      env[name] = value;
      kept.push(name);
    } else {
      dropped.push(name);
    }
  }
  // Gatehouse-provided values (run token, CODEX_HOME, ...) are added after scrubbing by design.
  return { env: { ...env, ...extra }, kept: kept.sort(), dropped: dropped.sort() };
}

export function isAllowed(name: string): boolean {
  const upper = name.toUpperCase();
  if (DENY_PATTERN.test(upper) || DENY_PREFIX.some((p) => upper.startsWith(p))) return false;
  return ALLOW_EXACT.has(upper) || ALLOW_PREFIX.some((p) => upper.startsWith(p));
}
