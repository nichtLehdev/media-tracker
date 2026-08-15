namespace Jellyfin.Plugin.Tracker.Controllers;

using Jellyfin.Plugin.Tracker.Api;
using Jellyfin.Plugin.Tracker.Queue;
using MediaBrowser.Common.Api;
using MediaBrowser.Controller;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

/// <summary>
/// The config page's own endpoints (S7.5). Administrator-only: registering a
/// server hands out a bearer token scoped to this whole Jellyfin instance.
/// </summary>
[ApiController]
[Authorize(Policy = Policies.RequiresElevation)]
[Route("Tracker")]
public sealed class TrackerController : ControllerBase
{
    private readonly TrackerApiClient _client;
    private readonly OutboundQueue _queue;
    private readonly IServerApplicationHost _applicationHost;
    private readonly QueueFlushService? _flush;
    private readonly ILogger<TrackerController> _logger;

    /// <summary>Initializes a new instance of the <see cref="TrackerController"/> class.</summary>
    /// <param name="client">Tracker API client.</param>
    /// <param name="queue">The durable outbound queue.</param>
    /// <param name="applicationHost">Jellyfin host, for its version.</param>
    /// <param name="flush">The flush service, for status.</param>
    /// <param name="logger">Logger.</param>
    public TrackerController(
        TrackerApiClient client,
        OutboundQueue queue,
        IServerApplicationHost applicationHost,
        IEnumerable<Microsoft.Extensions.Hosting.IHostedService> flush,
        ILogger<TrackerController> logger)
    {
        _client = client;
        _queue = queue;
        _applicationHost = applicationHost;
        _flush = flush.OfType<QueueFlushService>().FirstOrDefault();
        _logger = logger;
    }

    /// <summary>Body of a registration request from the config page.</summary>
    public sealed class RegisterBody
    {
        /// <summary>Tracker base URL.</summary>
        public string TrackerBaseUrl { get; set; } = string.Empty;

        /// <summary>The one-time code from the tracker's website.</summary>
        public string RegistrationCode { get; set; } = string.Empty;

        /// <summary>Owner-chosen name for this server.</summary>
        public string? Name { get; set; }
    }

    /// <summary>What the config page shows under "Status".</summary>
    public sealed class StatusBody
    {
        /// <summary>Whether credentials are present.</summary>
        public bool Registered { get; set; }

        /// <summary>Items waiting to be sent.</summary>
        public long QueueDepth { get; set; }

        /// <summary>When the last flush succeeded, ISO 8601.</summary>
        public string? LastSuccessAt { get; set; }

        /// <summary>Last failure detail, if any.</summary>
        public string? LastError { get; set; }
    }

    /// <summary>S6.1. Exchanges a one-time code for credentials and stores them.</summary>
    /// <param name="body">Registration details.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>No content on success.</returns>
    [HttpPost("Register")]
    public async Task<ActionResult> Register(
        [FromBody] RegisterBody body,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(body);

        var plugin = Plugin.Instance;
        if (plugin is null)
        {
            return StatusCode(500, "plugin not initialised");
        }

        try
        {
            var response = await _client.RegisterAsync(
                body.TrackerBaseUrl,
                new RegisterRequest
                {
                    RegistrationCode = body.RegistrationCode.Trim(),
                    Name = string.IsNullOrWhiteSpace(body.Name)
                        ? _applicationHost.FriendlyName
                        : body.Name,
                    JellyfinVersion = _applicationHost.ApplicationVersionString,
                    PluginVersion = GetType().Assembly.GetName().Version?.ToString(),
                },
                cancellationToken).ConfigureAwait(false);

            var configuration = plugin.Configuration;
            configuration.TrackerBaseUrl = body.TrackerBaseUrl.Trim();
            configuration.ServerId = response.ServerId;
            configuration.ServerSecret = response.ServerSecret;
            plugin.UpdateConfiguration(configuration);

            // Never log the secret (S15); the id is not sensitive.
            _logger.LogInformation("Registered with the tracker as {ServerId}", response.ServerId);
            return NoContent();
        }
        catch (HttpRequestException ex)
        {
            _logger.LogWarning(ex, "Registration failed");
            return BadRequest(ex.Message);
        }
    }

    /// <summary>Status for the config page.</summary>
    /// <returns>Current connection and queue state.</returns>
    [HttpGet("Status")]
    public ActionResult<StatusBody> Status()
    {
        var configuration = Plugin.Instance?.Configuration;
        return new StatusBody
        {
            Registered = configuration?.IsRegistered ?? false,
            QueueDepth = _queue.Depth(),
            LastSuccessAt = _flush?.LastSuccessAt?.ToString("o", System.Globalization.CultureInfo.InvariantCulture),
            LastError = _flush?.LastError,
        };
    }
}
