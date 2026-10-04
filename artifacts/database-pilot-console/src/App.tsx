import { useEffect, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Link, Route, Switch, useLocation } from 'wouter';
import {
  Activity, ArrowDownRight, ArrowRight, ArrowUpRight, Check, ChevronRight, CircleHelp,
  Copy, Database, KeyRound, Layers3, LockKeyhole, LogOut, Plus, RefreshCw, Server,
  ShieldCheck, Trash2, Unplug, UserRound, X,
} from 'lucide-react';
import {
  DatabaseType,
  getGetDashboardSummaryQueryKey,
  getGetSessionQueryKey,
  getListConnectionsQueryKey,
  getListTokensQueryKey,
  useCreateConnection,
  useCreateToken,
  useDeleteConnection,
  useGetDashboardSummary,
  useGetSession,
  useListConnections,
  useListTokens,
  useLoginAccount,
  useLogoutAccount,
  useRegisterAccount,
  useRevokeToken,
  useTestConnection,
} from '@workspace/api-client-react';
import type { ApiToken, ConnectionTestResult, DatabaseConnection } from '@workspace/api-client-react';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

const databaseNames: Record<string, string> = {
  postgres: 'PostgreSQL / CockroachDB',
  mysql: 'MySQL / MariaDB',
  sqlite: 'SQLite',
  sqlserver: 'SQL Server',
};
const databaseOptions = [
  { value: DatabaseType.postgres, label: databaseNames.postgres },
  { value: DatabaseType.mysql, label: databaseNames.mysql },
  { value: DatabaseType.sqlite, label: databaseNames.sqlite },
  { value: DatabaseType.sqlserver, label: databaseNames.sqlserver },
];

