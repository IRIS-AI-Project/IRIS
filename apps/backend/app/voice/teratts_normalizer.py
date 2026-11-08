"""Russian text preparation for TeraTTSv2.

TeraTTSv2 requires balanced language tags.  The application deliberately sends
one Russian span for Iris. Numbers are expanded before inference, including
digit runs inside identifiers that the model's own normalizer skips.
"""

from __future__ import annotations

import re
import unicodedata
from datetime import date

from num2words import num2words

from apps.backend.app.voice.lexicon import split_pronunciation_overrides
from apps.backend.app.voice.text import GROUPED_INTEGER


_MONTHS = (
    "января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря",
)
_MONTH_RE = "(" + "|".join(_MONTHS) + ")"

_YEAR = r"[1-9]\d{2,3}"
_DIGIT_WORDS = ("ноль", "один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять")
# num2words 0.5.14 names groups through 10**30 in Russian.
_MAX_CARDINAL_DIGITS = 33
_NUMBER = r"[+-]?\d+(?:[,.]\d+)?"

_FEMININE_QUANTITIES = {
    r"минут(?:а|ы|у|е)?": ("минуты", "минут"),
    r"секунд(?:а|ы|у|е)?": ("секунды", "секунд"),
    r"недел(?:я|и|ю|е|ь)": ("недели", "недель"),
    r"страниц(?:а|ы|у|е)?": ("страницы", "страниц"),
    r"глав(?:а|ы|у|е)?": ("главы", "глав"),
    r"верси[яиюей]": ("версии", "версий"),
    r"попыт(?:ка|ки|ку|ке|ок)": ("попытки", "попыток"),
    r"тысяч(?:а|и|у|е)?": ("тысячи", "тысяч"),
}
_FEMININE_NOUN = "(?:" + "|".join(_FEMININE_QUANTITIES) + r")\b"

_UNITS = {
    "%": ("процент", "процента", "процентов"),
    "кг": ("килограмм", "килограмма", "килограммов"),
    "г": ("грамм", "грамма", "граммов"),
    "км": ("километр", "километра", "километров"),
    "см": ("сантиметр", "сантиметра", "сантиметров"),
    "мм": ("миллиметр", "миллиметра", "миллиметров"),
    "л": ("литр", "литра", "литров"),
    "°c": ("градус Цельсия", "градуса Цельсия", "градусов Цельсия"),
    "°с": ("градус Цельсия", "градуса Цельсия", "градусов Цельсия"),
    "°": ("градус", "градуса", "градусов"),
    "₽": ("рубль", "рубля", "рублей"),
    "$": ("доллар", "доллара", "долларов"),
    "€": ("евро", "евро", "евро"),
}
_UNIT = "(?:" + "|".join(re.escape(unit) for unit in _UNITS) + r")(?!\w)"
_CURRENCY_SUBUNITS = {
    "₽": ("копейка", "копейки", "копеек"),
    "$": ("цент", "цента", "центов"),
    "€": ("цент", "цента", "центов"),
}

_ORDINAL_NEUTER_NOUNS = ("место", "число", "окно", "поле", "задание", "упражнение")

