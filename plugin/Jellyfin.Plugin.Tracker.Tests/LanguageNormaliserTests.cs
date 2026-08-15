namespace Jellyfin.Plugin.Tracker.Tests;

using Jellyfin.Plugin.Tracker.Media;
using Xunit;

/// <summary>
/// S7.7: language normalisation is the part of media profile extraction most likely to
/// silently mismatch real-library data, so these are data-driven against the spec's own
/// examples rather than aiming for line coverage.
/// </summary>
public class LanguageNormaliserTests
{
    // Every German spelling S7.7 calls out by name collapses to "de". "" and "und" are
    // covered separately below - they deliberately do NOT collapse to "de" (S7.7: unknown
    // language is different information from no track, even inside a German-only rip).
    [Theory]
    [InlineData("ger")]
    [InlineData("deu")]
    [InlineData("de")]
    [InlineData("de-DE")]
    [InlineData("German")]
    [InlineData("GERMAN")]
    [InlineData("german")]
    [InlineData(" de ")]
    [InlineData("DEU")]
    public void Normalise_GermanSpellings_CollapseToDe(string raw)
        => Assert.Equal("de", LanguageNormaliser.Normalise(raw));

    // S7.7 names these 639-2/B codes explicitly because they differ from 639-2/T; both
    // forms of every pair must resolve to the same ISO 639-1 code.
    [Theory]
    [InlineData("ger", "de")]
    [InlineData("deu", "de")]
    [InlineData("fre", "fr")]
    [InlineData("fra", "fr")]
    [InlineData("dut", "nl")]
    [InlineData("nld", "nl")]
    [InlineData("chi", "zh")]
    [InlineData("zho", "zh")]
    [InlineData("cze", "cs")]
    [InlineData("ces", "cs")]
    [InlineData("gre", "el")]
    [InlineData("ell", "el")]
    [InlineData("ice", "is")]
    [InlineData("isl", "is")]
    [InlineData("mac", "mk")]
    [InlineData("mkd", "mk")]
    [InlineData("mao", "mi")]
    [InlineData("mri", "mi")]
    [InlineData("may", "ms")]
    [InlineData("msa", "ms")]
    [InlineData("per", "fa")]
    [InlineData("fas", "fa")]
    [InlineData("rum", "ro")]
    [InlineData("ron", "ro")]
    [InlineData("slo", "sk")]
    [InlineData("slk", "sk")]
    [InlineData("wel", "cy")]
    [InlineData("cym", "cy")]
    [InlineData("arm", "hy")]
    [InlineData("hye", "hy")]
    [InlineData("baq", "eu")]
    [InlineData("eus", "eu")]
    [InlineData("bur", "my")]
    [InlineData("mya", "my")]
    [InlineData("geo", "ka")]
    [InlineData("kat", "ka")]
    [InlineData("tib", "bo")]
    [InlineData("bod", "bo")]
    public void Normalise_Iso6392BAndTCodes_MapToIso6391(string raw, string expected)
        => Assert.Equal(expected, LanguageNormaliser.Normalise(raw));

    // Also verify by uppercasing every code from the table above, to catch a
    // case-sensitive comparer hiding behind correct-looking lowercase test data.
    [Theory]
    [InlineData("GER", "de")]
    [InlineData("FRA", "fr")]
    [InlineData("NLD", "nl")]
    [InlineData("ZHO", "zh")]
    [InlineData("CES", "cs")]
    [InlineData("ELL", "el")]
    [InlineData("ISL", "is")]
    [InlineData("MKD", "mk")]
    [InlineData("MRI", "mi")]
    [InlineData("MSA", "ms")]
    [InlineData("FAS", "fa")]
    [InlineData("RON", "ro")]
    [InlineData("SLK", "sk")]
    [InlineData("CYM", "cy")]
    [InlineData("HYE", "hy")]
    [InlineData("EUS", "eu")]
    [InlineData("MYA", "my")]
    [InlineData("KAT", "ka")]
    [InlineData("BOD", "bo")]
    public void Normalise_Iso6392TCodesUppercase_MapToIso6391(string raw, string expected)
        => Assert.Equal(expected, LanguageNormaliser.Normalise(raw));

