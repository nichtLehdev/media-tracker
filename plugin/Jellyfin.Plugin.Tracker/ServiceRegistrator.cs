namespace Jellyfin.Plugin.Tracker;

using Jellyfin.Plugin.Tracker.Api;
using Jellyfin.Plugin.Tracker.Configuration;
using Jellyfin.Plugin.Tracker.Events;
using Jellyfin.Plugin.Tracker.Queue;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.Extensions.DependencyInjection;

/// <summary>S7.1. Registers the plugin's services with Jellyfin's container.</summary>
public sealed class ServiceRegistrator : IPluginServiceRegistrator
{
    /// <inheritdoc />
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        // Configuration is read through a delegate rather than injected once:
        // the owner can re-register or change exclusions at any time, and the
        // services must see that without a Jellyfin restart.
        serviceCollection.AddSingleton<Func<PluginConfiguration>>(
            _ => () => Plugin.Instance?.Configuration ?? new PluginConfiguration());

        serviceCollection.AddSingleton(_ => new OutboundQueue(
            Path.Combine(
                Plugin.Instance?.DataPath ?? Path.GetTempPath(),
                "tracker-queue.db")));

        serviceCollection.AddSingleton<LibraryExclusion>();

        serviceCollection.AddHttpClient<TrackerApiClient>(client =>
        {
            // Long enough for a 200-event batch over a slow domestic uplink,
            // short enough that a black-holed connection does not hold the
            // flush loop past its next tick.
            client.Timeout = TimeSpan.FromSeconds(30);
        });

        serviceCollection.AddHostedService<PlaybackEventService>();
        serviceCollection.AddHostedService<QueueFlushService>();
    }
}
