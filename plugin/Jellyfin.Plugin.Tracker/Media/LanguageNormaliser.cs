namespace Jellyfin.Plugin.Tracker.Media;

/// <summary>
/// Normalises the language tags a Jellyfin <c>MediaStream</c> can carry into ISO 639-1
/// (S7.7). Jellyfin persists whatever ffprobe read out of the file's own container
/// metadata at scan time, so the same language shows up across a library as an ISO
/// 639-2/B code, its 639-2/T counterpart, a bare 639-1 code, a region- or script-tagged
/// BCP 47 string, or a free-text English name, depending on how each file was muxed.
/// </summary>
public static class LanguageNormaliser
{
    /// <summary>
    /// The sentinel S7.7 requires for a track whose language is empty, unrecognised, or
    /// already the literal "und". Kept distinct from "no audio track" deliberately - for
    /// a lot of single-language rips, "und" is simply the member's own language.
    /// </summary>
    private const string Unknown = "und";

    /// <summary>
    /// BCP 47 tags such as "de-DE" or "zh-Hans" separate the language subtag from the
    /// region/script subtag with '-'; stripping to the primary subtag resolves them
    /// without needing an entry for every region combination (S7.7).
    /// </summary>
    private const char SubtagSeparator = '-';

    /// <summary>
    /// Every raw spelling this plugin has seen mapped to its ISO 639-1 code, built once
    /// so the hot path - every audio and subtitle track of every item, potentially
    /// 20,000 episodes on every nightly snapshot (S7.7) - never allocates a lookup
    /// structure or runs a regex. Ordinal + ignore-case: language tags are ASCII, and
    /// neither Jellyfin nor ffprobe localise them.
    /// </summary>
    private static readonly Dictionary<string, string> Map = new(StringComparer.OrdinalIgnoreCase)
    {
        // German - S7.7's own worked example: ger/deu/de/de-DE/German (plus ""/und,
        // handled separately below) all collapse to "de".
        ["de"] = "de",
        ["ger"] = "de",
        ["deu"] = "de",
        ["german"] = "de",

        // ISO 639-2/B codes that differ from 639-2/T, and their /T counterparts, per the
        // explicit list in S7.7.
        ["fre"] = "fr",
        ["fra"] = "fr",
        ["fr"] = "fr",
        ["french"] = "fr",
        ["dut"] = "nl",
        ["nld"] = "nl",
        ["nl"] = "nl",
        ["dutch"] = "nl",
        ["chi"] = "zh",
        ["zho"] = "zh",
        ["zh"] = "zh",
        ["chinese"] = "zh",
        ["cze"] = "cs",
        ["ces"] = "cs",
        ["cs"] = "cs",
        ["czech"] = "cs",
        ["gre"] = "el",
        ["ell"] = "el",
        ["el"] = "el",
        ["greek"] = "el",
        ["ice"] = "is",
        ["isl"] = "is",
        ["is"] = "is",
        ["icelandic"] = "is",
        ["mac"] = "mk",
        ["mkd"] = "mk",
        ["mk"] = "mk",
        ["macedonian"] = "mk",
        ["mao"] = "mi",
        ["mri"] = "mi",
        ["mi"] = "mi",
        ["maori"] = "mi",
        ["may"] = "ms",
        ["msa"] = "ms",
        ["ms"] = "ms",
        ["malay"] = "ms",
        ["per"] = "fa",
        ["fas"] = "fa",
        ["fa"] = "fa",
        ["persian"] = "fa",
        ["farsi"] = "fa",
        ["rum"] = "ro",
        ["ron"] = "ro",
        ["ro"] = "ro",
        ["romanian"] = "ro",
        ["slo"] = "sk",
        ["slk"] = "sk",
        ["sk"] = "sk",
        ["slovak"] = "sk",
        ["wel"] = "cy",
        ["cym"] = "cy",
        ["cy"] = "cy",
        ["welsh"] = "cy",
        ["arm"] = "hy",
        ["hye"] = "hy",
        ["hy"] = "hy",
        ["armenian"] = "hy",
        ["baq"] = "eu",
        ["eus"] = "eu",
        ["eu"] = "eu",
        ["basque"] = "eu",
        ["bur"] = "my",
        ["mya"] = "my",
        ["my"] = "my",
        ["burmese"] = "my",
        ["geo"] = "ka",
        ["kat"] = "ka",
        ["ka"] = "ka",
        ["georgian"] = "ka",
        ["tib"] = "bo",
        ["bod"] = "bo",
        ["bo"] = "bo",
        ["tibetan"] = "bo",

        // Other common European/world languages a real library holds beyond the 639-2/B
        // list (S7.7).
        ["en"] = "en",
        ["eng"] = "en",
        ["english"] = "en",
        ["es"] = "es",
        ["spa"] = "es",
        ["spanish"] = "es",
        ["it"] = "it",
        ["ita"] = "it",
        ["italian"] = "it",
        ["pt"] = "pt",
        ["por"] = "pt",
        ["portuguese"] = "pt",
        ["brazilian portuguese"] = "pt",
        ["ru"] = "ru",
        ["rus"] = "ru",
        ["russian"] = "ru",
        ["ja"] = "ja",
        ["jpn"] = "ja",
        ["japanese"] = "ja",
        ["ko"] = "ko",
        ["kor"] = "ko",
        ["korean"] = "ko",
        ["pl"] = "pl",
        ["pol"] = "pl",
        ["polish"] = "pl",
        ["sv"] = "sv",
        ["swe"] = "sv",
        ["swedish"] = "sv",
        ["da"] = "da",
        ["dan"] = "da",
        ["danish"] = "da",
        ["no"] = "no",
        ["nor"] = "no",
        ["norwegian"] = "no",
        ["fi"] = "fi",
        ["fin"] = "fi",
        ["finnish"] = "fi",
        ["tr"] = "tr",
        ["tur"] = "tr",
        ["turkish"] = "tr",
        ["ar"] = "ar",
        ["ara"] = "ar",
        ["arabic"] = "ar",
        ["hi"] = "hi",
        ["hin"] = "hi",
        ["hindi"] = "hi",
        ["he"] = "he",
        ["heb"] = "he",
        ["hebrew"] = "he",
        ["th"] = "th",
        ["tha"] = "th",
        ["thai"] = "th",
        ["vi"] = "vi",
        ["vie"] = "vi",
        ["vietnamese"] = "vi",
        ["uk"] = "uk",
        ["ukr"] = "uk",
        ["ukrainian"] = "uk",
        ["hu"] = "hu",
        ["hun"] = "hu",
        ["hungarian"] = "hu",
        ["bg"] = "bg",
        ["bul"] = "bg",
        ["bulgarian"] = "bg",
        ["hr"] = "hr",
        ["hrv"] = "hr",
        ["croatian"] = "hr",
        ["sr"] = "sr",
        ["srp"] = "sr",
        ["serbian"] = "sr",
        ["sl"] = "sl",
        ["slv"] = "sl",
        ["slovenian"] = "sl",
        ["et"] = "et",
        ["est"] = "et",
        ["estonian"] = "et",
        ["lv"] = "lv",
        ["lav"] = "lv",
        ["latvian"] = "lv",
        ["lt"] = "lt",
        ["lit"] = "lt",
        ["lithuanian"] = "lt",
        ["ca"] = "ca",
        ["cat"] = "ca",
        ["catalan"] = "ca",
        ["gl"] = "gl",
        ["glg"] = "gl",
        ["galician"] = "gl",
        ["id"] = "id",
        ["ind"] = "id",
        ["indonesian"] = "id",
    };

    /// <summary>
    /// Normalises a raw Jellyfin/ffprobe language tag to ISO 639-1, or the literal
    /// string "und" (S7.7) for anything empty, unrecognised, or already "und". Never
    /// throws and never returns null.
    /// </summary>
    public static string Normalise(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return Unknown;
        }

        // In the common case (no surrounding whitespace) Trim() returns the same
        // reference, so this is not an allocation on the hot path.
        var trimmed = raw.Trim();

        if (Map.TryGetValue(trimmed, out var code))
        {
            return code;
        }

        // Region/script subtags (de-DE, pt-BR, zh-Hans, zh-CN, ...) add nothing that
        // readiness matching needs once the primary subtag itself resolves (S7.7).
        var separatorIndex = trimmed.IndexOf(SubtagSeparator);
        if (separatorIndex > 0 && Map.TryGetValue(trimmed[..separatorIndex], out var primary))
        {
            return primary;
        }

        return Unknown;
    }
}
