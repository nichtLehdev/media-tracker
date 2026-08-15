namespace Jellyfin.Plugin.Tracker.Queue;

using System.Globalization;
using Microsoft.Data.Sqlite;

/// <summary>
/// S7.3. Member servers lose connectivity, so nothing may live only in memory.
///
/// The queue is durable and ordered: events flush in the order Jellyfin raised
/// them, which matters because a playback stop must not overtake its start.
/// Writes are synchronous, and deliberately so -- the spec's rule is that a
/// Jellyfin event handler must never block on *network* IO, and a WAL-mode
/// insert is sub-millisecond. Handing off to a background writer instead would
/// open a window where a crash loses the very events this table exists for.
/// </summary>
public sealed class OutboundQueue : IDisposable
{
    private readonly string _connectionString;
    private readonly object _gate = new();
    private bool _disposed;

    /// <summary>Initializes a new instance of the <see cref="OutboundQueue"/> class.</summary>
    /// <param name="databasePath">Full path to the SQLite file.</param>
    public OutboundQueue(string databasePath)
    {
        _connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = databasePath,
            Mode = SqliteOpenMode.ReadWriteCreate,
            Pooling = true,
        }.ToString();

        Initialise();
    }

    /// <summary>What a queued payload is destined for.</summary>
    public enum PayloadKind
    {
        /// <summary>A batch of watch and playback events (S6.2).</summary>
        Ingest,

        /// <summary>A library delta (S6.3.1).</summary>
        LibraryDelta,
    }

    /// <summary>One queued item.</summary>
    /// <param name="Id">Row id, used to acknowledge it.</param>
    /// <param name="Kind">Where the payload should be sent.</param>
    /// <param name="Payload">The JSON body.</param>
    /// <param name="CreatedAt">When it was enqueued, UTC.</param>
    public readonly record struct QueuedItem(
        long Id,
        PayloadKind Kind,
        string Payload,
        DateTimeOffset CreatedAt);

    /// <summary>Appends an item. Safe to call from a Jellyfin event handler.</summary>
    /// <param name="kind">Where the payload should be sent.</param>
    /// <param name="payload">The JSON body.</param>
    /// <param name="now">Enqueue time, UTC.</param>
    /// <returns>The new row id.</returns>
    public long Enqueue(PayloadKind kind, string payload, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(payload);

        lock (_gate)
        {
            using var connection = Open();
            using var command = connection.CreateCommand();
            command.CommandText =
                """
                INSERT INTO outbox (kind, payload, created_at)
                VALUES ($kind, $payload, $created_at)
                RETURNING id;
                """;
            command.Parameters.AddWithValue("$kind", (int)kind);
            command.Parameters.AddWithValue("$payload", payload);
            command.Parameters.AddWithValue("$created_at", Iso(now));
            return (long)command.ExecuteScalar()!;
        }
    }

    /// <summary>
    /// Reads the oldest items without removing them. They stay queued until
    /// the tracker has accepted them (S6.2: the plugin may only drop what was
    /// accepted, or permanently rejected).
    /// </summary>
    /// <param name="limit">Maximum items to return.</param>
    /// <returns>Items in insertion order.</returns>
    public IReadOnlyList<QueuedItem> Peek(int limit)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(limit);

        lock (_gate)
        {
            using var connection = Open();
            using var command = connection.CreateCommand();
            command.CommandText =
                """
                SELECT id, kind, payload, created_at
                FROM outbox
                ORDER BY id
                LIMIT $limit;
                """;
            command.Parameters.AddWithValue("$limit", limit);

            var items = new List<QueuedItem>();
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                items.Add(new QueuedItem(
                    reader.GetInt64(0),
                    (PayloadKind)reader.GetInt32(1),
                    reader.GetString(2),
                    DateTimeOffset.Parse(
                        reader.GetString(3),
                        CultureInfo.InvariantCulture,
                        DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal)));
            }

            return items;
        }
    }

    /// <summary>Removes items the tracker has taken responsibility for.</summary>
    /// <param name="ids">Row ids to remove.</param>
    /// <returns>How many rows were removed.</returns>
    public int Acknowledge(IReadOnlyCollection<long> ids)
    {
        ArgumentNullException.ThrowIfNull(ids);
        if (ids.Count == 0)
        {
            return 0;
        }

        lock (_gate)
        {
            using var connection = Open();
            using var transaction = connection.BeginTransaction();
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = "DELETE FROM outbox WHERE id = $id;";
            var parameter = command.CreateParameter();
            parameter.ParameterName = "$id";
            command.Parameters.Add(parameter);

            var removed = 0;
            foreach (var id in ids)
            {
                parameter.Value = id;
                removed += command.ExecuteNonQuery();
            }

            transaction.Commit();
            return removed;
        }
    }

    /// <summary>
    /// S7.3: drop events older than 30 days. A member whose server was off for
    /// a month has lost the window in which their history was still useful,
    /// and an unbounded queue is worse than a gap.
    /// </summary>
    /// <param name="olderThan">Cutoff; items created before this are dropped.</param>
    /// <returns>How many rows were dropped.</returns>
    public int Purge(DateTimeOffset olderThan)
    {
        lock (_gate)
        {
            using var connection = Open();
            using var command = connection.CreateCommand();
            command.CommandText = "DELETE FROM outbox WHERE created_at < $cutoff;";
            command.Parameters.AddWithValue("$cutoff", Iso(olderThan));
            return command.ExecuteNonQuery();
        }
    }

    /// <summary>Gets the number of queued items, for the config page (S7.5).</summary>
    /// <returns>Queue depth.</returns>
    public long Depth()
    {
        lock (_gate)
        {
            using var connection = Open();
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT COUNT(*) FROM outbox;";
            return (long)command.ExecuteScalar()!;
        }
    }

    /// <inheritdoc />
    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        SqliteConnection.ClearPool(new SqliteConnection(_connectionString));
    }

    private static string Iso(DateTimeOffset value) =>
        value.ToUniversalTime().ToString("o", CultureInfo.InvariantCulture);

    private SqliteConnection Open()
    {
        var connection = new SqliteConnection(_connectionString);
        connection.Open();
        return connection;
    }

    private void Initialise()
    {
        lock (_gate)
        {
            using var connection = Open();
            using var command = connection.CreateCommand();
            command.CommandText =
                """
                PRAGMA journal_mode = WAL;
                PRAGMA synchronous = NORMAL;

                CREATE TABLE IF NOT EXISTS outbox (
                    id         INTEGER PRIMARY KEY AUTOINCREMENT,
                    kind       INTEGER NOT NULL,
                    payload    TEXT    NOT NULL,
                    created_at TEXT    NOT NULL
                );

                CREATE INDEX IF NOT EXISTS outbox_created_at ON outbox (created_at);
                """;
            command.ExecuteNonQuery();
        }
    }
}
