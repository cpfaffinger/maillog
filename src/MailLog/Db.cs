using System.Text;
using Npgsql;

namespace MailLog;

/// <summary>Thin PostgreSQL wrapper: pooled connections, named parameters from anonymous objects, camelCase row dictionaries.</summary>
public sealed class Db
{
    private readonly NpgsqlDataSource _ds;

    public Db(Settings settings, ILogger<Db> log)
    {
        if (string.IsNullOrWhiteSpace(settings.DbConnection))
            throw new InvalidOperationException("MAILLOG_DB_CONNECTION must be set");
        _ds = NpgsqlDataSource.Create(settings.DbConnection);
        Migrate(settings, log);
    }

    public NpgsqlConnection Open() => _ds.OpenConnection();

    public static NpgsqlCommand Cmd(NpgsqlConnection c, string sql, object? p = null, NpgsqlTransaction? tx = null)
    {
        var cmd = c.CreateCommand();
        cmd.CommandText = sql;
        cmd.Transaction = tx;
        Bind(cmd, p);
        return cmd;
    }

    public static void Bind(NpgsqlCommand cmd, object? p)
    {
        if (p is null) return;
        if (p is IDictionary<string, object?> dict)
        {
            foreach (var (k, v) in dict) cmd.Parameters.AddWithValue(k, v ?? DBNull.Value);
            return;
        }
        foreach (var pr in p.GetType().GetProperties())
            cmd.Parameters.AddWithValue(pr.Name, pr.GetValue(p) ?? DBNull.Value);
    }

    public int Exec(string sql, object? p = null)
    {
        using var c = Open();
        using var cmd = Cmd(c, sql, p);
        return cmd.ExecuteNonQuery();
    }

    public T? Scalar<T>(string sql, object? p = null)
    {
        using var c = Open();
        using var cmd = Cmd(c, sql, p);
        var v = cmd.ExecuteScalar();
        if (v is null || v is DBNull) return default;
        return (T)Convert.ChangeType(v, Nullable.GetUnderlyingType(typeof(T)) ?? typeof(T));
    }

    /// <summary>Runs a query and returns each row as a dictionary; snake_case columns become camelCase keys.</summary>
    public List<Dictionary<string, object?>> Rows(string sql, object? p = null)
    {
        using var c = Open();
        using var cmd = Cmd(c, sql, p);
        using var r = cmd.ExecuteReader();
        var names = new string[r.FieldCount];
        for (var i = 0; i < names.Length; i++) names[i] = CamelCase(r.GetName(i));
        var list = new List<Dictionary<string, object?>>();
        while (r.Read())
        {
            var d = new Dictionary<string, object?>(names.Length);
            for (var i = 0; i < names.Length; i++) d[names[i]] = r.IsDBNull(i) ? null : r.GetValue(i);
            list.Add(d);
        }
        return list;
    }

    public static string CamelCase(string snake)
    {
        if (!snake.Contains('_')) return snake;
        var sb = new StringBuilder(snake.Length);
        var up = false;
        foreach (var ch in snake)
        {
            if (ch == '_') { up = true; continue; }
            sb.Append(up ? char.ToUpperInvariant(ch) : ch);
            up = false;
        }
        return sb.ToString();
    }

    public string? GetSetting(string key) => Scalar<string>("SELECT value FROM settings WHERE key=@key", new { key });

    public void SetSetting(string key, string value) =>
        Exec("INSERT INTO settings(key, value) VALUES(@key, @value) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", new { key, value });

