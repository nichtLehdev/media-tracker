namespace Jellyfin.Plugin.Tracker.Api;

using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Jellyfin.Plugin.Tracker.Configuration;

/// <summary>
/// The plugin's half of S6. Every call is outbound: the tracker can never
/// reach a member's server (C1), so there is no inbound surface here at all.
/// </summary>
public sealed class TrackerApiClient
{
    private static readonly JsonSerializerOptions SerializerOptions = new()
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly HttpClient _http;
    private readonly Func<PluginConfiguration> _configuration;

    /// <summary>Initializes a new instance of the <see cref="TrackerApiClient"/> class.</summary>
    /// <param name="http">Client to send with.</param>
    /// <param name="configuration">Reads current configuration each call, so a re-registration takes effect without a restart.</param>
    public TrackerApiClient(HttpClient http, Func<PluginConfiguration> configuration)
    {
        _http = http;
        _configuration = configuration;
    }

    /// <summary>Outcome of a flush attempt.</summary>
    /// <param name="Delivered">True when the tracker took responsibility for the payload.</param>
    /// <param name="Retryable">True when the same payload may be sent again.</param>
    /// <param name="Detail">Human-readable reason, for the config page.</param>
    public readonly record struct SendResult(bool Delivered, bool Retryable, string? Detail)
    {
        /// <summary>The tracker accepted the payload.</summary>
        /// <returns>A delivered result.</returns>
        public static SendResult Ok() => new(true, false, null);

        /// <summary>A transient failure; keep the payload and try later.</summary>
        /// <param name="detail">What went wrong.</param>
        /// <returns>A retryable result.</returns>
        public static SendResult Retry(string detail) => new(false, true, detail);

        /// <summary>The tracker will never accept this payload; drop it.</summary>
        /// <param name="detail">What went wrong.</param>
        /// <returns>A permanent failure.</returns>
        public static SendResult Permanent(string detail) => new(false, false, detail);
    }

    /// <summary>S6.1. Exchanges a one-time code for credentials.</summary>
    /// <param name="baseUrl">Tracker base URL.</param>
    /// <param name="request">Registration payload.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The assigned id and secret.</returns>
    public async Task<RegisterResponse> RegisterAsync(
        string baseUrl,
        RegisterRequest request,
        CancellationToken cancellationToken)
    {
        using var message = new HttpRequestMessage(
            HttpMethod.Post,
            new Uri(new Uri(Normalise(baseUrl)), "api/v1/servers/register"))
        {
            Content = JsonContent.Create(request, options: SerializerOptions),
        };

        using var response = await _http.SendAsync(message, cancellationToken).ConfigureAwait(false);
        response.EnsureSuccessStatusCode();

        return await response.Content
            .ReadFromJsonAsync<RegisterResponse>(SerializerOptions, cancellationToken)
            .ConfigureAwait(false)
            ?? throw new InvalidOperationException("registration returned an empty body");
    }

    /// <summary>Sends a queued payload to its endpoint.</summary>
    /// <param name="path">Endpoint path, e.g. api/v1/ingest.</param>
    /// <param name="json">The payload, already serialised.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Whether the payload may be dropped from the queue.</returns>
    public async Task<SendResult> PostAsync(
        string path,
        string json,
        CancellationToken cancellationToken)
    {
        var configuration = _configuration();
        if (!configuration.IsRegistered)
        {
            return SendResult.Retry("not registered");
        }

        using var message = new HttpRequestMessage(
            HttpMethod.Post,
            new Uri(new Uri(Normalise(configuration.TrackerBaseUrl)), path))
        {
            Content = new StringContent(json, System.Text.Encoding.UTF8, "application/json"),
        };
        message.Headers.Authorization =
            new AuthenticationHeaderValue("Bearer", configuration.ServerSecret);
        message.Headers.TryAddWithoutValidation(
            "X-Plugin-Version",
            typeof(TrackerApiClient).Assembly.GetName().Version?.ToString());

        HttpResponseMessage response;
        try
        {
            response = await _http.SendAsync(message, cancellationToken).ConfigureAwait(false);
        }
        catch (HttpRequestException ex)
        {
            // The usual case, and not an error worth alarming about: the member's
            // server is online but the tracker is not reachable right now.
            return SendResult.Retry(ex.Message);
        }
        catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return SendResult.Retry("timed out");
        }

        using (response)
        {
            if (response.IsSuccessStatusCode)
            {
                return SendResult.Ok();
            }

            // 401 means the owner revoked this server, or re-registered it. Retrying
            // cannot fix that, but neither should the queue be thrown away -- the
            // owner may re-register, so this is retryable and the config page is
            // where they find out (S7.5).
            if (response.StatusCode is HttpStatusCode.Unauthorized)
            {
                return SendResult.Retry("unauthorised: re-register this server");
            }

            // 4xx other than 401/408/429 means the tracker understood and refused.
            // Retrying a malformed payload forever would wedge the queue.
            var status = (int)response.StatusCode;
            var retryable = status is 408 or 429 || status >= 500;
            var detail = $"HTTP {status}";
            return retryable ? SendResult.Retry(detail) : SendResult.Permanent(detail);
        }
    }

    /// <summary>
    /// Posts and deserialises the response. Returns null when the tracker
    /// refuses, which for S6.3.2's `start` is the ordinary "this Jellyfin
    /// account is not linked" case rather than a failure.
    /// </summary>
    /// <typeparam name="T">Response type.</typeparam>
    /// <param name="path">Endpoint path.</param>
    /// <param name="json">Request body.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The response, or null.</returns>
    public async Task<T?> PostForAsync<T>(
        string path,
        string json,
        CancellationToken cancellationToken)
        where T : class
    {
        var configuration = _configuration();
        if (!configuration.IsRegistered)
        {
            return null;
        }

        using var message = new HttpRequestMessage(
            HttpMethod.Post,
            new Uri(new Uri(Normalise(configuration.TrackerBaseUrl)), path))
        {
            Content = new StringContent(json, System.Text.Encoding.UTF8, "application/json"),
        };
        message.Headers.Authorization =
            new AuthenticationHeaderValue("Bearer", configuration.ServerSecret);

        try
        {
            using var response = await _http.SendAsync(message, cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                return null;
            }

            return await response.Content
                .ReadFromJsonAsync<T>(SerializerOptions, cancellationToken)
                .ConfigureAwait(false);
        }
        catch (HttpRequestException)
        {
            return null;
        }
        catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return null;
        }
    }

    /// <summary>Ensures the base URL ends in a slash so relative paths resolve.</summary>
    private static string Normalise(string baseUrl) =>
        baseUrl.EndsWith('/') ? baseUrl : baseUrl + "/";
}
