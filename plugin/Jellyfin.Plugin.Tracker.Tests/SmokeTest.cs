namespace Jellyfin.Plugin.Tracker.Tests;

using Jellyfin.Plugin.Tracker.Media;
using Xunit;

public class SmokeTest
{
    [Fact]
    public void TestProjectCanReferenceThePlugin()
        => Assert.Equal("und", LanguageNormaliser.Normalise(null));
}