_TECH_LEXICON: tuple[tuple[re.Pattern[str], str], ...] = tuple(
    (re.compile(pattern, re.IGNORECASE), replacement)
    for pattern, replacement in {
        r"\bTeraTTS\s*[vV]?2\b": "Тера ТТС версия два",
        r"\bTeraTTS\b": "Тера ТТС",
        r"\bFastAPI\b": "Фаст+АПИ",
        r"\bWebSockets?\b": "Вебс+окет",
        r"\bPython\s*3\.12\b": "П+айтон три точка двенадцать",
        r"\bPython\b": "П+айтон",
        r"\bWindows\s*11\b": "В+индовс одиннадцать",
        r"\bWindows\b": "В+индовс",
        r"\bLinux\b": "Л+инукс",
        r"\bDocker\b": "Д+окер",
        r"\bPostgreSQL\b": "Постгре Эс Кью Эль",
        r"\bPostgres\b": "П+остгрес",
        r"\bONNX\s*Runtime\b": "ОННИКС Рант+айм",
        r"\bONNX\b": "ОННИКС",
        r"\bPyTorch\b": "Пайт+орч",
        r"\bGitHub\b": "Гитх+аб",
        r"\bAPI\b": "АП+И",
        r"\bGPU\b": "ГПУ",
        r"\bCPU\b": "ЦПУ",
        r"\bLLM\b": "Эль Эль +Эм",
        r"\bJSON\b": "Дж+ейсон",
        r"\bHTTP\b": "ХТТП",
        r"\bHTTPS\b": "ХТТПС",
        r"\bURL\b": "ЮРЭЛ",
        r"\bUI\b": "Ю+Ай",
        r"\bUX\b": "Ю+Икс",
        r"\bAI\b": "Эй+Ай",
        r"\bGPT-?4[oо]\b": "джи пи ти четыре о",
        r"\bGPT-?(?=\d)": "джи пи ти ",
        r"\bGPT\b": "джи пи ти",
        r"\b2D\b": "два дэ",
        r"\b3D\b": "три дэ",
        r"\bbackend\b": "бэк+енд",
        r"\bfrontend\b": "фронт+енд",
        r"\bframework\b": "фреймв+орк",
        r"\bIris\b": "+Ирис",
        r"\bNeuroAsist\b": "НейроАсс+ист",
        r"\bNode(?:\.js|JS)\b": "Н+ода",
        r"\bReact\b": "Ре+акт",
        r"\bTypeScript\b": "Тайпскр+ипт",
        r"\bJavaScript\b": "Джаваскр+ипт",
    }.items()
)


def normalize_unicode_for_model(text: str) -> str:
    """Map common editor punctuation/stress marks to Tera's vocabulary.

    TeraTTS uses ``+`` immediately before a stressed character.  User text
    often carries the same information as a combining acute accent (``а́``).
    Normalizing it here avoids a warning and, more importantly, preserves the
    explicitly requested stress instead of letting the model drop the mark.
    """
    decomposed = unicodedata.normalize("NFD", text)
    output: list[str] = []
    for character in decomposed:
        if character == "\u0301":
            if output and output[-1] != "+":
                output[-1] = "+" + output[-1]
            continue
        output.append(character)
    normalized = unicodedata.normalize("NFC", "".join(output))
    # Keep semantic dashes until ranges have been recognized.  A prose dash is
    # converted to a pause later, while a dash between numbers means "from/to".
    # U+2212 is an unambiguous math minus; keep its meaning before mapping
    # remaining unary minus signs to the numeric normalizer's ASCII spelling.
    normalized = re.sub(r"(?<=[\d)])\s*−\s*(?=[\d(])", " минус ", normalized)
    return normalized.replace("‑", "-").replace("−", "-").replace("\u00ad", "").replace("\u00a0", " ")


def _cardinal(value: int, *, feminine: bool = False, case: str = "nominative") -> str:
    return str(num2words(value, lang="ru", gender="feminine" if feminine else "masculine", case=case))


def _ordinal(value: int, *, form: str = "masculine") -> str:
    if form in ("masculine", "feminine", "neuter"):
        return str(num2words(value, lang="ru", to="ordinal", gender=form))
    return str(num2words(value, lang="ru", to="ordinal", case=form))


def _digit_words(raw: str) -> str:
    return " ".join(_DIGIT_WORDS[unicodedata.digit(digit)] for digit in raw)


def _integer_words(raw: str, *, feminine: bool = False, case: str = "nominative") -> str:
    digits = raw.lstrip("+-")
    if len(digits) > _MAX_CARDINAL_DIGITS or (len(digits) > 1 and unicodedata.digit(digits[0]) == 0):
        sign = "минус " if raw.startswith("-") else ""
        words = sign + _digit_words(digits)
    else:
        words = _cardinal(int(raw), feminine=feminine, case=case)
    return ("плюс " if raw.startswith("+") else "") + words


def _plural(value: int, one: str, few: str, many: str) -> str:
    last_two = abs(value) % 100
    if 11 <= last_two <= 14:
        return many
    last = abs(value) % 10
    return one if last == 1 else few if 2 <= last <= 4 else many


def _is_decimal(raw: str) -> bool:
    return "." in raw or "," in raw


def _genitive_quantity_forms(unit: str | None, noun: str | None) -> tuple[str, str]:
    if unit:
        return _UNITS[unit.lower()][1:]
    return next(forms for pattern, forms in _FEMININE_QUANTITIES.items()
                if re.fullmatch(pattern, noun or "", re.IGNORECASE))