    // Common world languages beyond the explicit 639-2/B list, in 639-1/639-2/English
    // forms, spot-checked rather than exhaustively enumerated.
    [Theory]
    [InlineData("eng", "en")]
    [InlineData("english", "en")]
    [InlineData("spa", "es")]
    [InlineData("SPANISH", "es")]
    [InlineData("ita", "it")]
    [InlineData("italian", "it")]
    [InlineData("por", "pt")]
    [InlineData("portuguese", "pt")]
    [InlineData("Brazilian Portuguese", "pt")]
    [InlineData("rus", "ru")]
    [InlineData("russian", "ru")]
    [InlineData("jpn", "ja")]
    [InlineData("japanese", "ja")]
    [InlineData("kor", "ko")]
    [InlineData("korean", "ko")]
    [InlineData("pol", "pl")]
    [InlineData("polish", "pl")]
    [InlineData("swe", "sv")]
    [InlineData("swedish", "sv")]
    [InlineData("dan", "da")]
    [InlineData("danish", "da")]
    [InlineData("nor", "no")]
    [InlineData("norwegian", "no")]
    [InlineData("fin", "fi")]
    [InlineData("finnish", "fi")]
    [InlineData("dutch", "nl")]
    [InlineData("tur", "tr")]
    [InlineData("turkish", "tr")]
    [InlineData("ara", "ar")]
    [InlineData("arabic", "ar")]
    [InlineData("hin", "hi")]
    [InlineData("hindi", "hi")]
    [InlineData("heb", "he")]
    [InlineData("hebrew", "he")]
    [InlineData("tha", "th")]
    [InlineData("thai", "th")]
    [InlineData("vie", "vi")]
    [InlineData("vietnamese", "vi")]
    [InlineData("ukr", "uk")]
    [InlineData("ukrainian", "uk")]
    [InlineData("hun", "hu")]
    [InlineData("hungarian", "hu")]
    [InlineData("bul", "bg")]
    [InlineData("bulgarian", "bg")]
    [InlineData("hrv", "hr")]
    [InlineData("croatian", "hr")]
    [InlineData("srp", "sr")]
    [InlineData("serbian", "sr")]
    [InlineData("slv", "sl")]
    [InlineData("slovenian", "sl")]
    [InlineData("est", "et")]
    [InlineData("estonian", "et")]
    [InlineData("lav", "lv")]
    [InlineData("latvian", "lv")]
    [InlineData("lit", "lt")]
    [InlineData("lithuanian", "lt")]
    [InlineData("cat", "ca")]
    [InlineData("catalan", "ca")]
    [InlineData("glg", "gl")]
    [InlineData("galician", "gl")]
    [InlineData("ind", "id")]
    [InlineData("indonesian", "id")]
    [InlineData("chinese", "zh")]
    [InlineData("malay", "ms")]
    public void Normalise_OtherCommonLanguages_MapToIso6391(string raw, string expected)
        => Assert.Equal(expected, LanguageNormaliser.Normalise(raw));

    // BCP 47 region/script subtags carry no readiness-relevant information once the
    // primary language subtag resolves (S7.7); stripping must work for region and
    // script subtags alike, and for languages outside the worked German example.
    [Theory]
    [InlineData("de-DE", "de")]
    [InlineData("pt-BR", "pt")]
    [InlineData("pt-PT", "pt")]
    [InlineData("en-US", "en")]
    [InlineData("en-GB", "en")]
    [InlineData("zh-Hans", "zh")]
    [InlineData("zh-Hant", "zh")]
    [InlineData("zh-CN", "zh")]
    [InlineData("fr-CA", "fr")]
    public void Normalise_RegionAndScriptTags_StripToPrimarySubtag(string raw, string expected)
        => Assert.Equal(expected, LanguageNormaliser.Normalise(raw));

    // Case-insensitivity and whitespace-trimming must apply uniformly, not just to the
    // German examples spelled out above.
    [Theory]
    [InlineData("  english  ", "en")]
    [InlineData("FreNcH", "fr")]
    [InlineData("\tPortuguese\n", "pt")]
    [InlineData("ZH-CN", "zh")]
    [InlineData("zh-cn", "zh")]
    public void Normalise_CaseAndWhitespace_AreIgnored(string raw, string expected)
        => Assert.Equal(expected, LanguageNormaliser.Normalise(raw));

    // Empty, unknown, and unrecognised junk all map to the literal "und" and must not
    // throw - S7.7 treats "und" as real information ("unknown language" vs. "no track")
    // rather than something to discard or collapse to a guess.
    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("\t")]
    [InlineData("und")]
    [InlineData("UND")]
    [InlineData(" und ")]
    [InlineData("xxx")]
    [InlineData("zz")]
    [InlineData("Director Commentary")]
    [InlineData("Commentary")]
    [InlineData("not-a-language")]
    [InlineData("-")]
    public void Normalise_EmptyUnknownOrJunk_ReturnsUnd(string? raw)
        => Assert.Equal("und", LanguageNormaliser.Normalise(raw));

    // An input that is already a valid ISO 639-1 code for a covered language passes
    // through unchanged, lowercased.
    [Theory]
    [InlineData("de", "de")]
    [InlineData("DE", "de")]
    [InlineData("en", "en")]
    [InlineData("EN", "en")]
    [InlineData("fr", "fr")]
    [InlineData("ja", "ja")]
    [InlineData("zh", "zh")]
    [InlineData("es", "es")]
    [InlineData("pt", "pt")]
    public void Normalise_Iso6391Passthrough_IsLowercased(string raw, string expected)
        => Assert.Equal(expected, LanguageNormaliser.Normalise(raw));

    [Fact]
    public void Normalise_NullInput_DoesNotThrow()
        => Assert.Equal("und", LanguageNormaliser.Normalise(null));
}
