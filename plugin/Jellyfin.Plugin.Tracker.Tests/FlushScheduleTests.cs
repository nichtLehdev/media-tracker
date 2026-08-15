namespace Jellyfin.Plugin.Tracker.Tests;

using Jellyfin.Plugin.Tracker.Queue;
using Xunit;

/// <summary>S7.3: 15s, 30s, 1m, 5m, 15m, capped.</summary>
public class FlushScheduleTests
{
    [Fact]
    public void StartsAtTheIdleInterval()
        => Assert.Equal(TimeSpan.FromSeconds(15), new FlushSchedule().Delay);

    [Fact]
    public void BacksOffAlongTheLadder()
    {
        var schedule = new FlushSchedule();
        var seen = new List<TimeSpan> { schedule.Delay };

        for (var i = 0; i < 4; i++)
        {
            schedule.Failed();
            seen.Add(schedule.Delay);
        }

        Assert.Equal(
            [
                TimeSpan.FromSeconds(15),
                TimeSpan.FromSeconds(30),
                TimeSpan.FromMinutes(1),
                TimeSpan.FromMinutes(5),
                TimeSpan.FromMinutes(15),
            ],
            seen);
    }

    [Fact]
    public void CapsRatherThanGrowingForever()
    {
        var schedule = new FlushSchedule();
        for (var i = 0; i < 50; i++)
        {
            schedule.Failed();
        }

        // A tracker down for a day must still be retried every 15 minutes.
        Assert.Equal(TimeSpan.FromMinutes(15), schedule.Delay);
    }

    [Fact]
    public void RecoversImmediatelyOnSuccess()
    {
        var schedule = new FlushSchedule();
        schedule.Failed();
        schedule.Failed();
        schedule.Failed();

        schedule.Succeeded();

        Assert.Equal(TimeSpan.FromSeconds(15), schedule.Delay);
        Assert.Equal(0, schedule.Failures);
    }
}
