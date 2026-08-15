namespace Jellyfin.Plugin.Tracker.Tests;

using Jellyfin.Plugin.Tracker.Events;
using Xunit;

/// <summary>S7.2: one progress event per 30 seconds per session.</summary>
public class ProgressThrottleTests
{
    private static readonly DateTimeOffset T0 = new(2026, 8, 15, 20, 0, 0, TimeSpan.Zero);

    [Fact]
    public void LetsTheFirstEventThrough()
        => Assert.True(new ProgressThrottle().ShouldSend("s1", T0));

    [Fact]
    public void SuppressesEventsInsideTheWindow()
    {
        var throttle = new ProgressThrottle();
        throttle.ShouldSend("s1", T0);

        Assert.False(throttle.ShouldSend("s1", T0.AddSeconds(5)));
        Assert.False(throttle.ShouldSend("s1", T0.AddSeconds(29)));
    }

    [Fact]
    public void LetsAnEventThroughOnceTheWindowHasPassed()
    {
        var throttle = new ProgressThrottle();
        throttle.ShouldSend("s1", T0);

        Assert.True(throttle.ShouldSend("s1", T0.AddSeconds(30)));
    }

    [Fact]
    public void MeasuresFromTheLastSentEventNotTheLastAttempt()
    {
        var throttle = new ProgressThrottle();
        throttle.ShouldSend("s1", T0);

        // Jellyfin keeps raising progress every few seconds; the suppressed ones
        // must not push the window along or nothing is ever sent again.
        for (var i = 1; i < 30; i++)
        {
            throttle.ShouldSend("s1", T0.AddSeconds(i));
        }

        Assert.True(throttle.ShouldSend("s1", T0.AddSeconds(30)));
    }

    [Fact]
    public void ThrottlesEachSessionSeparately()
    {
        var throttle = new ProgressThrottle();
        throttle.ShouldSend("s1", T0);

        // A household watching two things must not silence one with the other.
        Assert.True(throttle.ShouldSend("s2", T0.AddSeconds(1)));
    }

    [Fact]
    public void ForgettingASessionReleasesItsSlot()
    {
        var throttle = new ProgressThrottle();
        throttle.ShouldSend("s1", T0);

        throttle.Forget("s1");

        Assert.Equal(0, throttle.TrackedSessions);
        Assert.True(throttle.ShouldSend("s1", T0.AddSeconds(1)));
    }

    [Fact]
    public void IsSafeUnderConcurrentSessions()
    {
        var throttle = new ProgressThrottle();

        Parallel.For(0, 200, i => throttle.ShouldSend($"s{i}", T0));

        Assert.Equal(200, throttle.TrackedSessions);
    }
}