    private void Migrate(Settings s, ILogger log)
    {
        // The database container may still be starting.
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                using var c = Open();
                using var has = Cmd(c, "SELECT count(*) FROM information_schema.columns WHERE table_name='events' AND column_name='message_id'");
                var columnExisted = Convert.ToInt64(has.ExecuteScalar()) > 0;
                var tableExists = Convert.ToInt64(Cmd(c, "SELECT count(*) FROM information_schema.tables WHERE table_name='events'").ExecuteScalar()) > 0;
                using var cmd = Cmd(c, Schema);
                cmd.ExecuteNonQuery();
                if (tableExists && !columnExisted)
                {
                    // existing installation: derive the message id of already stored "cleanup ... message-id=<..>" lines once
                    using var fill = Cmd(c, @"UPDATE events SET message_id = NULLIF(btrim(btrim(substring(detail from '^message-id=(.*)$')), '<>'), '')
                                              WHERE kind='meta' AND detail LIKE 'message-id=%' AND message_id IS NULL");
                    fill.CommandTimeout = 600;
                    var n = fill.ExecuteNonQuery();
                    log.LogInformation("Added events.message_id, filled {Count} existing rows", n);
                }
                break;
            }
            catch (Exception e) when (attempt < 30 && e is NpgsqlException or System.Net.Sockets.SocketException or TimeoutException)
            {
                log.LogWarning("Database not ready yet ({Attempt}/30): {Message}", attempt, e.Message);
                Thread.Sleep(2000);
            }
        }
        if (GetSetting("retention_days") is null) SetSetting("retention_days", s.RetentionDays.ToString());
    }

    private const string Schema = """
        CREATE EXTENSION IF NOT EXISTS pg_trgm;

        CREATE TABLE IF NOT EXISTS settings(
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS dp_keys(
          name TEXT PRIMARY KEY,
          xml TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS users(
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL UNIQUE,
          display_name TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL,
          domains TEXT[] NOT NULL DEFAULT '{}',
          disabled BOOLEAN NOT NULL DEFAULT FALSE,
          must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
          created_at BIGINT NOT NULL,
          last_login BIGINT
        );

        CREATE TABLE IF NOT EXISTS passkeys(
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          credential_id BYTEA NOT NULL UNIQUE,
          public_key BYTEA NOT NULL,
          user_handle BYTEA NOT NULL,
          sign_count BIGINT NOT NULL DEFAULT 0,
          created_at BIGINT NOT NULL,
          last_used BIGINT
        );

        CREATE TABLE IF NOT EXISTS api_tokens(
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          prefix TEXT NOT NULL,
          read_only BOOLEAN NOT NULL DEFAULT TRUE,
          created_at BIGINT NOT NULL,
          expires_at BIGINT,
          last_used BIGINT,
          revoked BOOLEAN NOT NULL DEFAULT FALSE
        );

        CREATE TABLE IF NOT EXISTS agents(
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          role TEXT NOT NULL,
          token_hash TEXT UNIQUE,
          enroll_hash TEXT UNIQUE,
          enroll_expires BIGINT,
          created_at BIGINT NOT NULL,
          enrolled_at BIGINT,
          last_seen BIGINT,
          last_ip TEXT,
          hostname TEXT,
          version TEXT,
          checks_json TEXT NOT NULL,
          logs_json TEXT NOT NULL,
          interval_s INTEGER NOT NULL DEFAULT 30
        );

        CREATE TABLE IF NOT EXISTS events(
          id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          agent_id TEXT NOT NULL,
          ts BIGINT NOT NULL,
          source TEXT NOT NULL,
          program TEXT,
          pid INTEGER,
          queue_id TEXT,
          kind TEXT NOT NULL,
          sender TEXT,
          recipient TEXT,
          client_ip TEXT,
          client_host TEXT,
          sasl_user TEXT,
          relay TEXT,
          status TEXT,
          dsn TEXT,
          next_queue_id TEXT,
          delay_s DOUBLE PRECISION,
          detail TEXT,
          raw TEXT NOT NULL,
          line_hash TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS ix_events_hash ON events(agent_id, line_hash);
        CREATE INDEX IF NOT EXISTS ix_events_ts ON events(ts);
        CREATE INDEX IF NOT EXISTS ix_events_agent_ts ON events(agent_id, ts);
        CREATE INDEX IF NOT EXISTS ix_events_kind_ts ON events(kind, ts);
        CREATE INDEX IF NOT EXISTS ix_events_q ON events(queue_id);
        CREATE INDEX IF NOT EXISTS ix_events_next ON events(next_queue_id) WHERE next_queue_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS ix_events_ip ON events(client_ip) WHERE client_ip IS NOT NULL;
        CREATE INDEX IF NOT EXISTS ix_events_sdomain ON events((lower(split_part(sender, '@', 2))), ts);
        ALTER TABLE events ADD COLUMN IF NOT EXISTS message_id TEXT;
        CREATE INDEX IF NOT EXISTS ix_events_msgid ON events(message_id) WHERE message_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS ix_events_sender_trgm ON events USING gin (sender gin_trgm_ops);
        CREATE INDEX IF NOT EXISTS ix_events_recipient_trgm ON events USING gin (recipient gin_trgm_ops);

        -- Service keys for integrations (e.g. a customer application asking for the status of a message). Not tied to a user; limited to sender domains.
        CREATE TABLE IF NOT EXISTS api_keys(
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          key_hash TEXT NOT NULL UNIQUE,
          prefix TEXT NOT NULL,
          domains TEXT[] NOT NULL,
          created_by TEXT,
          created_at BIGINT NOT NULL,
          expires_at BIGINT,
          last_used BIGINT,
          last_ip TEXT,
          use_count BIGINT NOT NULL DEFAULT 0,
          revoked BOOLEAN NOT NULL DEFAULT FALSE
        );

        CREATE TABLE IF NOT EXISTS health(
          agent_id TEXT NOT NULL,
          name TEXT NOT NULL,
          state TEXT NOT NULL,
          message TEXT,
          since BIGINT NOT NULL,
          updated BIGINT NOT NULL,
          PRIMARY KEY(agent_id, name)
        );

        CREATE TABLE IF NOT EXISTS health_history(
          id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          agent_id TEXT NOT NULL,
          name TEXT NOT NULL,
          state TEXT NOT NULL,
          message TEXT,
          ts BIGINT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ix_hh_ts ON health_history(ts);

        CREATE TABLE IF NOT EXISTS actions(
          id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          agent_id TEXT NOT NULL,
          ts BIGINT NOT NULL,
          name TEXT NOT NULL,
          action TEXT NOT NULL,
          ok BOOLEAN NOT NULL,
          result TEXT,
          notified BOOLEAN NOT NULL DEFAULT FALSE
        );
        CREATE INDEX IF NOT EXISTS ix_actions_ts ON actions(ts);

        CREATE TABLE IF NOT EXISTS metrics(
          agent_id TEXT NOT NULL,
          ts BIGINT NOT NULL,
          queue_total INTEGER,
          queue_deferred INTEGER,
          queue_active INTEGER,
          oldest_age_s INTEGER,
          queue_detail JSONB
        );
        CREATE INDEX IF NOT EXISTS ix_metrics ON metrics(agent_id, ts);

        CREATE TABLE IF NOT EXISTS alerts(
          id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          key TEXT NOT NULL,
          agent_id TEXT,
          severity TEXT NOT NULL,
          title TEXT NOT NULL,
          body TEXT,
          opened_at BIGINT NOT NULL,
          resolved_at BIGINT,
          last_notified BIGINT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS ix_alert_open ON alerts(key) WHERE resolved_at IS NULL;
        """;
}