function getError(error: unknown, fallback = 'Something went wrong. Please try again.') {
  if (error && typeof error === 'object' && 'error' in error && typeof error.error === 'string') return error.error;
  if (error instanceof Error) return error.message;
  return fallback;
}
function formatDate(value: string | null | undefined) {
  if (!value) return 'Never tested';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
function DbMark({ type }: { type: string }) {
  const Icon = type === 'sqlite' ? Layers3 : type === 'sqlserver' ? Server : Database;
  return <span className="dp-db-icon"><Icon size={16} strokeWidth={1.8} /></span>;
}
function LoadingRows({ count = 3 }: { count?: number }) {
  return <div className="dp-loading" aria-label="Loading"><div>{Array.from({ length: count }, (_, i) => <div className="dp-skeleton" key={i} />)}</div></div>;
}
function PageHead({ eyebrow, title, subtitle, action }: { eyebrow: string; title: string; subtitle: string; action?: React.ReactNode }) {
  return <div className="dp-page-head"><div><div className="dp-eyebrow">{eyebrow}</div><h1 className="dp-title">{title}</h1><p className="dp-subtitle">{subtitle}</p></div>{action}</div>;
}
function Brand() {
  return <Link href="/" className="dp-brand"><span className="dp-brand-mark"><Database size={19} /></span><span><span className="dp-brand-name">Database Pilot</span><span className="dp-brand-caption">Access, kept in bounds</span></span></Link>;
}
function Shell({ user, children, title }: { user: { email: string }; children: React.ReactNode; title: string }) {
  const [, setLocation] = useLocation();
  const logout = useLogoutAccount();
  const qc = useQueryClient();
  const active = window.location.pathname;
  const handleLogout = () => logout.mutate(undefined, { onSuccess: () => { qc.clear(); setLocation('/login'); } });
  return <div className="dp-shell">
    <aside className="dp-sidebar">
      <Brand />
      <div className="dp-nav-label">Workspace</div>
      <nav className="dp-nav" aria-label="Main navigation">
        <Link href="/" className={active === '/' ? 'active' : ''}><Activity size={16} />Overview</Link>
        <Link href="/connections" className={active.startsWith('/connections') ? 'active' : ''}><Database size={16} />Connections</Link>
        <Link href="/tokens" className={active === '/tokens' ? 'active' : ''}><KeyRound size={16} />Access tokens</Link>
      </nav>
      <div className="dp-sidebar-bottom">
        <div className="dp-profile"><span className="dp-avatar">{user.email.slice(0, 1).toUpperCase()}</span><span className="dp-profile-mail">{user.email}</span></div>
        <button className="dp-signout" onClick={handleLogout} disabled={logout.isPending} data-testid="button-sign-out"><LogOut size={14} />{logout.isPending ? 'Signing out…' : 'Sign out'}</button>
      </div>
    </aside>
    <main className="dp-main">
      <div className="dp-topline"><div className="dp-breadcrumb"><span>Workspace</span><ChevronRight size={13} /><strong>{title}</strong></div><div className="dp-env">Private workspace</div></div>
      {children}
    </main>
  </div>;
}
function Empty({ icon, title, detail, action }: { icon: React.ReactNode; title: string; detail: string; action?: React.ReactNode }) {
  return <div className="dp-empty"><div className="dp-empty-icon">{icon}</div><div className="dp-empty-title">{title}</div><p className="dp-empty-copy">{detail}</p>{action}</div>;
}
function Alert({ kind, children }: { kind: 'error' | 'success' | 'info'; children: React.ReactNode }) {
  const Icon = kind === 'error' ? X : kind === 'success' ? Check : CircleHelp;
  return <div className={`dp-alert ${kind}`} role={kind === 'error' ? 'alert' : 'status'}><Icon size={15} />{children}</div>;
}
function AuthLayout({ children }: { children: React.ReactNode }) {
  return <div className="dp-auth-wrap">
    <section className="dp-auth-side"><Brand /><div className="dp-auth-quote"><div className="dp-eyebrow" style={{ color: '#8bc6aa' }}>Scoped access. Clear boundaries.</div><h1>Give agents a key.<br />Not the kingdom.</h1><p>Keep your database credentials private. Create a dedicated, read-only connection for every agent that needs to query your data.</p></div><div className="dp-auth-foot">DATABASE PILOT · CONTROL CONSOLE</div></section>
    <main className="dp-auth-main">{children}</main>
  </div>;
}
function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const loginMutation = useLoginAccount();
  const registerMutation = useRegisterAccount();
  const mutation = mode === 'login' ? loginMutation : registerMutation;
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    if (!email.trim()) { setError('Enter your email address.'); return; }
    if (password.length < (mode === 'register' ? 12 : 1)) { setError(mode === 'register' ? 'Use at least 12 characters for your password.' : 'Enter your password.'); return; }
    mutation.mutate({ data: { email: email.trim(), password } }, {
      onSuccess: (session) => {
        if (session.authenticated) {
          qc.setQueryData(getGetSessionQueryKey(), session);
          setLocation('/');
        } else setError('We could not start a session. Please try again.');
      },
      onError: (err) => setError(getError(err, mode === 'login' ? 'Sign in failed. Check your details and try again.' : 'Account creation failed. Please try again.')),
    });
  };
  return <AuthLayout><div className="dp-auth-card">
    <div className="dp-eyebrow">{mode === 'login' ? 'Welcome back' : 'Start with a boundary'}</div>
    <h2>{mode === 'login' ? 'Sign in to your workspace' : 'Create your account'}</h2>
    <p className="dp-subtitle">{mode === 'login' ? 'Your databases and agent credentials, in one place.' : 'A safer way to give AI agents database access.'}</p>
    {error && <div style={{ marginBottom: 16 }}><Alert kind="error">{error}</Alert></div>}
    <form className="dp-form" onSubmit={submit} noValidate>
      <label className="dp-field"><span className="dp-label">Email address</span><input className="dp-input" type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@company.com" data-testid="input-email" required /></label>
      <label className="dp-field"><span className="dp-label">Password</span><input className="dp-input" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={e => setPassword(e.target.value)} placeholder={mode === 'register' ? 'At least 12 characters' : 'Your password'} data-testid="input-password" required minLength={mode === 'register' ? 12 : 1} /></label>
      {mode === 'register' && <div className="dp-hint">Use 12 or more characters. Keep this password unique to Database Pilot.</div>}
      <button className="dp-button" type="submit" disabled={mutation.isPending} data-testid="button-auth-submit">{mutation.isPending ? 'Working…' : mode === 'login' ? 'Sign in' : 'Create account'}<ArrowRight size={15} /></button>
    </form>
    <div className="dp-auth-switch">{mode === 'login' ? 'New to Database Pilot? ' : 'Already have an account? '}<Link href={mode === 'login' ? '/register' : '/login'}>{mode === 'login' ? 'Create an account' : 'Sign in'}</Link></div>
  </div></AuthLayout>;
}
function SignedOutHome() {
  return <AuthLayout><div className="dp-auth-card"><div className="dp-eyebrow">Private database access</div><h2>Keep credentials out of agent prompts.</h2><p className="dp-subtitle">Connect a database once, then issue scoped tokens for the AI agents that need access.</p><div className="dp-form"><Link href="/login" className="dp-button">Sign in to Database Pilot<ArrowRight size={15} /></Link><Link href="/register" className="dp-button secondary">Create an account</Link><Alert kind="info"><span>Each token is tied to one saved connection. Your global database credential stays yours.</span></Alert></div></div></AuthLayout>;
}
function Overview({ user }: { user: { email: string } }) {
  const summary = useGetDashboardSummary();
  const data = summary.data;
  const connections = data?.recentConnections ?? [];
  const tokens = data?.recentTokens ?? [];
  return <Shell user={user} title="Overview"><div className="dp-content">
    <PageHead eyebrow="Workspace overview" title="A clear view of access." subtitle={`Your database connections and agent credentials, ${user.email}.`} action={<Link className="dp-button" href="/connections/new"><Plus size={15} />Add connection</Link>} />
    {summary.isLoading ? <div className="dp-grid dp-stats">{[1,2,3].map(x => <div className="dp-skeleton" key={x} />)}</div> : summary.isError ? <Alert kind="error">{getError(summary.error)} <button className="dp-button secondary small" onClick={() => summary.refetch()}>Retry</button></Alert> : <>
      <div className="dp-grid dp-stats">
        <div className="dp-stat"><div className="dp-stat-top">Saved connections<span className="dp-stat-icon"><Database size={15} /></span></div><div className="dp-stat-value" data-testid="stat-connections">{data?.connectionsCount ?? 0}</div><div className="dp-stat-note">Credentials stored securely</div></div>
        <div className="dp-stat"><div className="dp-stat-top">Active tokens<span className="dp-stat-icon"><KeyRound size={15} /></span></div><div className="dp-stat-value" data-testid="stat-active-tokens">{data?.activeTokensCount ?? 0}</div><div className="dp-stat-note">Scoped to a single connection</div></div>
        <div className="dp-stat"><div className="dp-stat-top">Revoked tokens<span className="dp-stat-icon"><ShieldCheck size={15} /></span></div><div className="dp-stat-value">{data?.revokedTokensCount ?? 0}</div><div className="dp-stat-note">No longer able to access data</div></div>
      </div>
      <div className="dp-content-two">
        <section className="dp-panel"><div className="dp-panel-head"><h2 className="dp-panel-title">Recent connections</h2><Link href="/connections" className="dp-panel-link">All connections <ArrowUpRight size={13} /></Link></div>
          {connections.length ? <div className="dp-list">{connections.map(c => <ConnectionRow key={c.id} connection={c} />)}</div> : <Empty icon={<Database size={20} />} title="No connections yet" detail="Save your first database connection to create a safe, scoped access point." action={<Link className="dp-button small" href="/connections/new"><Plus size={14} />Add a connection</Link>} />}
        </section>
        <section className="dp-panel"><div className="dp-panel-head"><h2 className="dp-panel-title">Recent tokens</h2><Link href="/tokens" className="dp-panel-link">Manage tokens <ArrowUpRight size={13} /></Link></div>
          {tokens.length ? <div className="dp-list">{tokens.slice(0,5).map(t => <TokenRow key={t.id} token={t} compact />)}</div> : <Empty icon={<KeyRound size={20} />} title="No agent tokens" detail="Create a token when a connection is ready to share with an agent." action={connections.length ? <Link className="dp-button small" href="/tokens"><Plus size={14} />Create a token</Link> : undefined} />}
        </section>
      </div>
    </>}
  </div></Shell>;
}
function ConnectionRow({ connection, action }: { connection: DatabaseConnection; action?: React.ReactNode }) {
  return <div className="dp-list-row" data-testid={`row-connection-${connection.id}`}><div className="dp-item-main"><DbMark type={connection.databaseType} /><div style={{ minWidth: 0 }}><div className="dp-item-title">{connection.name}</div><div className="dp-item-sub">{databaseNames[connection.databaseType] || connection.databaseType} · Tested {formatDate(connection.lastTestedAt)}</div></div></div>{action}</div>;
}
function TokenRow({ token, compact = false, action }: { token: ApiToken; compact?: boolean; action?: React.ReactNode }) {
  const revoked = Boolean(token.revokedAt);
  return <div className="dp-list-row" data-testid={`row-token-${token.id}`}><div className="dp-item-main"><span className="dp-db-icon"><KeyRound size={15} /></span><div style={{ minWidth: 0 }}><div className="dp-item-title">{token.label}</div><div className="dp-item-sub">{token.connectionName} · {token.tokenPrefix}••••</div>{!compact && <div className="dp-item-sub">Created {formatDate(token.createdAt)} · Last used {formatDate(token.lastUsedAt)}</div>}</div></div><div className="dp-inline-actions">{!compact && <span className={`dp-badge ${revoked ? 'revoked' : ''}`}>{revoked ? 'Revoked' : 'Active'}</span>}{action}</div></div>;
}
function Connections({ user }: { user: { email: string } }) {
  const query = useListConnections();
  const remove = useDeleteConnection();
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const handleDelete = (connection: DatabaseConnection) => {
    if (!window.confirm(`Remove “${connection.name}”? Tokens for this connection will also be revoked.`)) return;
    setError('');
    remove.mutate({ connectionId: connection.id }, {
      onSuccess: () => { qc.invalidateQueries({ queryKey: getListConnectionsQueryKey() }); qc.invalidateQueries({ queryKey: getListTokensQueryKey() }); qc.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() }); },
      onError: err => setError(getError(err, 'Could not remove the connection.')),
    });
  };
  return <Shell user={user} title="Connections"><div className="dp-content">
    <PageHead eyebrow="Database access" title="Connections" subtitle="Saved database credentials stay private. Tokens are scoped to one connection." action={<Link className="dp-button" href="/connections/new"><Plus size={15} />Add connection</Link>} />
    {error && <div style={{ marginBottom: 18 }}><Alert kind="error">{error}</Alert></div>}
    {query.isLoading ? <LoadingRows /> : query.isError ? <Alert kind="error">{getError(query.error)} <button className="dp-button secondary small" onClick={() => query.refetch()}>Retry</button></Alert> : query.data?.length ? <section className="dp-panel"><div className="dp-panel-head"><h2 className="dp-panel-title">Saved connections</h2><span className="dp-muted-note">{query.data.length} total</span></div><div className="dp-list">{query.data.map(c => <ConnectionRow key={c.id} connection={c} action={<button className="dp-button danger small" disabled={remove.isPending} onClick={() => handleDelete(c)} aria-label={`Remove ${c.name}`} data-testid={`button-delete-${c.id}`}><Trash2 size={13} />Remove</button>} />)}</div></section> : <section className="dp-panel"><Empty icon={<Unplug size={20} />} title="No saved connections" detail="Start by connecting a database. Your connection string is used to test and save the connection, and is never displayed again." action={<Link className="dp-button" href="/connections/new"><Plus size={15} />Connect a database</Link>} /></section>}
  </div></Shell>;
}
function NewConnection({ user }: { user: { email: string } }) {
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const create = useCreateConnection();
  const test = useTestConnection();
  const [name, setName] = useState('');
  const [databaseType, setDatabaseType] = useState<string>(DatabaseType.postgres);
  const [connectionString, setConnectionString] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [error, setError] = useState('');
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const [testedKey, setTestedKey] = useState('');
  const key = `${databaseType}|${connectionString}`;
  const resetTest = () => { setTestResult(null); setTestedKey(''); };
  const handleTest = (event: React.FormEvent) => {
    event.preventDefault(); setFieldError(''); setError('');
    if (!name.trim() || name.trim().length > 80) { setFieldError('Give this connection a name between 1 and 80 characters.'); return; }
    if (connectionString.trim().length < 5 || connectionString.trim().length > 4096) { setFieldError('Enter a valid connection string (5–4096 characters).'); return; }
    test.mutate({ data: { databaseType: databaseType as typeof DatabaseType[keyof typeof DatabaseType], connectionString: connectionString.trim() } }, {
      onSuccess: result => { setTestResult(result); setTestedKey(key); if (!result.success) setError(result.message || 'Connection test was not successful.'); },
      onError: err => { setTestResult(null); setError(getError(err, 'Connection test failed. Check the details and try again.')); },
    });
  };
  const saveConnection = (event: React.FormEvent) => {
    event.preventDefault(); setFieldError(''); setError('');
    if (!name.trim() || name.trim().length > 80) { setFieldError('Give this connection a name between 1 and 80 characters.'); return; }
    if (connectionString.trim().length < 5 || connectionString.trim().length > 4096) { setFieldError('Enter a valid connection string (5–4096 characters).'); return; }
    if (!testResult?.success || testedKey !== key) { setFieldError('Run a successful connection test before saving.'); return; }
    create.mutate({ data: { name: name.trim(), databaseType: databaseType as typeof DatabaseType[keyof typeof DatabaseType], connectionString: connectionString.trim() } }, {
      onSuccess: () => { setConnectionString(''); qc.invalidateQueries({ queryKey: getListConnectionsQueryKey() }); qc.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() }); setLocation('/connections'); },
      onError: err => setError(getError(err, 'Could not save this connection.')),
    });
  };
  return <Shell user={user} title="New connection"><div className="dp-content">
    <PageHead eyebrow="Database access" title="Add a connection" subtitle="Test connectivity first. Credentials are not shown after you save." />
    <div className="dp-content-two">
      <section className="dp-panel dp-form-panel">
        <form className="dp-form" onSubmit={handleTest} noValidate>
          <label className="dp-field"><span className="dp-label">Connection name</span><input className="dp-input" value={name} maxLength={80} onChange={e => { setName(e.target.value); setFieldError(''); }} placeholder="e.g. Analytics read replica" data-testid="input-connection-name" /><span className="dp-hint">A recognizable label for this database. Do not include credentials here.</span></label>
          <label className="dp-field"><span className="dp-label">Database type</span><select className="dp-select" value={databaseType} onChange={e => { setDatabaseType(e.target.value); resetTest(); }} data-testid="select-database-type">{databaseOptions.map(o => <option value={o.value} key={o.value}>{o.label}</option>)}</select></label>
          <label className="dp-field"><span className="dp-label">Connection string</span><textarea className="dp-textarea" value={connectionString} onChange={e => { setConnectionString(e.target.value); resetTest(); }} placeholder={databaseType === 'sqlite' ? 'file:/path/to/database.sqlite' : databaseType === 'sqlserver' ? 'Server=host;Database=name;User Id=…;Password=…' : `${databaseType === 'mysql' ? 'mysql' : 'postgres'}://user:password@host:5432/database`} autoComplete="new-password" spellCheck={false} data-testid="input-connection-string" /><span className="dp-hint">Sensitive. Used to test and save your connection; never displayed again. Prefer a database user with read-only permissions.{databaseType === 'sqlite' ? ' The file must already exist inside the server directory configured by SQLITE_DATABASE_ROOT; browser uploads are not supported.' : ''}</span></label>
          {fieldError && <span className="dp-field-error" role="alert">{fieldError}</span>}
          {error && <Alert kind="error">{error}</Alert>}
          {testResult && <Alert kind={testResult.success ? 'success' : 'error'}>{testResult.message}{testResult.success && <span> Found {testResult.schemaCount} schemas and {testResult.tableCount} tables.</span>}</Alert>}
          <div className="dp-form-actions">
            <button className="dp-button secondary" type="submit" disabled={test.isPending || create.isPending} data-testid="button-test-connection">{test.isPending ? <><RefreshCw size={14} />Testing…</> : <><Activity size={14} />Test connection</>}</button>
            <button className="dp-button" type="button" disabled={!testResult?.success || testedKey !== key || create.isPending} onClick={saveConnection} data-testid="button-save-connection">{create.isPending ? 'Saving…' : 'Save connection'}<ArrowRight size={14} /></button>
            <Link className="dp-button secondary" href="/connections">Cancel</Link>
          </div>
        </form>
      </section>
      <aside className="dp-panel"><div className="dp-panel-head"><h2 className="dp-panel-title">Before you connect</h2><LockKeyhole size={16} color="#4d826b" /></div><div className="dp-steps">
        <div className="dp-step"><span className="dp-step-num">01</span><div><div className="dp-step-title">Use a dedicated database user</div><div className="dp-step-desc">Grant only the read permissions your agent requires.</div></div></div>
        <div className="dp-step"><span className="dp-step-num">02</span><div><div className="dp-step-title">Test before saving</div><div className="dp-step-desc">We verify access and report the schema and table counts.</div></div></div>
        <div className="dp-step"><span className="dp-step-num">03</span><div><div className="dp-step-title">Issue scoped tokens</div><div className="dp-step-desc">Every agent token is bound to one saved connection.</div></div></div>
      </div></aside>
    </div>
  </div></Shell>;
}
function Tokens({ user }: { user: { email: string } }) {
  const qc = useQueryClient();
  const connectionsQuery = useListConnections();
  const tokensQuery = useListTokens();
  const create = useCreateToken();
  const revoke = useRevokeToken();
  const [connectionId, setConnectionId] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState('');
  const [validation, setValidation] = useState('');
  const [created, setCreated] = useState<{ token: string; info: ApiToken } | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => () => { setCreated(null); }, []);
  const connectionChoices = useMemo(() => connectionsQuery.data ?? [], [connectionsQuery.data]);
  useEffect(() => { if (!connectionId && connectionChoices.length) setConnectionId(connectionChoices[0].id); }, [connectionId, connectionChoices]);
  const selectedConnection = useMemo(() => connectionChoices.find(c => c.id === connectionId), [connectionChoices, connectionId]);
  const activeTokens = (tokensQuery.data ?? []).filter(t => !t.revokedAt);
  const createToken = (event: React.FormEvent) => {
    event.preventDefault(); setError(''); setValidation(''); setCreated(null);
    if (!connectionId) { setValidation('Choose a saved connection.'); return; }
    if (!label.trim() || label.trim().length > 80) { setValidation('Enter a label between 1 and 80 characters.'); return; }
    create.mutate({ data: { connectionId, label: label.trim() } }, {
      onSuccess: result => {
        setCreated({ token: result.token, info: result.tokenInfo }); setCopied(false); setLabel('');
        qc.invalidateQueries({ queryKey: getListTokensQueryKey() }); qc.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
      },
      onError: err => setError(getError(err, 'Could not create the token.')),
    });
  };
  const copyToken = async () => {
    if (!created) return;
    try { await navigator.clipboard.writeText(created.token); setCopied(true); } catch { setError('Clipboard access was blocked. Select and copy the token manually.'); }
  };
  const revokeToken = (token: ApiToken) => {
    if (!window.confirm(`Revoke “${token.label}”? Any agent using this token will lose access.`)) return;
    setError('');
    revoke.mutate({ tokenId: token.id }, {
      onSuccess: () => { qc.invalidateQueries({ queryKey: getListTokensQueryKey() }); qc.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() }); },
      onError: err => setError(getError(err, 'Could not revoke this token.')),
    });
  };
  return <Shell user={user} title="Access tokens"><div className="dp-content">
    <PageHead eyebrow="Scoped credentials" title="Access tokens" subtitle="Create a unique, revocable credential for each agent and connection." />
    {error && <div style={{ marginBottom: 18 }}><Alert kind="error">{error}</Alert></div>}
    <div className="dp-content-two">
      <section className="dp-panel dp-form-panel">
        <div className="dp-eyebrow">Issue a credential</div><h2 className="dp-panel-title" style={{ fontSize: 19, margin: '7px 0 20px' }}>Create an access token</h2>
        {connectionsQuery.isLoading ? <LoadingRows count={1} /> : connectionsQuery.isError ? <Alert kind="error">{getError(connectionsQuery.error)} <button className="dp-button secondary small" onClick={() => connectionsQuery.refetch()}>Retry</button></Alert> : connectionsQuery.data?.length ? <form className="dp-form" onSubmit={createToken} noValidate>
          <label className="dp-field"><span className="dp-label">Connection</span><select className="dp-select" value={connectionId} onChange={e => { setConnectionId(e.target.value); setCreated(null); }} data-testid="select-token-connection">{connectionsQuery.data.map(c => <option key={c.id} value={c.id}>{c.name} — {databaseNames[c.databaseType]}</option>)}</select><span className="dp-hint">This token will only access the selected connection.</span></label>
          <label className="dp-field"><span className="dp-label">Token label</span><input className="dp-input" value={label} maxLength={80} onChange={e => setLabel(e.target.value)} placeholder="e.g. Reporting assistant" data-testid="input-token-label" /><span className="dp-hint">Use the agent or integration name so you can identify it later.</span></label>
          {validation && <span className="dp-field-error" role="alert">{validation}</span>}
          <button className="dp-button" type="submit" disabled={create.isPending} data-testid="button-create-token">{create.isPending ? 'Creating…' : 'Create token'}<ArrowRight size={14} /></button>
        </form> : <Empty icon={<Database size={19} />} title="Connect a database first" detail="An access token must be scoped to a saved connection." action={<Link href="/connections/new" className="dp-button small"><Plus size={14} />Add a connection</Link>} />}
        {created && <div style={{ marginTop: 22, display: 'grid', gap: 12 }} data-testid="status-token-created">
          <Alert kind="success"><span><strong>Token created.</strong> Copy it now. The plaintext will not be shown again.</span></Alert>
          <div className="dp-token-secret">{created.token}</div>
          <div className="dp-form-actions"><button className="dp-button small" onClick={copyToken} data-testid="button-copy-token">{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? 'Copied' : 'Copy token'}</button><button className="dp-button secondary small" onClick={() => setCreated(null)} data-testid="button-dismiss-token">I’ve saved it</button></div>
        </div>}
      </section>
      <aside className="dp-panel"><div className="dp-panel-head"><h2 className="dp-panel-title">MCP setup</h2><Layers3 size={16} color="#4d826b" /></div><div style={{ padding: 21 }}>
        {selectedConnection ? <>
          <div className="dp-item-title" style={{ marginBottom: 6 }}>{selectedConnection.name}</div><div className="dp-item-sub" style={{ marginBottom: 17 }}>{databaseNames[selectedConnection.databaseType]}</div>
          <p className="dp-hint" style={{ margin: '0 0 14px' }}>Add your token to the MCP client environment. Keep it in a secret manager; never commit it to source control.</p>
          <pre className="dp-code">{`MCP URL: ${window.location.origin}/api/mcp\nAuthorization: Bearer <your-token>\nDATABASE_PILOT_TOKEN=<token-shown-once>\nDATABASE_PILOT_CONNECTION=${selectedConnection.name}`}</pre>
          <div className="dp-step-desc" style={{ marginTop: 13 }}>Use a client that supports a custom bearer header. This token can access only the selected connection. Keep it in a secret manager; never commit it to source control.</div>
        </> : <div className="dp-hint">Choose or add a saved connection to see setup guidance for that database.</div>}
      </div></aside>
    </div>
    <section className="dp-panel" style={{ marginTop: 22 }}>
      <div className="dp-panel-head"><h2 className="dp-panel-title">Issued tokens</h2><span className="dp-muted-note">{activeTokens.length} active</span></div>
      {tokensQuery.isLoading ? <div style={{ padding: 18 }}><LoadingRows /></div> : tokensQuery.isError ? <div style={{ padding: 18 }}><Alert kind="error">{getError(tokensQuery.error)} <button className="dp-button secondary small" onClick={() => tokensQuery.refetch()}>Retry</button></Alert></div> : tokensQuery.data?.length ? <div className="dp-list">{tokensQuery.data.map(t => <TokenRow key={t.id} token={t} action={!t.revokedAt ? <button className="dp-button danger small" disabled={revoke.isPending} onClick={() => revokeToken(t)} data-testid={`button-revoke-${t.id}`}><X size={13} />Revoke</button> : undefined} />)}</div> : <Empty icon={<KeyRound size={19} />} title="No tokens created" detail="Tokens you create for database connections will be listed here. Plaintext is only shown once." />}
    </section>
  </div></Shell>;
}
function SessionLoading() {
  return <div style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', background: '#f5f2e9' }}><div style={{ width: 'min(500px,84vw)' }}><div className="dp-skeleton" /><div style={{ height: 12 }} /><div className="dp-skeleton" /></div></div>;
}
function SessionFailure({ retry }: { retry: () => void }) {
  return <AuthLayout><div className="dp-auth-card"><div className="dp-eyebrow">Session unavailable</div><h2>We couldn’t check your account.</h2><p className="dp-subtitle">Check your connection and try again. Your credentials have not been changed.</p><button className="dp-button" onClick={retry}><RefreshCw size={14} />Try again</button></div></AuthLayout>;
}
function RoutedApp() {
  const session = useGetSession({ query: { queryKey: getGetSessionQueryKey(), retry: false } });
  const [location] = useLocation();
  if (session.isLoading) return <SessionLoading />;
  if (session.isError) return <SessionFailure retry={() => session.refetch()} />;
  const user = session.data?.authenticated ? session.data.user : null;
  if (location === '/login') return user ? <Overview user={user} /> : <AuthPage mode="login" />;
  if (location === '/register') return user ? <Overview user={user} /> : <AuthPage mode="register" />;
  if (!user) return <SignedOutHome />;
  return <Switch>
    <Route path="/" component={() => <Overview user={user} />} />
    <Route path="/connections" component={() => <Connections user={user} />} />
    <Route path="/connections/new" component={() => <NewConnection user={user} />} />
    <Route path="/tokens" component={() => <Tokens user={user} />} />
    <Route component={() => <Shell user={user} title="Not found"><div className="dp-content"><PageHead eyebrow="404" title="Page not found" subtitle="This workspace page does not exist." action={<Link className="dp-button" href="/">Back to overview</Link>} /></div></Shell>} />
  </Switch>;
}
function App() {
  return <QueryClientProvider client={queryClient}><RoutedApp /></QueryClientProvider>;
}
export default App;