def _day_form(prefix: str | None) -> str:
    if prefix and prefix.lower() == "к":
        return "dative"
    if prefix and prefix.lower() in ("на", "сегодня", "завтра", "вчера"):
        return "neuter"
    return "genitive"


def normalize_dates(text: str) -> str:
    prefix = r"(?:(на|к|сегодня|завтра|вчера)\s+)?"

    def replace_numeric_date(match: re.Match[str]) -> str:
        prep, year, iso_month, iso_day, day, month, local_year, year_abbreviation = match.groups()
        year_value = int(year or local_year)
        month_value = int(iso_month or month)
        day_value = int(iso_day or day)
        try:
            date(year_value, month_value, day_value)
        except ValueError:
            return match.group()
        day_words = _ordinal(day_value, form=_day_form(prep))
        year_words = _ordinal(year_value, form="genitive")
        lead = f"{prep} " if prep else ""
        stop = "." if year_abbreviation and not text[match.end():].strip() else ""
        return f"{lead}{day_words} {_MONTHS[month_value - 1]} {year_words} года{stop}"

    text = re.sub(
        rf"(?<![\w./-]){prefix}(?:({_YEAR})-(\d{{1,2}})-(\d{{1,2}})|"
        rf"(\d{{1,2}})[./](\d{{1,2}})[./]({_YEAR}))(?!\w|[./-]\d)(?:\s+(г\.(?!\w)))?",
        replace_numeric_date, text, flags=re.IGNORECASE,
    )

    def replace_written_date(match: re.Match[str]) -> str:
        prep, raw_day, month, year, year_word = match.groups()
        day = int(raw_day)
        if not 1 <= day <= 31:
            return match.group()
        words = _ordinal(day, form=_day_form(prep))
        result = f"{prep + ' ' if prep else ''}{words} {month}"
        if year:
            result += f" {_ordinal(int(year), form='genitive')} года"
        if year_word and year_word.endswith(".") and not text[match.end():].strip():
            result += "."
        return result

    return re.sub(
        rf"\b{prefix}(\d{{1,2}})\s+{_MONTH_RE}\b"
        rf"(?:\s+({_YEAR})\b(?:\s+(года\b|г\.(?!\w)))?)?",
        replace_written_date, text, flags=re.IGNORECASE,
    )


def normalize_years(text: str) -> str:
    """Speak calendar years as ordinals with the case implied by the phrase."""
    def replace_range(match: re.Match[str]) -> str:
        prep, start, end, noun = match.groups()
        lead = f"{prep} период " if prep and prep.lower() in ("в", "за") else ""
        start_words = _ordinal(int(start), form="genitive")
        end_words = _ordinal(int(end))
        stop = "." if noun.endswith(".") and not text[match.end():].strip() else ""
        return f"{lead}с {start_words} по {end_words} год{stop}"

    text = re.sub(
        rf"\b(?:(с|в|за)\s+)?({_YEAR})\s*(?:[-–—]\s*|\s+по\s+)({_YEAR})\s+"
        r"(годы\b|годах\b|год\b|гг?\.(?!\w))",
        replace_range, text, flags=re.IGNORECASE,
    )

    def replace_year(match: re.Match[str]) -> str:
        prep, year, noun = match.groups()
        year_nouns = {
            "год": "masculine", "года": "genitive", "году": "prepositional", "годом": "instrumental",
        }
        prep_forms = {
            "в": "prepositional", "во": "prepositional", "к": "dative",
            "до": "genitive", "с": "genitive", "от": "genitive", "после": "genitive",
            "за": "masculine", "на": "masculine", "между": "instrumental",
        }
        form = year_nouns.get(noun.lower(), "masculine")
        if noun.lower() in ("г.", "году") and prep:
            form = prep_forms[prep.lower()]
        forms = {form: word for word, form in year_nouns.items()}
        forms["dative"] = "году"
        stop = "." if noun.endswith(".") and not text[match.end():].strip() else ""
        lead = f"{prep} " if prep else ""
        return f"{lead}{_ordinal(int(year), form=form)} {forms[form]}{stop}"

    return re.sub(
        rf"\b(?:(в|во|к|до|с|от|после|за|на|между)\s+)?({_YEAR})(?:[-\s](?:й|ый|го|ого|м|ом|му|ому|ым))?"
        r"\s+(год(?:а|у|ом)?\b|г\.(?!\w))",
        replace_year, text, flags=re.IGNORECASE,
    )


def normalize_time(text: str) -> str:
    def replace_time(match: re.Match[str]) -> str:
        hour, minute = int(match.group(1)), int(match.group(2))
        hour_words = _cardinal(hour)
        hours = _plural(hour, "час", "часа", "часов")
        if minute == 0:
            return f"{hour_words} {hours} ровно"
        minute_words = _cardinal(minute, feminine=True)
        minutes = _plural(minute, "минута", "минуты", "минут")
        return f"{hour_words} {hours} {minute_words} {minutes}"

    return re.sub(r"\b([01]?\d|2[0-3]):([0-5]\d)\b", replace_time, text)


def normalize_versions(text: str) -> str:
    def words(raw: str) -> str:
        return " точка ".join(_integer_words(part) for part in raw.split("."))

    text = re.sub(
        r"\b(версия|версии|версию|версией|сборка|сборки|релиз)\s+[vV]?(\d+(?:\.\d+)+)\b",
        lambda m: f"{m.group(1)} {words(m.group(2))}",
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(r"\b[vV](\d+(?:\.\d+)+)\b", lambda m: f"версия {words(m.group(1))}", text)
    text = re.sub(r"\b(\d+\.\d+(?:\.\d+)+)\b", lambda m: words(m.group(1)), text)
    return re.sub(r"\b[vV](\d+)\b", lambda m: f"версия {_integer_words(m.group(1))}", text)


def normalize_numeric_ranges(text: str) -> str:
    """Speak both ends in the genitive, including decimal endpoints."""
    def replace(match: re.Match[str]) -> str:
        prefix, left, right, unit, feminine_noun = match.groups()
        feminine = bool(feminine_noun)
        start = _number_words(left, case="genitive", feminine=feminine)
        end = _number_words(right, case="genitive", feminine=feminine)
        suffix = ""
        if unit or feminine_noun:
            forms = _genitive_quantity_forms(unit, feminine_noun)
            suffix = " " + (forms[0] if _is_decimal(right) else _plural(int(right), forms[0], forms[1], forms[1]))
        return f"{prefix or 'от'} {start} до {end}{suffix}"

    ending = rf"(?:\s*({_UNIT})|\s+({_FEMININE_NOUN}))?(?!\w|[,.]\d)"
    text = re.sub(
        rf"(?<![\w.])(?:(от|с)\s+)?({_NUMBER})\s*[-–—]\s*({_NUMBER}){ending}",
        replace, text, flags=re.IGNORECASE,
    )
    return re.sub(
        rf"\b(от|с)\s+({_NUMBER})\s+до\s+({_NUMBER}){ending}",
        replace, text, flags=re.IGNORECASE,
    )


def normalize_ordinals(text: str) -> str:
    suffix_forms = {
        "й": "masculine", "ый": "masculine", "ой": "masculine",
        "я": "feminine", "ая": "feminine", "е": "neuter", "ое": "neuter",
        "го": "genitive", "ого": "genitive", "му": "dative", "ому": "dative",
        "м": "prepositional", "ом": "prepositional", "ым": "instrumental", "им": "instrumental",
    }

    def replace_suffix(match: re.Match[str]) -> str:
        return _ordinal(int(match.group(1)), form=suffix_forms[match.group(2).lower()])

    text = re.sub(
        r"\b(\d+)\s*-(ый|ой|ая|ое|ого|ому|ым|им|й|я|е|го|му|ом|м)\b",
        replace_suffix,
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(
        r"\bна\s+(\d+)\s+месте\b",
        lambda m: f"на {_ordinal(int(m.group(1)), form='prepositional')} месте",
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(
        r"\b(с|из)\s+(\d+)\s+места\b",
        lambda m: f"{m.group(1)} {_ordinal(int(m.group(2)), form='genitive')} места",
        text,
        flags=re.IGNORECASE,
    )
    nouns = "|".join(_ORDINAL_NEUTER_NOUNS)
    return re.sub(
        rf"\b(\d+)\s+({nouns})(?=\b)",
        lambda m: f"{_ordinal(int(m.group(1)), form='neuter')} {m.group(2)}",
        text,
        flags=re.IGNORECASE,
    )


def _number_words(raw: str, *, feminine: bool = False, case: str = "nominative") -> str:
    integer, point, fraction = raw.replace(",", ".").partition(".")
    if not point:
        return _integer_words(integer, feminine=feminine, case=case)
    if len(fraction) >= _MAX_CARDINAL_DIGITS - 3:
        return f"{_integer_words(integer, case=case)} запятая {_digit_words(fraction)}"
    whole, numerator = int(integer), int(fraction)
    sign = "минус " if integer.startswith("-") else "плюс " if integer.startswith("+") else ""
    whole_words = _cardinal(abs(whole), feminine=True, case=case)
    whole_noun = _plural(whole, "целая", "целых", "целых")
    if case == "genitive" and whole_noun == "целая":
        whole_noun = "целой"
    numerator_words = _cardinal(numerator, feminine=True, case=case)
    fraction_plural = abs(numerator) % 10 != 1 or abs(numerator) % 100 == 11
    denominator = num2words(
        10 ** len(fraction), lang="ru", to="ordinal", gender="feminine",
        case="genitive" if fraction_plural else case, plural=fraction_plural,
    )
    return f"{sign}{whole_words} {whole_noun} {numerator_words} {denominator}"


def normalize_quantities(text: str) -> str:
    """Expand quantities with their units and common genitive constructions."""
    def replace_quantity(match: re.Match[str]) -> str:
        prep, raw, unit, feminine_noun = match.groups()
        case = "genitive" if prep else "nominative"
        words = _number_words(raw, feminine=bool(feminine_noun), case=case)
        currency = unit if unit in _CURRENCY_SUBUNITS else None
        if currency and re.fullmatch(r"[+-]?\d+[,.]\d{1,2}", raw):
            words = _currency_words(raw, currency, case)
        elif unit or (prep and feminine_noun):
            if _is_decimal(raw) or prep:
                singular, plural = _genitive_quantity_forms(unit, feminine_noun)
                noun = singular if _is_decimal(raw) else _plural(int(raw), singular, plural, plural)
            else:
                noun = _plural(int(raw), *_UNITS[unit.lower()])
            words += f" {noun}"
        elif feminine_noun:
            words += f" {feminine_noun}"
        return f"{prep} {words}" if prep else words

    return re.sub(
        rf"(?<![\w.])(?:(более|менее|около|порядка|свыше|до|от|без)\s+)?({_NUMBER})"
        rf"(?:\s*({_UNIT})|\s+({_FEMININE_NOUN}))?(?!\w|[,.]\d)",
        replace_quantity, text, flags=re.IGNORECASE,
    )


def _currency_words(raw: str, currency: str, case: str) -> str:
    whole, fraction = raw.lstrip("+-").replace(",", ".").split(".")
    main, sub = int(whole), int(fraction.ljust(2, "0"))
    parts = []
    for value, forms, feminine in (
        (main, _UNITS[currency], False),
        (sub, _CURRENCY_SUBUNITS[currency], currency == "₽"),
    ):
        if value or (not parts and not sub):
            if case == "genitive":
                forms = (forms[1], forms[2], forms[2])
            parts.append(f"{_cardinal(value, feminine=feminine, case=case)} {_plural(value, *forms)}")
    sign = "минус " if raw.startswith("-") else "плюс " if raw.startswith("+") else ""
    return sign + " ".join(parts)


def normalize_numeric_notation(text: str) -> str:
    # Grouped thousands must stay together before dates, ranges and quantities.
    text = re.sub(GROUPED_INTEGER, lambda m: "".join(m.group().split()), text)
    text = re.sub(rf"(?<!\w)([$€₽])\s*({_NUMBER})(?!\w|[,.]\d)", r"\2 \1", text)
    text = re.sub(r"№\s*(?=\d)", "номер ", text)
    text = re.sub(r"(?<=\d)[²³]", lambda m: {"²": " в квадрате", "³": " в кубе"}[m.group()], text)
    return re.sub(
        r"(?<![\w.])(\d+(?:[,.]\d+)?)[eE]([+-]?\d+)(?!\w|[.,]\d)",
        r"\1 умножить на десять в степени \2", text,
    )


def expand_remaining_digits(text: str) -> str:
    """Keep digit runs in identifiers and pronunciation overrides audible."""
    def replace(match: re.Match[str]) -> str:
        words = " точка ".join(_integer_words(part) for part in match.group().split("."))
        return f" {words} "

    text = re.sub(r"\d+(?:\.\d+)*", replace, text)
    return "".join(f" {_digit_words(ch)} " if ch.isdigit() else ch for ch in text)


def normalize_abbreviations(text: str) -> str:
    expansions = {"е": "то есть", "д": "так далее", "п": "тому подобное", "к": "так как"}
    return re.sub(
        r"(?<!\w)т\.\s*([едпк])\.(?!\w)",
        lambda m: expansions[m.group(1).lower()], text, flags=re.IGNORECASE,
    )


def normalize_punctuation(text: str) -> str:
    """Translate typography into pauses TeraTTS renders consistently."""
    text = re.sub(r"\.{2,}", "…", text)
    text = re.sub(r"…+", "…", text)
    text = re.sub(r"\s*[—–]\s*", "; ", text)
    text = re.sub(r"\s+-\s+", "; ", text)
    text = re.sub(r"\s*;\s*", "; ", text)
    text = re.sub(r"\s*:\s*", ": ", text)
    text = re.sub(r"\s*,\s*", ", ", text)
    text = re.sub(r"([!?])[!?]+", r"\1", text)
    text = re.sub(r"\s+([,;:.!?…])", r"\1", text)
    return re.sub(r"[ \t]+", " ", text).strip()


def normalize_math_symbols(text: str) -> str:
    left = r"(?<=[\d)])"
    right = r"(?=[+-]?\s*\d|\()"
    math_only = re.fullmatch(r"[\d\s().,+*/×÷^=\-]+", text) is not None

    def formula_minus(match: re.Match[str]) -> str:
        formula = match.group()
        if math_only or re.search(r"[+*/×÷^=]", formula):
            return re.sub(left + r"\s*-\s*" + right, " минус ", formula)
        return formula

    # Keep nested subtraction in a numeric formula distinct from prose ranges.
    text = re.sub(r"(?<!\w)[\d(](?:[\d.\s()+*/×÷^=\-]|(?<=\d),(?=\d))*", formula_minus, text)

    def spaced_minus(match: re.Match[str]) -> str:
        # An explicit range preposition still wins over ASCII typography.
        if re.search(r"\b(?:от|с)\s+-?\d+(?:[.,]\d+)?$", text[:match.start()], re.IGNORECASE):
            return match.group()
        return " минус "

    text = re.sub(left + r"\s+-\s+" + right, spaced_minus, text)
    substitutions = (
        (left + r"\s*\+\s*" + right, " плюс "),
        (r"(?<=\d)\s*[−-]\s*(?=\d+\s*=)", " минус "),
        (left + r"\s*(?:\^|\*\*)\s*" + right, " в степени "),
        (left + r"\s*[×*·]\s*" + right, " умножить на "),
        (left + r"\s*[/÷]\s*" + right, " разделить на "),
        (left + r"\s*=\s*" + right, " равно "),
    )
    for pattern, replacement in substitutions:
        text = re.sub(pattern, replacement, text)
    return text


def normalize_tech_terms(text: str) -> str:
    for pattern, replacement in _TECH_LEXICON:
        text = pattern.sub(replacement, text)
    return text


def normalize_for_teratts(text: str, pronunciations: dict[str, str] | None = None) -> str:
    """Return exactly one balanced Russian TeraTTSv2 span."""
    clean = re.sub(r"</?(?:ru|en)\b[^>]*>", "", str(text or ""), flags=re.IGNORECASE)
    clean = re.sub(r"</?[a-zA-Z][^>]*>", "", clean)
    parts = []
    # Match the original words once, longest phrase first. User replacements
    # take precedence over built-ins and are never fed into another replacement.
    for part, overridden in split_pronunciation_overrides(clean, pronunciations or {}):
        part = normalize_unicode_for_model(part)
        if not overridden:
            part = normalize_numeric_notation(part)
            part = re.sub(
                rf"\d{{{_MAX_CARDINAL_DIGITS + 1},}}", lambda m: f" {_digit_words(m.group())} ", part,
            )
            part = normalize_dates(part)
            part = normalize_years(part)
            part = normalize_time(part)
            part = normalize_versions(part)
            part = normalize_math_symbols(part)
            part = normalize_numeric_ranges(part)
            part = normalize_ordinals(part)
            part = normalize_tech_terms(part)
            part = normalize_quantities(part)
            part = normalize_abbreviations(part)
        parts.append(part)
    clean = "".join(parts)
    clean = normalize_punctuation(expand_remaining_digits(clean))
    if not clean:
        raise ValueError("TTS text is empty after normalization")
    return f"<ru>{clean}</ru>"
